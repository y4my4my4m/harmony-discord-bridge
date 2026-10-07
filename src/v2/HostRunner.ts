import { createHash } from 'crypto'
import type { HostedEntry } from './BridgeApi.js'
import type { HealthReport } from '../health.js'
import { Logger, errorText } from '../log.js'

/** One running hosted bridge. */
export interface HostedInstance {
  start(): Promise<void>
  stop(): Promise<void>
  health(): HealthReport
}

/** Instance bot bridges, reconciled on the same timer (InstanceHost). */
export interface InstanceReconciler {
  reconcile(): Promise<void>
  stop(): Promise<void>
  health(): HealthReport
}

export interface HostRunnerOptions {
  /** GET /bridge/v2/hosted; null when the gateway answers 404 (hosting off). */
  fetchHosted: () => Promise<HostedEntry[] | null>
  createInstance: (entry: HostedEntry) => HostedInstance
  instance?: InstanceReconciler
  log: Logger
  intervalMs?: number
}

interface Running {
  fingerprint: string
  instance: HostedInstance
}

/** Token pair fingerprint; a change restarts the instance. Tokens never leave this hash. */
function fingerprint(entry: HostedEntry): string {
  return createHash('sha256').update(`${entry.harmony_token}\u0000${entry.discord_token}`).digest('hex')
}

/**
 * Host mode: one bridge instance per entry of GET /bridge/v2/hosted,
 * reconciled every 60 s. Entries that appear start, entries that disappear
 * stop, entries whose tokens changed restart. Instances fail independently.
 * Instance bot bridges (GET /bridge/v2/hosted/instance) reconcile on the
 * same tick, independently of the own-token list.
 */
export class HostRunner {
  private readonly running = new Map<string, Running>()
  private timer: NodeJS.Timeout | null = null
  private reconciling: Promise<void> | null = null
  private lastListOk = false
  private lastListAt = 0
  private hostingDisabled = false
  private lastErrorLogged = ''

  constructor(private readonly opts: HostRunnerOptions) {}

  async start(): Promise<void> {
    await this.reconcile()
    this.timer = setInterval(() => { void this.reconcile() }, this.opts.intervalMs ?? 60_000)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.reconciling
    const all = Array.from(this.running.entries())
    this.running.clear()
    await Promise.allSettled([
      ...all.map(([, r]) => r.instance.stop()),
      this.opts.instance?.stop(),
    ])
  }

  runningIds(): string[] {
    return Array.from(this.running.keys())
  }

  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling
    this.reconciling = this.doReconcile().finally(() => { this.reconciling = null })
    return this.reconciling
  }

  private async doReconcile(): Promise<void> {
    await this.reconcileHosted()
    try {
      await this.opts.instance?.reconcile()
    } catch (err) {
      this.opts.log.error(`Instance bot reconcile failed: ${errorText(err)}`)
    }
  }

  private async reconcileHosted(): Promise<void> {
    const log = this.opts.log
    let list: HostedEntry[] | null
    try {
      list = await this.opts.fetchHosted()
    } catch (err) {
      this.lastListOk = false
      const line = `Cannot fetch the hosted bridge list (${errorText(err)}); keeping ${this.running.size} running bridge(s).`
      if (this.lastErrorLogged !== line) {
        this.lastErrorLogged = line
        log.error(line)
      }
      return
    }
    this.lastErrorLogged = ''
    this.lastListOk = true
    this.lastListAt = Date.now()

    if (list === null) {
      if (!this.hostingDisabled) {
        log.warn('Own-bot hosting is disabled on this Harmony instance (or BRIDGE_HOST_SECRET is not set there); no own-bot hosted bridges run.')
      }
      this.hostingDisabled = true
      list = []
    } else if (this.hostingDisabled) {
      this.hostingDisabled = false
      log.info('Hosting enabled; starting hosted bridges.')
    }

    const desired = new Map<string, HostedEntry>()
    for (const entry of list) desired.set(entry.bridge_id, entry)

    const stops: Promise<unknown>[] = []
    for (const [id, running] of this.running) {
      const entry = desired.get(id)
      if (!entry) {
        log.info(`Hosted bridge ${id.slice(0, 8)} removed; stopping`)
        this.running.delete(id)
        stops.push(this.safeStop(id, running.instance))
      } else if (fingerprint(entry) !== running.fingerprint) {
        log.info(`Hosted bridge ${id.slice(0, 8)} tokens changed; restarting`)
        this.running.delete(id)
        stops.push(this.safeStop(id, running.instance))
      }
    }
    await Promise.allSettled(stops)

    // Starts are not awaited: a slow Discord login must not stall reconciliation.
    for (const [id, entry] of desired) {
      if (this.running.has(id)) continue
      let instance: HostedInstance
      try {
        instance = this.opts.createInstance(entry)
      } catch (err) {
        log.error(`Hosted bridge ${id.slice(0, 8)} could not be created: ${errorText(err)}`)
        continue
      }
      this.running.set(id, { fingerprint: fingerprint(entry), instance })
      log.info(`Hosted bridge ${id.slice(0, 8)} starting`)
      instance.start().catch(err => {
        log.error(`Hosted bridge ${id.slice(0, 8)} failed to start: ${errorText(err)}`)
      })
    }
  }

  private async safeStop(id: string, instance: HostedInstance) {
    try {
      await instance.stop()
    } catch (err) {
      this.opts.log.error(`Hosted bridge ${id.slice(0, 8)} failed to stop cleanly: ${errorText(err)}`)
    }
  }

  /** Healthy while both lists load; individual bridge failures show in the body. */
  health(): HealthReport {
    const bridges = Array.from(this.running.entries()).map(([id, r]) => {
      const h = r.instance.health()
      return { id, ok: h.ok, ...h.body }
    })
    const instance = this.opts.instance?.health() ?? null
    return {
      ok: this.lastListOk && (instance?.ok ?? true),
      body: {
        mode: 'host',
        hosting_enabled: !this.hostingDisabled,
        list_fetched_at: this.lastListAt ? new Date(this.lastListAt).toISOString() : null,
        bridges,
        ...(instance ? { instance: instance.body } : {}),
      },
    }
  }
}
