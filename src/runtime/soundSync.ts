import type { DiscordSoundImport, HarmonyServerSound } from '../HarmonyClient.js'
import type { SyncHarmonyItem } from './expressionSync.js'

export interface DiscordSoundInput {
  soundId: string
  name: string
  volume: number
  emojiId: string | null
  emojiName: string | null
  available: boolean
}

export interface DesiredSound extends DiscordSoundImport {
  /** The Discord sound uses a custom emoji that has no Harmony counterpart yet. */
  hadUnimportedEmoji: boolean
}

export function desiredSound(d: DiscordSoundInput, harmonyEmojiFor: (discordEmojiId: string) => string | null): DesiredSound {
  const volume = Math.min(1, Math.max(0, Math.round(d.volume * 100) / 100))
  let emoji: string | null = null
  let emojiId: string | null = null
  let hadUnimportedEmoji = false
  if (d.emojiId) {
    emojiId = harmonyEmojiFor(d.emojiId)
    hadUnimportedEmoji = emojiId === null
  } else if (d.emojiName) {
    emoji = d.emojiName
  }
  return { id: d.soundId, name: d.name.trim(), volume, emoji, emojiId, hadUnimportedEmoji }
}

export function harmonySyncItem(row: HarmonyServerSound): SyncHarmonyItem & { row: HarmonyServerSound } {
  return { id: row.id, name: row.name, discordId: row.discord_sound_id, row }
}

/** An emoji the bridge cannot map is no difference: the Harmony sound keeps the emoji it has. */
export function soundDiffers(d: DesiredSound, h: { row: HarmonyServerSound }): boolean {
  const r = h.row
  if (d.name !== r.name || Math.round(Number(d.volume) * 100) !== Math.round(Number(r.volume) * 100)) return true
  if (d.hadUnimportedEmoji) return false
  return d.emoji !== r.emoji || d.emojiId !== r.emoji_id
}

/** The import body of an update: an unmapped custom emoji leaves the row's emoji in place. */
export function soundUpdate(d: DesiredSound, row: HarmonyServerSound): DiscordSoundImport {
  const { hadUnimportedEmoji, ...sound } = d
  return hadUnimportedEmoji ? { ...sound, emoji: row.emoji, emojiId: row.emoji_id } : sound
}
