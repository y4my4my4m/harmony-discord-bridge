export type PairDirection = 'both' | 'to_harmony' | 'to_discord'

export interface ChannelPair {
  /** Discord channel id */
  discord: string
  /** Harmony channel id */
  harmony: string
  /** v1 semantics: false = Discord → Harmony only. Equals `direction === 'both'`. */
  bidirectional: boolean
  direction?: PairDirection
  name?: string
}

export interface BridgeScope {
  discordGuildId: string
  harmonyServerId: string
  channelMappings: ChannelPair[]
  name?: string
}

/** Behavior switches the runtime reads on every event. */
export interface RuntimeSettings {
  syncReactions: boolean
  syncEdits: boolean
  syncDeletes: boolean
  syncPresence: boolean
  syncMemberList: boolean
  syncPermissions: boolean
  cloneRoles: boolean
}

/**
 * Read side of the channel pairing, implemented by ChannelMapper (v1 YAML)
 * and V2Directory (bot-gateway /bridge/v2/config).
 */
export interface PairDirectory {
  runtimeSettings(): RuntimeSettings
  getBridges(): BridgeScope[]
  getBridgeForDiscordGuild(guildId: string): BridgeScope | undefined
  getDiscordGuildIds(): string[]
  getHarmonyServerIds(): string[]
  getTotalMappingCount(): number
  isConfiguredDiscordGuild(guildId: string): boolean
  getHarmonyChannel(discordChannelId: string): string | null
  getDiscordChannel(harmonyChannelId: string): string | null
  shouldBridgeFromDiscord(discordChannelId: string): boolean
  shouldBridgeFromHarmony(harmonyChannelId: string): boolean
  getAllMappings(discordGuildId?: string): ChannelPair[]
}

export interface NewPair {
  discord: string
  discordName?: string
  harmony: string
  direction: PairDirection
  name?: string
}

/** Write side: YAML edits in v1, POST/DELETE /bridge/v2/pairs in v2. */
export interface PairWriter {
  link(guildId: string, pair: NewPair): Promise<void>
  /** Pairs that conflict with existing ones are skipped; returns those written. */
  linkMany(guildId: string, pairs: NewPair[]): Promise<NewPair[]>
  unlink(discordChannelId: string): Promise<boolean>
}

export function directionLabel(direction: PairDirection | undefined, bidirectional: boolean): string {
  const dir = direction ?? (bidirectional ? 'both' : 'to_harmony')
  if (dir === 'to_harmony') return 'Discord → Harmony only'
  if (dir === 'to_discord') return 'Harmony → Discord only'
  return 'bidirectional'
}
