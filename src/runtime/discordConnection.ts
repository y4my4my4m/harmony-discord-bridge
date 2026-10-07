import {
  Client as DiscordClient,
  Events,
  GatewayIntentBits,
  Partials,
  type ClientOptions,
} from 'discord.js'
import { Backoff, fetchWithRetry, type FetchLike } from '../http.js'
import { Logger, errorText } from '../log.js'
import { intentPortalHint, type PrivilegedIntent } from '../problems.js'

const DISCORD_API = 'https://discord.com/api/v10'

/**
 * Application flags (Discord API, Application Object → Application Flags).
 * The *_LIMITED bits mean the toggle is on for an unverified app under 100 guilds.
 */
export const APPLICATION_FLAGS = {
  GATEWAY_PRESENCE: 1 << 12,
  GATEWAY_PRESENCE_LIMITED: 1 << 13,
  GATEWAY_GUILD_MEMBERS: 1 << 14,
  GATEWAY_GUILD_MEMBERS_LIMITED: 1 << 15,
  GATEWAY_MESSAGE_CONTENT: 1 << 18,
  GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19,
} as const

/** Gateway close codes (Discord API, Opcodes and Status Codes). */
export const DISCORD_CLOSE = {
  AUTHENTICATION_FAILED: 4004,
  INVALID_INTENTS: 4013,
  DISALLOWED_INTENTS: 4014,
} as const

export type IntentGrants = Record<PrivilegedIntent, boolean>

export function grantsFromApplicationFlags(flags: number): IntentGrants {
  const has = (full: number, limited: number) => (flags & full) !== 0 || (flags & limited) !== 0
  return {
    message_content: has(APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT, APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED),
    members: has(APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS, APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS_LIMITED),
    presence: has(APPLICATION_FLAGS.GATEWAY_PRESENCE, APPLICATION_FLAGS.GATEWAY_PRESENCE_LIMITED),
  }
}

export interface IntentSelection {
  /** Bits passed to the discord.js client. */
  intents: GatewayIntentBits[]
  /** Privileged intents the settings ask for. */
  requested: PrivilegedIntent[]
  /** Requested privileged intents included in `intents`. */
  active: IntentGrants
  /** Requested privileged intents the application does not have. */
  missing: PrivilegedIntent[]
}

/**
 * Guilds + GuildMessages + MessageContent always; GuildMembers only with
 * sync_member_list, GuildPresences only with sync_presence. Presence data
 * arrives on member objects, so presence also needs the members intent.
 * GuildMessageReactions is unprivileged and always on.
 *
 * `grants` null means unknown: everything requested is attempted.
 * A requested intent the application lacks is left out and reported missing,
 * so the connection still comes up.
 */
export function selectIntents(
  settings: { syncMemberList: boolean; syncPresence: boolean },
  grants: IntentGrants | null,
): IntentSelection {
  const requested: PrivilegedIntent[] = ['message_content']
  if (settings.syncMemberList) requested.push('members')
  if (settings.syncPresence && settings.syncMemberList) requested.push('presence')

  const active: IntentGrants = { message_content: false, members: false, presence: false }
  const missing: PrivilegedIntent[] = []
  for (const intent of requested) {
    if (!grants || grants[intent]) active[intent] = true
    else missing.push(intent)
  }

  const intents: GatewayIntentBits[] = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ]
  if (active.message_content) intents.push(GatewayIntentBits.MessageContent)
  if (active.members) intents.push(GatewayIntentBits.GuildMembers)
  if (active.presence) intents.push(GatewayIntentBits.GuildPresences)

  return { intents, requested, active, missing }
}

export function sameIntents(a: GatewayIntentBits[], b: GatewayIntentBits[]): boolean {
  const sum = (xs: GatewayIntentBits[]) => xs.reduce((acc, x) => acc | x, 0)
  return sum(a) === sum(b)
}

export type PreflightResult =
  | {
      kind: 'ok'
      applicationId: string
      applicationName: string
      flags: number
      grants: IntentGrants
      botUser: { id: string; name: string; avatar: string | null } | null
    }
  | { kind: 'token_invalid' }
  | { kind: 'unreachable'; error: string }

/** GET /applications/@me with the bot token: validity, application id, intent toggles. */
export async function discordPreflight(token: string, fetchImpl?: FetchLike): Promise<PreflightResult> {
  if (!token.trim()) return { kind: 'token_invalid' }
  let res: Response
  try {
    res = await fetchWithRetry(`${DISCORD_API}/applications/@me`, {
      headers: { Authorization: `Bot ${token}` },
    }, { fetchImpl, attempts: 3, timeoutMs: 15_000 })
  } catch (err) {
    return { kind: 'unreachable', error: err instanceof Error ? err.message : String(err) }
  }
  if (res.status === 401 || res.status === 403) return { kind: 'token_invalid' }
  if (!res.ok) return { kind: 'unreachable', error: `HTTP ${res.status}` }

  const app = await res.json() as {
    id?: string
    name?: string
    flags?: number
    bot?: { id?: string; username?: string; avatar?: string | null }
  }
  const flags = Number(app.flags ?? 0)
  return {
    kind: 'ok',
    applicationId: String(app.id ?? ''),
    applicationName: String(app.name ?? ''),
    flags,
    grants: grantsFromApplicationFlags(flags),
    botUser: app.bot?.id
      ? { id: String(app.bot.id), name: String(app.bot.username ?? ''), avatar: app.bot.avatar ?? null }
      : null,
  }
}

export type DiscordFailure = 'token_invalid' | 'intents_disallowed' | 'intents_invalid'

/** Close codes discord.js does not recover from on its own. */
export function classifyDiscordClose(code: number): DiscordFailure | null {
  if (code === DISCORD_CLOSE.AUTHENTICATION_FAILED) return 'token_invalid'
  if (code === DISCORD_CLOSE.DISALLOWED_INTENTS) return 'intents_disallowed'
  if (code === DISCORD_CLOSE.INVALID_INTENTS) return 'intents_invalid'
  return null
}

/** discord.js login rejections. */
export function classifyLoginError(err: unknown): DiscordFailure | 'unreachable' {
  const code = (err as { code?: unknown })?.code
  const message = err instanceof Error ? err.message : String(err)
  if (code === 'TokenInvalid' || /invalid token/i.test(message)) return 'token_invalid'
  if (code === 'DisallowedIntents' || /disallowed intents/i.test(message)) return 'intents_disallowed'
  return 'unreachable'
}

export type DiscordConnState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'reconnecting'
  | 'token_invalid'
  | 'intents_disallowed'
  | 'unreachable'
  | 'stopped'

export interface DiscordApplication {
  id: string
  name: string
  grants: IntentGrants
  botUser: { id: string; name: string; avatar: string | null } | null
}

/** Privileged intents wanted, in bridge-settings terms (see selectIntents). */
export interface IntentNeeds {
  syncMemberList: boolean
  syncPresence: boolean
}

export interface DiscordConnectionListener {
  /** A new client exists, before login. `isCurrent` is false once it is replaced or stopped. */
  onClient(client: DiscordClient, isCurrent: () => boolean): void
  /** ClientReady of the current client. */
  onReady(client: DiscordClient): void
  onState(state: DiscordConnState): void
  /** The current client is about to be destroyed. */
  onTeardown(client: DiscordClient): void
}

export interface DiscordConnectionOptions {
  token: string
  log: Logger
  needs: () => IntentNeeds
  listener: DiscordConnectionListener
  /** Log line for a token rejection. */
  tokenHint: () => string
  fetchImpl?: FetchLike
  createClient?: (options: ClientOptions) => DiscordClient
}

const INTENT_RECHECK_MS = 5 * 60 * 1000

/**
 * One discord.js client for one bot token: preflight, intent selection,
 * login, close-code handling and backoff. A refused token or intent set is
 * a state with a retry timer, never a crash loop.
 */
export class DiscordConnection {
  client: DiscordClient | null = null
  state: DiscordConnState = 'idle'
  application: DiscordApplication | null = null
  selection: IntentSelection | null = null
  private token: string
  private generation = 0
  private retryTimer: NodeJS.Timeout | null = null
  private readonly backoff = new Backoff(30_000, 15 * 60_000)
  private recheckTimer: NodeJS.Timeout | null = null
  private lastFailureLogged = ''
  /** ClientReady seen for the current client. */
  private clientReady = false
  private stopped = false
  private readonly createClient: (options: ClientOptions) => DiscordClient

  constructor(private readonly opts: DiscordConnectionOptions) {
    this.token = opts.token
    this.createClient = opts.createClient ?? ((options) => new DiscordClient(options))
  }

  currentToken(): string {
    return this.token
  }

  isClientReady(): boolean {
    return this.client !== null && this.clientReady
  }

  /** Requested privileged intents Discord refused or the application lacks. */
  missingIntents(): PrivilegedIntent[] {
    if (this.state === 'intents_disallowed') return this.selection?.requested ?? ['message_content']
    return this.selection?.missing ?? []
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearRetry()
    if (this.recheckTimer) {
      clearInterval(this.recheckTimer)
      this.recheckTimer = null
    }
    await this.teardown()
    this.state = 'stopped'
  }

  /** New token; reconnects when `reconnect` is set. */
  async setToken(token: string, reconnect: boolean): Promise<void> {
    if (token === this.token) return
    this.token = token
    this.lastFailureLogged = ''
    this.backoff.reset()
    if (reconnect) await this.connect()
  }

  private clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private scheduleRetry() {
    if (this.stopped) return
    this.clearRetry()
    const delay = this.backoff.next()
    this.opts.log.debug(`Discord reconnect attempt in ${Math.round(delay / 1000)} s`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, delay)
  }

  /** Logs `line` once per distinct failure; later retries log at debug. */
  private logFailure(key: string, line: string) {
    if (this.lastFailureLogged === key) {
      this.opts.log.debug(line)
      return
    }
    this.lastFailureLogged = key
    this.opts.log.error(line)
  }

  private setState(state: DiscordConnState) {
    if (this.state === state) return
    this.state = state
    this.opts.listener.onState(state)
  }

  async connect(): Promise<void> {
    if (this.stopped) return
    this.clearRetry()
    await this.teardown()
    const generation = ++this.generation
    this.setState('connecting')

    const pre = await discordPreflight(this.token, this.opts.fetchImpl)
    if (generation !== this.generation || this.stopped) return

    if (pre.kind === 'token_invalid') {
      this.setState('token_invalid')
      this.logFailure('token', this.opts.tokenHint())
      this.scheduleRetry()
      return
    }
    if (pre.kind === 'unreachable') {
      this.setState('unreachable')
      this.logFailure('unreachable', `Cannot reach Discord (${pre.error}); retrying with backoff.`)
      this.scheduleRetry()
      return
    }

    this.application = { id: pre.applicationId, name: pre.applicationName, grants: pre.grants, botUser: pre.botUser }
    const selection = selectIntents(this.opts.needs(), pre.grants)
    this.selection = selection
    if (selection.missing.length > 0) {
      this.logFailure(`intents:${selection.missing.join(',')}`, intentPortalHint(selection.missing))
    }

    const client = this.createClient({
      intents: selection.intents,
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
      rest: { retries: 3 },
    })
    this.client = client
    this.clientReady = false
    this.attachConnectionHandlers(client, generation)
    this.opts.listener.onClient(client, () => generation === this.generation && !this.stopped)

    try {
      await client.login(this.token)
    } catch (err) {
      if (generation !== this.generation || this.stopped) return
      const failure = classifyLoginError(err)
      await this.teardown()
      if (failure === 'token_invalid') {
        this.setState('token_invalid')
        this.logFailure('token', this.opts.tokenHint())
      } else if (failure === 'intents_disallowed') {
        this.setState('intents_disallowed')
        this.logFailure(`disallowed:${selection.requested.join(',')}`, intentPortalHint(selection.requested))
      } else {
        this.setState('unreachable')
        this.logFailure('unreachable', `Discord login failed (${errorText(err)}); retrying with backoff.`)
      }
      this.scheduleRetry()
      return
    }

    this.ensureIntentRecheck()
  }

  /** Re-reads the application's intent toggles while some are missing; reconnects once they flip. */
  private ensureIntentRecheck() {
    if (this.recheckTimer) return
    this.recheckTimer = setInterval(() => {
      if (this.stopped || this.missingIntents().length === 0 || this.state !== 'ready') return
      void this.recheckIntents()
    }, INTENT_RECHECK_MS)
    this.recheckTimer.unref?.()
  }

  private async recheckIntents() {
    const pre = await discordPreflight(this.token, this.opts.fetchImpl)
    if (pre.kind !== 'ok' || this.stopped) return
    this.application = { id: pre.applicationId, name: pre.applicationName, grants: pre.grants, botUser: pre.botUser }
    const next = selectIntents(this.opts.needs(), pre.grants)
    if (this.selection && !sameIntents(next.intents, this.selection.intents)) {
      this.opts.log.info('Discord intent toggles changed; reconnecting with the new intent set')
      await this.connect()
    }
  }

  /** Needs changed: reconnects when the intent set differs. */
  async applyNeeds(): Promise<void> {
    const next = selectIntents(this.opts.needs(), this.application?.grants ?? null)
    const current = this.selection
    if (!current || !sameIntents(next.intents, current.intents)) {
      this.opts.log.info('The required Discord intent set changed; reconnecting')
      await this.connect()
      return
    }
    this.selection = next
    if (next.missing.length > 0) {
      this.logFailure(`intents:${next.missing.join(',')}`, intentPortalHint(next.missing))
    }
  }

  /** Destroys the current client; its in-flight login and events become stale. */
  private async teardown() {
    this.generation++
    const client = this.client
    if (!client) return
    this.client = null
    this.clientReady = false
    this.opts.listener.onTeardown(client)
    client.removeAllListeners()
    try {
      await client.destroy()
    } catch (err) {
      this.opts.log.debug('discord.js destroy failed:', errorText(err))
    }
  }

  private attachConnectionHandlers(client: DiscordClient, generation: number) {
    const current = () => generation === this.generation && !this.stopped

    client.on(Events.ClientReady, () => {
      if (!current()) return
      this.opts.log.info(`Discord bot connected: ${client.user?.tag} (${client.guilds.cache.size} guild(s))`)
      this.backoff.reset()
      this.lastFailureLogged = ''
      this.clientReady = true
      this.setState('ready')
      this.opts.listener.onReady(client)
    })

    client.on(Events.ShardDisconnect, (event) => {
      if (!current()) return
      const failure = classifyDiscordClose(event.code)
      if (!failure) {
        this.setState('reconnecting')
        return
      }
      if (failure === 'token_invalid') {
        this.setState('token_invalid')
        this.logFailure('token', this.opts.tokenHint())
      } else if (failure === 'intents_disallowed') {
        this.setState('intents_disallowed')
        const requested = this.selection?.requested ?? ['message_content']
        this.logFailure(`disallowed:${requested.join(',')}`, intentPortalHint(requested))
      } else {
        this.setState('unreachable')
        this.logFailure('invalid-intents', `Discord closed the connection with code ${event.code} (invalid intents)`)
      }
      void this.teardown().then(() => this.scheduleRetry())
    })

    client.on(Events.ShardReconnecting, () => {
      if (current()) this.setState('reconnecting')
    })
    client.on(Events.ShardResume, () => {
      if (current() && this.clientReady) this.setState('ready')
    })
    client.on(Events.ShardReady, () => {
      if (current() && this.clientReady) this.setState('ready')
    })
    client.on(Events.ShardError, (err) => {
      if (current()) this.opts.log.warn(`Discord connection error: ${errorText(err)}`)
    })
    client.on(Events.Error, (err) => {
      if (current()) this.opts.log.error('discord.js error:', errorText(err))
    })
  }
}
