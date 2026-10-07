import {
  Client as DiscordClient,
  Message as DiscordMessage,
  Webhook,
  TextChannel,
  Partials,
  GuildMember,
  Events,
  PermissionFlagsBits,
  ActivityType,
  type APIEmbed,
  type ClientOptions,
  type Interaction,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
  type PartialMessage,
} from 'discord.js'
import { HarmonyClient, HarmonyHttpError } from '../HarmonyClient.js'
import { MessageTranslator } from '../MessageTranslator.js'
import { PermissionSync } from '../PermissionSync.js'
import { PermissionSyncStore } from '../PermissionSyncStore.js'
import { BoundedMap } from '../utils/BoundedMap.js'
import {
  buildDiscordJumpLink,
  formatHarmonyReplyForDiscord,
  isDiscordUserAlreadyMentioned,
  parseDiscordJumpLink,
  stripDiscordJumpLinkLine,
  stripDiscordUserMentionPrefix,
} from '../utils/replyFormatter.js'
import { refreshDiscordAttachmentParts } from '../refreshAttachments.js'
import { splitDiscordContent } from '../utils/discordMessage.js'
import { buildHarmonyInviteDiscordEmbeds } from '../utils/harmonyInviteEmbeds.js'
import { shouldBridgeHarmonyMessageToDiscord } from '../utils/harmonyMessageFilter.js'
import { buildDiscordUserMetadata } from '../utils/discordUserMetadata.js'
import { buildDiscordReactionPayload, mergeReactionMetadata } from '../utils/discordReaction.js'
import { formatHarmonyDisplayNameForDiscord } from '../utils/discordDisplayName.js'
import { loadInstanceIcon } from '../utils/instanceIcon.js'
import { ReactionLedger } from '../utils/reactionLedger.js'
import { resolveDeliveryMode } from '../utils/deliveryMode.js'
import { Backoff, type FetchLike } from '../http.js'
import { Logger, errorText } from '../log.js'
import {
  intentPortalHint,
  type DiscordGuildView,
  type PrivilegedIntent,
  type Problem,
} from '../problems.js'
import { collectGuildViews } from '../v2/selfCheck.js'
import type { PairDirectory, PairWriter } from './PairDirectory.js'
import {
  classifyDiscordClose,
  classifyLoginError,
  discordPreflight,
  sameIntents,
  selectIntents,
  type IntentGrants,
  type IntentSelection,
} from './discordConnection.js'
import { handleInteraction, registerSlashCommands } from './commands.js'

export interface BridgedDiscordRoleInfo {
  id: string
  name: string
  color: string | null
  position: number
}

/** Discord member as sent to Harmony for the member sidebar and autosuggest. */
export interface CachedDiscordMember {
  guildId: string
  id: string
  username: string
  displayName: string
  avatarUrl: string
  bannerUrl: string | null
  accentColor: string | null
  harmonyRoleIds: string[]
  roles: BridgedDiscordRoleInfo[]
  joinedAt: string | null
  createdAt: string | null
  presenceStatus: 'online' | 'away' | 'busy' | 'offline'
  customStatus: { text: string; emoji: string | null } | null
}

export interface CachedHarmonyUser {
  id: string
  username: string
  displayName: string
  domain: string | null
  isLocal: boolean
  avatarUrl: string | null
}

export interface HarmonyChannelOption {
  id: string
  name: string
  category?: string | null
  type?: number | string
}

export interface RuntimeHooks {
  /** Current problems for `/bridge status` (v2). */
  problems?: () => Problem[]
  /** Harmony channels offered by `/bridge link` autocomplete (v2). */
  harmonyChannels?: () => HarmonyChannelOption[]
  /** Connection state, guild membership or channel layout changed. */
  onStateChange?: (reason: string) => void
  /** Pairs were written through PairWriter; the directory needs a reload. */
  afterPairsWritten?: () => Promise<void>
  /** Log line explaining a Harmony token rejection. */
  harmonyAuthHint?: string
  /** Log line explaining a Discord token rejection. */
  discordTokenHint?: string
}

export interface BridgeRuntimeOptions {
  mode: 'v1' | 'v2'
  directory: PairDirectory
  writer: PairWriter
  discordToken: string
  harmony: { token: string; gatewayUrl: string; apiUrl: string; baseUrl: string }
  permissionStorePath: string
  log: Logger
  hooks?: RuntimeHooks
  fetchImpl?: FetchLike
  /** Test seam for the discord.js client. */
  createDiscordClient?: (options: ClientOptions) => DiscordClient
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

/**
 * Message id mappings between Discord and Harmony, LRU-bounded. A dropped
 * mapping loses edit/delete/reaction bridging for that old message.
 */
const MESSAGE_MAPPING_CAP = 50_000
const HARMONY_USER_CACHE_REFRESH_MS = 5 * 60 * 1000
const INTENT_RECHECK_MS = 5 * 60 * 1000
/** rate_limited stays reported this long after the last drop. */
const RATE_LIMIT_PROBLEM_MS = 5 * 60 * 1000
/** A Discord REST wait longer than this counts as rate limiting worth reporting. */
const DISCORD_LONG_RATE_LIMIT_MS = 10_000

function memberCacheKey(guildId: string, username: string): string {
  return `${guildId}:${username.toLowerCase()}`
}

function isMissingPermission(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 50013
}

function isRateLimitError(err: unknown): boolean {
  if (err instanceof HarmonyHttpError) return err.status === 429
  const e = err as { status?: number; name?: string } | null
  return e?.status === 429 || e?.name === 'RateLimitError'
}

/**
 * One bridge: a discord.js client and a Harmony bot-gateway connection,
 * pairing channels from a PairDirectory. Several run side by side in host mode.
 */
export class BridgeRuntime {
  readonly mode: 'v1' | 'v2'
  readonly dir: PairDirectory
  readonly writer: PairWriter
  readonly harmony: HarmonyClient
  readonly translator: MessageTranslator
  readonly log: Logger
  readonly hooks: RuntimeHooks
  readonly permissionSyncStore: PermissionSyncStore
  readonly permissionSync: PermissionSync
  readonly harmonyBaseUrl: URL
  private readonly discordToken: string
  private readonly fetchImpl?: FetchLike
  private readonly createClient: (options: ClientOptions) => DiscordClient

  discord: DiscordClient | null = null
  private discordState: DiscordConnState = 'idle'
  private discordGeneration = 0
  private discordRetryTimer: NodeJS.Timeout | null = null
  private readonly discordBackoff = new Backoff(30_000, 15 * 60_000)
  private intentRecheckTimer: NodeJS.Timeout | null = null
  private application: { id: string; name: string; grants: IntentGrants; botUser: { id: string; name: string; avatar: string | null } | null } | null = null
  intentSelection: IntentSelection | null = null
  private lastDiscordFailureLogged = ''
  private discordStartupDone = false
  private readonly registeredCommandGuilds = new Set<string>()
  private stopped = false

  readonly discordToHarmonyMessages = new BoundedMap<string, string>(MESSAGE_MAPPING_CAP)
  readonly harmonyToDiscordMessages = new BoundedMap<string, string>(MESSAGE_MAPPING_CAP)
  /** Harmony message id → Discord copy sent via webhook (else bot send). */
  private readonly harmonyDiscordViaWebhook = new BoundedMap<string, boolean>(MESSAGE_MAPPING_CAP)
  /** Harmony message id → every Discord message id of a split message. */
  private readonly harmonyDiscordChunks = new BoundedMap<string, string[]>(MESSAGE_MAPPING_CAP)
  private readonly webhookCache = new Map<string, Webhook>()
  private readonly webhookPermissionWarned = new Set<string>()
  private instanceIcon: Promise<Buffer | null> | null = null

  /** lowercase `guildId:username` → Discord user id, for mention lookups. */
  private readonly discordMemberCache = new Map<string, string>()
  private readonly discordMemberDetails = new Map<string, CachedDiscordMember>()
  private readonly harmonyUserCacheByServer = new Map<string, Map<string, CachedHarmonyUser>>()
  private harmonyUserCacheTimer: NodeJS.Timeout | null = null

  private discordReady = false
  private harmonyReady = false
  private harmonyStartupDone = false
  private harmonyAuthLogged = false
  /** Socket errors since the last READY. */
  private harmonyUnreachable = false
  private bridgeDataRegisterTimer: NodeJS.Timeout | null = null
  private lastRegistrationSummary = ''
  /** Harmony messages not bridged while Discord was down, since the last ready. */
  private skippedWhileDiscordDown = 0
  private readonly recentlyRefreshedMessages = new Set<string>()

  private readonly reactionLedger = new ReactionLedger()

  private droppedMessages = 0
  private rateLimitedUntil = 0

  constructor(opts: BridgeRuntimeOptions) {
    this.mode = opts.mode
    this.dir = opts.directory
    this.writer = opts.writer
    this.log = opts.log
    this.hooks = opts.hooks ?? {}
    this.discordToken = opts.discordToken
    this.fetchImpl = opts.fetchImpl
    this.createClient = opts.createDiscordClient ?? ((options) => new DiscordClient(options))

    this.harmonyBaseUrl = new URL(opts.harmony.baseUrl)
    if (!this.harmonyBaseUrl.hostname || this.harmonyBaseUrl.hostname === 'localhost') {
      this.log.warn('Harmony base URL is localhost; federation mentions will use the localhost domain')
    }

    this.translator = new MessageTranslator(this.log)
    this.translator.setHarmonyDomain(this.harmonyBaseUrl.hostname)
    this.translator.setHarmonyMemberLookup((username, domain) => this.findHarmonyMember(username, domain))

    this.harmony = new HarmonyClient(opts.harmony.token, opts.harmony.gatewayUrl, opts.harmony.apiUrl, {
      log: this.log,
      fetchImpl: opts.fetchImpl,
      retry: { timeoutMs: 30_000 },
    })

    this.permissionSyncStore = new PermissionSyncStore(opts.permissionStorePath)
    this.permissionSync = new PermissionSync(this.harmony, this.dir, this.permissionSyncStore, this.log)

    this.attachHarmonyHandlers()
  }

  settings() {
    return this.dir.runtimeSettings()
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    this.stopped = false
    this.log.info(`Bridge starting: ${this.dir.getTotalMappingCount()} channel pair(s), ${this.dir.getBridges().length} guild scope(s)`)
    this.harmony.connect().catch(err => this.log.error('Harmony connect failed:', errorText(err)))
    await this.connectDiscord()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.discordState = 'stopped'
    this.clearDiscordRetry()
    if (this.intentRecheckTimer) {
      clearInterval(this.intentRecheckTimer)
      this.intentRecheckTimer = null
    }
    if (this.harmonyUserCacheTimer) {
      clearInterval(this.harmonyUserCacheTimer)
      this.harmonyUserCacheTimer = null
    }
    if (this.bridgeDataRegisterTimer) {
      clearTimeout(this.bridgeDataRegisterTimer)
      this.bridgeDataRegisterTimer = null
    }
    await this.teardownDiscord()
    this.harmony.disconnect()
    this.harmony.removeAllListeners()
  }

  isDiscordConnected(): boolean {
    return this.discordState === 'ready'
  }

  isHarmonyConnected(): boolean {
    return this.harmony.isConnected()
  }

  getDiscordState(): DiscordConnState {
    return this.discordState
  }

  private notify(reason: string) {
    try {
      this.hooks.onStateChange?.(reason)
    } catch (err) {
      this.log.error('State change hook failed:', errorText(err))
    }
  }

  /** Problems known from connection attempts, independent of guild layout. */
  connectionProblems(now = Date.now()): Problem[] {
    const problems: Problem[] = []
    if (this.discordState === 'token_invalid') problems.push({ code: 'discord_token_invalid' })
    if (this.discordState === 'unreachable') problems.push({ code: 'discord_unreachable' })
    for (const intent of this.missingIntents()) problems.push({ code: 'intent_missing', params: { intent } })
    if (this.harmony.isAuthRejected()) problems.push({ code: 'harmony_auth_failed' })
    else if (!this.harmony.isConnected() && this.harmonyUnreachable) problems.push({ code: 'harmony_unreachable' })
    if (now < this.rateLimitedUntil) problems.push({ code: 'rate_limited' })
    return problems
  }

  private missingIntents(): PrivilegedIntent[] {
    if (this.discordState === 'intents_disallowed') {
      return this.intentSelection?.requested ?? ['message_content']
    }
    return this.intentSelection?.missing ?? []
  }

  /** Guilds the bot is in, with per-channel permissions. Null while disconnected. */
  guildViews(): DiscordGuildView[] | null {
    if (!this.discord || this.discordState !== 'ready') return null
    return collectGuildViews(this.discord as unknown as Parameters<typeof collectGuildViews>[0])
  }

  discordIdentity(): {
    applicationId: string | null
    botUser: { id: string; name: string; avatar: string | null } | null
    intents: { message_content: boolean; members: boolean; presence: boolean }
  } {
    const user = this.discord?.user
    const grants = this.application?.grants
    const active = this.intentSelection?.active
    return {
      applicationId: this.discord?.application?.id ?? this.application?.id ?? null,
      botUser: user
        ? { id: user.id, name: user.username, avatar: user.displayAvatarURL({ size: 128 }) }
        : this.application?.botUser ?? null,
      intents: {
        message_content: grants?.message_content ?? active?.message_content ?? false,
        members: grants?.members ?? active?.members ?? false,
        presence: grants?.presence ?? active?.presence ?? false,
      },
    }
  }

  // ===========================================================================
  // Discord connection: preflight, intents, backoff
  // ===========================================================================

  private clearDiscordRetry() {
    if (this.discordRetryTimer) {
      clearTimeout(this.discordRetryTimer)
      this.discordRetryTimer = null
    }
  }

  private scheduleDiscordRetry() {
    if (this.stopped) return
    this.clearDiscordRetry()
    const delay = this.discordBackoff.next()
    this.log.debug(`Discord reconnect attempt in ${Math.round(delay / 1000)} s`)
    this.discordRetryTimer = setTimeout(() => {
      this.discordRetryTimer = null
      void this.connectDiscord()
    }, delay)
  }

  private discordTokenHint(): string {
    return this.hooks.discordTokenHint
      ?? 'Discord rejected the bot token (DISCORD_TOKEN). Reset it in the Discord Developer Portal → your app → Bot → Reset Token, then update DISCORD_TOKEN (retrying automatically).'
  }

  /** Logs `line` once per distinct failure; later retries log at debug. */
  private logDiscordFailure(key: string, line: string) {
    if (this.lastDiscordFailureLogged === key) {
      this.log.debug(line)
      return
    }
    this.lastDiscordFailureLogged = key
    this.log.error(line)
  }

  private setDiscordState(state: DiscordConnState) {
    if (this.discordState === state) return
    this.discordState = state
    this.notify(`discord:${state}`)
  }

  async connectDiscord(): Promise<void> {
    if (this.stopped) return
    this.clearDiscordRetry()
    await this.teardownDiscord()
    const generation = ++this.discordGeneration
    this.setDiscordState('connecting')

    const pre = await discordPreflight(this.discordToken, this.fetchImpl)
    if (generation !== this.discordGeneration || this.stopped) return

    if (pre.kind === 'token_invalid') {
      this.setDiscordState('token_invalid')
      this.logDiscordFailure('token', this.discordTokenHint())
      this.scheduleDiscordRetry()
      return
    }
    if (pre.kind === 'unreachable') {
      this.setDiscordState('unreachable')
      this.logDiscordFailure('unreachable', `Cannot reach Discord (${pre.error}); retrying with backoff.`)
      this.scheduleDiscordRetry()
      return
    }

    this.application = { id: pre.applicationId, name: pre.applicationName, grants: pre.grants, botUser: pre.botUser }
    const selection = selectIntents(this.settings(), pre.grants)
    this.intentSelection = selection
    if (selection.missing.length > 0) {
      this.logDiscordFailure(`intents:${selection.missing.join(',')}`, intentPortalHint(selection.missing))
    }

    const client = this.createClient({
      intents: selection.intents,
      partials: [Partials.Message, Partials.Channel, Partials.Reaction],
      rest: { retries: 3 },
    })
    this.discord = client
    this.discordStartupDone = false
    this.registeredCommandGuilds.clear()
    this.attachDiscordHandlers(client, generation)

    try {
      await client.login(this.discordToken)
    } catch (err) {
      if (generation !== this.discordGeneration || this.stopped) return
      const failure = classifyLoginError(err)
      await this.teardownDiscord()
      if (failure === 'token_invalid') {
        this.setDiscordState('token_invalid')
        this.logDiscordFailure('token', this.discordTokenHint())
      } else if (failure === 'intents_disallowed') {
        this.setDiscordState('intents_disallowed')
        this.logDiscordFailure(`disallowed:${selection.requested.join(',')}`, intentPortalHint(selection.requested))
      } else {
        this.setDiscordState('unreachable')
        this.logDiscordFailure('unreachable', `Discord login failed (${errorText(err)}); retrying with backoff.`)
      }
      this.scheduleDiscordRetry()
      return
    }

    this.ensureIntentRecheck()
  }

  /** Re-reads the application's intent toggles while some are missing; reconnects once they flip. */
  private ensureIntentRecheck() {
    if (this.intentRecheckTimer) return
    this.intentRecheckTimer = setInterval(() => {
      if (this.stopped || this.missingIntents().length === 0 || this.discordState !== 'ready') return
      void this.recheckIntents()
    }, INTENT_RECHECK_MS)
    this.intentRecheckTimer.unref?.()
  }

  private async recheckIntents() {
    const pre = await discordPreflight(this.discordToken, this.fetchImpl)
    if (pre.kind !== 'ok' || this.stopped) return
    this.application = { id: pre.applicationId, name: pre.applicationName, grants: pre.grants, botUser: pre.botUser }
    const next = selectIntents(this.settings(), pre.grants)
    if (this.intentSelection && !sameIntents(next.intents, this.intentSelection.intents)) {
      this.log.info('Discord intent toggles changed; reconnecting with the new intent set')
      await this.connectDiscord()
    }
  }

  /** Settings changed: reconnect when the intent set differs. */
  private async applyIntentSettings() {
    const next = selectIntents(this.settings(), this.application?.grants ?? null)
    const current = this.intentSelection
    if (!current || !sameIntents(next.intents, current.intents)) {
      this.log.info('Bridge settings need a different Discord intent set; reconnecting')
      await this.connectDiscord()
      return
    }
    this.intentSelection = next
    if (next.missing.length > 0) {
      this.logDiscordFailure(`intents:${next.missing.join(',')}`, intentPortalHint(next.missing))
    }
  }

  /** Destroys the current client; its in-flight login and events become stale. */
  private async teardownDiscord() {
    this.discordGeneration++
    const client = this.discord
    if (!client) return
    this.discord = null
    this.discordReady = false
    this.discordStartupDone = false
    this.permissionSync.detach()
    this.webhookCache.clear()
    client.removeAllListeners()
    try {
      await client.destroy()
    } catch (err) {
      this.log.debug('discord.js destroy failed:', errorText(err))
    }
  }

  requireDiscord(): DiscordClient {
    if (!this.discord) throw new Error('Discord is not connected')
    return this.discord
  }

  private attachDiscordHandlers(client: DiscordClient, generation: number) {
    const current = () => generation === this.discordGeneration && !this.stopped

    client.on(Events.ClientReady, () => {
      if (!current()) return
      void this.onDiscordReady(client)
    })

    client.on(Events.ShardDisconnect, (event) => {
      if (!current()) return
      const failure = classifyDiscordClose(event.code)
      if (!failure) {
        this.setDiscordState('reconnecting')
        return
      }
      if (failure === 'token_invalid') {
        this.setDiscordState('token_invalid')
        this.logDiscordFailure('token', this.discordTokenHint())
      } else if (failure === 'intents_disallowed') {
        this.setDiscordState('intents_disallowed')
        const requested = this.intentSelection?.requested ?? ['message_content']
        this.logDiscordFailure(`disallowed:${requested.join(',')}`, intentPortalHint(requested))
      } else {
        this.setDiscordState('unreachable')
        this.logDiscordFailure('invalid-intents', `Discord closed the connection with code ${event.code} (invalid intents)`)
      }
      void this.teardownDiscord().then(() => this.scheduleDiscordRetry())
    })

    client.on(Events.ShardReconnecting, () => {
      if (current()) this.setDiscordState('reconnecting')
    })
    client.on(Events.ShardResume, () => {
      if (current() && this.discordReady) this.setDiscordState('ready')
    })
    client.on(Events.ShardReady, () => {
      if (current() && this.discordReady) this.setDiscordState('ready')
    })
    client.on(Events.ShardError, (err) => {
      if (current()) this.log.warn(`Discord connection error: ${errorText(err)}`)
    })
    client.on(Events.Error, (err) => {
      if (current()) this.log.error('discord.js error:', errorText(err))
    })
    client.rest.on('rateLimited', (info) => {
      if (!current()) return
      this.log.debug(`Discord rate limit on ${info.route}: waiting ${info.timeToReset} ms`)
      if (info.timeToReset > DISCORD_LONG_RATE_LIMIT_MS) {
        this.rateLimitedUntil = Date.now() + RATE_LIMIT_PROBLEM_MS
      }
    })

    client.on(Events.MessageCreate, (msg) => { if (current()) void this.onDiscordMessage(msg) })
    client.on(Events.MessageReactionAdd, (reaction, user) => { if (current()) void this.onDiscordReactionAdd(reaction, user) })
    client.on(Events.MessageReactionRemove, (reaction, user) => { if (current()) void this.onDiscordReactionRemove(reaction, user) })
    client.on(Events.MessageUpdate, (_old, msg) => { if (current()) void this.onDiscordMessageUpdate(msg) })
    client.on(Events.MessageDelete, (msg) => { if (current()) void this.onDiscordMessageDelete(msg) })

    client.on(Events.GuildMemberAdd, (member) => {
      if (!current() || member.user.bot || !this.settings().syncMemberList) return
      if (!this.dir.isConfiguredDiscordGuild(member.guild.id)) return
      this.cacheMember(member)
      this.log.debug(`Member cache: added ${member.id}`)
      this.registerBridgeDataWithGateway()
    })

    client.on(Events.GuildMemberRemove, (member) => {
      if (!current()) return
      this.uncacheMemberById(member.id, member.user.username)
      this.log.debug(`Member cache: removed ${member.id}`)
      this.registerBridgeDataWithGateway()
    })

    client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
      if (!current() || newMember.user.bot || !this.settings().syncMemberList) return
      if (!this.dir.isConfiguredDiscordGuild(newMember.guild.id)) return

      const rolesChanged =
        oldMember.roles.cache.size !== newMember.roles.cache.size
        || !oldMember.roles.cache.equals(newMember.roles.cache)
      const profileChanged =
        oldMember.user.username !== newMember.user.username
        || oldMember.displayName !== newMember.displayName
        || oldMember.user.avatar !== newMember.user.avatar
        || oldMember.user.banner !== newMember.user.banner
        || oldMember.user.hexAccentColor !== newMember.user.hexAccentColor

      if (!rolesChanged && !profileChanged) return

      if (oldMember.user.username !== newMember.user.username) {
        this.uncacheMemberById(oldMember.id, oldMember.user.username)
      }
      this.cacheMember(newMember)
      this.registerBridgeDataWithGateway()
    })

    client.on(Events.PresenceUpdate, (_oldPresence, newPresence) => {
      if (!current() || !this.isSyncPresenceEnabled()) return
      const member = newPresence.member
      if (!member || member.user.bot) return
      if (!this.dir.isConfiguredDiscordGuild(member.guild.id)) return

      const cached = this.discordMemberDetails.get(member.id)
      if (!cached) {
        this.cacheMember(member)
      } else {
        const { presenceStatus, customStatus } = this.extractMemberPresence(member)
        this.discordMemberDetails.set(member.id, { ...cached, presenceStatus, customStatus })
      }
      this.scheduleBridgeDataRegistration()
    })

    client.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (!current()) return
      handleInteraction(this, interaction).catch(err => this.log.error('Interaction failed:', errorText(err)))
    })

    // Guild membership and channel layout feed the v2 self-check.
    client.on(Events.GuildCreate, (guild) => {
      if (!current()) return
      this.notify('guilds')
      if (this.commandGuildIds(client).includes(guild.id)) void this.registerCommandsFor(client, guild.id)
    })
    client.on(Events.GuildDelete, () => { if (current()) this.notify('guilds') })
    client.on(Events.ChannelCreate, () => { if (current()) this.notify('channels') })
    client.on(Events.ChannelDelete, () => { if (current()) this.notify('channels') })
    client.on(Events.ChannelUpdate, () => { if (current()) this.notify('channels') })
    client.on(Events.GuildRoleUpdate, () => { if (current()) this.notify('channels') })
    client.on(Events.GuildMemberUpdate, (_old, member) => {
      if (current() && member.id === client.user?.id) this.notify('channels')
    })
  }

  private async onDiscordReady(client: DiscordClient) {
    this.log.info(`Discord bot connected: ${client.user?.tag} (${client.guilds.cache.size} guild(s))`)
    this.discordBackoff.reset()
    this.lastDiscordFailureLogged = ''
    this.skippedWhileDiscordDown = 0
    this.discordReady = true
    this.setDiscordState('ready')

    // ClientReady can repeat after gateway reconnects; startup runs once per client.
    if (!this.discordStartupDone) {
      this.discordStartupDone = true

      for (const guildId of this.dir.getDiscordGuildIds()) {
        await this.runGuildStartup(client, guildId)
      }
      for (const guildId of this.commandGuildIds(client)) {
        await this.registerCommandsFor(client, guildId)
      }

      this.log.info(`Cached ${this.discordMemberDetails.size} Discord members for mention lookups`)

      await this.refreshHarmonyUserCache({ verbose: true })
      if (!this.harmonyUserCacheTimer) {
        this.harmonyUserCacheTimer = setInterval(
          () => { void this.refreshHarmonyUserCache({ verbose: false }) },
          HARMONY_USER_CACHE_REFRESH_MS,
        )
      }
    } else {
      this.log.debug('Discord gateway reconnected (startup already done)')
    }

    this.registerBridgeDataWithGateway()
    this.notify('discord:ready')
  }

  /**
   * Member cache, slash commands and permission sync for one bridged guild.
   * Each step fails on its own: a member fetch failure (e.g. Server Members
   * Intent off) leaves commands and permission sync intact.
   */
  private async runGuildStartup(client: DiscordClient, guildId: string) {
    let guild
    try {
      guild = await client.guilds.fetch(guildId)
    } catch (err) {
      this.log.error(`Cannot open Discord guild ${guildId}: ${errorText(err)}`)
      return
    }

    const settings = this.settings()
    if (settings.syncMemberList && this.intentSelection?.active.members) {
      try {
        this.log.info(`Fetching members for guild ${guild.name}`)
        const members = await guild.members.fetch({ withPresences: this.isSyncPresenceEnabled() })
        members.forEach(member => {
          if (!member.user.bot) this.cacheMember(member)
        })
      } catch (err) {
        this.log.warn(`Member fetch failed for ${guild.name}: ${errorText(err)}`)
      }
    }

    await this.registerCommandsFor(client, guild.id)

    if (settings.syncPermissions) {
      try {
        this.permissionSync.attach(client)
        await this.permissionSync.initialSync(guild)
      } catch (err) {
        this.log.error(`Permission sync initial reconcile failed for ${guild.name}: ${errorText(err)}`)
      }
    }
  }

  /** v1: configured guilds. v2: the selected guild, or every guild while none is selected. */
  private commandGuildIds(client: DiscordClient): string[] {
    const configured = this.dir.getDiscordGuildIds()
    if (this.mode === 'v1' || configured.length > 0) return configured
    return Array.from(client.guilds.cache.keys()).slice(0, 25)
  }

  private async registerCommandsFor(client: DiscordClient, guildId: string) {
    if (this.registeredCommandGuilds.has(guildId)) return
    try {
      await registerSlashCommands(this, client, guildId)
      this.registeredCommandGuilds.add(guildId)
    } catch (err) {
      this.log.error(`Slash command registration failed for guild ${guildId}: ${errorText(err)}`)
    }
  }

  /**
   * Directory contents changed (v1 YAML reload or edit, v2 /config change):
   * restore message mappings for newly paired Harmony channels, refresh guild
   * startup for a newly selected guild, reconnect when intents change.
   */
  async onDirectoryChanged(change: {
    pairsChanged?: boolean
    guildChanged?: boolean
    settingsChanged?: boolean
    addedHarmonyChannels?: string[]
  } = {}): Promise<void> {
    if (this.stopped) return

    if (change.settingsChanged) {
      const settings = this.settings()
      if (!settings.syncMemberList && this.discordMemberDetails.size > 0) {
        this.discordMemberDetails.clear()
        this.discordMemberCache.clear()
      }
      if (!settings.syncPermissions) this.permissionSync.detach()
      await this.applyIntentSettings()
    }

    const client = this.discord
    if (change.guildChanged && client && this.discordReady) {
      for (const guildId of this.dir.getDiscordGuildIds()) {
        await this.runGuildStartup(client, guildId)
      }
    } else if (change.settingsChanged && client && this.discordReady && this.settings().syncPermissions) {
      for (const guildId of this.dir.getDiscordGuildIds()) {
        const guild = client.guilds.cache.get(guildId)
        if (!guild) continue
        this.permissionSync.attach(client)
        await this.permissionSync.initialSync(guild).catch(err =>
          this.log.error(`Permission sync reconcile failed: ${errorText(err)}`))
      }
    }

    const added = change.addedHarmonyChannels
      ?? (change.pairsChanged === false ? [] : this.dir.getAllMappings().map(m => m.harmony))
    await this.restoreMappingsFor(added, 50)
    this.registerBridgeDataWithGateway()
  }

  private async restoreMappingsFor(harmonyChannelIds: string[], limit: number) {
    if (!this.harmonyReady) return
    for (const channelId of harmonyChannelIds) {
      try {
        const recent = await this.harmony.loadRecentMessages(channelId, limit)
        let restored = 0
        for (const m of recent) {
          if (m.metadata?.discord_message_id && m.id) {
            this.discordToHarmonyMessages.set(m.metadata.discord_message_id, m.id)
            this.harmonyToDiscordMessages.set(m.id, m.metadata.discord_message_id)
            restored++
          }
        }
        if (restored > 0) this.log.info(`Restored ${restored} message mappings for Harmony channel ${channelId}`)
      } catch (err) {
        this.log.error(`Failed to restore mappings for ${channelId}: ${errorText(err)}`)
      }
    }
  }

  // ===========================================================================
  // Discord member cache
  // ===========================================================================

  private mapMemberRoles(member: GuildMember): { harmonyRoleIds: string[]; roles: BridgedDiscordRoleInfo[] } {
    const harmonyRoleIds: string[] = []
    for (const role of member.roles.cache.values()) {
      const harmonyId =
        this.permissionSyncStore.getHarmonyRoleId(role.id)
        ?? (role.id === member.guild.id ? this.permissionSyncStore.getDefaultHarmonyRoleId() : undefined)
      if (harmonyId && !harmonyRoleIds.includes(harmonyId)) {
        harmonyRoleIds.push(harmonyId)
      }
    }

    const roles = member.roles.cache
      .filter(r => r.id !== member.guild.id)
      .sort((a, b) => b.position - a.position)
      .map(r => ({
        id: r.id,
        name: r.name,
        color: r.hexColor === '#000000' ? null : r.hexColor,
        position: r.position,
      }))

    return { harmonyRoleIds, roles }
  }

  private isSyncPresenceEnabled(): boolean {
    return this.settings().syncPresence && !!this.intentSelection?.active.presence
  }

  private extractMemberPresence(member: GuildMember): {
    presenceStatus: 'online' | 'away' | 'busy' | 'offline'
    customStatus: { text: string; emoji: string | null } | null
  } {
    if (!this.isSyncPresenceEnabled()) {
      return { presenceStatus: 'offline', customStatus: null }
    }

    const discordStatus = member.presence?.status ?? 'offline'
    let presenceStatus: 'online' | 'away' | 'busy' | 'offline'
    if (discordStatus === 'online') presenceStatus = 'online'
    else if (discordStatus === 'idle') presenceStatus = 'away'
    else if (discordStatus === 'dnd') presenceStatus = 'busy'
    else presenceStatus = 'offline'

    const customActivity = member.presence?.activities?.find(a => a.type === ActivityType.Custom)
    if (!customActivity) {
      return { presenceStatus, customStatus: null }
    }

    const text = customActivity.state?.trim() ?? ''
    const emoji = customActivity.emoji?.name ?? null
    if (!text && !emoji) {
      return { presenceStatus, customStatus: null }
    }
    return { presenceStatus, customStatus: { text, emoji } }
  }

  getDiscordMemberCacheForGuild(guildId: string): Map<string, string> {
    const scoped = new Map<string, string>()
    const prefix = `${guildId}:`
    for (const [key, value] of this.discordMemberCache.entries()) {
      if (key.startsWith(prefix)) {
        scoped.set(key.slice(prefix.length), value)
      }
    }
    return scoped
  }

  private cacheMember(member: GuildMember) {
    const guildId = member.guild.id
    this.discordMemberCache.set(memberCacheKey(guildId, member.user.username), member.id)

    const { harmonyRoleIds, roles } = this.mapMemberRoles(member)
    const { presenceStatus, customStatus } = this.extractMemberPresence(member)
    const bannerUrl = member.user.bannerURL({ size: 512 }) ?? null

    this.discordMemberDetails.set(member.id, {
      guildId,
      id: member.id,
      username: member.user.username,
      displayName: member.displayName || member.user.username,
      avatarUrl: member.user.displayAvatarURL({ size: 128 }),
      bannerUrl,
      accentColor: member.user.hexAccentColor ?? null,
      harmonyRoleIds,
      roles,
      joinedAt: member.joinedAt?.toISOString() ?? null,
      createdAt: member.user.createdAt.toISOString(),
      presenceStatus,
      customStatus,
    })
  }

  private uncacheMemberById(memberId: string, username: string) {
    const existing = this.discordMemberDetails.get(memberId)
    if (existing) {
      this.discordMemberCache.delete(memberCacheKey(existing.guildId, username))
    }
    this.discordMemberDetails.delete(memberId)
  }

  getCachedDiscordMember(memberId: string): CachedDiscordMember | undefined {
    return this.discordMemberDetails.get(memberId)
  }

  // ===========================================================================
  // Harmony user cache (Discord /mention autocomplete)
  // ===========================================================================

  /** Harmony server members for `/mention` autocomplete; startup, then every 5 minutes. */
  async refreshHarmonyUserCache(options: { verbose?: boolean } = {}) {
    const verbose = options.verbose ?? false
    const serverIds = this.dir.getHarmonyServerIds()
    if (serverIds.length === 0) {
      this.log.warn('No Harmony server configured; /mention autocomplete is empty')
      return
    }

    for (const serverId of serverIds) {
      const prevSize = this.harmonyUserCacheByServer.get(serverId)?.size ?? 0
      try {
        const members = await this.harmony.getServerMembers(serverId)
        const serverCache = new Map<string, CachedHarmonyUser>()

        for (const member of members) {
          if (member.user) {
            const username = member.user.username || 'unknown'
            serverCache.set(member.user.id, {
              id: member.user.id,
              username,
              displayName: formatHarmonyDisplayNameForDiscord(member.user.display_name, username),
              domain: member.user.domain ?? null,
              isLocal: member.user.is_local !== false,
              avatarUrl: member.user.avatar || null,
            })
          }
        }

        this.harmonyUserCacheByServer.set(serverId, serverCache)

        if (verbose || serverCache.size !== prevSize) {
          this.log.info(`Harmony user cache (${serverId.slice(0, 8)}…): ${serverCache.size} users`)
        }
      } catch (error) {
        this.log.error(`Failed to fetch Harmony users for ${serverId}: ${errorText(error)}`)
      }
    }
  }

  getHarmonyUserCacheForGuild(guildId: string): Map<string, CachedHarmonyUser> {
    const bridge = this.dir.getBridgeForDiscordGuild(guildId)
    const serverId = bridge?.harmonyServerId ?? (this.mode === 'v2' ? this.dir.getHarmonyServerIds()[0] : undefined)
    if (!serverId) return new Map()
    return this.harmonyUserCacheByServer.get(serverId) ?? new Map()
  }

  searchHarmonyUsers(query: string, guildId?: string): CachedHarmonyUser[] {
    const lowerQuery = query.toLowerCase()
    const results: CachedHarmonyUser[] = []
    const sources = guildId
      ? [this.getHarmonyUserCacheForGuild(guildId)]
      : Array.from(this.harmonyUserCacheByServer.values())

    for (const cache of sources) {
      for (const user of cache.values()) {
        const handle = (user.isLocal ? `@${user.username}` : `@${user.username}@${user.domain ?? ''}`).toLowerCase()
        if (
          user.username.toLowerCase().includes(lowerQuery) ||
          user.displayName.toLowerCase().includes(lowerQuery) ||
          handle.includes(lowerQuery) ||
          (user.domain && user.domain.toLowerCase().includes(lowerQuery))
        ) {
          results.push(user)
          if (results.length >= 25) break
        }
      }
      if (results.length >= 25) break
    }

    return results
  }

  private findHarmonyMember(username: string, domain: string | null = null): CachedHarmonyUser | null {
    const lowerUser = username.toLowerCase()
    for (const cache of this.harmonyUserCacheByServer.values()) {
      for (const user of cache.values()) {
        if (user.username.toLowerCase() !== lowerUser) continue
        if (domain) {
          if (user.domain?.toLowerCase() === domain.toLowerCase()) return user
          continue
        }
        if (user.isLocal) return user
      }
    }
    return null
  }

  harmonyUserToMentionPart(user: CachedHarmonyUser) {
    return {
      type: 'mention',
      userId: user.id,
      username: user.username,
      domain: user.domain || this.harmonyBaseUrl.hostname,
      isLocal: user.isLocal,
      displayName: user.displayName,
    }
  }

  // ===========================================================================
  // REGISTER_BRIDGE_DATA
  // ===========================================================================

  /** Sends pairs and Discord members to the gateway once both sides are ready. */
  registerBridgeDataWithGateway() {
    if (!this.discordReady || !this.harmonyReady) {
      this.log.debug(`Bridge data registration waiting: Discord=${this.discordReady}, Harmony=${this.harmonyReady}`)
      return
    }

    const syncMembers = this.settings().syncMemberList
    const channels = this.dir.getBridges().flatMap(bridge => {
      const members = !syncMembers ? [] : Array.from(this.discordMemberDetails.values())
        .filter(m => m.guildId === bridge.discordGuildId)
        .map(m => ({
          id: m.id,
          username: m.username,
          displayName: m.displayName,
          avatarUrl: m.avatarUrl,
          bannerUrl: m.bannerUrl,
          accentColor: m.accentColor,
          harmonyRoleIds: m.harmonyRoleIds,
          roles: m.roles,
          joinedAt: m.joinedAt,
          createdAt: m.createdAt,
          presenceStatus: m.presenceStatus,
          customStatus: m.customStatus,
          source: 'discord' as const,
        }))

      return bridge.channelMappings.map(mapping => ({
        harmonyChannelId: mapping.harmony,
        discordChannelId: mapping.discord,
        members,
      }))
    })

    const totalMembers = syncMembers ? this.discordMemberDetails.size : 0
    const summary = `Registering bridge data: ${channels.length} channel(s), ${totalMembers} Discord member(s)`
    if (summary !== this.lastRegistrationSummary) {
      this.lastRegistrationSummary = summary
      this.log.info(summary)
    } else {
      this.log.debug(summary)
    }
    for (const ch of channels) {
      this.log.debug(`  ${ch.harmonyChannelId} <-> Discord ${ch.discordChannelId}`)
    }

    this.harmony.registerBridgeData(channels)
  }

  /** Debounced; presence updates arrive in bursts. */
  private scheduleBridgeDataRegistration() {
    if (this.bridgeDataRegisterTimer) clearTimeout(this.bridgeDataRegisterTimer)
    this.bridgeDataRegisterTimer = setTimeout(() => {
      this.bridgeDataRegisterTimer = null
      this.registerBridgeDataWithGateway()
    }, 1500)
  }

  // ===========================================================================
  // Discord output: webhook puppeting, bot fallback, split messages
  // ===========================================================================

  private fetchInstanceIcon(): Promise<Buffer | null> {
    if (!this.instanceIcon) {
      this.instanceIcon = loadInstanceIcon(this.harmonyBaseUrl.href, this.fetchImpl).catch(() => null)
    }
    return this.instanceIcon
  }

  /** The channel's "Harmony Bridge" webhook, created on first use. Null without Manage Webhooks. */
  private async getOrCreateWebhook(channelId: string): Promise<Webhook | null> {
    try {
      const cached = this.webhookCache.get(channelId)
      if (cached) return cached

      const channel = await this.requireDiscord().channels.fetch(channelId) as TextChannel
      if (!channel || !channel.isTextBased()) {
        return null
      }

      const webhooks = await channel.fetchWebhooks()
      let webhook = webhooks.find(wh => wh.name === 'Harmony Bridge' && wh.token)

      if (!webhook) {
        this.log.info(`Creating webhook for channel ${channelId}`)
        const avatar = await this.fetchInstanceIcon()
        webhook = await channel.createWebhook({
          name: 'Harmony Bridge',
          ...(avatar ? { avatar } : {}),
        })
      }

      this.webhookCache.set(channelId, webhook)
      return webhook
    } catch (error) {
      if (isMissingPermission(error)) {
        if (!this.webhookPermissionWarned.has(channelId)) {
          this.webhookPermissionWarned.add(channelId)
          this.log.warn(
            `Channel ${channelId}: missing Manage Webhooks; Harmony → Discord posts as the bot (no author avatar/name). Grant Manage Webhooks to the bot on that channel.`,
          )
          this.notify('channels')
        }
        return null
      }
      this.log.error(`Failed to get/create webhook for ${channelId}: ${errorText(error)}`)
      return null
    }
  }

  private allowedMentions(mentionUserIds?: string[]) {
    return mentionUserIds && mentionUserIds.length > 0
      ? { parse: [] as const, users: mentionUserIds }
      : { parse: [] as const }
  }

  /** Posts a Harmony message: webhook first (author name/avatar), else as the bot. */
  private async sendHarmonyToDiscord(
    channel: TextChannel,
    opts: {
      content: string
      username: string
      avatarURL?: string
      mentionUserIds?: string[]
      embeds?: APIEmbed[]
    },
  ): Promise<{ discordMessageIds: string[]; viaWebhook: boolean } | null> {
    const me = channel.client.user
    const webhook = await this.getOrCreateWebhook(channel.id)
    const allowedMentions = this.allowedMentions(opts.mentionUserIds)
    const embeds = opts.embeds?.length ? opts.embeds.slice(0, 10) : undefined

    if (webhook) {
      const chunks = splitDiscordContent(opts.content)
      const ids: string[] = []
      for (let i = 0; i < chunks.length; i++) {
        const sent = await webhook.send({
          content: chunks[i],
          username: opts.username,
          avatarURL: opts.avatarURL,
          allowedMentions,
          embeds: i === chunks.length - 1 ? embeds : undefined,
        })
        if (sent?.id) ids.push(sent.id)
      }
      if (ids.length === 0) return null
      return { discordMessageIds: ids, viaWebhook: true }
    }

    if (!me) {
      this.log.error('Discord client not ready')
      return null
    }
    if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
      this.log.error(`Cannot send to #${channel.name} (${channel.id}): bot lacks Send Messages`)
      return null
    }

    const chunks = splitDiscordContent(`**${opts.username}**: ${opts.content}`)
    const ids: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const sent = await channel.send({
        content: chunks[i],
        allowedMentions,
        embeds: i === chunks.length - 1 ? embeds : undefined,
      })
      ids.push(sent.id)
    }
    return { discordMessageIds: ids, viaWebhook: false }
  }

  /**
   * Edits a bridged message; returns the Discord ids now holding it. Bot posts
   * are the bot's own messages and need no extra permission. Webhook posts
   * need the webhook (Manage Webhooks); Discord offers no other way to edit them.
   */
  private async editHarmonyOnDiscord(
    channel: TextChannel,
    discordMessageIds: string[],
    viaWebhook: boolean,
    content: string,
    author: { username: string; avatarURL?: string },
    mentionUserIds?: string[],
  ): Promise<string[]> {
    const allowedMentions = this.allowedMentions(mentionUserIds)

    if (viaWebhook) {
      const webhook = await this.getOrCreateWebhook(channel.id)
      if (!webhook) {
        throw new Error('Cannot edit a webhook post without Manage Webhooks on the channel')
      }
      const chunks = splitDiscordContent(content)
      const ids: string[] = []
      for (let i = 0; i < chunks.length; i++) {
        if (i < discordMessageIds.length) {
          await webhook.editMessage(discordMessageIds[i], { content: chunks[i], allowedMentions })
          ids.push(discordMessageIds[i])
        } else {
          const sent = await webhook.send({
            content: chunks[i],
            username: author.username,
            avatarURL: author.avatarURL,
            allowedMentions,
          })
          ids.push(sent.id)
        }
      }
      for (const surplus of discordMessageIds.slice(chunks.length)) {
        await webhook.deleteMessage(surplus).catch(() => {})
      }
      return ids
    }

    const chunks = splitDiscordContent(`**${author.username}**: ${content}`)
    const ids: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      if (i < discordMessageIds.length) {
        await channel.messages.edit(discordMessageIds[i], { content: chunks[i], allowedMentions })
        ids.push(discordMessageIds[i])
      } else {
        const sent = await channel.send({ content: chunks[i], allowedMentions })
        ids.push(sent.id)
      }
    }
    for (const surplus of discordMessageIds.slice(chunks.length)) {
      await channel.messages.delete(surplus).catch(() => {})
    }
    return ids
  }

  /**
   * Deletes a bridged message. Bot posts: own messages, no extra permission.
   * Webhook posts: through the webhook, else with Manage Messages.
   */
  private async deleteHarmonyOnDiscord(
    channel: TextChannel,
    discordMessageIds: string[],
    viaWebhook: boolean,
  ): Promise<void> {
    if (!viaWebhook) {
      for (const id of discordMessageIds) await channel.messages.delete(id)
      return
    }

    const webhook = await this.getOrCreateWebhook(channel.id)
    if (webhook) {
      for (const id of discordMessageIds) await webhook.deleteMessage(id)
      return
    }

    const me = channel.client.user
    if (me && channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
      for (const id of discordMessageIds) await channel.messages.delete(id)
      return
    }
    throw new Error('Cannot delete a webhook post: the bot needs Manage Webhooks (or Manage Messages) on the channel')
  }

  private deliveryModeFor(channel: TextChannel, harmonyMsg: any, discordMessageId: string): Promise<boolean | null> {
    return resolveDeliveryMode({
      cached: this.harmonyDiscordViaWebhook.get(harmonyMsg.id),
      metadata: harmonyMsg.metadata,
      botUserId: channel.client.user?.id,
      fetchDiscordMessage: () => channel.messages.fetch(discordMessageId),
    })
  }

  private chunkIdsFor(harmonyMsg: any, firstId: string): string[] {
    const known = this.harmonyDiscordChunks.get(harmonyMsg.id)
    if (known?.length) return known
    const recorded = harmonyMsg.metadata?.discord_message_ids
    if (Array.isArray(recorded) && recorded.length > 0 && recorded[0] === firstId) {
      return recorded.map(String)
    }
    return [firstId]
  }

  private noteDrop(direction: string, err: unknown) {
    if (!isRateLimitError(err)) return false
    this.droppedMessages++
    this.rateLimitedUntil = Date.now() + RATE_LIMIT_PROBLEM_MS
    this.log.warn(`Dropped a ${direction} message after rate-limit retries (${this.droppedMessages} dropped since start)`)
    this.notify('rate_limited')
    return true
  }

  // ===========================================================================
  // Replies
  // ===========================================================================

  /** Discord @mention for the parent author of a Harmony reply, unless already mentioned. */
  private async resolveReplyParentAuthorMention(
    harmonyParentId: string,
    parentDiscordMessageId: string,
    discordChannel: TextChannel,
    replyContent: string,
    replyContentRaw?: unknown[],
  ): Promise<{ mention: string | null; userId: string | null }> {
    let parent: any = null
    try {
      parent = await this.harmony.getMessage(harmonyParentId)
    } catch {
      // Best effort; the jump link works without a mention.
    }

    let discordUserId: string | null = null
    const usernames: string[] = []

    if (parent?.metadata?.discord_user?.id) {
      discordUserId = String(parent.metadata.discord_user.id)
      if (parent.metadata.discord_user.username) {
        usernames.push(parent.metadata.discord_user.username)
      }
    } else if (parent?.author?.username) {
      usernames.push(parent.author.username)
      if (parent.author.display_name) usernames.push(parent.author.display_name)
      const cached = this.discordMemberCache.get(memberCacheKey(discordChannel.guildId, parent.author.username))
      if (cached) discordUserId = cached
    }

    if (!discordUserId) {
      try {
        const dMsg = await discordChannel.messages.fetch(parentDiscordMessageId)
        if (!dMsg.webhookId) {
          discordUserId = dMsg.author.id
          usernames.push(dMsg.author.username, dMsg.author.displayName ?? '')
        }
      } catch {
        // Mention is optional.
      }
    }

    if (!discordUserId) return { mention: null, userId: null }

    if (isDiscordUserAlreadyMentioned(discordUserId, replyContent, replyContentRaw, usernames, parent?.author?.id)) {
      return { mention: null, userId: null }
    }

    return { mention: `<@${discordUserId}>`, userId: discordUserId }
  }

  /** Discord content for a Harmony message, with jump-link + mention reply formatting. */
  private async buildHarmonyOutboundDiscordContent(
    msg: any,
    discordChannel: TextChannel,
  ): Promise<{ content: string; mentionUserIds: string[] }> {
    const contentText = this.translator.harmonyToDiscord(
      msg,
      this.getDiscordMemberCacheForGuild(discordChannel.guildId),
    )
    if (!contentText || contentText.trim() === '') {
      return { content: contentText, mentionUserIds: [] }
    }

    if (!msg.reply_to || !discordChannel.guildId) {
      return { content: contentText, mentionUserIds: [] }
    }

    const parentDiscordId = await this.resolveParentDiscordId(msg.reply_to, msg.channel_id)
    if (!parentDiscordId) {
      this.log.debug(`Harmony reply parent ${msg.reply_to} has no Discord mapping; sending without reply link`)
      return { content: contentText, mentionUserIds: [] }
    }

    const jumpLink = buildDiscordJumpLink(discordChannel.guildId, discordChannel.id, parentDiscordId)
    const { mention, userId } = await this.resolveReplyParentAuthorMention(
      msg.reply_to,
      parentDiscordId,
      discordChannel,
      contentText,
      msg.content_raw,
    )

    return {
      content: formatHarmonyReplyForDiscord(jumpLink, mention, contentText),
      mentionUserIds: userId ? [userId] : [],
    }
  }

  /** Harmony reply parent → Discord message id (memory, then metadata, then recent scan). */
  private async resolveParentDiscordId(harmonyReplyToId: string, harmonyChannelId: string): Promise<string | null> {
    const mapped = this.harmonyToDiscordMessages.get(harmonyReplyToId)
    if (mapped) return mapped

    try {
      const parent = await this.harmony.getMessage(harmonyReplyToId)
      const discordId = parent?.metadata?.discord_message_id
      if (discordId && parent?.id) {
        this.discordToHarmonyMessages.set(discordId, parent.id)
        this.harmonyToDiscordMessages.set(parent.id, discordId)
        return discordId
      }
    } catch (err) {
      this.log.debug(`getMessage failed for reply parent ${harmonyReplyToId}: ${errorText(err)}`)
    }

    try {
      const recent = await this.harmony.loadRecentMessages(harmonyChannelId, 100)
      const found = recent.find(m => m.id === harmonyReplyToId && m.metadata?.discord_message_id)
      if (found?.metadata?.discord_message_id) {
        const discordId = found.metadata.discord_message_id
        this.discordToHarmonyMessages.set(discordId, found.id)
        this.harmonyToDiscordMessages.set(found.id, discordId)
        return discordId
      }
    } catch (err) {
      this.log.debug(`Recent message scan failed for reply parent ${harmonyReplyToId}: ${errorText(err)}`)
    }

    return null
  }

  /** Discord reply parent → Harmony message id (memory, then lookup, then recent scan). */
  private async resolveParentHarmonyId(discordParentId: string, harmonyChannelId: string): Promise<string | null> {
    const mapped = this.discordToHarmonyMessages.get(discordParentId)
    if (mapped) return mapped

    try {
      const parent = await this.harmony.lookupMessageByDiscordId(harmonyChannelId, discordParentId)
      if (parent?.id) {
        this.discordToHarmonyMessages.set(discordParentId, parent.id)
        this.harmonyToDiscordMessages.set(parent.id, discordParentId)
        return parent.id
      }
    } catch {
      // Fall through to the recent scan.
    }

    try {
      const recent = await this.harmony.loadRecentMessages(harmonyChannelId, 100)
      const found = recent.find(m => m.metadata?.discord_message_id === discordParentId)
      if (found?.id) {
        this.discordToHarmonyMessages.set(discordParentId, found.id)
        this.harmonyToDiscordMessages.set(found.id, discordParentId)
        return found.id
      }
    } catch (err) {
      this.log.debug(`Recent message scan failed for Discord reply parent ${discordParentId}: ${errorText(err)}`)
    }

    return null
  }

  /**
   * Harmony reply_to from a Discord reply (native reference or jump-link
   * prefix); strips the bridge's reply formatting from the content.
   */
  private async resolveDiscordReplyToHarmony(
    msg: DiscordMessage,
    harmonyChannelId: string,
  ): Promise<{ replyTo: string | null; cleanedContent: string }> {
    let content = msg.content ?? ''
    let discordParentId = msg.reference?.messageId ?? null

    if (!discordParentId) {
      const parsed = parseDiscordJumpLink(content)
      if (parsed) {
        discordParentId = parsed.messageId
        content = content.slice(parsed.consumedLength).trimStart()
      }
    }

    if (!discordParentId) {
      return { replyTo: null, cleanedContent: content }
    }

    const replyTo = await this.resolveParentHarmonyId(discordParentId, harmonyChannelId)
    if (!replyTo) {
      this.log.debug(`Discord reply parent ${discordParentId} not mapped; sending as plain message`)
      return { replyTo: null, cleanedContent: content }
    }

    content = stripDiscordJumpLinkLine(content)

    const repliedUserId = msg.mentions.repliedUser?.id
    if (repliedUserId) {
      content = stripDiscordUserMentionPrefix(content, repliedUserId)
    }

    return { replyTo, cleanedContent: content }
  }

  // ===========================================================================
  // Discord → Harmony
  // ===========================================================================

  private async onDiscordMessage(msg: DiscordMessage) {
    if (msg.author.bot) return

    if (msg.partial) {
      try {
        msg = await msg.fetch()
      } catch (err) {
        this.log.warn(`Failed to fetch partial Discord message: ${errorText(err)}`)
        return
      }
    }

    const harmonyChannelId = this.dir.getHarmonyChannel(msg.channelId)
    if (!harmonyChannelId) return
    if (!this.dir.shouldBridgeFromDiscord(msg.channelId)) return

    // Without the Message Content intent Discord delivers empty messages.
    if (!this.intentSelection?.active.message_content && !msg.content && msg.attachments.size === 0) {
      this.log.debug(`Skipping Discord message ${msg.id}: no content (Message Content Intent off)`)
      return
    }

    try {
      const { replyTo, cleanedContent } = await this.resolveDiscordReplyToHarmony(msg, harmonyChannelId)

      // Guild member carries the server nickname.
      let guildMember = msg.member
      if (!guildMember && msg.guild) {
        guildMember = msg.guild.members.cache.get(msg.author.id)
          ?? await msg.guild.members.fetch(msg.author.id).catch(() => null)
      }

      // Attachment storage policy (link/refresh/mirror) is applied by the bot-gateway.
      const contentParts = this.translator.discordToHarmonyParts({
        ...msg,
        content: cleanedContent,
      })

      const metadata = {
        ...buildDiscordUserMetadata(
          msg.author,
          guildMember,
          this.discordMemberDetails.get(msg.author.id),
        ),
        discord_message_id: msg.id,
      }

      const result = await this.harmony.sendMessage(harmonyChannelId, contentParts, metadata, replyTo)

      // The gateway returns the message at top level (BotRestAPI.formatMessage).
      const harmonyMessageId = result?.id ?? result?.message?.id
      if (harmonyMessageId) {
        this.discordToHarmonyMessages.set(msg.id, harmonyMessageId)
        this.harmonyToDiscordMessages.set(harmonyMessageId, msg.id)
      } else {
        this.log.warn(`Bridged message returned no id; reaction/edit/delete sync skipped for Discord ${msg.id}`)
      }

      this.log.info(`Discord → Harmony: ${msg.id} → ${harmonyMessageId ?? '?'} (channel ${msg.channelId})`)
    } catch (error) {
      if (!this.noteDrop('Discord → Harmony', error)) {
        this.log.error(`Failed to bridge Discord → Harmony (${msg.id}): ${errorText(error)}`)
      }
    }
  }

  private discordReactionIdentifier(reaction: MessageReaction | PartialMessageReaction): {
    identifier: string | null
    metadata: Record<string, unknown>
  } {
    if (reaction.emoji.id) {
      const payload = buildDiscordReactionPayload(
        reaction.emoji.name || 'unknown',
        reaction.emoji.id,
        reaction.emoji.animated || false,
      )
      return { identifier: payload.identifier, metadata: payload.metadata }
    }
    return { identifier: reaction.emoji.name || null, metadata: {} }
  }

  private async onDiscordReactionAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    if (user.bot) return

    if (reaction.partial) {
      try {
        await reaction.fetch()
      } catch (error) {
        this.log.warn(`Failed to fetch reaction: ${errorText(error)}`)
        return
      }
    }

    const harmonyChannelId = this.dir.getHarmonyChannel(reaction.message.channelId)
    if (!harmonyChannelId) return
    if (!this.dir.shouldBridgeFromDiscord(reaction.message.channelId)) return
    if (!this.settings().syncReactions) return

    try {
      const harmonyMessageId = this.discordToHarmonyMessages.get(reaction.message.id)
      if (!harmonyMessageId) {
        this.log.debug(`No message mapping for Discord message ${reaction.message.id}`)
        return
      }

      const { identifier, metadata: emojiMetadata } = this.discordReactionIdentifier(reaction)
      if (!identifier) {
        this.log.warn('Could not determine emoji identifier for Discord reaction')
        return
      }

      let reactionMember = reaction.message.guild?.members.cache.get(user.id) ?? null
      if (!reactionMember && reaction.message.guild) {
        reactionMember = await reaction.message.guild.members.fetch(user.id).catch(() => null)
      }
      const reactionMetadata = mergeReactionMetadata(
        buildDiscordUserMetadata(user as User, reactionMember, this.discordMemberDetails.get(user.id)),
        emojiMetadata,
      )

      await this.harmony.addReaction(harmonyChannelId, harmonyMessageId, identifier, reactionMetadata)
      this.log.debug(`Discord → Harmony reaction on ${harmonyMessageId}`)
    } catch (error) {
      if (!this.noteDrop('Discord → Harmony reaction', error)) {
        this.log.error(`Failed to bridge reaction Discord → Harmony: ${errorText(error)}`)
      }
    }
  }

  private async onDiscordReactionRemove(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) {
    if (user.bot) return

    if (reaction.partial) {
      try {
        await reaction.fetch()
      } catch (error) {
        this.log.warn(`Failed to fetch reaction: ${errorText(error)}`)
        return
      }
    }

    const harmonyChannelId = this.dir.getHarmonyChannel(reaction.message.channelId)
    if (!harmonyChannelId) return
    if (!this.dir.shouldBridgeFromDiscord(reaction.message.channelId)) return
    if (!this.settings().syncReactions) return

    try {
      const harmonyMessageId = this.discordToHarmonyMessages.get(reaction.message.id)
      if (!harmonyMessageId) {
        this.log.debug(`No message mapping for Discord message ${reaction.message.id}`)
        return
      }

      const { identifier } = this.discordReactionIdentifier(reaction)
      if (!identifier) {
        this.log.warn('Could not determine emoji identifier for Discord reaction')
        return
      }

      // Scoped to this Discord user.
      await this.harmony.removeReaction(harmonyChannelId, harmonyMessageId, identifier, user.id)
      this.log.debug(`Discord → Harmony reaction removed on ${harmonyMessageId}`)
    } catch (error) {
      if (!this.noteDrop('Discord → Harmony reaction', error)) {
        this.log.error(`Failed to bridge reaction removal Discord → Harmony: ${errorText(error)}`)
      }
    }
  }

  private async onDiscordMessageUpdate(newMsg: DiscordMessage | PartialMessage) {
    if (!this.settings().syncEdits) return
    if (!newMsg.author || newMsg.author.bot) return

    const harmonyChannelId = this.dir.getHarmonyChannel(newMsg.channelId)
    if (!harmonyChannelId || !this.dir.shouldBridgeFromDiscord(newMsg.channelId)) return

    try {
      const harmonyMessageId = this.discordToHarmonyMessages.get(newMsg.id)
      if (!harmonyMessageId) {
        this.log.debug(`No message mapping for Discord message ${newMsg.id}`)
        return
      }

      const contentParts = this.translator.discordToHarmonyParts(newMsg)
      await this.harmony.editMessage(harmonyMessageId, contentParts)
      this.log.info(`Discord → Harmony edit: ${newMsg.id} → ${harmonyMessageId}`)
    } catch (error) {
      if (!this.noteDrop('Discord → Harmony edit', error)) {
        this.log.error(`Failed to bridge edit Discord → Harmony: ${errorText(error)}`)
      }
    }
  }

  private async onDiscordMessageDelete(msg: DiscordMessage | PartialMessage) {
    if (!this.settings().syncDeletes) return
    if (msg.author?.bot) return

    const harmonyChannelId = this.dir.getHarmonyChannel(msg.channelId)
    if (!harmonyChannelId || !this.dir.shouldBridgeFromDiscord(msg.channelId)) return

    try {
      const harmonyMessageId = this.discordToHarmonyMessages.get(msg.id)
      if (!harmonyMessageId) {
        this.log.debug(`No message mapping for Discord message ${msg.id}`)
        return
      }

      await this.harmony.deleteMessage(harmonyMessageId)
      this.log.info(`Discord → Harmony delete: ${msg.id} → ${harmonyMessageId}`)

      this.discordToHarmonyMessages.delete(msg.id)
      this.harmonyToDiscordMessages.delete(harmonyMessageId)
    } catch (error) {
      if (!this.noteDrop('Discord → Harmony delete', error)) {
        this.log.error(`Failed to bridge delete Discord → Harmony: ${errorText(error)}`)
      }
    }
  }

  // ===========================================================================
  // Harmony → Discord
  // ===========================================================================

  private attachHarmonyHandlers() {
    const h = this.harmony

    h.on('ready', (data: any) => { void this.onHarmonyReady(data) })
    h.on('connectionState', () => this.notify('harmony'))
    h.on('unreachable', () => {
      this.harmonyUnreachable = true
      this.notify('harmony')
    })
    h.on('authFailed', () => {
      if (!this.harmonyAuthLogged) {
        this.harmonyAuthLogged = true
        this.log.error(this.hooks.harmonyAuthHint ?? 'Harmony rejected the bot token.')
      }
      this.notify('harmony')
    })
    h.on('rateLimited', () => {
      this.log.debug('Harmony rate limit hit; waiting as instructed')
    })
    h.on('messageCreate', (msg: any) => { void this.onHarmonyMessageCreate(msg) })
    h.on('messageUpdate', (msg: any) => { void this.onHarmonyMessageUpdate(msg) })
    h.on('messageDelete', (msg: any) => { void this.onHarmonyMessageDelete(msg) })
    h.on('refreshAttachments', (data: any) => { void this.onRefreshAttachments(data) })
    h.on('reactionAdd', (data: any) => { void this.onHarmonyReactionAdd(data) })
    h.on('reactionRemove', (data: any) => { void this.onHarmonyReactionRemove(data) })
  }

  private async onHarmonyReady(data: any) {
    this.log.info(`Harmony bot connected: ${data.bot?.username} (${data.bot?.id})`)
    ;(this.harmony as any).botId = data.bot?.id
    this.harmonyUnreachable = false
    this.harmonyAuthLogged = false
    this.harmonyReady = true

    // READY repeats on every gateway reconnect; mappings restore once.
    if (!this.harmonyStartupDone) {
      this.harmonyStartupDone = true
      await this.restoreMappingsFor(this.dir.getAllMappings().map(m => m.harmony), 100)
    } else {
      this.log.debug('Harmony gateway reconnected (mappings already restored)')
    }

    this.registerBridgeDataWithGateway()
    this.notify('harmony:ready')
  }

  private async onHarmonyMessageCreate(msg: any) {
    this.log.debug('Harmony message:', {
      id: msg.id,
      author: msg.author?.id,
      isBot: msg.author?.bot,
      bridge_source: msg.metadata?.bridge_source,
      reply_to: msg.reply_to,
      channelId: msg.channel_id,
      content: msg.content,
      content_raw: msg.content_raw,
    })

    if (msg.metadata?.discord_message_id && msg.id) {
      const discordMsgId = msg.metadata.discord_message_id
      this.discordToHarmonyMessages.set(discordMsgId, msg.id)
      this.harmonyToDiscordMessages.set(msg.id, discordMsgId)
    }

    // Loop guards: Discord-originated, own, and other bots' messages.
    if (msg.metadata?.bridge_source === 'discord') return
    const botId = (this.harmony as any).botId
    if (msg.author?.id === botId) return
    if (msg.author?.bot && !msg.author?.discord_user) return

    if (!shouldBridgeHarmonyMessageToDiscord(msg)) return

    const discordChannelId = this.dir.getDiscordChannel(msg.channel_id)
    if (!discordChannelId) return
    if (!this.dir.shouldBridgeFromHarmony(msg.channel_id)) return

    const client = this.discord
    if (!client || !this.discordReady) {
      this.skippedWhileDiscordDown++
      const line = `Harmony message ${msg.id} not bridged: Discord is not connected (${this.skippedWhileDiscordDown} skipped)`
      if (this.skippedWhileDiscordDown === 1 || this.skippedWhileDiscordDown % 50 === 0) this.log.warn(line)
      else this.log.debug(line)
      return
    }

    try {
      const discordChannel = await client.channels.fetch(discordChannelId) as TextChannel
      if (!discordChannel || !discordChannel.guild) {
        this.log.error(`Discord channel ${discordChannelId} not found or not in a guild`)
        return
      }

      const username = formatHarmonyDisplayNameForDiscord(msg.author?.display_name, msg.author?.username)
      const avatarURL = msg.author?.avatar?.startsWith('http://localhost') ? undefined : msg.author?.avatar

      const outboundContent = await this.buildHarmonyOutboundDiscordContent(msg, discordChannel)
      if (!outboundContent.content || outboundContent.content.trim() === '') {
        this.log.warn(`Harmony message ${msg.id} is empty after translation; not sent`)
        return
      }

      const inviteEmbeds = await buildHarmonyInviteDiscordEmbeds(msg, this.harmony, this.harmonyBaseUrl.hostname)

      const outbound = await this.sendHarmonyToDiscord(discordChannel, {
        content: outboundContent.content,
        username,
        avatarURL,
        mentionUserIds: outboundContent.mentionUserIds,
        embeds: inviteEmbeds,
      })

      if (!outbound) {
        this.log.error(`Could not send Harmony message ${msg.id} to Discord`)
        return
      }

      const [firstId] = outbound.discordMessageIds
      if (msg.id) {
        this.harmonyToDiscordMessages.set(msg.id, firstId)
        for (const id of outbound.discordMessageIds) this.discordToHarmonyMessages.set(id, msg.id)
        this.harmonyDiscordViaWebhook.set(msg.id, outbound.viaWebhook)
        if (outbound.discordMessageIds.length > 1) this.harmonyDiscordChunks.set(msg.id, outbound.discordMessageIds)

        // Persisted so replies, edits and deletes survive restarts.
        try {
          await this.harmony.mergeMessageMetadata(msg.id, {
            discord_message_id: firstId,
            ...(outbound.discordMessageIds.length > 1 ? { discord_message_ids: outbound.discordMessageIds } : {}),
            discord_via_webhook: outbound.viaWebhook,
            bridge_source: 'harmony',
          })
        } catch (err) {
          this.log.warn(`Failed to persist Discord ids on Harmony message ${msg.id}: ${errorText(err)}`)
        }
      }

      this.log.info(
        `Harmony → Discord (${outbound.viaWebhook ? 'webhook' : 'bot'}): ${msg.id} → ${outbound.discordMessageIds.join(',')} (channel ${discordChannelId})`,
      )
    } catch (error) {
      if (!this.noteDrop('Harmony → Discord', error)) {
        this.log.error(`Failed to bridge Harmony → Discord (${msg.id}): ${errorText(error)}`)
      }
    }
  }

  /** v1 always bridged Harmony edits/deletes/reactions to Discord; v2 follows the settings. */
  private harmonyToDiscordEnabled(kind: 'edits' | 'deletes' | 'reactions'): boolean {
    if (this.mode === 'v1') return true
    const s = this.settings()
    return kind === 'edits' ? s.syncEdits : kind === 'deletes' ? s.syncDeletes : s.syncReactions
  }

  private async onHarmonyMessageUpdate(msg: any) {
    this.log.debug('Harmony message updated:', {
      id: msg.id,
      channel_id: msg.channel_id,
      content: msg.content,
      mappingExists: this.harmonyToDiscordMessages.has(msg.id),
    })

    if (!this.harmonyToDiscordEnabled('edits')) return
    if (msg.metadata?.bridge_source === 'discord') return
    if (!shouldBridgeHarmonyMessageToDiscord(msg)) return

    // "[deleted]" edits precede MESSAGE_DELETE.
    const contentText = msg.content || ''
    const contentRaw = msg.content_raw || []
    const isDeleted = contentText === '[deleted]' ||
      (Array.isArray(contentRaw) && contentRaw.length === 1 && contentRaw[0]?.text === '[deleted]')
    if (isDeleted) return

    const discordMessageId = this.harmonyToDiscordMessages.get(msg.id)
      ?? (msg.metadata?.bridge_source === 'harmony' ? msg.metadata?.discord_message_id : undefined)
    if (!discordMessageId) {
      this.log.debug(`No Discord mapping for Harmony message ${msg.id}`)
      return
    }

    const discordChannelId = this.dir.getDiscordChannel(msg.channel_id)
    if (!discordChannelId || !this.dir.shouldBridgeFromHarmony(msg.channel_id)) return

    const client = this.discord
    if (!client || !this.discordReady) return

    try {
      const discordChannel = await client.channels.fetch(discordChannelId) as TextChannel
      if (!discordChannel) {
        this.log.error(`Discord channel ${discordChannelId} not found`)
        return
      }

      const viaWebhook = await this.deliveryModeFor(discordChannel, msg, discordMessageId)
      if (viaWebhook === null) {
        this.log.warn(`Harmony edit ${msg.id}: Discord copy ${discordMessageId} is gone or unreadable; not edited`)
        return
      }

      const outboundContent = await this.buildHarmonyOutboundDiscordContent(msg, discordChannel)
      const username = formatHarmonyDisplayNameForDiscord(msg.author?.display_name, msg.author?.username)
      const avatarURL = msg.author?.avatar?.startsWith('http://localhost') ? undefined : msg.author?.avatar

      const before = this.chunkIdsFor(msg, discordMessageId)
      const after = await this.editHarmonyOnDiscord(
        discordChannel,
        before,
        viaWebhook,
        outboundContent.content,
        { username, avatarURL },
        outboundContent.mentionUserIds,
      )
      this.harmonyDiscordViaWebhook.set(msg.id, viaWebhook)
      for (const id of after) this.discordToHarmonyMessages.set(id, msg.id)
      if (after.length > 1) this.harmonyDiscordChunks.set(msg.id, after)
      else this.harmonyDiscordChunks.delete(msg.id)
      if (after.join(',') !== before.join(',')) {
        await this.harmony.mergeMessageMetadata(msg.id, { discord_message_ids: after }).catch(() => {})
      }

      this.log.info(`Harmony → Discord edit: ${msg.id} → ${discordMessageId}`)
    } catch (error) {
      if (!this.noteDrop('Harmony → Discord edit', error)) {
        this.log.error(`Failed to bridge edit Harmony → Discord (${msg.id}): ${errorText(error)}`)
      }
    }
  }

  private async onHarmonyMessageDelete(msg: any) {
    this.log.debug('Harmony message deleted:', { id: msg.id, channel_id: msg.channel_id })

    if (!this.harmonyToDiscordEnabled('deletes')) return
    if (msg.metadata?.bridge_source === 'discord') return

    const discordMessageId = this.harmonyToDiscordMessages.get(msg.id)
      ?? (msg.metadata?.bridge_source === 'harmony' ? msg.metadata?.discord_message_id : undefined)
    if (!discordMessageId) {
      this.log.debug(`No Discord mapping for Harmony message ${msg.id}`)
      return
    }

    const discordChannelId = this.dir.getDiscordChannel(msg.channel_id)
    if (!discordChannelId || !this.dir.shouldBridgeFromHarmony(msg.channel_id)) return

    const client = this.discord
    if (!client || !this.discordReady) return

    try {
      const discordChannel = await client.channels.fetch(discordChannelId) as TextChannel
      if (!discordChannel) {
        this.log.error(`Discord channel ${discordChannelId} not found`)
        return
      }

      const viaWebhook = await this.deliveryModeFor(discordChannel, msg, discordMessageId)
      if (viaWebhook === null) {
        this.log.debug(`Harmony delete ${msg.id}: Discord copy ${discordMessageId} already gone`)
      } else {
        const ids = this.chunkIdsFor(msg, discordMessageId)
        await this.deleteHarmonyOnDiscord(discordChannel, ids, viaWebhook)
        for (const id of ids) this.discordToHarmonyMessages.delete(id)
        this.log.info(`Harmony → Discord delete: ${msg.id} → ${ids.join(',')}`)
      }

      this.harmonyToDiscordMessages.delete(msg.id)
      this.harmonyDiscordViaWebhook.delete(msg.id)
      this.harmonyDiscordChunks.delete(msg.id)
    } catch (error) {
      if (!this.noteDrop('Harmony → Discord delete', error)) {
        this.log.error(`Failed to bridge delete Harmony → Discord (${msg.id}): ${errorText(error)}`)
      }
    }
  }

  /**
   * bridge_attachment_mode = refresh: the gateway forwards a view of an
   * expired Discord CDN URL; the bridge re-signs and patches the message.
   */
  private async onRefreshAttachments(data: any) {
    const messageId = data?.messageId
    const content = data?.content
    if (!messageId || !Array.isArray(content)) return
    if (this.recentlyRefreshedMessages.has(messageId)) return
    this.recentlyRefreshedMessages.add(messageId)
    setTimeout(() => this.recentlyRefreshedMessages.delete(messageId), 15_000)

    try {
      const newContent = await refreshDiscordAttachmentParts(content, this.discordToken, this.fetchImpl)
      if (!newContent) return
      await this.harmony.silentUpdateMessageContent(messageId, newContent)
      this.log.info(`Refreshed expired attachment URLs for message ${messageId}`)
    } catch (error) {
      this.log.error(`Attachment refresh failed for ${messageId}: ${errorText(error)}`)
    }
  }

  /**
   * Harmony emoji → Discord reaction identifier. `discord:name:id` maps back to
   * the Discord emoji; unicode passes through; a Harmony custom emoji matches
   * a guild emoji by name or is skipped.
   */
  private resolveDiscordEmojiForReaction(channel: TextChannel, emojiName: string): string | null {
    const discordBridged = emojiName.match(/^discord:([^:]+):(\d+)$/)
    if (discordBridged) {
      const [, name, id] = discordBridged
      const byId = channel.guild.emojis.cache.get(id)
      if (byId) return byId.identifier
      const byName = channel.guild.emojis.cache.find(e => e.name === name)
      if (byName) return byName.identifier
      return `${name}:${id}`
    }

    if (!/^[a-zA-Z0-9_+\-~]+$/.test(emojiName)) {
      return emojiName
    }
    const guildEmoji = channel.guild.emojis.cache.find(e => e.name === emojiName)
    if (guildEmoji) return guildEmoji.identifier
    return null
  }

  /** Emoji name from a reaction event; `emoji` is `{id, name}` or a string. */
  private static reactionEmojiName(data: any): string {
    if (typeof data?.emoji === 'string') return data.emoji
    return typeof data?.emoji?.name === 'string' ? data.emoji.name : ''
  }

  private async onHarmonyReactionAdd(data: any) {
    if (!this.harmonyToDiscordEnabled('reactions')) return
    if (data.metadata?.bridge_source === 'discord') return

    const discordChannelId = this.dir.getDiscordChannel(data.channel_id)
    if (!discordChannelId || !this.dir.shouldBridgeFromHarmony(data.channel_id)) return

    const discordMessageId = this.harmonyToDiscordMessages.get(data.message_id)
    if (!discordMessageId) {
      this.log.debug(`Harmony reaction: no Discord mapping for ${data.message_id}`)
      return
    }

    const client = this.discord
    if (!client || !this.discordReady) return

    try {
      const discordChannel = await client.channels.fetch(discordChannelId) as TextChannel
      if (!discordChannel) return

      const emojiInput = BridgeRuntime.reactionEmojiName(data)
      if (!emojiInput) return

      const resolved = this.resolveDiscordEmojiForReaction(discordChannel, emojiInput)
      if (!resolved) {
        this.log.debug(`Harmony reaction: no Discord emoji for "${emojiInput}"`)
        return
      }

      const reactionId = String(data.reaction_id ?? `${data.user_id ?? data.bot_id ?? '?'}:${resolved}`)
      if (!this.reactionLedger.add(String(data.message_id), resolved, reactionId)) {
        this.log.debug(`Harmony reaction added; Discord already shows it (${this.reactionLedger.count(String(data.message_id), resolved)} holder(s))`)
        return
      }

      const discordMessage = await discordChannel.messages.fetch(discordMessageId).catch(() => null)
      if (!discordMessage) {
        this.log.debug(`Harmony reaction: Discord message ${discordMessageId} not found`)
        return
      }

      await discordMessage.react(resolved)
      this.log.debug(`Harmony → Discord reaction on ${discordMessageId}`)
    } catch (err) {
      this.log.error(`Failed to bridge reaction Harmony → Discord: ${errorText(err)}`)
    }
  }

  /**
   * Removes the bot's Discord reaction only when no Harmony reaction holding
   * that emoji remains. REMOVE events carry the reaction id, not the emoji;
   * a reaction this process never saw added is left alone.
   */
  private async onHarmonyReactionRemove(data: any) {
    if (!this.harmonyToDiscordEnabled('reactions')) return
    if (data.metadata?.bridge_source === 'discord') return

    const discordChannelId = this.dir.getDiscordChannel(data.channel_id)
    if (!discordChannelId || !this.dir.shouldBridgeFromHarmony(data.channel_id)) return

    const discordMessageId = this.harmonyToDiscordMessages.get(data.message_id)
    if (!discordMessageId) return

    const known = data.reaction_id ? this.reactionLedger.remove(String(data.reaction_id)) : null
    if (!known) {
      this.log.debug(`Harmony reaction removal ${data.reaction_id ?? '?'}: not tracked; Discord reaction kept`)
      return
    }
    if (!known.last) {
      this.log.debug(`Harmony reaction removed; ${known.remaining} Harmony reaction(s) still hold it`)
      return
    }

    const client = this.discord
    if (!client || !this.discordReady) return

    try {
      const discordChannel = await client.channels.fetch(discordChannelId) as TextChannel
      if (!discordChannel) return

      const discordMessage = await discordChannel.messages.fetch(discordMessageId).catch(() => null)
      if (!discordMessage) return

      const reaction = discordMessage.reactions.cache.find(r => r.emoji.identifier === known.emoji
        || r.emoji.name === known.emoji)
      if (reaction && client.user) {
        await reaction.users.remove(client.user.id)
        this.log.debug(`Harmony → Discord reaction removed on ${discordMessageId}`)
      }
    } catch (err) {
      this.log.error(`Failed to bridge reaction removal Harmony → Discord: ${errorText(err)}`)
    }
  }
}
