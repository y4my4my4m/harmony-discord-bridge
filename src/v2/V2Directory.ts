import type { BridgeV2Config } from './BridgeApi.js'
import type {
  BridgeScope,
  ChannelPair,
  PairDirection,
  PairDirectory,
  RuntimeSettings,
} from '../runtime/PairDirectory.js'

/** Defaults of discord_bridges.settings (bridge-v2 contract). */
const SETTING_DEFAULTS = {
  sync_member_list: true,
  sync_presence: false,
  sync_reactions: true,
  sync_edits: true,
  sync_deletes: true,
  sync_permissions: false,
  clone_roles: false,
} as const

export function normalizeV2Settings(raw: Record<string, unknown> | null | undefined): RuntimeSettings {
  const read = (key: keyof typeof SETTING_DEFAULTS): boolean => {
    const value = raw?.[key]
    return typeof value === 'boolean' ? value : SETTING_DEFAULTS[key]
  }
  return {
    syncMemberList: read('sync_member_list'),
    syncPresence: read('sync_presence'),
    syncReactions: read('sync_reactions'),
    syncEdits: read('sync_edits'),
    syncDeletes: read('sync_deletes'),
    syncPermissions: read('sync_permissions'),
    cloneRoles: read('clone_roles'),
  }
}

function normalizeDirection(raw: unknown): PairDirection {
  return raw === 'to_harmony' || raw === 'to_discord' ? raw : 'both'
}

export interface DirectoryChange {
  pairsChanged: boolean
  guildChanged: boolean
  settingsChanged: boolean
  addedHarmonyChannels: string[]
}

/** PairDirectory over GET /bridge/v2/config. One Discord guild ↔ one Harmony server. */
export class V2Directory implements PairDirectory {
  private cfg: BridgeV2Config
  private settings: RuntimeSettings
  private pairs: ChannelPair[]

  constructor(config: BridgeV2Config) {
    this.cfg = config
    this.settings = normalizeV2Settings(config.settings)
    this.pairs = V2Directory.toPairs(config)
  }

  private static toPairs(config: BridgeV2Config): ChannelPair[] {
    return config.pairs
      .filter(p => p && p.discord_channel_id && p.harmony_channel_id)
      .map(p => {
        const direction = normalizeDirection(p.direction)
        return {
          discord: String(p.discord_channel_id),
          harmony: String(p.harmony_channel_id),
          bidirectional: direction === 'both',
          direction,
          name: p.harmony_channel_name,
        }
      })
  }

  config(): BridgeV2Config {
    return this.cfg
  }

  update(next: BridgeV2Config): DirectoryChange {
    const prevPairs = this.pairs
    const prevSettings = this.settings
    const prevGuild = this.cfg.discord_guild_id

    this.cfg = next
    this.settings = normalizeV2Settings(next.settings)
    this.pairs = V2Directory.toPairs(next)

    const key = (p: ChannelPair) => `${p.discord}|${p.harmony}|${p.direction}`
    const before = new Set(prevPairs.map(key))
    const after = new Set(this.pairs.map(key))
    const prevHarmony = new Set(prevPairs.map(p => p.harmony))

    return {
      pairsChanged: before.size !== after.size || [...after].some(k => !before.has(k)),
      guildChanged: prevGuild !== next.discord_guild_id,
      settingsChanged: JSON.stringify(prevSettings) !== JSON.stringify(this.settings),
      addedHarmonyChannels: this.pairs.map(p => p.harmony).filter(h => !prevHarmony.has(h)),
    }
  }

  runtimeSettings(): RuntimeSettings {
    return this.settings
  }

  selectedGuildId(): string | null {
    return this.cfg.discord_guild_id
  }

  getBridges(): BridgeScope[] {
    const guildId = this.cfg.discord_guild_id
    if (!guildId) return []
    return [{
      discordGuildId: guildId,
      harmonyServerId: this.cfg.server_id,
      channelMappings: this.pairs,
    }]
  }

  getBridgeForDiscordGuild(guildId: string): BridgeScope | undefined {
    return this.getBridges().find(b => b.discordGuildId === guildId)
  }

  getDiscordGuildIds(): string[] {
    return this.cfg.discord_guild_id ? [this.cfg.discord_guild_id] : []
  }

  getHarmonyServerIds(): string[] {
    return this.cfg.server_id ? [this.cfg.server_id] : []
  }

  getTotalMappingCount(): number {
    return this.pairs.length
  }

  isConfiguredDiscordGuild(guildId: string): boolean {
    return this.cfg.discord_guild_id === guildId
  }

  getHarmonyChannel(discordChannelId: string): string | null {
    return this.pairs.find(p => p.discord === discordChannelId)?.harmony ?? null
  }

  getDiscordChannel(harmonyChannelId: string): string | null {
    return this.pairs.find(p => p.harmony === harmonyChannelId)?.discord ?? null
  }

  shouldBridgeFromDiscord(discordChannelId: string): boolean {
    const pair = this.pairs.find(p => p.discord === discordChannelId)
    return !!pair && pair.direction !== 'to_discord'
  }

  shouldBridgeFromHarmony(harmonyChannelId: string): boolean {
    const pair = this.pairs.find(p => p.harmony === harmonyChannelId)
    return !!pair && pair.direction !== 'to_harmony'
  }

  getAllMappings(discordGuildId?: string): ChannelPair[] {
    if (discordGuildId && discordGuildId !== this.cfg.discord_guild_id) return []
    return this.pairs
  }
}
