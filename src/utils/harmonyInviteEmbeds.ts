import type { APIEmbed } from 'discord.js'
import type { HarmonyClient } from '../HarmonyClient.js'

const INVITE_PATH_RE = /^\/invite\/([A-Za-z0-9]+)$/

export interface HarmonyInvitePreview {
  code: string
  invite_url: string
  server_name: string
  server_description?: string | null
  server_icon_url?: string | null
  member_count?: number | null
}

/** Collect unique Harmony invite URLs from a bridged message. */
export function collectHarmonyInviteUrls(
  msg: { content?: string; content_raw?: unknown[]; metadata?: { embeds?: Record<string, { provider?: string; url?: string }> } },
  harmonyHostname: string,
): string[] {
  const urls = new Set<string>()

  const consider = (raw?: string) => {
    if (!raw) return
    const normalized = normalizeInviteUrl(raw, harmonyHostname)
    if (normalized) urls.add(normalized)
  }

  if (Array.isArray(msg.content_raw)) {
    for (const part of msg.content_raw) {
      const p = part as { type?: string; url?: string }
      if (p.type === 'url') consider(p.url)
    }
  }

  const embeds = msg.metadata?.embeds
  if (embeds && typeof embeds === 'object') {
    for (const [url, payload] of Object.entries(embeds)) {
      if (payload?.provider === 'harmony-invite' || isHarmonyInviteUrl(url, harmonyHostname)) {
        consider(url)
      }
    }
  }

  if (msg.content) {
    const urlRegex = /https?:\/\/[^\s<]+/g
    let match: RegExpExecArray | null
    while ((match = urlRegex.exec(msg.content)) !== null) {
      consider(match[0].replace(/[>,]+$/, ''))
    }
  }

  return [...urls]
}

function normalizeInviteUrl(raw: string, harmonyHostname: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (!isHarmonyInviteUrl(url.toString(), harmonyHostname)) return null
    url.hash = ''
    url.search = ''
    return url.toString()
  } catch {
    return null
  }
}

export function isHarmonyInviteUrl(raw: string, harmonyHostname: string): boolean {
  try {
    const url = new URL(raw.trim())
    const host = url.hostname.toLowerCase()
    const hostname = harmonyHostname.toLowerCase()
    if (host !== hostname && host !== 'localhost') return false
    return INVITE_PATH_RE.test(url.pathname)
  } catch {
    return false
  }
}

export function getHarmonyInviteCode(raw: string, harmonyHostname: string): string | null {
  try {
    const url = new URL(raw.trim())
    if (!isHarmonyInviteUrl(url.toString(), harmonyHostname)) return null
    const match = url.pathname.match(INVITE_PATH_RE)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function previewFromMetadata(
  inviteUrl: string,
  embeds?: Record<string, { provider?: string; title?: string; description?: string; image?: string; siteName?: string }>,
): HarmonyInvitePreview | null {
  const payload = embeds?.[inviteUrl]
  if (!payload || payload.provider !== 'harmony-invite') return null
  const code = getHarmonyInviteCode(inviteUrl, new URL(inviteUrl).hostname)
  if (!code) return null
  return {
    code,
    invite_url: inviteUrl,
    server_name: payload.title || payload.siteName || 'Harmony Server',
    server_description: payload.description ?? null,
    server_icon_url: payload.image ?? null,
  }
}

function toDiscordEmbed(preview: HarmonyInvitePreview): APIEmbed {
  const embed: APIEmbed = {
    title: preview.server_name,
    url: preview.invite_url,
    description: preview.server_description?.trim() || 'Join this Harmony server',
    color: 0x5865f2,
    footer: { text: 'Harmony Server Invite' },
  }
  if (preview.server_icon_url) {
    embed.thumbnail = { url: preview.server_icon_url }
  }
  if (preview.member_count != null && preview.member_count > 0) {
    embed.fields = [{ name: 'Members', value: String(preview.member_count), inline: true }]
  }
  return embed
}

/** Build Discord embed cards for Harmony server invite links in a message. */
export async function buildHarmonyInviteDiscordEmbeds(
  msg: {
    content?: string
    content_raw?: unknown[]
    metadata?: { embeds?: Record<string, { provider?: string; title?: string; description?: string; image?: string; siteName?: string }> }
  },
  harmonyClient: HarmonyClient,
  harmonyHostname: string,
): Promise<APIEmbed[]> {
  const inviteUrls = collectHarmonyInviteUrls(msg, harmonyHostname)
  if (inviteUrls.length === 0) return []

  const embeds: APIEmbed[] = []
  for (const inviteUrl of inviteUrls.slice(0, 3)) {
    let preview = previewFromMetadata(inviteUrl, msg.metadata?.embeds)
    if (!preview) {
      const code = getHarmonyInviteCode(inviteUrl, harmonyHostname)
      if (!code) continue
      preview = await harmonyClient.fetchInvitePreview(code).catch(() => null)
      if (preview) preview.invite_url = inviteUrl
    }
    if (preview) embeds.push(toDiscordEmbed(preview))
  }
  return embeds
}
