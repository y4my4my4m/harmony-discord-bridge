import { join } from 'path'
import { BridgeApi, BridgeApiError, type BridgeV2Config } from './BridgeApi.js'
import { V2Directory, type DirectoryChange } from './V2Directory.js'
import { buildStatusPayload } from './selfCheck.js'
import {
  BridgeRuntime,
  type BridgeRuntimeOptions,
  type HarmonyChannelOption,
} from '../runtime/BridgeRuntime.js'
import type { NewPair, PairWriter } from '../runtime/PairDirectory.js'
import type { SharedDiscordClient } from '../runtime/SharedDiscordClient.js'
import { detectProblems, type DiscordGuildView, type Problem } from '../problems.js'
import { Backoff, type FetchLike } from '../http.js'
import { Logger, errorText } from '../log.js'
import type { HealthReport } from '../health.js'

/** The parts of BridgeRuntime the orchestrator drives; tests substitute a fake. */
export interface RuntimeLike {
  harmony: { on(event: string, listener: (...args: any[]) => void): unknown }
  start(): Promise<void>
  stop(): Promise<void>
  onDirectoryChanged(change: Partial<DirectoryChange>): Promise<void>
  connectionProblems(): Problem[]
  guildViews(): DiscordGuildView[] | null
  discordIdentity(): ReturnType<BridgeRuntime['discordIdentity']>
  isDiscordConnected(): boolean
  isHarmonyConnected(): boolean
}

export interface V2BridgeOptions {
  /** Log prefix, e.g. the short bridge id in host mode. */
  label?: string
  harmonyToken: string
  apiBase: string
  gatewayUrl: string
  /** Public Harmony site URL; null → /config base_url → bot-gateway URL minus /bot-gateway. */
  baseUrl: string | null
  discordToken: string
  /** Instance bot client; replaces `discordToken`. */
  sharedDiscord?: SharedDiscordClient
  /** Directory for permission-sync.yml. */
  dataDir: string
  /** Directory of application emoji maps, shared by bridges of one application; default `<dataDir>/app-emojis`. */
  appEmojiDir?: string
  log: Logger
  version: string
  /** Log line for a Harmony token rejection. */
  authHint: string
  /** Log line for a Discord token rejection; default names DISCORD_TOKEN. */
  discordTokenHint?: string
  fetchImpl?: FetchLike
  configRefreshMs?: number
  heartbeatMs?: number
  /** Status sends after a state change wait this long to batch bursts. */
  statusDebounceMs?: number
  createRuntime?: (opts: BridgeRuntimeOptions) => RuntimeLike
}

class ApiPairWriter implements PairWriter {
  constructor(private readonly api: BridgeApi) {}

  async link(_guildId: string, pair: NewPair): Promise<void> {
    await this.api.createPair({
      discord_channel_id: pair.discord,
      discord_channel_name: pair.discordName ?? pair.name ?? '',
      harmony_channel_id: pair.harmony,
      direction: pair.direction,
    })
  }

  async linkMany(guildId: string, pairs: NewPair[]): Promise<NewPair[]> {
    const added: NewPair[] = []
    for (const pair of pairs) {
      try {
        await this.link(guildId, pair)
        added.push(pair)
      } catch (err) {
        if (err instanceof BridgeApiError && err.status === 409) continue
        throw err
      }
    }
    return added
  }

  async unlink(discordChannelId: string): Promise<boolean> {
    return this.api.deletePair(discordChannelId)
  }
}

function harmonyChannelOptions(config: BridgeV2Config): HarmonyChannelOption[] {
  return config.harmony_channels.map(c => ({
    id: String(c.id),
    name: String(c.name ?? ''),
    category: c.category ?? null,
    type: c.type,
  }))
}

/**
 * A v2 bridge: credentials in hand, configuration from bot-gateway.
 * GET /config at start, every 60 s and on BRIDGE_CONFIG_UPDATE;
 * POST /status every 30 s and shortly after any state change.
 */
export class V2Bridge {
  readonly api: BridgeApi
  private readonly log: Logger
  private directory: V2Directory | null = null
  private runtime: RuntimeLike | null = null
  private configJson = ''
  private configTimer: NodeJS.Timeout | null = null
  private heartbeatTimer: NodeJS.Timeout | null = null
  private bootstrapTimer: NodeJS.Timeout | null = null
  private statusTimer: NodeJS.Timeout | null = null
  private configSoonTimer: NodeJS.Timeout | null = null
  private configError: 'auth' | 'unreachable' | null = null
  private statusAuthFailed = false
  private lastGuildViews: DiscordGuildView[] | null = null
  private stopped = false
  private refreshing: Promise<void> | null = null
  private readonly unreachableBackoff = new Backoff(5_000, 5 * 60_000)
  private readonly authBackoff = new Backoff(60_000, 15 * 60_000)
  private lastConfigErrorLogged = ''

  constructor(private readonly opts: V2BridgeOptions) {
    this.log = opts.label ? opts.log.child(opts.label) : opts.log
    this.api = new BridgeApi(opts.apiBase, opts.harmonyToken, { fetchImpl: opts.fetchImpl })
  }

  /** Returns after the first configuration attempt; later attempts back off in the background. */
  async start(): Promise<void> {
    this.stopped = false
    await this.bootstrap()
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const t of [this.configTimer, this.heartbeatTimer]) if (t) clearInterval(t)
    for (const t of [this.bootstrapTimer, this.statusTimer, this.configSoonTimer]) if (t) clearTimeout(t)
    this.configTimer = this.heartbeatTimer = this.bootstrapTimer = this.statusTimer = this.configSoonTimer = null
    const runtime = this.runtime
    this.runtime = null
    await runtime?.stop()
  }

  private noteConfigError(err: unknown): 'auth' | 'unreachable' {
    const kind = err instanceof BridgeApiError && err.isAuth ? 'auth' : 'unreachable'
    this.configError = kind
    const line = kind === 'auth'
      ? this.opts.authHint
      : `Cannot load the bridge configuration from Harmony (${errorText(err)}); retrying.`
    if (this.lastConfigErrorLogged !== kind) {
      this.lastConfigErrorLogged = kind
      this.log.error(line)
    } else {
      this.log.debug(line)
    }
    return kind
  }

  private async bootstrap(): Promise<void> {
    if (this.stopped || this.runtime) return
    let config: BridgeV2Config
    try {
      config = await this.api.getConfig()
    } catch (err) {
      const kind = this.noteConfigError(err)
      const delay = (kind === 'auth' ? this.authBackoff : this.unreachableBackoff).next()
      this.bootstrapTimer = setTimeout(() => {
        this.bootstrapTimer = null
        void this.bootstrap()
      }, delay)
      return
    }
    if (this.stopped) return

    this.configError = null
    this.lastConfigErrorLogged = ''
    this.unreachableBackoff.reset()
    this.authBackoff.reset()
    this.configJson = JSON.stringify(config)
    const directory = new V2Directory(config)
    this.directory = directory

    const baseUrl = this.opts.baseUrl
      ?? config.base_url
      ?? this.opts.apiBase.replace(/\/bot-gateway\/?$/i, '')

    const runtimeOptions: BridgeRuntimeOptions = {
      mode: 'v2',
      directory,
      writer: new ApiPairWriter(this.api),
      discordToken: this.opts.discordToken,
      sharedDiscord: this.opts.sharedDiscord,
      harmony: {
        token: this.opts.harmonyToken,
        gatewayUrl: this.opts.gatewayUrl,
        apiUrl: this.opts.apiBase,
        baseUrl,
      },
      permissionStorePath: join(this.opts.dataDir, 'permission-sync.yml'),
      appEmojiDir: this.opts.appEmojiDir ?? join(this.opts.dataDir, 'app-emojis'),
      log: this.log,
      fetchImpl: this.opts.fetchImpl,
      hooks: {
        problems: () => this.currentProblems(),
        harmonyChannels: () => harmonyChannelOptions(directory.config()),
        onStateChange: () => this.statusSoon(),
        afterPairsWritten: () => this.refreshConfig('pairs written'),
        harmonyAuthHint: this.opts.authHint,
        discordTokenHint: this.opts.discordTokenHint,
      },
    }
    const runtime = (this.opts.createRuntime ?? ((o) => new BridgeRuntime(o)))(runtimeOptions)
    this.runtime = runtime

    runtime.harmony.on('bridgeConfigUpdate', (data: { bridge_id?: string } | undefined) => {
      if (data?.bridge_id && data.bridge_id !== directory.config().bridge_id) return
      this.refreshConfigSoon()
    })

    this.log.info(
      `Bridge ${config.bridge_id || '?'}: ${config.pairs.length} pair(s), guild ${config.discord_guild_id ?? '(not chosen)'}`,
    )

    this.configTimer = setInterval(() => { void this.refreshConfig('interval') }, this.opts.configRefreshMs ?? 60_000)
    this.heartbeatTimer = setInterval(() => { void this.sendStatus() }, this.opts.heartbeatMs ?? 30_000)

    try {
      await runtime.start()
    } catch (err) {
      this.log.error(`Bridge runtime failed to start: ${errorText(err)}`)
    }
    this.statusSoon()
  }

  private refreshConfigSoon() {
    if (this.configSoonTimer) clearTimeout(this.configSoonTimer)
    this.configSoonTimer = setTimeout(() => {
      this.configSoonTimer = null
      void this.refreshConfig('BRIDGE_CONFIG_UPDATE')
    }, 250)
  }

  /** Fetches /config and applies differences. Concurrent calls share one fetch. */
  refreshConfig(reason: string): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefreshConfig(reason).finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async doRefreshConfig(reason: string): Promise<void> {
    if (this.stopped || !this.directory || !this.runtime) return
    let config: BridgeV2Config
    try {
      config = await this.api.getConfig()
    } catch (err) {
      this.noteConfigError(err)
      this.statusSoon()
      return
    }
    const hadError = this.configError !== null
    this.configError = null
    this.lastConfigErrorLogged = ''

    const json = JSON.stringify(config)
    if (json === this.configJson) {
      if (hadError) this.statusSoon()
      return
    }
    this.configJson = json
    const change = this.directory.update(config)
    this.log.info(
      `Configuration updated (${reason}): ${config.pairs.length} pair(s), guild ${config.discord_guild_id ?? '(not chosen)'}`
      + `${change.settingsChanged ? ', settings changed' : ''}`,
    )
    try {
      await this.runtime.onDirectoryChanged(change)
    } catch (err) {
      this.log.error(`Applying configuration failed: ${errorText(err)}`)
    }
    this.statusSoon()
  }

  private statusSoon() {
    if (this.stopped || this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      void this.sendStatus()
    }, this.opts.statusDebounceMs ?? 2_000)
  }

  private configProblems(): Problem[] {
    if (this.configError === 'auth' || this.statusAuthFailed) return [{ code: 'harmony_auth_failed' }]
    if (this.configError === 'unreachable') return [{ code: 'harmony_unreachable' }]
    return []
  }

  /** Problems for status, /health and `/bridge status`. */
  currentProblems(): Problem[] {
    const runtime = this.runtime
    const config = this.directory?.config() ?? null
    const guilds = runtime?.guildViews() ?? null
    if (guilds) this.lastGuildViews = guilds
    return detectProblems({
      connection: [...(runtime?.connectionProblems() ?? []), ...this.configProblems()],
      guilds,
      scopedToSelection: this.opts.sharedDiscord !== undefined,
      config: config && {
        discord_guild_id: config.discord_guild_id,
        pairs: this.directory!.getAllMappings().map(p => ({
          harmony_channel_id: p.harmony,
          discord_channel_id: p.discord,
          direction: p.direction ?? 'both',
        })),
        harmony_channels: config.harmony_channels.map(c => ({ id: String(c.id), encrypted: c.encrypted === true })),
      },
    })
  }

  async sendStatus(): Promise<void> {
    const runtime = this.runtime
    if (this.stopped || !runtime) return
    const problems = this.currentProblems()
    const identity = runtime.discordIdentity()
    const payload = buildStatusPayload({
      version: this.opts.version,
      discordConnected: runtime.isDiscordConnected(),
      applicationId: identity.applicationId,
      botUser: identity.botUser,
      intents: identity.intents,
      guilds: runtime.guildViews() ?? this.lastGuildViews,
      harmonyConnected: runtime.isHarmonyConnected(),
      problems,
    })
    try {
      await this.api.postStatus(payload)
      if (this.statusAuthFailed) this.statusAuthFailed = false
      this.log.debug(`Status sent: ${problems.length} problem(s)`)
    } catch (err) {
      if (err instanceof BridgeApiError && err.isAuth) this.statusAuthFailed = true
      this.log.debug(`Status heartbeat failed: ${errorText(err)}`)
    }
  }

  /** The first /config has loaded. */
  configLoaded(): boolean {
    return this.directory !== null
  }

  /** discord_guild_id of the last loaded /config. */
  linkedGuildId(): string | null {
    return this.directory?.config().discord_guild_id ?? null
  }

  health(): HealthReport {
    const runtime = this.runtime
    const discord = runtime?.isDiscordConnected() ?? false
    const harmony = runtime?.isHarmonyConnected() ?? false
    return {
      ok: discord && harmony,
      body: {
        bridge_id: this.directory?.config().bridge_id ?? null,
        discord: { connected: discord },
        harmony: { connected: harmony },
        problems: this.currentProblems().map(p => p.code),
      },
    }
  }
}
