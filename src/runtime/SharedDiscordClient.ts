import { EventEmitter } from 'events'
import { Events, type Client as DiscordClient, type ClientOptions } from 'discord.js'
import type { FetchLike } from '../http.js'
import { Logger, errorText } from '../log.js'
import type { PrivilegedIntent } from '../problems.js'
import {
  DiscordConnection,
  type DiscordApplication,
  type DiscordConnState,
  type IntentNeeds,
  type IntentSelection,
} from './discordConnection.js'

/** One bridge served by the shared client. */
export interface SharedDiscordSink {
  /** Routing key: the Discord guild this bridge is linked to. */
  guildId(): string | null
  needs(): IntentNeeds
  /** discord.js client events of this bridge's guild, same names and arguments. */
  readonly events: EventEmitter
  /** REST `rateLimited` events attributable to this bridge's guild, or global. */
  readonly rest: EventEmitter
  bindClient(client: DiscordClient): void
  onReady(client: DiscordClient): void
  onState(state: DiscordConnState): void
  unbindClient(): void
}

type GuildOf = (client: DiscordClient, ...args: any[]) => string | null | undefined

function channelGuild(client: DiscordClient, channelId: string | null | undefined): string | null {
  if (!channelId) return null
  const channel = client.channels.cache.get(channelId) as { guildId?: string | null } | undefined
  return channel?.guildId ?? null
}

/** Client events forwarded to the bridge of the guild they belong to; DM and unlinked-guild events are dropped. */
export const ROUTED_EVENTS: Readonly<Record<string, GuildOf>> = {
  [Events.MessageCreate]: (c, m) => m.guildId ?? channelGuild(c, m.channelId),
  [Events.MessageUpdate]: (c, _old, m) => m.guildId ?? channelGuild(c, m.channelId),
  [Events.MessageDelete]: (c, m) => m.guildId ?? channelGuild(c, m.channelId),
  [Events.MessageReactionAdd]: (c, r) => r.message?.guildId ?? channelGuild(c, r.message?.channelId),
  [Events.MessageReactionRemove]: (c, r) => r.message?.guildId ?? channelGuild(c, r.message?.channelId),
  [Events.GuildMemberAdd]: (_c, m) => m.guild?.id,
  [Events.GuildMemberRemove]: (_c, m) => m.guild?.id,
  [Events.GuildMemberUpdate]: (_c, _old, m) => m.guild?.id,
  [Events.PresenceUpdate]: (_c, _old, p) => p.guild?.id,
  [Events.InteractionCreate]: (_c, i) => i.guildId,
  [Events.GuildCreate]: (_c, g) => g.id,
  [Events.GuildDelete]: (_c, g) => g.id,
  [Events.GuildRoleCreate]: (_c, r) => r.guild?.id,
  [Events.GuildRoleUpdate]: (_c, _old, r) => r.guild?.id,
  [Events.GuildRoleDelete]: (_c, r) => r.guild?.id,
  [Events.ChannelCreate]: (_c, ch) => ch.guildId,
  [Events.ChannelDelete]: (_c, ch) => ch.guildId,
  [Events.ChannelUpdate]: (_c, _old, ch) => ch.guildId,
}

export const INSTANCE_DISCORD_TOKEN_HINT =
  'Discord rejected the instance bot token. Reset it in the Discord Developer Portal (Bot → Reset Token) and paste it in Harmony → Admin → Discord bridge (retrying automatically).'

export interface SharedDiscordOptions {
  token: string
  /** Instance presence switch: GuildPresences may be requested at all. */
  presence: boolean
  log: Logger
  fetchImpl?: FetchLike
  createClient?: (options: ClientOptions) => DiscordClient
  /** Quiet period after attaches and setting changes before connecting or reconnecting. */
  settleMs?: number
}

/**
 * The instance bot: one discord.js client serving every instance bridge.
 * Events route by guild id to the one bridge linked to that guild. The
 * intent set is the union of the attached bridges' needs (presence only
 * with the instance switch); a change of that set or of the token
 * reconnects, attaching and detaching bridges does not.
 */
export class SharedDiscordClient {
  private readonly sinks = new Set<SharedDiscordSink>()
  private index: Map<string, SharedDiscordSink> | null = null
  private readonly duplicateWarned = new Set<string>()
  private readonly connection: DiscordConnection
  private presence: boolean
  private settleTimer: NodeJS.Timeout | null = null
  private armed = false
  private connectIssued = false
  private stopped = false

  constructor(private readonly opts: SharedDiscordOptions) {
    this.presence = opts.presence
    this.connection = new DiscordConnection({
      token: opts.token,
      log: opts.log,
      fetchImpl: opts.fetchImpl,
      createClient: opts.createClient,
      needs: () => this.needs(),
      tokenHint: () => INSTANCE_DISCORD_TOKEN_HINT,
      listener: {
        onClient: (client, isCurrent) => this.bindClient(client, isCurrent),
        onReady: (client) => this.each(s => s.onReady(client)),
        onState: (state) => this.each(s => s.onState(state)),
        onTeardown: () => this.each(s => s.unbindClient()),
      },
    })
  }

  /** Connects after the settle period, so bridges starting together share one IDENTIFY. Not restartable after stop(). */
  start(): void {
    if (this.armed || this.stopped) return
    this.armed = true
    this.scheduleSettle()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
    await this.connection.stop()
  }

  setToken(token: string): void {
    void this.connection.setToken(token, this.connectIssued && !this.stopped)
  }

  setPresence(presence: boolean): void {
    if (presence === this.presence) return
    this.presence = presence
    this.requirementsChanged()
  }

  attach(sink: SharedDiscordSink): void {
    if (this.sinks.has(sink)) return
    this.sinks.add(sink)
    this.index = null
    const client = this.connection.client
    this.call(sink, s => {
      if (client) s.bindClient(client)
      s.onState(this.connection.state)
      if (client && this.connection.isClientReady()) s.onReady(client)
    })
    this.requirementsChanged()
  }

  detach(sink: SharedDiscordSink): void {
    if (!this.sinks.delete(sink)) return
    this.index = null
    this.requirementsChanged()
  }

  /** A bridge's linked guild changed. */
  reindex(): void {
    this.index = null
  }

  /** A bridge's needs may have changed; the intent set is re-evaluated after the settle period. */
  requirementsChanged(): void {
    if (!this.armed || this.stopped) return
    this.scheduleSettle()
  }

  state(): DiscordConnState {
    return this.connection.state
  }

  application(): DiscordApplication | null {
    return this.connection.application
  }

  token(): string {
    return this.connection.currentToken()
  }

  /** Instance presence switch. */
  presenceAllowed(): boolean {
    return this.presence
  }

  attachedCount(): number {
    return this.sinks.size
  }

  /** Guilds the client is in; null until it is ready. */
  guildIds(): string[] | null {
    const client = this.connection.client
    if (!client || !this.connection.isClientReady()) return null
    return Array.from(client.guilds.cache.keys())
  }

  /** Leaves `guildId` unless an attached bridge is linked to it. Returns the guild name when left. */
  async leaveGuild(guildId: string): Promise<string | null> {
    if (this.route(guildId)) return null
    const guild = this.connection.client?.guilds.cache.get(guildId)
    if (!guild) return null
    await guild.leave()
    return guild.name
  }

  /** Union of the attached bridges' needs; presence only with the instance switch. */
  needs(): IntentNeeds {
    let members = false
    let presence = false
    for (const sink of this.sinks) {
      const n = sink.needs()
      if (!n.syncMemberList) continue
      members = true
      if (n.syncPresence) presence = true
    }
    return { syncMemberList: members, syncPresence: this.presence && presence }
  }

  /** One bridge's view of the shared intent set: what it asks for, what is active, what is missing. */
  selectionFor(needs: IntentNeeds): IntentSelection | null {
    const shared = this.connection.selection
    if (!shared) return null
    const requested: PrivilegedIntent[] = ['message_content']
    if (needs.syncMemberList) requested.push('members')
    if (needs.syncMemberList && needs.syncPresence && this.presence) requested.push('presence')
    const active = { message_content: false, members: false, presence: false }
    for (const intent of requested) active[intent] = shared.active[intent]
    return {
      intents: shared.intents,
      requested,
      active,
      missing: requested.filter(i => shared.missing.includes(i)),
    }
  }

  health(): Record<string, unknown> {
    const selection = this.connection.selection
    return {
      state: this.connection.state,
      application_id: this.connection.application?.id ?? null,
      bridges: this.sinks.size,
      intents: selection ? selection.active : null,
      missing_intents: this.connection.missingIntents(),
    }
  }

  private scheduleSettle() {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      void this.settle()
    }, this.opts.settleMs ?? 2_000)
  }

  private async settle() {
    if (this.stopped) return
    try {
      if (!this.connectIssued) {
        this.connectIssued = true
        await this.connection.start()
      } else if (this.connection.client) {
        // Without a client a retry is pending; it reads the needs afresh.
        await this.connection.applyNeeds()
      }
    } catch (err) {
      this.opts.log.error(`Instance bot connection failed: ${errorText(err)}`)
    }
  }

  private call(sink: SharedDiscordSink, fn: (sink: SharedDiscordSink) => void) {
    try {
      fn(sink)
    } catch (err) {
      this.opts.log.error(`Instance bridge callback failed: ${errorText(err)}`)
    }
  }

  private each(fn: (sink: SharedDiscordSink) => void) {
    for (const sink of Array.from(this.sinks)) this.call(sink, fn)
  }

  private buildIndex(): Map<string, SharedDiscordSink> {
    const index = new Map<string, SharedDiscordSink>()
    for (const sink of this.sinks) {
      const guildId = sink.guildId()
      if (!guildId) continue
      if (index.has(guildId)) {
        if (!this.duplicateWarned.has(guildId)) {
          this.duplicateWarned.add(guildId)
          this.opts.log.warn(`Two instance bridges claim Discord guild ${guildId}; events go to the first`)
        }
        continue
      }
      index.set(guildId, sink)
    }
    return index
  }

  /** Bridge linked to `guildId`, or null. */
  route(guildId: string | null | undefined): SharedDiscordSink | null {
    if (!guildId) return null
    if (!this.index) this.index = this.buildIndex()
    const hit = this.index.get(guildId)
    if (!hit) return null
    if (hit.guildId() === guildId) return hit
    this.index = this.buildIndex()
    return this.index.get(guildId) ?? null
  }

  private bindClient(client: DiscordClient, isCurrent: () => boolean) {
    const emitter = client as unknown as EventEmitter
    for (const [event, guildOf] of Object.entries(ROUTED_EVENTS)) {
      emitter.on(event, (...args: unknown[]) => {
        if (!isCurrent()) return
        let sink: SharedDiscordSink | null
        try {
          sink = this.route(guildOf(client, ...args))
        } catch {
          return
        }
        if (!sink) return
        try {
          sink.events.emit(event, ...args)
        } catch (err) {
          this.opts.log.error(`Instance bridge handler for ${event} failed: ${errorText(err)}`)
        }
      })
    }

    // majorParameter: guild id, channel id or webhook id of the route; webhook routes cannot be attributed.
    client.rest.on('rateLimited', (info) => {
      if (!isCurrent()) return
      const targets = info.global
        ? Array.from(this.sinks)
        : [this.route(info.majorParameter) ?? this.route(channelGuild(client, info.majorParameter))]
      for (const sink of targets) {
        if (sink) this.call(sink, s => { s.rest.emit('rateLimited', info) })
      }
    })

    this.each(s => s.bindClient(client))
  }
}
