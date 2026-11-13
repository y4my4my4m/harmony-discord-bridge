import type { DiscordStickerImport, HarmonyStickerSyncRow } from '../HarmonyClient.js'
import type { SyncHarmonyItem } from './expressionSync.js'

export interface DiscordStickerInput {
  id: string
  name: string | null
  description: string | null
  /** Discord format_type: 1 PNG, 2 APNG, 3 Lottie, 4 GIF. */
  formatType: number
  available: boolean
}

export type DesiredSticker = DiscordStickerImport

export type StickerSkip = { id: string; name: string; reason: 'lottie' | 'name' }

const NAME_MAX = 30
const DESCRIPTION_MAX = 300
const LOTTIE = 3

function cut(s: string, max: number): string {
  return Array.from(s).slice(0, max).join('')
}

export function isStickerSkip(x: DesiredSticker | StickerSkip): x is StickerSkip {
  return 'reason' in x
}

export function desiredSticker(s: DiscordStickerInput): DesiredSticker | StickerSkip {
  // Trim again after the cut: Harmony stores btrim(name), so a trailing space would never match.
  const name = cut((s.name ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim(), NAME_MAX).trim()
  if (s.formatType === LOTTIE) return { id: s.id, name, reason: 'lottie' }
  if (Array.from(name).length < 2) return { id: s.id, name, reason: 'name' }
  const description = cut((s.description ?? '').trim(), DESCRIPTION_MAX).trim() || name
  return { id: s.id, name, description, formatType: s.formatType }
}

export function harmonyStickerSyncItem(r: HarmonyStickerSyncRow): SyncHarmonyItem & { description: string } {
  return { id: r.id, name: r.name, description: r.description, discordId: r.discord_sticker_id, removed: r.removed }
}

export function stickerDiffers(d: DesiredSticker, h: { name: string; description: string }): boolean {
  return d.name !== h.name || d.description !== h.description
}
