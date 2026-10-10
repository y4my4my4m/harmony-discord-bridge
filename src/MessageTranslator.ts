import { Logger } from './log.js'
import { isPublicHttpsUrl } from './utils/fetchCapped.js'

/** Discord MessageFlags.IsVoiceMessage. */
const VOICE_MESSAGE_FLAG = 1 << 13
/** Discord MessageReferenceType.Forward. */
const REFERENCE_FORWARD = 1
/** Discord StickerFormatType: 1 PNG, 2 APNG, 3 Lottie, 4 GIF. */
const STICKER_LOTTIE = 3
const STICKER_GIF = 4
/** Discord's allowed_mentions.users limit. */
const MAX_ALLOWED_USERS = 100

/** Split URLs glued without separators (`...pnghttps://...`). */
function extractGluedHttpUrls(text: string): string[] {
  if (!text) return []
  const regex = /https?:\/\/[^\s<>"']+?(?=https?:\/\/|\s|$|>)/g
  const urls: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    let url = match[0]
    while (url.length > 0 && /[.,;:!?)>\]}]$/.test(url)) {
      url = url.slice(0, -1)
    }
    if (url) urls.push(url)
  }
  return urls
}

/** Compare URLs ignoring fragments, query strings, and trailing slashes. */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'])
const TRACKING_PARAMS = /^(utm_\w+|si|fbclid|gclid|igshid|feature|ref_src|ref_url)$/i

/** YouTube video id of youtu.be/ID, /watch?v=ID, /shorts/ID, /embed/ID or /live/ID. */
function youtubeVideoId(u: URL): string | null {
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host === 'youtu.be') return u.pathname.split('/')[1] || null
  if (!YOUTUBE_HOSTS.has(host)) return null
  if (u.pathname === '/watch') return u.searchParams.get('v')
  const match = u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)
  return match ? match[1] : null
}

/** Equal for two URLs Discord treats as one link: host without www, no trailing slash, no tracking params. */
function normalizeUrlForDedup(url: string): string {
  try {
    const u = new URL(url)
    const videoId = youtubeVideoId(u)
    if (videoId) return `youtube:${videoId}`
    const host = u.host.toLowerCase().replace(/^www\./, '')
    const path = u.pathname.replace(/\/+$/, '')
    const params = [...u.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAMS.test(key))
      .sort(([a], [b]) => a.localeCompare(b))
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : ''
    return `${host}${path}${query}`
  } catch {
    return url.replace(/#.*$/, '').replace(/\/+$/, '')
  }
}

function collectNormalizedUrls(parts: any[]): Set<string> {
  const urls = new Set<string>()
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      for (const url of extractGluedHttpUrls(part.text)) {
        urls.add(normalizeUrlForDedup(url))
      }
    } else if (part.type === 'url' && part.url) {
      urls.add(normalizeUrlForDedup(part.url))
    }
  }
  return urls
}

function isUrlAlreadyRepresented(parts: any[], candidateUrl: string): boolean {
  const normalized = normalizeUrlForDedup(candidateUrl)
  return collectNormalizedUrls(parts).has(normalized)
}

/** Split prose into text + url parts (Discord `<https://...>` suppresses preview). */
function splitTextForUrlParts(text: string): any[] {
  if (!text) return []

  const regex = /https?:\/\/[^\s<>"']+?(?=https?:\/\/|\s|$|>)/g
  const parts: any[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const suppressed = match.index > 0 && text[match.index - 1] === '<'
    let segmentStart = match.index
    let segmentEnd = match.index + match[0].length
    let url = match[0]
    while (url.length > 0 && /[.,;:!?)>\]}]$/.test(url)) {
      url = url.slice(0, -1)
      segmentEnd -= 1
    }
    if (!url) continue

    if (suppressed) {
      segmentStart -= 1
      if (segmentEnd < text.length && text[segmentEnd] === '>') {
        segmentEnd += 1
      }
    }

    if (segmentStart > lastIndex) {
      const before = text.slice(lastIndex, segmentStart)
      if (before) parts.push({ type: 'text', text: before })
    }

    parts.push({ type: 'url', url, preview: !suppressed })
    lastIndex = segmentEnd
  }

  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex)
    if (tail) parts.push({ type: 'text', text: tail })
  }

  return parts.length > 0 ? parts : [{ type: 'text', text }]
}

/** Expand text parts into separate url parts so URLs aren't duplicated via embeds. */
function expandTextPartsWithUrls(parts: any[]): any[] {
  const result: any[] = []
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      result.push(...splitTextForUrlParts(part.text))
    } else {
      result.push(part)
    }
  }
  return result
}

export type HarmonyFileType = 'image' | 'video' | 'audio' | 'file'

export function inferAttachmentFileType(name: string, contentType: string, url: string): HarmonyFileType {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  if (contentType.startsWith('audio/')) return 'audio'
  const probe = `${name} ${url}`.toLowerCase()
  if (/\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)/.test(probe)) return 'image'
  if (/\.(mp3|ogg|oga|opus|wav|flac|m4a|aac)(\?|$)/.test(probe)) return 'audio'
  if (/\.(mp4|webm|mov|m4v|avi|mkv|ogv)(\?|$)/.test(probe)) return 'video'
  return 'file'
}

function splitGluedUrlsInParts(parts: any[]): any[] {
  const result: any[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue

    if (part.type === 'url' && part.url) {
      const split = extractGluedHttpUrls(part.url)
      if (split.length > 1) {
        for (const url of split) result.push({ ...part, url })
        continue
      }
    }

    if (part.type === 'text' && part.text) {
      const urls = extractGluedHttpUrls(part.text)
      if (urls.length > 1 && urls.join('') === part.text.replace(/\s/g, '')) {
        for (const url of urls) {
          const fileType = inferAttachmentFileType('', '', url)
          if (fileType === 'image' || fileType === 'video') {
            result.push({ type: 'file', url, fileType, fileName: url.split('/').pop() })
          } else {
            result.push({ type: 'url', url, preview: true })
          }
        }
        continue
      }
    }

    result.push(part)
  }
  return result
}

/**
 * `@user` / `@user@domain` typed as plain text. The `@` must follow the start,
 * whitespace or opening punctuation: `bob@example.com` and `/@user` in a URL
 * are not mentions. A federated domain needs a dot.
 */
const PLAIN_MENTION_RE = /(?<=^|[\s([{"'<>,;:!?*~|])@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+))?(?![\w@-])/g

/** Words that are never user mentions. */
const RESERVED_MENTIONS = new Set(['everyone', 'here'])

export interface HarmonyMentionLookup {
  id: string
  username: string
  displayName: string
  domain: string | null
  isLocal: boolean
}

/** Bridge state the Discord → Harmony translation consults. */
export interface DiscordToHarmonyContext {
  /** Discord role id → Harmony role id (permission-sync mapping). */
  harmonyRoleFor?: (discordRoleId: string) => string | undefined
  /** Paired Discord channel → its Harmony channel. */
  harmonyChannelFor?: (discordChannelId: string) => { id: string; serverId: string; name: string } | null
  /** Discord emoji id → the Harmony server emoji imported from it. */
  harmonyEmojiFor?: (discordEmojiId: string) => { id: string; name: string; url: string | null } | null
}

/** Bridge state the Harmony → Discord translation consults. */
export interface HarmonyToDiscordContext {
  /** Harmony role id → Discord role id (permission-sync mapping). */
  discordRoleFor?: (harmonyRoleId: string) => string | undefined
  /** Harmony channel id → paired Discord channel id. */
  discordChannelFor?: (harmonyChannelId: string) => string | null
  /** Harmony custom emoji part → Discord application emoji. */
  appEmojiFor?: (emoji: any) => { id: string; name: string; animated: boolean } | null
  /** Harmony emoji imported from Discord → that Discord emoji. */
  discordEmojiFor?: (emoji: any) => { id: string; name: string; animated: boolean } | null
  /** harmonyFileKey of files sent as Discord attachments; they produce no text. */
  uploadedFiles?: ReadonlySet<string>
}

export interface DiscordRendering {
  content: string
  /** Discord user ids of explicit mention parts, at most 100: allowed_mentions.users. */
  mentionUserIds: string[]
  /** Every link the author wrote asks for no preview, and nothing else would embed. */
  suppressEmbeds: boolean
}

/** A Harmony file part. */
export interface HarmonyFilePart {
  url: string
  /** message_media object name; absent on legacy public parts. */
  path: string | null
  /** Signed imgproxy render (1600×1600 contain, q82) the gateway adds to JPEG/PNG parts with a path. */
  renderUrl: string | null
  fileName: string
  fileSize: number | null
  fileType: string
}

/** Identity of a file part across events: its storage path, else its URL (signed URLs change per event). */
export function harmonyFileKey(part: { path?: unknown; url?: unknown }): string {
  return typeof part.path === 'string' && part.path ? part.path : String(part.url ?? '')
}

type DiscordSegmentKind = 'inline' | 'url' | 'file'

/** Characters that extend a URL when glued to one. */
const URL_CONTINUATION = /[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]/

/**
 * Join translated parts into one Discord message. Text, mentions, emoji and
 * hashtags join without a separator; the Harmony parts already carry their
 * own spacing. File parts sit on their own line. A url part gets a space only
 * where gluing would extend it (`...pnghttps://`).
 */
export function joinDiscordSegments(segments: Array<{ kind: DiscordSegmentKind; text: string }>): string {
  let out = ''
  let prevKind: DiscordSegmentKind | null = null
  for (const seg of segments) {
    if (!seg.text) continue
    let text = seg.text
    if (out && prevKind !== null) {
      if (seg.kind === 'file' || prevKind === 'file') {
        out = out.replace(/[ \t]+$/, '')
        text = text.replace(/^[ \t]+/, '')
        if (!out.endsWith('\n') && !text.startsWith('\n')) out += '\n'
      } else if (seg.kind === 'url' || prevKind === 'url') {
        const last = out[out.length - 1]
        if (URL_CONTINUATION.test(last) && URL_CONTINUATION.test(text[0])) out += ' '
      }
    }
    out += text
    prevKind = seg.kind
  }
  return out
}

/** File name from a file part, else the last URL path segment without query. */
export function harmonyFileName(part: { fileName?: unknown; url?: unknown }): string {
  if (typeof part.fileName === 'string' && part.fileName.trim()) return part.fileName.trim()
  const url = typeof part.url === 'string' ? part.url : ''
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
  } catch {
    // Not a URL.
  }
  return 'file'
}

/** `42 MB`, `512 KB`, `900 B` (binary units). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/**
 * Masked link for a file sent as a link: `[name · 42 MB](<url>)`. The angle
 * brackets stop Discord from previewing the signed storage URL.
 */
export function maskedFileLink(part: { url: string; fileName?: unknown; fileSize?: unknown }): string {
  const name = harmonyFileName(part).replace(/([\\[\]*_~`|()])/g, '\\$1')
  const size = typeof part.fileSize === 'number' && part.fileSize > 0 ? ` · ${formatFileSize(part.fileSize)}` : ''
  return `[${name}${size}](<${part.url.replace(/>/g, '%3E')}>)`
}

/**
 * Bare URL of a file part that Discord embeds from the link: an image or
 * video on a public https host outside Supabase storage, with no storage
 * path (GIF picker media). Harmony's `#harmony-…` fragment is dropped.
 * Null for anything else.
 */
export function embeddableMediaUrl(part: { url?: unknown; path?: unknown; fileName?: unknown; fileType?: unknown }): string | null {
  if (typeof part.url !== 'string' || (typeof part.path === 'string' && part.path)) return null
  if (!isPublicHttpsUrl(part.url)) return null
  const u = new URL(part.url)
  if (u.pathname.includes('/storage/v1/')) return null
  const type = typeof part.fileType === 'string'
    ? part.fileType
    : inferAttachmentFileType(typeof part.fileName === 'string' ? part.fileName : '', '', u.pathname)
  if (type !== 'image' && type !== 'video') return null
  if (u.hash.startsWith('#harmony-')) u.hash = ''
  return u.toString()
}

/** File parts of a Harmony message, in order. */
export function collectHarmonyFiles(msg: { content_raw?: unknown }): HarmonyFilePart[] {
  if (!Array.isArray(msg.content_raw)) return []
  const out: HarmonyFilePart[] = []
  for (const part of msg.content_raw) {
    const p = part as { type?: string; url?: unknown; path?: unknown; render_url?: unknown; fileName?: unknown; fileSize?: unknown; fileType?: unknown }
    if (p?.type !== 'file' || typeof p.url !== 'string' || !p.url) continue
    out.push({
      url: p.url,
      path: typeof p.path === 'string' && p.path ? p.path : null,
      renderUrl: typeof p.render_url === 'string' && p.render_url ? p.render_url : null,
      fileName: harmonyFileName(p),
      fileSize: typeof p.fileSize === 'number' ? p.fileSize : null,
      fileType: typeof p.fileType === 'string' ? p.fileType : 'file',
    })
  }
  return out
}

/** Harmony custom emoji parts (not Discord-bridged), by emoji id. */
export function collectHarmonyCustomEmoji(msg: { content_raw?: unknown }): Array<{ id: string; name: string }> {
  if (!Array.isArray(msg.content_raw)) return []
  const seen = new Map<string, { id: string; name: string }>()
  for (const part of msg.content_raw) {
    const emoji = (part as { type?: string; emoji?: any })?.type === 'emoji' ? (part as { emoji?: any }).emoji : null
    if (!emoji || emoji.domain === 'discord.com') continue
    if (typeof emoji.id === 'string' && emoji.id && typeof emoji.name === 'string' && !seen.has(emoji.id)) {
      seen.set(emoji.id, { id: emoji.id, name: emoji.name })
    }
  }
  return Array.from(seen.values())
}

function isVoiceMessage(msg: any): boolean {
  const flags = msg?.flags
  if (typeof flags?.has === 'function') return flags.has(VOICE_MESSAGE_FLAG)
  const bits = Number(flags?.bitfield ?? flags ?? 0)
  return (bits & VOICE_MESSAGE_FLAG) !== 0
}

function collectionValues<T = any>(coll: any): T[] {
  if (!coll) return []
  if (typeof coll.values === 'function') return Array.from(coll.values()) as T[]
  if (Array.isArray(coll)) return coll as T[]
  return []
}

/** Snapshots of a forwarded Discord message; empty for anything else. */
function forwardedSnapshots(msg: any): any[] {
  if (msg?.reference?.type !== REFERENCE_FORWARD) return []
  return collectionValues(msg.messageSnapshots)
}

/** Discord sticker CDN image; null for Lottie stickers. */
export function stickerImageUrl(sticker: { id: string; format?: number | null }): string | null {
  if (sticker.format === STICKER_LOTTIE) return null
  const ext = sticker.format === STICKER_GIF ? 'gif' : 'png'
  return `https://media.discordapp.net/stickers/${sticker.id}.${ext}`
}

export class MessageTranslator {
  private harmonyDomain: string | null = null
  private harmonyMemberLookup: ((username: string, domain: string | null) => HarmonyMentionLookup | null) | null = null

  constructor(private readonly log: Logger = new Logger()) {}

  /** Harmony instance domain for federation mentions; required before translating. */
  setHarmonyDomain(domain: string) {
    if (!domain) {
      throw new Error('Harmony domain is required')
    }
    this.harmonyDomain = domain
  }

  /** Resolve @user / @user@domain plain-text mentions against the Harmony member cache. */
  setHarmonyMemberLookup(
    lookup: (username: string, domain: string | null) => HarmonyMentionLookup | null,
  ) {
    this.harmonyMemberLookup = lookup
  }

  private buildHarmonyMentionPart(
    username: string,
    domain: string | null,
    lookup: HarmonyMentionLookup | null,
  ) {
    if (lookup) {
      return {
        type: 'mention',
        userId: lookup.id,
        username: lookup.username,
        domain: lookup.domain || this.getHarmonyDomain(),
        isLocal: lookup.isLocal,
        displayName: lookup.displayName,
      }
    }
    return {
      type: 'mention',
      userId: `unresolved-${username}`,
      username,
      domain: domain || null,
      isLocal: !domain,
      displayName: username,
    }
  }

  private getHarmonyDomain(): string {
    if (!this.harmonyDomain) {
      throw new Error('MessageTranslator: harmonyDomain not configured. Call setHarmonyDomain() first.')
    }
    return this.harmonyDomain
  }

  // ===========================================================================
  // Discord → Harmony
  // ===========================================================================

  /**
   * Harmony content parts for a Discord message. A forward becomes an
   * italic "↪ Forwarded" line followed by the snapshot's content and
   * attachments. `content` overrides the message text (reply prefix removed).
   */
  discordToHarmonyParts(discordMsg: any, ctx: DiscordToHarmonyContext = {}, overrides: { content?: string } = {}): any[] {
    const own = this.messageBody(discordMsg, discordMsg, ctx, overrides.content ?? discordMsg.content)
    const snapshots = forwardedSnapshots(discordMsg)
    if (snapshots.length === 0) return own

    const parts: any[] = [{ type: 'text', text: '*↪ Forwarded*\n' }]
    for (const snapshot of snapshots) {
      parts.push(...this.messageBody(snapshot, discordMsg, ctx, snapshot.content))
    }
    if (own.length > 0) parts.push({ type: 'text', text: '\n' }, ...own)
    return parts
  }

  /** Content, attachments, stickers and embeds of one message; `origin` locates attachments for refresh. */
  private messageBody(msg: any, origin: any, ctx: DiscordToHarmonyContext, content: unknown): any[] {
    const parts: any[] = typeof content === 'string' && content ? this.contentParts(msg, ctx, content) : []

    const voice = isVoiceMessage(msg)
    for (const attachment of collectionValues(msg.attachments)) {
      const fileType: HarmonyFileType = voice
        ? 'audio'
        : inferAttachmentFileType(attachment.name || '', attachment.contentType || '', attachment.url || '')
      parts.push({
        type: 'file',
        url: attachment.url,
        fileName: attachment.name,
        fileType,
        ...(typeof attachment.size === 'number' ? { fileSize: attachment.size } : {}),
        bridgeRef: {
          source: 'discord',
          discordChannelId: origin.channelId,
          discordMessageId: origin.id,
          discordAttachmentId: attachment.id,
        },
      })
    }

    for (const sticker of collectionValues(msg.stickers)) {
      const url = stickerImageUrl(sticker)
      if (url) {
        parts.push({ type: 'file', url, fileName: `${sticker.name || 'sticker'}.${url.endsWith('.gif') ? 'gif' : 'png'}`, fileType: 'image' })
      } else {
        parts.push({ type: 'text', text: `${parts.length > 0 ? '\n' : ''}[sticker: ${sticker.name || 'sticker'}]` })
      }
    }

    // Discord auto-embeds links already in the content, under the resolved URL (youtu.be/ID
    // becomes youtube.com/watch?v=ID): those are never new links. Only rich embeds (bots,
    // webhooks) and embeds of a message with no link of its own add url parts.
    const contentHasLink = collectNormalizedUrls(parts).size > 0
    for (const embed of collectionValues(msg.embeds)) {
      if (!embed?.url) continue
      if (contentHasLink && embed.type !== 'rich') continue
      if (isUrlAlreadyRepresented(parts, embed.url)) continue
      parts.push({ type: 'url', url: embed.url, preview: true })
    }

    return splitGluedUrlsInParts(parts)
  }

  /** Text with custom emoji, user/role/channel mentions and plain `@user` mentions as parts. */
  private contentParts(msg: any, ctx: DiscordToHarmonyContext, content: string): any[] {
    const parts: any[] = []
    // <a:name:id> / <:name:id>, <@id> / <@!id>, <@&id>, <#id>
    const tokenRegex = /<(a?):(\w+):(\d+)>|<@!?(\d+)>|<@&(\d+)>|<#(\d+)>/g
    let lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = tokenRegex.exec(content)) !== null) {
      if (match.index > lastIndex) parts.push({ type: 'text', text: content.substring(lastIndex, match.index) })

      const linked = match[2] && match[3] ? ctx.harmonyEmojiFor?.(match[3]) ?? null : null
      if (linked) {
        parts.push({
          type: 'emoji',
          emoji: { id: linked.id, name: linked.name, url: linked.url, domain: null, display_name: linked.name },
        })
      } else if (match[2] && match[3]) {
        const animated = match[1] === 'a'
        parts.push({
          type: 'emoji',
          emoji: {
            name: match[2],
            url: `https://cdn.discordapp.com/emojis/${match[3]}.${animated ? 'gif' : 'png'}`,
            id: null,
            domain: 'discord.com',
            display_name: match[2],
            server_id: null,
          },
        })
      } else if (match[4]) {
        const id = match[4]
        const member = msg.guild?.members?.cache?.get(id)
        const user = msg.mentions?.users?.get(id) ?? member?.user
        if (user) {
          parts.push({
            type: 'mention',
            userId: id,
            username: user.username,
            domain: 'discord.com',
            isLocal: false,
            displayName: member?.displayName || user.globalName || user.username,
            isBridged: true,
            bridgeSource: 'discord',
          })
        } else {
          parts.push({ type: 'text', text: match[0], literal: true })
        }
      } else if (match[5]) {
        // A role Discord did not ping (mention_roles) stays text: no ping on Harmony either.
        const id = match[5]
        const pinged = msg.mentions?.roles?.get(id)
        const role = pinged ?? msg.guild?.roles?.cache?.get(id)
        const harmonyRoleId = pinged ? ctx.harmonyRoleFor?.(id) : undefined
        if (harmonyRoleId) {
          const color = typeof role?.hexColor === 'string' && role.hexColor !== '#000000' ? role.hexColor : null
          parts.push({ type: 'role_mention', roleId: harmonyRoleId, roleName: role?.name ?? 'role', roleColor: color })
        } else {
          parts.push({ type: 'text', text: role?.name ? `@${role.name}` : '@deleted-role', literal: true })
        }
      } else if (match[6]) {
        const id = match[6]
        const channel = msg.mentions?.channels?.get(id) ?? msg.guild?.channels?.cache?.get(id)
        const paired = ctx.harmonyChannelFor?.(id)
        if (paired) {
          parts.push({ type: 'channel_mention', channelId: paired.id, serverId: paired.serverId, name: paired.name || channel?.name || 'channel' })
        } else {
          parts.push({ type: 'text', text: channel?.name ? `#${channel.name}` : '#unknown', literal: true })
        }
      }
      lastIndex = tokenRegex.lastIndex
    }
    if (lastIndex < content.length) parts.push({ type: 'text', text: content.substring(lastIndex) })

    const out: any[] = []
    for (const part of parts) {
      if (part.type !== 'text') {
        out.push(part)
        continue
      }
      if (part.literal) {
        out.push({ type: 'text', text: part.text })
        continue
      }
      out.push(...this.plainMentionParts(part.text))
    }

    // Separate url parts keep Harmony from gluing text and link into one broken URL.
    return expandTextPartsWithUrls(out)
  }

  private plainMentionParts(text: string): any[] {
    const out: any[] = []
    let last = 0
    PLAIN_MENTION_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = PLAIN_MENTION_RE.exec(text)) !== null) {
      const username = m[1]
      if (RESERVED_MENTIONS.has(username.toLowerCase())) continue
      if (m.index > last) out.push({ type: 'text', text: text.substring(last, m.index) })
      const domain = m[2] || null
      const lookup = this.harmonyMemberLookup?.(username, domain) ?? null
      this.log.debug(`D→H plain mention: @${username}${domain ? `@${domain}` : ''}${lookup ? ` → ${lookup.id}` : ' (unresolved)'}`)
      out.push(this.buildHarmonyMentionPart(username, domain, lookup))
      last = PLAIN_MENTION_RE.lastIndex
    }
    if (last < text.length) out.push({ type: 'text', text: text.substring(last) })
    return out
  }

  // ===========================================================================
  // Harmony → Discord
  // ===========================================================================

  /** Discord content of a Harmony message; see renderHarmonyForDiscord. */
  harmonyToDiscord(harmonyMsg: any, ctx: HarmonyToDiscordContext = {}): string {
    return this.renderHarmonyForDiscord(harmonyMsg, ctx).content
  }

  /**
   * Harmony message to Discord content. The result can exceed 2000
   * characters; the sender splits it (splitDiscordContent). A mention
   * becomes `<@id>` only for a Discord user (domain discord.com); Harmony
   * users stay `@user@domain`. Uploaded files produce no text, external
   * media its bare URL (embeddableMediaUrl); other files become masked links.
   */
  renderHarmonyForDiscord(harmonyMsg: any, ctx: HarmonyToDiscordContext = {}): DiscordRendering {
    const mentionIds: string[] = []
    let previewable = 0
    let suppressed = 0
    let content = ''

    if (Array.isArray(harmonyMsg.content_raw)) {
      const segments = harmonyMsg.content_raw.map((part: any): { kind: DiscordSegmentKind; text: string } => {
        switch (part?.type) {
          case 'text': {
            const text = part.text || ''
            if (/https?:\/\//.test(text)) previewable++
            return { kind: 'inline', text }
          }
          case 'mention': {
            if (part.domain === 'discord.com' && typeof part.userId === 'string' && /^\d+$/.test(part.userId)) {
              if (!mentionIds.includes(part.userId)) mentionIds.push(part.userId)
              return { kind: 'inline', text: `<@${part.userId}>` }
            }
            return { kind: 'inline', text: `@${part.username || 'unknown'}@${part.domain || this.getHarmonyDomain()}` }
          }
          case 'role_mention': {
            const discordRoleId = typeof part.roleId === 'string' ? ctx.discordRoleFor?.(part.roleId) : undefined
            return { kind: 'inline', text: discordRoleId ? `<@&${discordRoleId}>` : `@${part.roleName || 'role'}` }
          }
          case 'channel_mention': {
            const discordChannelId = typeof part.channelId === 'string' ? ctx.discordChannelFor?.(part.channelId) : null
            return { kind: 'inline', text: discordChannelId ? `<#${discordChannelId}>` : `#${part.name || 'channel'}` }
          }
          case 'emoji':
            return { kind: 'inline', text: this.emojiText(part.emoji, ctx) }
          case 'file': {
            if (!part.url || ctx.uploadedFiles?.has(harmonyFileKey(part))) return { kind: 'file', text: '' }
            const media = embeddableMediaUrl(part)
            if (media) {
              previewable++
              return { kind: 'file', text: media }
            }
            return { kind: 'file', text: maskedFileLink(part) }
          }
          case 'url': {
            if (!part.url) return { kind: 'url', text: '' }
            if (part.preview === false) {
              suppressed++
              return { kind: 'url', text: `<${part.url}>` }
            }
            previewable++
            return { kind: 'url', text: part.url }
          }
          case 'hashtag':
            return { kind: 'inline', text: `#${part.name || ''}` }
          default:
            return { kind: 'inline', text: '' }
        }
      })
      content = joinDiscordSegments(segments)
    } else if (typeof harmonyMsg.content === 'string') {
      content = harmonyMsg.content
      if (/https?:\/\//.test(content)) previewable++
    }

    return {
      // Loop guard for the pre-puppeting "[Discord]" prefix format.
      content: content.replace(/^\*\*\[Discord\]\*\*\s+/, ''),
      mentionUserIds: mentionIds.slice(0, MAX_ALLOWED_USERS),
      suppressEmbeds: suppressed > 0 && previewable === 0,
    }
  }

  private emojiText(emoji: any, ctx: HarmonyToDiscordContext): string {
    if (!emoji) return ''
    if (typeof emoji.content === 'string' && emoji.content) return emoji.content
    // Bridged Discord emoji: https://cdn.discordapp.com/emojis/<id>.<ext>
    if (emoji.domain === 'discord.com' && typeof emoji.url === 'string') {
      const match = emoji.url.match(/emojis\/(\d+)\.(png|gif|webp)/)
      if (match) return `<${match[2] === 'gif' ? 'a' : ''}:${emoji.name}:${match[1]}>`
    }
    const linked = ctx.discordEmojiFor?.(emoji)
    if (linked) return `<${linked.animated ? 'a' : ''}:${linked.name}:${linked.id}>`
    const app = ctx.appEmojiFor?.(emoji)
    if (app) return `<${app.animated ? 'a' : ''}:${app.name}:${app.id}>`
    return `:${emoji.name}:`
  }
}
