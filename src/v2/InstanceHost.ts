import { createHash } from 'crypto'
import type { InstanceBridgeEntry, InstanceHosted } from './BridgeApi.js'
import type { HostedInstance } from './HostRunner.js'
import type { HealthReport } from '../health.js'
import { Logger, errorText } from '../log.js'

/** Lifecycle surface of SharedDiscordClient. */
export interface SharedClientLike {
  start(): void
  stop(): Promise<void>
  setToken(token: string): void
  setPresence(presence: boolean): void
  /** Null until the client is ready. */
  guildIds(): string[] | null
  /** Guild name when left, null when refused or unknown. */
  leaveGuild(guildId: string): Promise<string | null>
  health(): Record<string, unknown>
}

/** An instance bridge (V2Bridge). */
export interface InstanceBridge extends HostedInstance {
  configLoaded(): boolean
  linkedGuildId(): string | null
}

export interface InstanceHostOptions<S extends SharedClientLike> {
  /** GET /bridge/v2/hosted/instance; null when the gateway answers 404. */
  fetchInstance: () => Promise<InstanceHosted | null>
  createShared: (init: { token: string; presence: boolean }) => S
  createBridge: (entry: InstanceBridgeEntry, shared: S) => InstanceBridge
  log: Logger
  /** How long a guild stays unlinked before the bot leaves it. */
  orphanGraceMs?: number
  now?: () => number
}

interface Running {
  fingerprint: string
  instance: InstanceBridge
}

/** Upper bound on waiting for the first bridges to attach before the first connect. */
const INITIAL_ATTACH_WAIT_MS = 15_000
export const ORPHAN_GRACE_MS = 10 * 60_000

/**
 * Guilds the instance bot is in that no bridge links, observed on successful
 * polls only. A guild is due once every successful poll for the grace
 * period saw it unlinked; linking it again forgets it.
 */
export class OrphanGuilds {
  private readonly since = new Map<string, number>()

  constructor(private readonly graceMs = ORPHAN_GRACE_MS) {}

  /** Due guilds; none while `canLeave` is false (observation continues). */
  observe(present: Iterable<string>, linked: ReadonlySet<string>, now: number, canLeave: boolean): string[] {
    const seen = new Set<string>()
    const due: string[] = []
    for (const id of present) {
      seen.add(id)
      if (linked.has(id)) {
        this.since.delete(id)
        continue
      }
      const first = this.since.get(id)
      if (first === undefined) this.since.set(id, now)
      else if (canLeave && now - first >= this.graceMs) due.push(id)
    }
    for (const id of Array.from(this.since.keys())) {
      if (!seen.has(id)) this.since.delete(id)
    }
    return due
  }

  forget(guildId: string): void {
    this.since.delete(guildId)
  }

  /** Observations restart from the next successful poll. */
  reset(): void {
    this.since.clear()
  }

  get size(): number {
    return this.since.size
  }
}

/** Tokens never leave this hash. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Instance bot bridges of host mode: one shared Discord client for the
 * instance token, one V2Bridge per linked bridge. Bridges come and go
 * without touching the client; a new token or presence switch is handed to
 * the client, which reconnects only when its token or intent set changes.
 * A 404 stops every instance bridge and the client.
 */
export class InstanceHost<S extends SharedClientLike = SharedClientLike> {
  private shared: S | null = null
  private tokenHash = ''
  private presence = false
  private readonly running = new Map<string, Running>()
  private enabled = false
  private lastOk = true
  private lastAt = 0
  private lastErrorLogged = ''
  private readonly orphans: OrphanGuilds
  private readonly leaveFailureLogged = new Set<string>()

  constructor(private readonly opts: InstanceHostOptions<S>) {
    this.orphans = new OrphanGuilds(opts.orphanGraceMs)
  }

  runningIds(): string[] {
    return Array.from(this.running.keys())
  }

  hasSharedClient(): boolean {
    return this.shared !== null
  }

  async reconcile(): Promise<void> {
    const log = this.opts.log
    let hosted: InstanceHosted | null
    try {
      hosted = await this.opts.fetchInstance()
    } catch (err) {
      this.lastOk = false
      // Linked state is unknown; configs may be stale once the gateway is back.
      this.orphans.reset()
      const line = `Cannot fetch the instance bot configuration (${errorText(err)}); keeping ${this.running.size} running bridge(s).`
      if (this.lastErrorLogged !== line) {
        this.lastErrorLogged = line
        log.error(line)
      }
      return
    }
    this.lastErrorLogged = ''
    this.lastOk = true
    this.lastAt = Date.now()

    if (!hosted) {
      if (this.enabled) log.info('Instance bot disabled on this Harmony instance; stopping its bridges.')
      this.enabled = false
      this.orphans.reset()
      await this.stopAll()
      return
    }
    if (!this.enabled) log.info(`Instance bot enabled: ${hosted.bridges.length} linked bridge(s).`)
    this.enabled = true

    const tokenHash = sha256(hosted.discord_token)
    let created: S | null = null
    if (!this.shared) {
      created = this.opts.createShared({ token: hosted.discord_token, presence: hosted.presence })
      this.shared = created
      this.tokenHash = tokenHash
      this.presence = hosted.presence
    } else {
      if (tokenHash !== this.tokenHash) {
        log.info('Instance bot token changed; reconnecting the instance bot.')
        this.tokenHash = tokenHash
        this.shared.setToken(hosted.discord_token)
      }
      if (hosted.presence !== this.presence) {
        log.info(`Instance presence sync turned ${hosted.presence ? 'on' : 'off'}.`)
        this.presence = hosted.presence
        this.shared.setPresence(hosted.presence)
      }
    }
    const shared = this.shared

    const desired = new Map<string, InstanceBridgeEntry>()
    for (const entry of hosted.bridges) desired.set(entry.bridge_id, entry)

    const stops: Promise<unknown>[] = []
    for (const [id, running] of this.running) {
      const entry = desired.get(id)
      if (!entry) {
        log.info(`Instance bridge ${id.slice(0, 8)} removed; stopping`)
        this.running.delete(id)
        stops.push(this.safeStop(id, running.instance))
      } else if (sha256(entry.harmony_token) !== running.fingerprint) {
        log.info(`Instance bridge ${id.slice(0, 8)} token changed; restarting`)
        this.running.delete(id)
        stops.push(this.safeStop(id, running.instance))
      }
    }
    await Promise.allSettled(stops)

    // Starts are not awaited: one slow /config must not stall the others.
    const starts: Promise<unknown>[] = []
    for (const [id, entry] of desired) {
      if (this.running.has(id)) continue
      let instance: InstanceBridge
      try {
        instance = this.opts.createBridge(entry, shared)
      } catch (err) {
        log.error(`Instance bridge ${id.slice(0, 8)} could not be created: ${errorText(err)}`)
        continue
      }
      this.running.set(id, { fingerprint: sha256(entry.harmony_token), instance })
      log.info(`Instance bridge ${id.slice(0, 8)} starting`)
      starts.push(instance.start().catch(err => {
        log.error(`Instance bridge ${id.slice(0, 8)} failed to start: ${errorText(err)}`)
      }))
    }
    if (created) this.startAfter(created, starts)
    await this.leaveOrphans(shared, hosted)
  }

  /**
   * Leaves guilds no instance bridge links. Linked: any guild named by the
   * fetched list or by a bridge's loaded /config. Nothing is left while a
   * bridge's /config has not loaded.
   */
  private async leaveOrphans(shared: S, hosted: InstanceHosted) {
    const present = shared.guildIds()
    if (!present) return
    const linked = new Set<string>()
    for (const entry of hosted.bridges) if (entry.discord_guild_id) linked.add(entry.discord_guild_id)
    let allLoaded = true
    for (const { instance } of this.running.values()) {
      if (!instance.configLoaded()) allLoaded = false
      const guildId = instance.linkedGuildId()
      if (guildId) linked.add(guildId)
    }
    const now = this.opts.now?.() ?? Date.now()
    for (const guildId of this.orphans.observe(present, linked, now, allLoaded)) {
      try {
        const name = await shared.leaveGuild(guildId)
        this.orphans.forget(guildId)
        this.leaveFailureLogged.delete(guildId)
        if (name !== null) {
          this.opts.log.info(`Left Discord server ${name} (${guildId}): no instance bridge has linked it for ${Math.round((this.opts.orphanGraceMs ?? ORPHAN_GRACE_MS) / 60_000)} min.`)
        }
      } catch (err) {
        if (!this.leaveFailureLogged.has(guildId)) {
          this.leaveFailureLogged.add(guildId)
          this.opts.log.error(`Cannot leave unlinked Discord server ${guildId}: ${errorText(err)}; retrying on the next poll.`)
        }
      }
    }
  }

  /** First connect after the initial bridges attached (bounded): one IDENTIFY with their combined intents. */
  private startAfter(shared: S, starts: Promise<unknown>[]) {
    let timer: NodeJS.Timeout | undefined
    const cap = new Promise<void>(resolve => { timer = setTimeout(resolve, INITIAL_ATTACH_WAIT_MS) })
    void Promise.race([Promise.allSettled(starts), cap]).then(() => {
      clearTimeout(timer)
      if (this.shared === shared) shared.start()
    })
  }

  async stop(): Promise<void> {
    await this.stopAll()
  }

  private async stopAll(): Promise<void> {
    const all = Array.from(this.running.entries())
    this.running.clear()
    await Promise.allSettled(all.map(([id, r]) => this.safeStop(id, r.instance)))
    const shared = this.shared
    this.shared = null
    this.tokenHash = ''
    if (shared) {
      try {
        await shared.stop()
      } catch (err) {
        this.opts.log.error(`Instance bot failed to stop cleanly: ${errorText(err)}`)
      }
    }
  }

  private async safeStop(id: string, instance: InstanceBridge) {
    try {
      await instance.stop()
    } catch (err) {
      this.opts.log.error(`Instance bridge ${id.slice(0, 8)} failed to stop cleanly: ${errorText(err)}`)
    }
  }

  health(): HealthReport {
    const bridges = Array.from(this.running.entries()).map(([id, r]) => {
      const h = r.instance.health()
      return { id, ok: h.ok, ...h.body }
    })
    return {
      ok: this.lastOk,
      body: {
        enabled: this.enabled,
        fetched_at: this.lastAt ? new Date(this.lastAt).toISOString() : null,
        discord: this.shared?.health() ?? null,
        unlinked_guilds: this.orphans.size,
        bridges,
      },
    }
  }
}
