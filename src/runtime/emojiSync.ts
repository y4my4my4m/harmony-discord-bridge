import type { HarmonyEmojiSyncRow } from '../HarmonyClient.js'
import type { SyncHarmonyItem } from './expressionSync.js'

export interface DiscordEmojiInput {
  id: string
  name: string | null
  animated: boolean
  available: boolean
}

export interface DesiredEmoji {
  /** Discord emoji id. */
  id: string
  name: string
  animated: boolean
}

/** Null when the name is empty after sanitizing. */
export function desiredEmoji(e: DiscordEmojiInput): DesiredEmoji | null {
  const name = (e.name ?? '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32)
  if (!name) return null
  return { id: e.id, name, animated: e.animated }
}

/**
 * `imported` and `restorable` are the gateway's (Harmony 1.9.7). Without `imported` a Discord link
 * stands in for it; without `restorable` a removed emoji stays removed.
 */
export function harmonyEmojiSyncItem(r: HarmonyEmojiSyncRow): SyncHarmonyItem {
  return {
    id: r.id,
    name: r.name,
    discordId: r.discord_emoji_id,
    removed: r.removed,
    removable: r.imported ?? r.discord_emoji_id !== null,
    restorable: r.restorable === true,
  }
}

export function emojiDiffers(d: DesiredEmoji, h: { name: string }): boolean {
  return d.name !== h.name
}

/** Ascending by snowflake value, for sorting Discord input. */
export function byDiscordId(a: { id: string }, b: { id: string }): number {
  const x = BigInt(a.id)
  const y = BigInt(b.id)
  return x < y ? -1 : x > y ? 1 : 0
}
