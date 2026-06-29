import { readFileSync, writeFileSync, existsSync, watch as fsWatch, FSWatcher } from 'fs'
import { parse, stringify } from 'yaml'
import { EventEmitter } from 'events'

export interface ChannelMapping {
  discord: string // Discord channel ID
  harmony: string // Harmony channel ID
  bidirectional: boolean
  name?: string // Human-friendly name
}

export interface BridgeInstance {
  /** Discord guild (server) ID */
  discordGuildId: string
  /** Harmony server UUID */
  harmonyServerId: string
  channelMappings: ChannelMapping[]
  /** Optional label for logs */
  name?: string
}

export interface BridgeConfig {
  discord: {
    token: string
    /** @deprecated Use `bridges[].discordGuildId` — kept for single-bridge configs */
    guildId?: string
  }
  harmony: {
    token: string
    gatewayUrl: string
    apiUrl: string
    /** @deprecated Use `bridges[].harmonyServerId` */
    serverId?: string
    baseUrl: string
    /** Optional pairing code from Harmony Server Settings */
    pairingCode?: string
  }
  /** @deprecated Use `bridges[].channelMappings` */
  channelMappings?: ChannelMapping[]
  /** One bot token can bridge multiple Discord↔Harmony server pairs */
  bridges?: BridgeInstance[]
  settings: {
    syncAttachments: boolean
    syncReactions: boolean
    syncEdits: boolean
    syncDeletes: boolean
    mentionTranslation: boolean
    cloneRoles?: boolean
    syncPermissions?: boolean
    syncPresence?: boolean
  }
}

type NormalizedBridgeConfig = BridgeConfig & { bridges: BridgeInstance[] }

export class ChannelMapper extends EventEmitter {
  private config: NormalizedBridgeConfig
  private configPath: string
  private watcher: FSWatcher | null = null
  private reloadTimer: NodeJS.Timeout | null = null
  private savingSelf = false

  constructor(configPath: string = './config/bridge-config.yml') {
    super()
    this.configPath = configPath
    this.config = this.normalizeConfig(this.loadRawConfig())
  }

  private loadRawConfig(): BridgeConfig {
    if (!existsSync(this.configPath)) {
      throw new Error(`Config file not found: ${this.configPath}`)
    }

    const fileContent = readFileSync(this.configPath, 'utf8')
    return parse(fileContent) as BridgeConfig
  }

  private normalizeConfig(raw: BridgeConfig): NormalizedBridgeConfig {
    if (raw.bridges && raw.bridges.length > 0) {
      for (const bridge of raw.bridges) {
        if (!bridge.discordGuildId || !bridge.harmonyServerId) {
          throw new Error('Each bridges[] entry requires discordGuildId and harmonyServerId')
        }
        bridge.channelMappings = bridge.channelMappings ?? []
      }
      return { ...raw, bridges: raw.bridges }
    }

    const guildId = raw.discord?.guildId
    const serverId = raw.harmony?.serverId
    if (!guildId || !serverId) {
      throw new Error(
        'Config must define bridges[] or legacy discord.guildId + harmony.serverId',
      )
    }

    return {
      ...raw,
      bridges: [{
        discordGuildId: guildId,
        harmonyServerId: serverId,
        channelMappings: raw.channelMappings ?? [],
      }],
    }
  }

  saveConfig() {
    const toSave = this.serializeConfig()
    const yamlContent = stringify(toSave)
    this.savingSelf = true
    try {
      writeFileSync(this.configPath, yamlContent, 'utf8')
    } finally {
      setTimeout(() => { this.savingSelf = false }, 500)
    }
    console.log('✅ Config saved to', this.configPath)
  }

  /** Persist multi-bridge shape when more than one pair is configured. */
  private serializeConfig(): BridgeConfig {
    const { bridges, ...rest } = this.config
    if (bridges.length === 1) {
      const only = bridges[0]
      return {
        ...rest,
        discord: { ...rest.discord, guildId: only.discordGuildId },
        harmony: { ...rest.harmony, serverId: only.harmonyServerId },
        channelMappings: only.channelMappings,
      }
    }
    return {
      ...rest,
      bridges: bridges.map(b => ({
        discordGuildId: b.discordGuildId,
        harmonyServerId: b.harmonyServerId,
        channelMappings: b.channelMappings,
        ...(b.name ? { name: b.name } : {}),
      })),
    }
  }

  startWatching() {
    if (this.watcher) return
    try {
      this.watcher = fsWatch(this.configPath, (eventType) => {
        if (eventType !== 'change') return
        if (this.savingSelf) return
        if (this.reloadTimer) clearTimeout(this.reloadTimer)
        this.reloadTimer = setTimeout(() => this.reloadFromDisk(), 250)
      })
      console.log(`👀 Watching ${this.configPath} for changes (live reload)`)
    } catch (err) {
      console.warn(`⚠️  Could not watch config file: ${(err as Error).message}`)
    }
  }

  stopWatching() {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer)
      this.reloadTimer = null
    }
  }

  private reloadFromDisk() {
    try {
      const next = this.normalizeConfig(this.loadRawConfig())
      const prevCount = this.getTotalMappingCount()
      this.config = next
      console.log(`🔁 Config reloaded (${this.getTotalMappingCount()} mappings across ${next.bridges.length} bridge(s))`)
      this.emit('configReloaded', {
        previousCount: prevCount,
        currentCount: this.getTotalMappingCount(),
      })
    } catch (err) {
      console.error(`❌ Failed to reload config: ${(err as Error).message}`)
    }
  }

  getConfig(): NormalizedBridgeConfig {
    return this.config
  }

  /**
   * Resolve pairingCode via bot-gateway public lookup (fills serverId / URLs).
   */
  async resolveHarmonyPairing(): Promise<void> {
    const code = this.config.harmony.pairingCode?.trim()
    if (!code) return

    const base = (this.config.harmony.baseUrl || '').replace(/\/$/, '')
    if (!base || base.includes('example')) {
      console.warn('⚠️ pairingCode set but harmony.baseUrl is missing — cannot resolve pairing')
      return
    }

    try {
      const lookupUrl = `${base}/bot-gateway/bridge-setup/${encodeURIComponent(code.toUpperCase())}`
      const res = await fetch(lookupUrl)
      if (!res.ok) {
        console.warn(`⚠️ Pairing lookup failed (${res.status}): ${lookupUrl}`)
        return
      }

      const data = await res.json() as {
        server_id?: string
        base_url?: string
        gateway_url_remote?: string
        api_url_remote?: string
        gateway_url_colocated?: string
        api_url_colocated?: string
      }

      if (data.base_url) {
        this.config.harmony.baseUrl = data.base_url.replace(/\/$/, '')
      }

      if (data.server_id) {
        for (const bridge of this.config.bridges) {
          const sid = bridge.harmonyServerId
          if (!sid || /YOUR_|UUID/i.test(sid)) {
            bridge.harmonyServerId = data.server_id
          }
        }
      }

      const apiUrl = this.config.harmony.apiUrl || ''
      const gatewayUrl = this.config.harmony.gatewayUrl || ''
      if (
        (!apiUrl || /YOUR_/i.test(apiUrl))
        && data.api_url_remote
        && data.gateway_url_remote
      ) {
        const useColocated =
          apiUrl.includes('localhost') || gatewayUrl.includes('localhost')
        this.config.harmony.apiUrl = useColocated
          ? (data.api_url_colocated || apiUrl)
          : data.api_url_remote
        this.config.harmony.gatewayUrl = useColocated
          ? (data.gateway_url_colocated || gatewayUrl)
          : data.gateway_url_remote
      }

      console.log(`🔗 Resolved pairing ${code.toUpperCase()} → Harmony server ${data.server_id}`)
    } catch (err) {
      console.warn('⚠️ Pairing resolve failed:', (err as Error).message)
    }
  }

  getBridges(): BridgeInstance[] {
    return this.config.bridges
  }

  getBridgeForDiscordGuild(guildId: string): BridgeInstance | undefined {
    return this.config.bridges.find(b => b.discordGuildId === guildId)
  }

  getBridgeForHarmonyServer(serverId: string): BridgeInstance | undefined {
    return this.config.bridges.find(b => b.harmonyServerId === serverId)
  }

  findBridgeByDiscordChannel(discordChannelId: string): BridgeInstance | undefined {
    return this.config.bridges.find(b =>
      b.channelMappings.some(m => m.discord === discordChannelId),
    )
  }

  findBridgeByHarmonyChannel(harmonyChannelId: string): BridgeInstance | undefined {
    return this.config.bridges.find(b =>
      b.channelMappings.some(m => m.harmony === harmonyChannelId),
    )
  }

  getDiscordGuildIds(): string[] {
    return this.config.bridges.map(b => b.discordGuildId)
  }

  getHarmonyServerIds(): string[] {
    return this.config.bridges.map(b => b.harmonyServerId)
  }

  getTotalMappingCount(): number {
    return this.config.bridges.reduce((sum, b) => sum + b.channelMappings.length, 0)
  }

  isConfiguredDiscordGuild(guildId: string): boolean {
    return this.config.bridges.some(b => b.discordGuildId === guildId)
  }

  getHarmonyChannel(discordChannelId: string): string | null {
    for (const bridge of this.config.bridges) {
      const mapping = bridge.channelMappings.find(m => m.discord === discordChannelId)
      if (mapping) return mapping.harmony
    }
    return null
  }

  shouldBridgeFromDiscord(discordChannelId: string): boolean {
    return this.getHarmonyChannel(discordChannelId) !== null
  }

  getDiscordChannel(harmonyChannelId: string): string | null {
    for (const bridge of this.config.bridges) {
      const mapping = bridge.channelMappings.find(m => m.harmony === harmonyChannelId)
      if (mapping) return mapping.discord
    }
    return null
  }

  shouldBridgeFromHarmony(harmonyChannelId: string): boolean {
    for (const bridge of this.config.bridges) {
      const mapping = bridge.channelMappings.find(m => m.harmony === harmonyChannelId)
      if (!mapping) continue
      return mapping.bidirectional !== false
    }
    return false
  }

  addMapping(
    discord: string,
    harmony: string,
    bidirectional: boolean = true,
    name?: string,
    discordGuildId?: string,
  ) {
    const bridge = discordGuildId
      ? this.getBridgeForDiscordGuild(discordGuildId)
      : this.config.bridges.length === 1 ? this.config.bridges[0] : undefined

    if (!bridge) {
      throw new Error('discordGuildId is required when multiple bridges are configured')
    }

    const exists = this.config.bridges.some(b =>
      b.channelMappings.some(m => m.discord === discord || m.harmony === harmony),
    )
    if (exists) {
      throw new Error('Mapping already exists for one or both channels')
    }

    bridge.channelMappings.push({ discord, harmony, bidirectional, name })
    this.saveConfig()
    console.log(`✅ Added mapping: ${discord} <-> ${harmony} (guild ${bridge.discordGuildId})`)
  }

  addMappingsBatch(entries: ChannelMapping[], discordGuildId?: string): ChannelMapping[] {
    const bridge = discordGuildId
      ? this.getBridgeForDiscordGuild(discordGuildId)
      : this.config.bridges.length === 1 ? this.config.bridges[0] : undefined

    if (!bridge) {
      throw new Error('discordGuildId is required when multiple bridges are configured')
    }

    const taken = new Set<string>()
    for (const b of this.config.bridges) {
      for (const m of b.channelMappings) {
        taken.add(m.discord)
        taken.add(m.harmony)
      }
    }

    const added: ChannelMapping[] = []
    for (const entry of entries) {
      if (taken.has(entry.discord) || taken.has(entry.harmony)) continue
      bridge.channelMappings.push(entry)
      taken.add(entry.discord)
      taken.add(entry.harmony)
      added.push(entry)
    }
    if (added.length > 0) {
      this.saveConfig()
    }
    return added
  }

  removeMapping(discordChannelId: string): boolean {
    let removed = false
    for (const bridge of this.config.bridges) {
      const before = bridge.channelMappings.length
      bridge.channelMappings = bridge.channelMappings.filter(m => m.discord !== discordChannelId)
      if (bridge.channelMappings.length !== before) removed = true
    }
    if (removed) {
      this.saveConfig()
      console.log(`🗑️ Removed mapping for Discord channel ${discordChannelId}`)
    }
    return removed
  }

  getAllMappings(discordGuildId?: string): ChannelMapping[] {
    if (discordGuildId) {
      return this.getBridgeForDiscordGuild(discordGuildId)?.channelMappings ?? []
    }
    return this.config.bridges.flatMap(b => b.channelMappings)
  }

  getSettings() {
    return this.config.settings
  }

  updateSetting(key: keyof BridgeConfig['settings'], value: boolean) {
    this.config.settings[key] = value
    this.saveConfig()
  }
}
