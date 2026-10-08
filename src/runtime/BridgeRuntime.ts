import { EventEmitter } from 'events'
import { join } from 'path'
import {
  Client as DiscordClient,
  Message as DiscordMessage,
  Webhook,
  TextChannel,
  GuildMember,
  Events,
  type Guild,
  MessageFlags,
  PermissionFlagsBits,
  Routes,
  type APIEmbed,
  type ClientOptions,
  type Interaction,
  type MessageReaction,
  type PartialMessageReaction,
  type Presence,
  type ReadonlyCollection,
  type User,
  type PartialUser,
  type PartialMessage,
} from 'discord.js'
import { HarmonyClient, HarmonyHttpError, isAutomodBlocked } from '../HarmonyClient.js'
import {
  MessageTranslator,
  collectHarmonyCustomEmoji,
  collectHarmonyFiles,
  type DiscordRendering,
  type DiscordToHarmonyContext,
  type HarmonyToDiscordContext,
} from '../MessageTranslator.js'
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
import {
  botPostPrefix,
  formatHarmonyDisplayNameForDiscord,
  harmonyAuthorName,
  sanitizeWebhookUsername,
} from '../utils/discordDisplayName.js'
import { isPublicHttpsUrl } from '../utils/fetchCapped.js'
import { loadInstanceIcon } from '../utils/instanceIcon.js'
import { ReactionLedger } from '../utils/reactionLedger.js'
import { ServerEmojiLinks } from './serverEmojiLinks.js'
import { resolveDeliveryMode } from '../utils/deliveryMode.js'
import type { FetchLike } from '../http.js'
import { Logger, errorText } from '../log.js'
import type { DiscordGuildView, PrivilegedIntent, Problem } from '../problems.js'
import { collectGuildViews } from '../v2/selfCheck.js'
import type { PairDirectory, PairWriter } from './PairDirectory.js'
import {
  DiscordConnection,
  type DiscordApplication,
  type DiscordConnState,
  type IntentSelection,
} from './discordConnection.js'
import type { SharedDiscordClient, SharedDiscordSink } from './SharedDiscordClient.js'
import {
  PresenceDeltaQueue,
  mapDiscordPresence,
  samePresence,
  type MappedPresence,
} from './presenceDeltas.js'
import { handleInteraction, registerSlashCommands } from './commands.js'
import { DiscordAuthorLimiter } from './antiSpam.js'
import { AppEmojiStore, loadEmojiImage, type AppEmoji, type AppEmojiIO } from './appEmojis.js'
import {
  OutboundMedia,
  guildUploadLimit,
  mediaOptionsFromEnv,
  type MediaOptions,
  type PreparedUpload,
} from './outboundMedia.js'

export type { DiscordConnState } from './discordConnection.js'

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
  /** Instance bot: events of the linked guild come from this client; `discordToken` is unused. */
  sharedDiscord?: SharedDiscordClient
  /** BRIDGE_PRESENCE_UPDATE flush interval; never below 5 s. */
  presenceFlushMs?: number
  /** Upload budget and media origin; default from MAX_UPLOAD_MB and HARMONY_MEDIA_ORIGIN. */
  media?: MediaOptions
  /** Directory of application emoji maps (`<application id>.json`); null keeps them in memory. */
  appEmojiDir?: string | null
}

/** Where guild events and REST rate-limit events arrive from. */
interface DiscordEventSource {
  events: EventEmitter
  rest: EventEmitter
}

/**
 * Message id mappings between Discord and Harmony, LRU-bounded. A dropped
 * mapping loses edit/delete/reaction bridging for that old message.
 */
const MESSAGE_MAPPING_CAP = 50_000
const HARMONY_USER_CACHE_REFRESH_MS = 5 * 60 * 1000
/** rate_limited stays reported this long after the last drop. */
const RATE_LIMIT_PROBLEM_MS = 5 * 60 * 1000
/** A Discord REST wait longer than this counts as rate limiting worth reporting. */
const DISCORD_LONG_RATE_LIMIT_MS = 10_000
/** REGISTER_BRIDGE_DATA (op 6) at most this often; the gateway allows 120 frames per 60 s. */
const REGISTER_MIN_INTERVAL_MS = 5_000
/** BRIDGE_PRESENCE_UPDATE (op 7) at most this often. */
const PRESENCE_MIN_INTERVAL_MS = 5_000
/** Application emoji uploads wait this long before a message goes out with `:name:` text. */
const APP_EMOJI_WAIT_MS = 4_000
/** Distinct custom emoji per message considered for upload. */
const APP_EMOJI_PER_MESSAGE = 10
/** Harmony emoji rows cached this long; a missing row is asked again after MISS_TTL. */
const HARMONY_EMOJI_TTL_MS = 60 * 60 * 1000
const HARMONY_EMOJI_MISS_TTL_MS = 10 * 60 * 1000
/** Spam drops are logged at the first and then every this many. */
const SPAM_LOG_EVERY = 50

/** Discord REST error codes. */
const DISCORD_UNKNOWN_WEBHOOK = 10015
const DISCORD_UNKNOWN_MESSAGE = 10008
const DISCORD_UNKNOWN_EMOJI = 10014
const DISCORD_MISSING_PERMISSIONS = 50013
const DISCORD_ENTITY_TOO_LARGE = 40005
/** Discord MessageReferenceType.Forward. */
const REFERENCE_FORWARD = 1

function discordCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

function isMissingPermission(err: unknown): boolean {
  return discordCode(err) === DISCORD_MISSING_PERMISSIONS
}

function isTooLarge(err: unknown): boolean {
  return discordCode(err) === DISCORD_ENTITY_TOO_LARGE || (err as { status?: number } | null)?.status === 413
}

/** A send that failed after posting some chunks; those ids are known so they can be removed. */
class PartialSendError extends Error {
  constructor(readonly failure: unknown, readonly sentIds: string[]) {
    super(errorText(failure))
  }
}

function unwrapSend(err: unknown): { failure: unknown; sentIds: string[] } {
  return err instanceof PartialSendError ? { failure: err.failure, sentIds: err.sentIds } : { failure: err, sentIds: [] }
}

/** One rendering of a Harmony message for Discord: text, attachments, flags. */
interface OutboundVariant {
  content: string
  files: PreparedUpload[]
  suppressEmbeds: boolean
}

interface Outbound {
  /** Puppet name before webhook sanitising. */
  username: string
  avatarURL?: string
  mentionUserIds: string[]
  embeds?: APIEmbed[]
  primary: OutboundVariant
  /** Same message with every file as a link; null when `primary` has no attachments. */
  linksOnly: OutboundVariant | null
}

interface Delivery {
  discordMessageIds: string[]
  viaWebhook: boolean
  uploadedKeys: string[]
}

function isRateLimitError(err: unknown): boolean {
  if (err instanceof HarmonyHttpError) return err.status === 429
  const e = err as { status?: number; name?: string } | null
  return e?.status === 429 || e?.name === 'RateLimitError'
}

/**
 * One bridge: a discord.js client and a Harmony bot-gateway connection,
 * pairing channels from a PairDirectory. Several run side by side in host mode.
 * The client is the bridge's own (DiscordConnection) or the instance bot's
 * (SharedDiscordClient), which delivers only the linked guild's events.
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
  private readonly fetchImpl?: FetchLike
  /** Own client (self, hosted, v1); null with a shared client. */
  private readonly connection: DiscordConnection | null
  private readonly shared: SharedDiscordClient | null
  private readonly sharedSink: SharedDiscordSink | null

  discord: DiscordClient | null = null
  private discordState: DiscordConnState = 'idle'
  private discordStartupDone = false
  /** What the member list was last fetched with on this client: 'members', 'presence', or null. */
  private memberListKey: string | null = null
  private readonly registeredCommandGuilds = new Set<string>()
  private stopped = false

  readonly discordToHarmonyMessages = new BoundedMap<string, string>(MESSAGE_MAPPING_CAP)
  readonly harmonyToDiscordMessages = new BoundedMap<string, string>(MESSAGE_MAPPING_CAP)
  /** Harmony message id → Discord copy sent via webhook (else bot send). */
  private readonly harmonyDiscordViaWebhook = new BoundedMap<string, boolean>(MESSAGE_MAPPING_CAP)
  /** Harmony message id → every Discord message id of a split message. */
  private readonly harmonyDiscordChunks = new BoundedMap<string, string[]>(MESSAGE_MAPPING_CAP)
  /** Harmony message id → harmonyFileKey of files sent as Discord attachments. */
  private readonly harmonyDiscordUploads = new BoundedMap<string, string[]>(MESSAGE_MAPPING_CAP)
  /** Discord ids of copies of Harmony messages: a Discord delete of one is not mirrored to Harmony. */
  private readonly harmonyOriginCopies = new BoundedMap<string, true>(MESSAGE_MAPPING_CAP)
  /** Discord ids whose Harmony copy the bridge deleted; Harmony's MESSAGE_DELETE for them is an echo. */
  private readonly deletedFromDiscord = new BoundedMap<string, true>(10_000)
  private readonly webhookCache = new Map<string, Webhook>()
  private readonly webhookPermissionWarned = new Set<string>()
  private readonly manageMessagesWarned = new Set<string>()
  private instanceIcon: Promise<Buffer | null> | null = null

  readonly antiSpam = new DiscordAuthorLimiter()
  readonly media: OutboundMedia
  /** Guild id → upload limit learned from a 40005 rejection. */
  private readonly learnedUploadLimit = new Map<string, number>()
  private readonly appEmojiDir: string | null
  private readonly appEmojiStores = new Map<string, AppEmojiStore>()
  /** Harmony emoji id → row (null: not found), with fetch time. */
  private readonly harmonyEmojiRows = new BoundedMap<string, { row: { name: string; url: string } | null; at: number }>(5_000)
  private registerTimer: NodeJS.Timeout | null = null
  private lastRegisterAt = -Infinity

  private readonly discordMemberDetails = new Map<string, CachedDiscordMember>()
  private readonly harmonyUserCacheByServer = new Map<string, Map<string, CachedHarmonyUser>>()
  private harmonyUserCacheTimer: NodeJS.Timeout | null = null

  private discordReady = false
  private harmonyReady = false
  private harmonyStartupDone = false
  private harmonyAuthLogged = false
  /** Socket errors since the last READY. */
  private harmonyUnreachable = false
  private readonly presenceDeltas: PresenceDeltaQueue
  private lastRegistrationSummary = ''
  /** Harmony messages not bridged while Discord was down, since the last ready. */
  private skippedWhileDiscordDown = 0
  private readonly recentlyRefreshedMessages = new Set<string>()

  private readonly reactionLedger = new ReactionLedger()
  /** Harmony server emoji imported from Discord; one emoji on both sides. */
  readonly emojiLinks = new ServerEmojiLinks(serverId => this.harmony.getServerEmojis(serverId))

  private droppedMessages = 0
  /** Discord messages Harmony's AutoMod refused since start. */
  automodBlocked = 0
  private rateLimitedUntil = 0

  constructor(opts: BridgeRuntimeOptions) {
    this.mode = opts.mode
    this.dir = opts.directory
    this.writer = opts.writer
    this.log = opts.log
    this.hooks = opts.hooks ?? {}
    this.fetchImpl = opts.fetchImpl

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
    this.presenceDeltas = new PresenceDeltaQueue(
      updates => this.harmony.sendPresenceUpdates(updates),
      Math.max(PRESENCE_MIN_INTERVAL_MS, opts.presenceFlushMs ?? PRESENCE_MIN_INTERVAL_MS),
    )
    this.media = new OutboundMedia(this.harmonyBaseUrl.href, opts.media ?? mediaOptionsFromEnv(process.env, this.log), opts.fetchImpl)
    this.appEmojiDir = opts.appEmojiDir ?? null

    this.shared = opts.sharedDiscord ?? null
    if (this.shared) {
      this.connection = null
      this.sharedSink = {
        guildId: () => this.dir.getDiscordGuildIds()[0] ?? null,
        needs: () => this.settings(),
        events: new EventEmitter(),
        rest: new EventEmitter(),
        bindClient: (client) => this.bindClient(client),
        onReady: (client) => { this.onDiscordReady(client).catch(err => this.log.error('Discord startup failed:', errorText(err))) },
        onState: (state) => this.setDiscordState(state),
        unbindClient: () => this.unbindClient(),
      }
      this.attachDiscordHandlers(this.sharedSink, () => !this.stopped)
    } else {
      this.sharedSink = null
      this.connection = new DiscordConnection({
        token: opts.discordToken,
        log: this.log,
        fetchImpl: opts.fetchImpl,
        createClient: opts.createDiscordClient,
        needs: () => this.settings(),
        tokenHint: () => this.discordTokenHint(),
        listener: {
          onClient: (client, isCurrent) => {
            this.bindClient(client)
            this.attachDiscordHandlers({ events: client, rest: client.rest }, isCurrent)
          },
          onReady: (client) => { this.onDiscordReady(client).catch(err => this.log.error('Discord startup failed:', errorText(err))) },
          onState: (state) => this.setDiscordState(state),
          onTeardown: () => this.unbindClient(),
        },
      })
    }

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
    if (this.shared) {
      this.shared.attach(this.sharedSink!)
      return
    }
    await this.connection!.start()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.discordState = 'stopped'
    if (this.harmonyUserCacheTimer) {
      clearInterval(this.harmonyUserCacheTimer)
      this.harmonyUserCacheTimer = null
    }
    if (this.registerTimer) {
      clearTimeout(this.registerTimer)
      this.registerTimer = null
    }
    for (const store of this.appEmojiStores.values()) store.flush()
    this.presenceDeltas.stop()
    if (this.connection) {
      await this.connection.stop()
    } else {
      this.shared!.detach(this.sharedSink!)
      this.unbindClient()
    }
    this.harmony.disconnect()
    this.harmony.removeAllListeners()
  }

  /** Own client only; the instance bot connects on its own schedule. */
  async connectDiscord(): Promise<void> {
    await this.connection?.connect()
  }

  /** Runs on the instance bot client. */
  isShared(): boolean {
    return this.shared !== null
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

  /** Active intent set as this bridge sees it. */
  get intentSelection(): IntentSelection | null {
    if (this.connection) return this.connection.selection
    return this.shared!.selectionFor(this.settings())
  }

  private get application(): DiscordApplication | null {
    return this.connection ? this.connection.application : this.shared!.application()
  }

  private currentDiscordToken(): string {
    return this.connection ? this.connection.currentToken() : this.shared!.token()
  }

  /**
   * Guilds the bot is in, with per-channel permissions. Null while
   * disconnected. The instance bot reports only the linked guild.
   */
  guildViews(): DiscordGuildView[] | null {
    if (!this.discord || this.discordState !== 'ready') return null
    const client = this.discord as unknown as Parameters<typeof collectGuildViews>[0]
    if (!this.shared) return collectGuildViews(client)
    const linked = new Set(this.dir.getDiscordGuildIds())
    return collectGuildViews(client, id => linked.has(id))
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
        presence: (grants?.presence ?? active?.presence ?? false) && (this.shared?.presenceAllowed() ?? true),
      },
    }
  }

  // ===========================================================================
  // Discord client binding (own or shared)
  // ===========================================================================

  private discordTokenHint(): string {
    return this.hooks.discordTokenHint
      ?? 'Discord rejected the bot token (DISCORD_TOKEN). Reset it in the Discord Developer Portal → your app → Bot → Reset Token, then update DISCORD_TOKEN (retrying automatically).'
  }

  private setDiscordState(state: DiscordConnState) {
    if (this.discordState === state) return
    this.discordState = state
    this.notify(`discord:${state}`)
  }

  private bindClient(client: DiscordClient) {
    this.discord = client
    this.discordStartupDone = false
    this.memberListKey = null
    this.registeredCommandGuilds.clear()
  }

  /** The client is going away; state bound to it is dropped. */
  private unbindClient() {
    this.discord = null
    this.discordReady = false
    this.discordStartupDone = false
    this.memberListKey = null
    this.permissionSync.detach()
    this.webhookCache.clear()
  }

  /** Settings changed: the own client reconnects when its intent set differs; the shared one re-evaluates. */
  private async applyIntentSettings() {
    if (this.connection) await this.connection.applyNeeds()
    else this.shared!.requirementsChanged()
  }

  requireDiscord(): DiscordClient {
    if (!this.discord) throw new Error('Discord is not connected')
    return this.discord
  }

  /** Paired Discord channel. The instance bot refuses channels outside the linked guild. */
  private async fetchPairedChannel(client: DiscordClient, channelId: string): Promise<TextChannel | null> {
    const channel = await client.channels.fetch(channelId) as TextChannel | null
    if (channel && this.shared && !this.dir.isConfiguredDiscordGuild(channel.guildId)) {
      this.log.warn(`Discord channel ${channelId} is outside the linked guild; ignored`)
      return null
    }
    return channel
  }

  /** discord.js events of this bridge: the client itself, or the guild-scoped emitter. */
  private permissionEvents(client: DiscordClient): EventEmitter {
    return this.sharedSink?.events ?? client
  }

  private attachDiscordHandlers(source: DiscordEventSource, current: () => boolean) {
    const { events, rest } = source

    rest.on('rateLimited', (info: { route: string; timeToReset: number }) => {
      if (!current()) return
      this.log.debug(`Discord rate limit on ${info.route}: waiting ${info.timeToReset} ms`)
      if (info.timeToReset > DISCORD_LONG_RATE_LIMIT_MS) {
        this.rateLimitedUntil = Date.now() + RATE_LIMIT_PROBLEM_MS
      }
    })

    events.on(Events.MessageCreate, (msg: DiscordMessage) => { if (current()) void this.onDiscordMessage(msg) })
    events.on(Events.MessageReactionAdd, (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
      if (current()) void this.onDiscordReactionAdd(reaction, user)
    })
    events.on(Events.MessageReactionRemove, (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
      if (current()) void this.onDiscordReactionRemove(reaction, user)
    })
    events.on(Events.MessageUpdate, (_old: unknown, msg: DiscordMessage | PartialMessage) => {
      if (current()) void this.onDiscordMessageUpdate(msg)
    })
    events.on(Events.MessageDelete, (msg: DiscordMessage | PartialMessage) => { if (current()) void this.onDiscordMessageDelete(msg) })
    events.on(Events.MessageBulkDelete, (messages: ReadonlyCollection<string, DiscordMessage | PartialMessage>) => {
      if (current()) void this.onDiscordMessageBulkDelete(Array.from(messages.values()))
    })

    events.on(Events.GuildMemberAdd, (member: GuildMember) => {
      if (!current() || member.user.bot || !this.settings().syncMemberList) return
      if (!this.dir.isConfiguredDiscordGuild(member.guild.id)) return
      this.cacheMember(member)
      this.log.debug(`Member cache: added ${member.id}`)
      this.registerBridgeDataWithGateway()
    })

    events.on(Events.GuildMemberRemove, (member: GuildMember) => {
      if (!current()) return
      this.discordMemberDetails.delete(member.id)
      this.log.debug(`Member cache: removed ${member.id}`)
      this.registerBridgeDataWithGateway()
    })

    events.on(Events.GuildMemberUpdate, (oldMember: GuildMember, newMember: GuildMember) => {
      if (!current() || newMember.user.bot || !this.settings().syncMemberList) return
      if (!this.dir.isConfiguredDiscordGuild(newMember.guild.id)) return

      const rolesChanged =
        oldMember.roles.cache.size !== newMember.roles.cache.size
        || !oldMember.roles.cache.equals(newMember.roles.cache)
      const profileChanged =
        oldMember.user.username !== newMember.user.username
        || oldMember.displayName !== newMember.displayName
        || oldMember.avatar !== newMember.avatar
        || oldMember.user.avatar !== newMember.user.avatar
        || oldMember.user.banner !== newMember.user.banner
        || oldMember.user.hexAccentColor !== newMember.user.hexAccentColor

      if (!rolesChanged && !profileChanged) return

      this.cacheMember(newMember)
      this.registerBridgeDataWithGateway()
    })

    events.on(Events.PresenceUpdate, (_old: Presence | null, presence: Presence) => {
      if (!current() || !this.isSyncPresenceEnabled() || !this.settings().syncMemberList) return
      const guildId = presence.guild?.id
      if (!guildId || !this.dir.isConfiguredDiscordGuild(guildId)) return
      this.onMemberPresence(presence.userId, guildId, mapDiscordPresence(presence))
    })

    events.on(Events.InteractionCreate, (interaction: Interaction) => {
      if (!current()) return
      handleInteraction(this, interaction).catch(err => this.log.error('Interaction failed:', errorText(err)))
    })

    // Guild membership and channel layout feed the v2 self-check.
    events.on(Events.GuildCreate, (guild: { id: string }) => {
      if (!current()) return
      this.notify('guilds')
      const client = this.discord
      if (!client) return
      if (this.shared) {
        // Instance bot added to the linked guild after startup.
        if (this.discordReady && this.discordStartupDone && this.dir.isConfiguredDiscordGuild(guild.id)) {
          void this.runGuildStartup(client, guild.id).then(() => this.registerBridgeDataWithGateway())
        }
        return
      }
      if (this.commandGuildIds(client).includes(guild.id)) void this.registerCommandsFor(client, guild.id)
    })
    events.on(Events.GuildDelete, () => { if (current()) this.notify('guilds') })
    events.on(Events.ChannelCreate, () => { if (current()) this.notify('channels') })
    events.on(Events.ChannelDelete, () => { if (current()) this.notify('channels') })
    events.on(Events.ChannelUpdate, () => { if (current()) this.notify('channels') })
    events.on(Events.GuildRoleUpdate, () => { if (current()) this.notify('channels') })
    events.on(Events.GuildMemberUpdate, (_old: GuildMember, member: GuildMember) => {
      if (current() && member.id === this.discord?.user?.id) this.notify('channels')
    })
  }

  private async onDiscordReady(client: DiscordClient) {
    this.skippedWhileDiscordDown = 0
    this.discordReady = true
    if (this.shared) this.log.info(`Instance bot ready; linked guild ${this.dir.getDiscordGuildIds()[0] ?? '(none)'}`)

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
      await this.refreshEmojiLinks()
      if (!this.harmonyUserCacheTimer) {
        this.harmonyUserCacheTimer = setInterval(
          () => { void this.refreshHarmonyUserCache({ verbose: false }); void this.refreshEmojiLinks() },
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
    if (this.shared && !client.guilds.cache.has(guildId)) {
      this.log.warn(`The instance bot is not in the linked Discord guild ${guildId}`)
      this.notify('guilds')
      return
    }

    let guild
    try {
      guild = await client.guilds.fetch(guildId)
    } catch (err) {
      this.log.error(`Cannot open Discord guild ${guildId}: ${errorText(err)}`)
      return
    }

    const settings = this.settings()
    await this.loadMemberList(guild)

    await this.registerCommandsFor(client, guild.id)

    if (settings.syncPermissions) {
      try {
        this.permissionSync.attach(this.permissionEvents(client))
        await this.permissionSync.initialSync(guild)
      } catch (err) {
        this.log.error(`Permission sync initial reconcile failed for ${guild.name}: ${errorText(err)}`)
      }
    }
  }

  /** 'members' or 'presence' when the member list is synced and the intents allow it, else null. */
  private memberListWanted(): string | null {
    if (!this.settings().syncMemberList || !this.intentSelection?.active.members) return null
    return this.isSyncPresenceEnabled() ? 'presence' : 'members'
  }

  private async loadMemberList(guild: Guild) {
    const wanted = this.memberListWanted()
    if (!wanted) return
    try {
      this.log.info(`Fetching members for guild ${guild.name}`)
      const members = await guild.members.fetch({ withPresences: wanted === 'presence' })
      members.forEach(member => {
        if (!member.user.bot) this.cacheMember(member)
      })
      this.memberListKey = wanted
    } catch (err) {
      this.log.warn(`Member fetch failed for ${guild.name}: ${errorText(err)}`)
    }
  }

  /**
   * v1: configured guilds. v2: the selected guild, or every guild while none
   * is selected. Instance bot: the linked guild only.
   */
  private commandGuildIds(client: DiscordClient): string[] {
    const configured = this.dir.getDiscordGuildIds()
    if (this.mode === 'v1' || configured.length > 0 || this.shared) return configured
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

    if (change.guildChanged) this.shared?.reindex()

    if (change.settingsChanged) {
      const settings = this.settings()
      if (!settings.syncMemberList && this.discordMemberDetails.size > 0) {
        this.discordMemberDetails.clear()
        this.memberListKey = null
      }
      if (!settings.syncPermissions) this.permissionSync.detach()
      await this.applyIntentSettings()
    }

    const client = this.discord
    if (change.guildChanged && client && this.discordReady) {
      for (const guildId of this.dir.getDiscordGuildIds()) {
        await this.runGuildStartup(client, guildId)
      }
    } else if (change.settingsChanged && client && this.discordReady) {
      // The shared client keeps its connection when its intent set already covers the new settings.
      const wanted = this.shared ? this.memberListWanted() : null
      if (wanted && wanted !== this.memberListKey) {
        for (const guildId of this.dir.getDiscordGuildIds()) {
          const guild = client.guilds.cache.get(guildId)
          if (guild) await this.loadMemberList(guild)
        }
      }
      if (this.settings().syncPermissions) {
        for (const guildId of this.dir.getDiscordGuildIds()) {
          const guild = client.guilds.cache.get(guildId)
          if (!guild) continue
          this.permissionSync.attach(this.permissionEvents(client))
          await this.permissionSync.initialSync(guild).catch(err =>
            this.log.error(`Permission sync reconcile failed: ${errorText(err)}`))
        }
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
            this.rememberMapping(m)
            restored++
          }
        }
        if (restored > 0) this.log.info(`Restored ${restored} message mappings for Harmony channel ${channelId}`)
      } catch (err) {
        this.log.error(`Failed to restore mappings for ${channelId}: ${errorText(err)}`)
      }
    }
  }

  /** Records the Discord ids a Harmony message's metadata names. */
  private rememberMapping(m: { id: string; metadata?: any }) {
    const discordId = String(m.metadata.discord_message_id)
    this.discordToHarmonyMessages.set(discordId, m.id)
    this.harmonyToDiscordMessages.set(m.id, discordId)
    if (m.metadata.bridge_source === 'harmony') {
      const ids: string[] = Array.isArray(m.metadata.discord_message_ids) ? m.metadata.discord_message_ids.map(String) : [discordId]
      for (const id of ids) this.harmonyOriginCopies.set(id, true)
      if (Array.isArray(m.metadata.discord_uploaded_files)) {
        this.harmonyDiscordUploads.set(m.id, m.metadata.discord_uploaded_files.map(String))
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

  private extractMemberPresence(member: GuildMember): MappedPresence {
    if (!this.isSyncPresenceEnabled()) {
      return { presenceStatus: 'offline', customStatus: null }
    }
    return mapDiscordPresence(member.presence)
  }

  /**
   * PresenceUpdate of a member in the synced list. Activity-only changes map
   * to the same status and custom status and are dropped; real changes go
   * out as BRIDGE_PRESENCE_UPDATE deltas, never as a full REGISTER_BRIDGE_DATA.
   */
  private onMemberPresence(userId: string, guildId: string, next: MappedPresence) {
    const cached = this.discordMemberDetails.get(userId)
    if (!cached || cached.guildId !== guildId) return
    if (samePresence(cached, next)) return
    this.discordMemberDetails.set(userId, { ...cached, ...next })
    this.presenceDeltas.push({ id: userId, ...next })
  }

  private cacheMember(member: GuildMember) {
    const guildId = member.guild.id
    const { harmonyRoleIds, roles } = this.mapMemberRoles(member)
    const { presenceStatus, customStatus } = this.extractMemberPresence(member)
    const bannerUrl = member.user.bannerURL({ size: 512 }) ?? null

    this.discordMemberDetails.set(member.id, {
      guildId,
      id: member.id,
      username: member.user.username,
      displayName: member.displayName || member.user.username,
      // Server avatar, else the account avatar: the picture bridged messages carry.
      avatarUrl: member.displayAvatarURL({ size: 128 }),
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

  /**
   * Sends pairs and Discord members to the gateway once both sides are ready,
   * at most every 5 s; changes inside that interval go out together at its
   * end. `immediate` is for a new gateway connection, which holds nothing yet.
   */
  registerBridgeDataWithGateway(opts: { immediate?: boolean } = {}) {
    if (!this.discordReady || !this.harmonyReady) {
      this.log.debug(`Bridge data registration waiting: Discord=${this.discordReady}, Harmony=${this.harmonyReady}`)
      return
    }
    const wait = this.lastRegisterAt + REGISTER_MIN_INTERVAL_MS - Date.now()
    if (!opts.immediate && wait > 0) {
      if (!this.registerTimer) {
        this.registerTimer = setTimeout(() => {
          this.registerTimer = null
          if (!this.stopped) this.registerBridgeDataWithGateway()
        }, wait)
      }
      return
    }
    if (this.registerTimer) {
      clearTimeout(this.registerTimer)
      this.registerTimer = null
    }
    this.lastRegisterAt = Date.now()
    this.sendRegistration()
  }

  private sendRegistration() {
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

    if (this.harmony.registerBridgeData(channels)) {
      // op 6 carries presence; deltas start from what it sent.
      this.presenceDeltas.baseline(channels.flatMap(ch => ch.members))
    }
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

      const channel = await this.fetchPairedChannel(this.requireDiscord(), channelId)
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

  /** Pings only the Discord users the message names; never roles, @everyone or @here. */
  private allowedMentions(mentionUserIds?: string[]) {
    return mentionUserIds && mentionUserIds.length > 0
      ? { parse: [] as const, users: mentionUserIds.slice(0, 100) }
      : { parse: [] as const }
  }

  /**
   * Webhook avatar_url for a Harmony avatar: absolute http(s) URLs as given,
   * paths resolved against the Harmony base URL. Undefined when Discord
   * cannot fetch it (loopback host, other schemes).
   */
  webhookAvatarUrl(avatar: unknown): string | undefined {
    if (typeof avatar !== 'string' || !avatar.trim()) return undefined
    let u: URL
    try {
      u = new URL(avatar.trim(), this.harmonyBaseUrl)
    } catch {
      return undefined
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]') return undefined
    return u.href
  }

  /** Attachment bytes per message: MAX_UPLOAD_MB, capped by the guild's limit. */
  private uploadBudget(channel: TextChannel): number {
    const guildLimit = this.learnedUploadLimit.get(channel.guildId) ?? guildUploadLimit(channel.guild?.premiumTier)
    return Math.min(this.media.options.maxUploadBytes, guildLimit)
  }

  /** Discord refused `attempted` bytes (40005): later messages in the guild stay below it. */
  private learnUploadLimit(guildId: string, attempted: number) {
    const next = Math.max(0, attempted - 1)
    if (next >= (this.learnedUploadLimit.get(guildId) ?? Infinity)) return
    this.learnedUploadLimit.set(guildId, next)
    this.log.warn(`Discord refused ${Math.round(attempted / 1024)} KiB of attachments in guild ${guildId}; larger files go as links`)
  }

  /** Sends `variant` in chunks of at most 2000 characters; attachments and embeds ride on the last chunk. */
  private async postChunks(
    variant: OutboundVariant,
    opts: { prefix: string; embeds?: APIEmbed[]; send: (payload: any) => Promise<{ id?: string } | null | undefined> },
  ): Promise<string[]> {
    const chunks = splitDiscordContent(opts.prefix + variant.content)
    const ids: string[] = []
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1
      try {
        const sent = await opts.send({
          ...(chunks[i] ? { content: chunks[i] } : {}),
          ...(last && variant.files.length > 0 ? { files: variant.files.map(f => ({ attachment: f.data, name: f.name })) } : {}),
          ...(last && opts.embeds ? { embeds: opts.embeds } : {}),
          ...(variant.suppressEmbeds && !opts.embeds ? { flags: MessageFlags.SuppressEmbeds } : {}),
        })
        if (sent?.id) ids.push(sent.id)
      } catch (err) {
        throw new PartialSendError(err, ids)
      }
    }
    return ids
  }

  /**
   * Posts a Harmony message: webhook first (author name and avatar), else as
   * the bot with a bold author prefix. A vanished webhook (10015) is created
   * again once; any other webhook failure falls back to the bot. Attachments
   * Discord refuses fall back to links.
   */
  private async sendHarmonyToDiscord(channel: TextChannel, out: Outbound): Promise<Delivery | null> {
    const allowedMentions = this.allowedMentions(out.mentionUserIds)
    const embeds = out.embeds?.length ? out.embeds.slice(0, 10) : undefined
    let variant = out.primary
    const switchToLinks = (failure: unknown): boolean => {
      if (!out.linksOnly || variant === out.linksOnly) return false
      if (isTooLarge(failure)) this.learnUploadLimit(channel.guildId, variant.files.reduce((n, f) => n + f.data.length, 0))
      variant = out.linksOnly
      return true
    }
    const delivered = (ids: string[], viaWebhook: boolean): Delivery =>
      ({ discordMessageIds: ids, viaWebhook, uploadedKeys: variant.files.map(f => f.key) })

    let webhook = await this.getOrCreateWebhook(channel.id)
    let recreated = false
    while (webhook) {
      const hook: Webhook = webhook
      try {
        const ids = await this.postChunks(variant, {
          prefix: '',
          embeds,
          send: payload => hook.send({
            ...payload,
            username: sanitizeWebhookUsername(out.username),
            avatarURL: out.avatarURL,
            allowedMentions,
          }),
        })
        if (ids.length === 0) return null
        return delivered(ids, true)
      } catch (err) {
        const { failure, sentIds } = unwrapSend(err)
        for (const id of sentIds) await hook.deleteMessage(id).catch(() => {})
        if (discordCode(failure) === DISCORD_UNKNOWN_WEBHOOK) {
          this.webhookCache.delete(channel.id)
          if (!recreated) {
            recreated = true
            this.log.info(`Webhook of channel ${channel.id} no longer exists; creating it again`)
            webhook = await this.getOrCreateWebhook(channel.id)
            continue
          }
        }
        if (isTooLarge(failure) && switchToLinks(failure)) continue
        this.log.warn(`Webhook post to channel ${channel.id} failed (${errorText(failure)}); posting as the bot`)
        break
      }
    }

    const me = channel.client.user
    if (!me) {
      this.log.error('Discord client not ready')
      return null
    }
    if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
      this.log.error(`Cannot send to #${channel.name} (${channel.id}): bot lacks Send Messages`)
      return null
    }

    for (;;) {
      try {
        const ids = await this.postChunks(variant, {
          prefix: botPostPrefix(out.username),
          embeds,
          send: payload => channel.send({ ...payload, allowedMentions }),
        })
        return delivered(ids, false)
      } catch (err) {
        const { failure, sentIds } = unwrapSend(err)
        for (const id of sentIds) await channel.messages.delete(id).catch(() => {})
        if (switchToLinks(failure)) continue
        throw failure
      }
    }
  }

  /**
   * Edits a bridged message; returns the Discord ids now holding it. Bot posts
   * are the bot's own messages and need no extra permission. Webhook posts
   * need the webhook (Manage Webhooks); Discord offers no other way to edit them.
   * Attachments stay: an edit without `attachments` keeps them.
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
            username: sanitizeWebhookUsername(author.username),
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

    const chunks = splitDiscordContent(`${botPostPrefix(author.username)}${content}`)
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

  /** A relay Harmony's AutoMod refused: counted, logged without content, not retried. */
  noteAutomodBlock(channelId: string) {
    this.automodBlocked++
    const line = `Harmony AutoMod blocked a Discord message from channel ${channelId} (${this.automodBlocked} blocked since start)`
    if (this.automodBlocked === 1 || this.automodBlocked % SPAM_LOG_EVERY === 0) this.log.warn(line)
    else this.log.debug(line)
  }

  /** Anti-spam drop of a Discord message: counted, logged without content. */
  noteSpamDrop(reason: 'rate' | 'duplicate', channelId: string) {
    const { rate, duplicate } = this.antiSpam.dropped
    const total = rate + duplicate
    const line = `Anti-spam: dropped a Discord message in channel ${channelId} (${reason === 'rate' ? 'too many messages' : 'repeated content'}); ${rate} rate-limited and ${duplicate} repeated since start`
    if (total === 1 || total % SPAM_LOG_EVERY === 0) this.log.warn(line)
    else this.log.debug(line)
  }

  // ===========================================================================
  // Application emojis (Harmony custom emoji on Discord)
  // ===========================================================================

  /** The application emoji map of the connected application and the REST calls for it. */
  private appEmojiContext(): { store: AppEmojiStore; io: AppEmojiIO } | null {
    const client = this.discord
    const appId = client?.application?.id ?? this.application?.id
    if (!client || !appId) return null
    let store = this.appEmojiStores.get(appId)
    if (!store) {
      const path = this.appEmojiDir ? join(this.appEmojiDir, `${appId.replace(/[^0-9A-Za-z_-]/g, '_')}.json`) : null
      store = AppEmojiStore.forPath(path, { log: this.log })
      this.appEmojiStores.set(appId, store)
    }
    const rest = client.rest
    const io: AppEmojiIO = {
      api: {
        list: async () => {
          const res = await rest.get(Routes.applicationEmojis(appId)) as { items?: unknown } | unknown[]
          return (Array.isArray(res) ? res : Array.isArray((res as { items?: unknown }).items) ? (res as { items: unknown[] }).items : []) as Array<{ id: string; name: string; animated?: boolean }>
        },
        create: async (name, image) =>
          await rest.post(Routes.applicationEmojis(appId), { body: { name, image } }) as { id: string; name: string; animated?: boolean },
        delete: async (id) => { await rest.delete(Routes.applicationEmoji(appId, id)) },
      },
      loadImage: (url) => loadEmojiImage(this.media.route(url), this.fetchImpl),
    }
    return { store, io }
  }

  /**
   * Harmony emoji row by id (GET /emojis?id=), cached. Only a row whose id is
   * the requested one counts: Harmony before 1.6.16 ignores `id` and answers
   * every row.
   */
  private async harmonyEmojiRow(id: string): Promise<{ name: string; url: string } | null> {
    const now = Date.now()
    const cached = this.harmonyEmojiRows.get(id)
    if (cached && now - cached.at < (cached.row ? HARMONY_EMOJI_TTL_MS : HARMONY_EMOJI_MISS_TTL_MS)) return cached.row
    let rows: Array<{ id: string; name: string | null; url: string | null }>
    try {
      rows = await this.harmony.getEmojis(id)
    } catch (err) {
      this.log.debug(`Harmony emoji lookup failed: ${errorText(err)}`)
      return cached?.row ?? null
    }
    const match = rows.find(r => r?.id === id && typeof r.url === 'string' && /^https?:\/\//.test(r.url))
    const row = match ? { name: match.name || 'emoji', url: match.url! } : null
    this.harmonyEmojiRows.set(id, { row, at: now })
    return row
  }

  /**
   * Discord emoji for a Harmony emoji row: a row holding a Discord CDN emoji
   * is that emoji; any other image becomes an application emoji. Null when
   * it cannot be uploaded.
   */
  private async appEmojiForRow(row: { name: string; url: string }): Promise<AppEmoji | null> {
    const cdn = row.url.match(/^https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/emojis\/(\d+)\.(png|gif|webp)/)
    if (cdn) return { id: cdn[1], name: row.name.replace(/[^A-Za-z0-9_]/g, '_') || 'emoji', animated: cdn[2] === 'gif' }
    if (!this.media.isFetchable(row.url) && !isPublicHttpsUrl(row.url)) return null
    const ctx = this.appEmojiContext()
    if (!ctx) return null
    return ctx.store.resolve({ url: row.url, name: row.name }, ctx.io)
  }

  /**
   * Application emoji of a Harmony message's custom emoji, by Harmony emoji
   * id. Waits at most 4 s; uploads still running finish for later messages.
   */
  private async resolveAppEmojis(msg: any): Promise<Map<string, AppEmoji>> {
    const found = new Map<string, AppEmoji>()
    const wanted = collectHarmonyCustomEmoji(msg)
      .filter(emoji => !this.linkedDiscordEmoji(emoji.id))
      .slice(0, APP_EMOJI_PER_MESSAGE)
    if (wanted.length === 0 || !this.appEmojiContext()) return found
    const work = (async () => {
      for (const emoji of wanted) {
        const row = await this.harmonyEmojiRow(emoji.id)
        if (!row) continue
        const app = await this.appEmojiForRow(row).catch(() => null)
        if (app) found.set(emoji.id, app)
      }
    })()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, APP_EMOJI_WAIT_MS) })
    await Promise.race([work, deadline])
    clearTimeout(timer)
    return new Map(found)
  }

  // ===========================================================================
  // Replies and content
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
    } else if (!parent) {
      // Parent unknown to Harmony: the Discord message names its author.
      try {
        const dMsg = await discordChannel.messages.fetch(parentDiscordMessageId)
        if (!dMsg.webhookId && !dMsg.author.bot) {
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

  /** Translation context for Harmony → Discord. */
  private harmonyToDiscordContext(appEmoji: Map<string, AppEmoji>, uploaded?: ReadonlySet<string>): HarmonyToDiscordContext {
    return {
      discordRoleFor: id => this.permissionSyncStore.getDiscordRoleId(id),
      discordChannelFor: id => this.dir.getDiscordChannel(id),
      appEmojiFor: emoji => (typeof emoji?.id === 'string' ? appEmoji.get(emoji.id) : undefined) ?? null,
      discordEmojiFor: emoji => (typeof emoji?.id === 'string' ? this.linkedDiscordEmoji(emoji.id) : null),
      uploadedFiles: uploaded,
    }
  }

  /** Translation context for Discord → Harmony. */
  private discordToHarmonyContext(serverId?: string): DiscordToHarmonyContext {
    return {
      harmonyEmojiFor: discordEmojiId => this.linkedHarmonyEmoji(discordEmojiId, serverId),
      harmonyRoleFor: id => this.permissionSyncStore.getHarmonyRoleId(id),
      harmonyChannelFor: id => {
        for (const bridge of this.dir.getBridges()) {
          const pair = bridge.channelMappings.find(m => m.discord === id)
          if (pair) return { id: pair.harmony, serverId: bridge.harmonyServerId, name: pair.name ?? '' }
        }
        return null
      },
    }
  }

  /**
   * Reply formatting of a Harmony reply: a jump link to the Discord parent and
   * an @mention of its Discord author. Identity for anything else.
   */
  private async replyFormatting(
    msg: any,
    discordChannel: TextChannel,
    content: string,
  ): Promise<{ apply: (content: string) => string; userId: string | null }> {
    const none = { apply: (c: string) => c, userId: null }
    if (!msg.reply_to || !discordChannel.guildId) return none

    const parentDiscordId = await this.resolveParentDiscordId(msg.reply_to, msg.channel_id)
    if (!parentDiscordId) {
      this.log.debug(`Harmony reply parent ${msg.reply_to} has no Discord mapping; sending without reply link`)
      return none
    }

    const jumpLink = buildDiscordJumpLink(discordChannel.guildId, discordChannel.id, parentDiscordId)
    const { mention, userId } = await this.resolveReplyParentAuthorMention(
      msg.reply_to,
      parentDiscordId,
      discordChannel,
      content,
      msg.content_raw,
    )
    return { apply: (c: string) => formatHarmonyReplyForDiscord(jumpLink, mention, c), userId }
  }

  /** Harmony reply parent → Discord message id (memory, then metadata, then recent scan). */
  private async resolveParentDiscordId(harmonyReplyToId: string, harmonyChannelId: string): Promise<string | null> {
    const mapped = this.harmonyToDiscordMessages.get(harmonyReplyToId)
    if (mapped) return mapped

    try {
      const parent = await this.harmony.getMessage(harmonyReplyToId)
      const discordId = parent?.metadata?.discord_message_id
      if (discordId && parent?.id) {
        this.rememberMapping(parent)
        return String(discordId)
      }
    } catch (err) {
      this.log.debug(`getMessage failed for reply parent ${harmonyReplyToId}: ${errorText(err)}`)
    }

    try {
      const recent = await this.harmony.loadRecentMessages(harmonyChannelId, 100)
      const found = recent.find(m => m.id === harmonyReplyToId && m.metadata?.discord_message_id)
      if (found?.metadata?.discord_message_id) {
        this.rememberMapping(found)
        return String(found.metadata.discord_message_id)
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
   * prefix); strips the bridge's reply formatting from the content. A
   * forward's reference names the forwarded message, not a parent.
   */
  private async resolveDiscordReplyToHarmony(
    msg: DiscordMessage,
    harmonyChannelId: string,
  ): Promise<{ replyTo: string | null; cleanedContent: string }> {
    let content = msg.content ?? ''
    const isForward = msg.reference?.type === REFERENCE_FORWARD
    let discordParentId = isForward ? null : (msg.reference?.messageId ?? null)

    if (!discordParentId && !isForward) {
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

  /** Anti-spam identity of a Discord message: text plus attachments, stickers and forwarded content. */
  private static spamKey(msg: DiscordMessage): string {
    const extras: string[] = []
    for (const a of msg.attachments?.values() ?? []) extras.push(`a:${a.name}:${a.size}`)
    for (const s of msg.stickers?.values() ?? []) extras.push(`s:${s.id}`)
    for (const f of msg.messageSnapshots?.values() ?? []) extras.push(`f:${f.content ?? ''}:${f.attachments?.size ?? 0}`)
    return DiscordAuthorLimiter.contentKey(msg.content ?? '', extras)
  }

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
    const hasBody = !!msg.content || msg.attachments.size > 0 || (msg.stickers?.size ?? 0) > 0 || (msg.messageSnapshots?.size ?? 0) > 0
    if (!this.intentSelection?.active.message_content && !hasBody) {
      this.log.debug(`Skipping Discord message ${msg.id}: no content (Message Content Intent off)`)
      return
    }

    const verdict = this.antiSpam.check(msg.author.id, msg.channelId, BridgeRuntime.spamKey(msg))
    if (verdict !== 'ok') {
      this.noteSpamDrop(verdict, msg.channelId)
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
      const contentParts = this.translator.discordToHarmonyParts(msg, this.discordToHarmonyContext(await this.emojiServerFor(msg.guildId)), { content: cleanedContent })
      if (contentParts.length === 0) {
        this.log.debug(`Discord message ${msg.id} has nothing to bridge`)
        return
      }

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
      if (isAutomodBlocked(error)) {
        this.noteAutomodBlock(msg.channelId)
        return
      }
      if (!this.noteDrop('Discord → Harmony', error)) {
        this.log.error(`Failed to bridge Discord → Harmony (${msg.id}): ${errorText(error)}`)
      }
    }
  }

  /** Reaction emoji for Harmony; a custom emoji carries its CDN URL (`.gif` when animated). */
  private async discordReactionIdentifier(reaction: MessageReaction | PartialMessageReaction): Promise<{
    identifier: string | null
    metadata: Record<string, unknown>
  }> {
    if (reaction.emoji.id) {
      const serverId = await this.emojiServerFor(reaction.message.guildId)
      const linked = this.linkedHarmonyEmoji(reaction.emoji.id, serverId)
      if (linked) return { identifier: linked.id, metadata: {} }
      const animated = reaction.emoji.animated
        ?? reaction.message.guild?.emojis.cache.get(reaction.emoji.id)?.animated
        ?? false
      const payload = buildDiscordReactionPayload(reaction.emoji.name || 'unknown', reaction.emoji.id, animated)
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

      const { identifier, metadata: emojiMetadata } = await this.discordReactionIdentifier(reaction)
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

      const { identifier } = await this.discordReactionIdentifier(reaction)
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

      const contentParts = this.translator.discordToHarmonyParts(newMsg, this.discordToHarmonyContext(await this.emojiServerFor(newMsg.guildId)))
      await this.harmony.editMessage(harmonyMessageId, contentParts)
      this.log.info(`Discord → Harmony edit: ${newMsg.id} → ${harmonyMessageId}`)
    } catch (error) {
      if (isAutomodBlocked(error)) {
        this.noteAutomodBlock(newMsg.channelId)
        return
      }
      if (!this.noteDrop('Discord → Harmony edit', error)) {
        this.log.error(`Failed to bridge edit Discord → Harmony (${newMsg.id}): ${errorText(error)}`)
      }
    }
  }

  private async onDiscordMessageDelete(msg: DiscordMessage | PartialMessage) {
    if (!this.settings().syncDeletes) return
    if (await this.deleteHarmonyCopy(msg)) {
      this.log.info(`Discord → Harmony delete: ${msg.id} (channel ${msg.channelId})`)
    }
  }

  /** MESSAGE_DELETE_BULK (purge): each Discord-origin message loses its Harmony copy. */
  private async onDiscordMessageBulkDelete(messages: Array<DiscordMessage | PartialMessage>) {
    if (!this.settings().syncDeletes || messages.length === 0) return
    let deleted = 0
    for (const msg of messages) {
      if (await this.deleteHarmonyCopy(msg)) deleted++
    }
    if (deleted > 0) {
      this.log.info(`Discord → Harmony bulk delete: ${deleted} of ${messages.length} message(s) (channel ${messages[0].channelId})`)
    }
  }

  /**
   * Deletes the Harmony copy of a Discord-origin message. Copies of Harmony
   * messages (webhook or bot posts) are skipped: removing one on Discord does
   * not delete the Harmony original. True when a copy was deleted.
   */
  private async deleteHarmonyCopy(msg: DiscordMessage | PartialMessage): Promise<boolean> {
    if (msg.author?.bot || msg.webhookId) return false
    if (this.harmonyOriginCopies.has(msg.id)) return false

    const harmonyChannelId = this.dir.getHarmonyChannel(msg.channelId)
    if (!harmonyChannelId || !this.dir.shouldBridgeFromDiscord(msg.channelId)) return false

    const harmonyMessageId = this.discordToHarmonyMessages.get(msg.id)
    if (!harmonyMessageId) {
      this.log.debug(`No message mapping for Discord message ${msg.id}`)
      return false
    }

    try {
      this.deletedFromDiscord.set(msg.id, true)
      await this.harmony.deleteMessage(harmonyMessageId)
      this.discordToHarmonyMessages.delete(msg.id)
      this.harmonyToDiscordMessages.delete(harmonyMessageId)
      return true
    } catch (error) {
      this.deletedFromDiscord.delete(msg.id)
      if (!this.noteDrop('Discord → Harmony delete', error)) {
        this.log.error(`Failed to bridge delete Discord → Harmony (${msg.id}): ${errorText(error)}`)
      }
      return false
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
    h.on('gatewayRateLimited', () => {
      this.rateLimitedUntil = Date.now() + RATE_LIMIT_PROBLEM_MS
      this.notify('rate_limited')
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

    this.registerBridgeDataWithGateway({ immediate: true })
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

    if (msg.metadata?.discord_message_id && msg.id) this.rememberMapping(msg)

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
      const discordChannel = await this.fetchPairedChannel(client, discordChannelId)
      if (!discordChannel || !discordChannel.guild) {
        this.log.error(`Discord channel ${discordChannelId} not found or not in a guild`)
        return
      }

      const appEmoji = await this.resolveAppEmojis(msg)
      const links = this.translator.renderHarmonyForDiscord(msg, this.harmonyToDiscordContext(appEmoji))
      if (!links.content.trim()) {
        this.log.warn(`Harmony message ${msg.id} is empty after translation; not sent`)
        return
      }

      const files = collectHarmonyFiles(msg)
      const uploads = files.length > 0 ? await this.media.prepare(files, this.uploadBudget(discordChannel)) : []
      const primary = uploads.length > 0
        ? this.translator.renderHarmonyForDiscord(msg, this.harmonyToDiscordContext(appEmoji, new Set(uploads.map(u => u.key))))
        : links

      const reply = await this.replyFormatting(msg, discordChannel, primary.content)
      const inviteEmbeds = await buildHarmonyInviteDiscordEmbeds(msg, this.harmony, this.harmonyBaseUrl.hostname)
      const variant = (r: DiscordRendering, attached: PreparedUpload[]): OutboundVariant =>
        ({ content: reply.apply(r.content), files: attached, suppressEmbeds: r.suppressEmbeds })

      const outbound = await this.sendHarmonyToDiscord(discordChannel, {
        username: harmonyAuthorName(msg.author),
        avatarURL: this.webhookAvatarUrl(msg.author?.avatar),
        mentionUserIds: reply.userId && !primary.mentionUserIds.includes(reply.userId)
          ? [reply.userId, ...primary.mentionUserIds]
          : primary.mentionUserIds,
        embeds: inviteEmbeds,
        primary: variant(primary, uploads),
        linksOnly: uploads.length > 0 ? variant(links, []) : null,
      })

      if (!outbound) {
        this.log.error(`Could not send Harmony message ${msg.id} to Discord`)
        return
      }

      const [firstId] = outbound.discordMessageIds
      if (msg.id) {
        this.harmonyToDiscordMessages.set(msg.id, firstId)
        for (const id of outbound.discordMessageIds) {
          this.discordToHarmonyMessages.set(id, msg.id)
          this.harmonyOriginCopies.set(id, true)
        }
        this.harmonyDiscordViaWebhook.set(msg.id, outbound.viaWebhook)
        if (outbound.discordMessageIds.length > 1) this.harmonyDiscordChunks.set(msg.id, outbound.discordMessageIds)
        if (outbound.uploadedKeys.length > 0) this.harmonyDiscordUploads.set(msg.id, outbound.uploadedKeys)

        // Persisted so replies, edits and deletes survive restarts.
        try {
          await this.harmony.mergeMessageMetadata(msg.id, {
            discord_message_id: firstId,
            ...(outbound.discordMessageIds.length > 1 ? { discord_message_ids: outbound.discordMessageIds } : {}),
            ...(outbound.uploadedKeys.length > 0 ? { discord_uploaded_files: outbound.uploadedKeys } : {}),
            discord_via_webhook: outbound.viaWebhook,
            bridge_source: 'harmony',
          })
        } catch (err) {
          this.log.warn(`Failed to persist Discord ids on Harmony message ${msg.id}: ${errorText(err)}`)
        }
      }

      this.log.info(
        `Harmony → Discord (${outbound.viaWebhook ? 'webhook' : 'bot'}${outbound.uploadedKeys.length ? `, ${outbound.uploadedKeys.length} file(s)` : ''}): ${msg.id} → ${outbound.discordMessageIds.join(',')} (channel ${discordChannelId})`,
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
      const discordChannel = await this.fetchPairedChannel(client, discordChannelId)
      if (!discordChannel) {
        this.log.error(`Discord channel ${discordChannelId} not found`)
        return
      }

      const viaWebhook = await this.deliveryModeFor(discordChannel, msg, discordMessageId)
      if (viaWebhook === null) {
        this.log.warn(`Harmony edit ${msg.id}: Discord copy ${discordMessageId} is gone or unreadable; not edited`)
        return
      }

      const recorded = msg.metadata?.discord_uploaded_files
      const uploaded = new Set(this.harmonyDiscordUploads.get(msg.id) ?? (Array.isArray(recorded) ? recorded.map(String) : []))
      const appEmoji = await this.resolveAppEmojis(msg)
      const rendered = this.translator.renderHarmonyForDiscord(msg, this.harmonyToDiscordContext(appEmoji, uploaded))
      const reply = await this.replyFormatting(msg, discordChannel, rendered.content)
      const mentionUserIds = reply.userId && !rendered.mentionUserIds.includes(reply.userId)
        ? [reply.userId, ...rendered.mentionUserIds]
        : rendered.mentionUserIds

      const before = this.chunkIdsFor(msg, discordMessageId)
      const after = await this.editHarmonyOnDiscord(
        discordChannel,
        before,
        viaWebhook,
        reply.apply(rendered.content),
        {
          username: harmonyAuthorName(msg.author),
          avatarURL: this.webhookAvatarUrl(msg.author?.avatar),
        },
        mentionUserIds,
      )
      this.harmonyDiscordViaWebhook.set(msg.id, viaWebhook)
      for (const id of after) {
        this.discordToHarmonyMessages.set(id, msg.id)
        this.harmonyOriginCopies.set(id, true)
      }
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
    if (msg.metadata?.bridge_source === 'discord') {
      await this.deleteDiscordOriginal(msg)
      return
    }

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
      const discordChannel = await this.fetchPairedChannel(client, discordChannelId)
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
      this.harmonyDiscordUploads.delete(msg.id)
    } catch (error) {
      if (!this.noteDrop('Harmony → Discord delete', error)) {
        this.log.error(`Failed to bridge delete Harmony → Discord (${msg.id}): ${errorText(error)}`)
      }
    }
  }

  /**
   * A Discord-origin message deleted on Harmony (moderator, AutoMod): the
   * Discord original is deleted too. Needs Manage Messages in the channel;
   * without it the original stays and the channel is logged once. Harmony's
   * echo of a delete the bridge itself made is ignored.
   */
  private async deleteDiscordOriginal(msg: any) {
    const recorded = msg.metadata?.discord_message_id
    const discordId = recorded ? String(recorded) : this.harmonyToDiscordMessages.get(msg.id)
    if (!discordId) return
    this.harmonyToDiscordMessages.delete(msg.id)
    this.discordToHarmonyMessages.delete(discordId)
    if (this.deletedFromDiscord.has(discordId)) {
      this.deletedFromDiscord.delete(discordId)
      return
    }

    const discordChannelId = this.dir.getDiscordChannel(msg.channel_id)
    if (!discordChannelId || !this.dir.shouldBridgeFromHarmony(msg.channel_id)) return

    const client = this.discord
    if (!client || !this.discordReady) return

    try {
      const channel = await this.fetchPairedChannel(client, discordChannelId)
      if (!channel) return
      const me = channel.client.user
      if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
        if (!this.manageMessagesWarned.has(channel.id)) {
          this.manageMessagesWarned.add(channel.id)
          this.log.warn(
            `Channel ${channel.id}: Discord messages deleted on Harmony stay on Discord; the bot lacks Manage Messages there. Re-link the bot (Add to Discord) or grant it Manage Messages on that channel.`,
          )
        }
        return
      }
      await channel.messages.delete(discordId)
      this.log.info(`Harmony → Discord delete of a Discord message: ${msg.id} → ${discordId}`)
    } catch (error) {
      if (discordCode(error) === DISCORD_UNKNOWN_MESSAGE) {
        this.log.debug(`Discord message ${discordId} already gone`)
        return
      }
      if (!this.noteDrop('Harmony → Discord delete', error)) {
        this.log.error(`Failed to delete Discord message ${discordId} deleted on Harmony: ${errorText(error)}`)
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
      const newContent = await refreshDiscordAttachmentParts(content, this.currentDiscordToken(), this.fetchImpl)
      if (!newContent) return
      await this.harmony.silentUpdateMessageContent(messageId, newContent)
      this.log.info(`Refreshed expired attachment URLs for message ${messageId}`)
    } catch (error) {
      this.log.error(`Attachment refresh failed for ${messageId}: ${errorText(error)}`)
    }
  }

  /**
   * Harmony reaction emoji → Discord reaction identifier. A Harmony custom
   * emoji (`{id, name}`) becomes the application emoji uploaded from its
   * image; `discord:name:id` maps back to the Discord emoji; unicode passes
   * through. A bare name without an emoji row matches a guild emoji by name.
   */
  /** Harmony server of a bridged guild, with its emoji links loaded. */
  private async emojiServerFor(guildId: string | null | undefined): Promise<string | undefined> {
    const serverId = guildId ? this.dir.getBridgeForDiscordGuild(guildId)?.harmonyServerId : undefined
    if (serverId) await this.emojiLinks.ensure(serverId)
    return serverId
  }

  private async refreshEmojiLinks(): Promise<void> {
    for (const bridge of this.dir.getBridges()) {
      if (bridge.harmonyServerId) await this.emojiLinks.ensure(bridge.harmonyServerId)
    }
  }

  /** Harmony emoji row a Discord emoji is imported as; the message's server first. */
  private linkedHarmonyEmoji(discordEmojiId: string, serverId?: string) {
    if (serverId) {
      const own = this.emojiLinks.harmonyFor(serverId, discordEmojiId)
      if (own) return own
    }
    for (const bridge of this.dir.getBridges()) {
      const row = bridge.harmonyServerId ? this.emojiLinks.harmonyFor(bridge.harmonyServerId, discordEmojiId) : null
      if (row) return row
    }
    return null
  }

  /** Discord emoji a Harmony emoji was imported from. */
  private linkedDiscordEmoji(harmonyEmojiId: string): { id: string; name: string; animated: boolean } | null {
    for (const bridge of this.dir.getBridges()) {
      if (!bridge.harmonyServerId) continue
      const id = this.emojiLinks.discordFor(bridge.harmonyServerId, harmonyEmojiId)
      if (!id) continue
      const row = this.emojiLinks.harmonyFor(bridge.harmonyServerId, id)!
      return { id, name: row.name, animated: /\.gif(\?|$)/i.test(row.url ?? '') }
    }
    return null
  }

  private async resolveDiscordEmojiForReaction(
    channel: TextChannel,
    data: any,
  ): Promise<{ identifier: string; appUrl?: string } | null> {
    const emoji = data?.emoji
    if (emoji && typeof emoji === 'object' && typeof emoji.id === 'string' && emoji.id) {
      await this.emojiServerFor(channel.guild.id)
      const linked = this.linkedDiscordEmoji(emoji.id)
      if (linked) {
        const guildEmoji = channel.guild.emojis.cache.get(linked.id)
        return { identifier: guildEmoji ? guildEmoji.identifier : `${linked.animated ? 'a:' : ''}${linked.name}:${linked.id}` }
      }
      // Harmony 1.6.16 sends the image URL with the reaction; older gateways need a lookup.
      const row = typeof emoji.url === 'string' && /^https?:\/\//.test(emoji.url)
        ? { name: typeof emoji.name === 'string' && emoji.name ? emoji.name : 'emoji', url: emoji.url }
        : await this.harmonyEmojiRow(emoji.id)
      if (!row) return null
      const app = await this.appEmojiForRow(row)
      return app ? { identifier: `${app.animated ? 'a:' : ''}${app.name}:${app.id}`, appUrl: row.url } : null
    }

    const emojiName = BridgeRuntime.reactionEmojiName(data)
    if (!emojiName) return null
    const discordBridged = emojiName.match(/^discord:([^:]+):(\d+)$/)
    if (discordBridged) {
      const [, name, id] = discordBridged
      const byId = channel.guild.emojis.cache.get(id)
      if (byId) return { identifier: byId.identifier }
      return { identifier: `${name}:${id}` }
    }

    if (!/^[a-zA-Z0-9_+\-~]+$/.test(emojiName)) {
      return { identifier: emojiName }
    }
    const guildEmoji = channel.guild.emojis.cache.find(e => e.name === emojiName)
    return guildEmoji ? { identifier: guildEmoji.identifier } : null
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
      const discordChannel = await this.fetchPairedChannel(client, discordChannelId)
      if (!discordChannel) return

      const resolved = await this.resolveDiscordEmojiForReaction(discordChannel, data)
      if (!resolved) {
        this.log.debug('Harmony reaction: no Discord emoji for it')
        return
      }

      const reactionId = String(data.reaction_id ?? `${data.user_id ?? data.bot_id ?? '?'}:${resolved.identifier}`)
      if (!this.reactionLedger.add(String(data.message_id), resolved.identifier, reactionId)) {
        this.log.debug(`Harmony reaction added; Discord already shows it (${this.reactionLedger.count(String(data.message_id), resolved.identifier)} holder(s))`)
        return
      }

      const discordMessage = await discordChannel.messages.fetch(discordMessageId).catch(() => null)
      if (!discordMessage) {
        this.log.debug(`Harmony reaction: Discord message ${discordMessageId} not found`)
        return
      }

      try {
        await discordMessage.react(resolved.identifier)
      } catch (err) {
        // The application emoji was deleted elsewhere: upload again once.
        if (discordCode(err) !== DISCORD_UNKNOWN_EMOJI || !resolved.appUrl) throw err
        this.appEmojiContext()?.store.invalidate(resolved.appUrl)
        const again = await this.resolveDiscordEmojiForReaction(discordChannel, data)
        if (!again) throw err
        this.reactionLedger.remove(reactionId)
        this.reactionLedger.add(String(data.message_id), again.identifier, reactionId)
        await discordMessage.react(again.identifier)
      }
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
      const discordChannel = await this.fetchPairedChannel(client, discordChannelId)
      if (!discordChannel) return

      const discordMessage = await discordChannel.messages.fetch(discordMessageId).catch(() => null)
      if (!discordMessage) return

      const reaction = discordMessage.reactions.cache.find(r => r.emoji.identifier === known.emoji
        || r.emoji.name === known.emoji
        || (!!r.emoji.id && known.emoji.endsWith(`:${r.emoji.id}`)))
      if (reaction && client.user) {
        await reaction.users.remove(client.user.id)
        this.log.debug(`Harmony → Discord reaction removed on ${discordMessageId}`)
      }
    } catch (err) {
      this.log.error(`Failed to bridge reaction removal Harmony → Discord: ${errorText(err)}`)
    }
  }
}
