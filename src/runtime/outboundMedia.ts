import type { FetchLike } from '../http.js'
import { Logger } from '../log.js'
import { harmonyFileKey, type HarmonyFilePart } from '../MessageTranslator.js'
import { fetchCapped, fetchPrefix, isPublicHttpsUrl, sniffImageType } from '../utils/fetchCapped.js'

const MIB = 1024 * 1024

export interface MediaOptions {
  /** Attachment bytes per Discord message; the guild limit caps it further. */
  maxUploadBytes: number
  /** Origin that replaces Harmony's public origin for media fetches (co-located host). */
  mediaOrigin: string | null
}

export const DEFAULT_MAX_UPLOAD_MB = 8

/** MAX_UPLOAD_MB and HARMONY_MEDIA_ORIGIN; invalid values fall back with a warning. */
export function mediaOptionsFromEnv(env: NodeJS.ProcessEnv, log: Logger = new Logger()): MediaOptions {
  let maxUploadBytes = DEFAULT_MAX_UPLOAD_MB * MIB
  const rawMax = env.MAX_UPLOAD_MB?.trim()
  if (rawMax) {
    const mb = Number(rawMax)
    if (Number.isFinite(mb) && mb >= 0) maxUploadBytes = Math.floor(mb * MIB)
    else log.warn(`MAX_UPLOAD_MB="${rawMax}" is not a number; using ${DEFAULT_MAX_UPLOAD_MB}`)
  }

  let mediaOrigin: string | null = null
  const rawOrigin = env.HARMONY_MEDIA_ORIGIN?.trim()
  if (rawOrigin) {
    try {
      const u = new URL(rawOrigin)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme')
      mediaOrigin = u.origin
    } catch {
      log.warn(`HARMONY_MEDIA_ORIGIN="${rawOrigin}" is not an http(s) origin; ignored`)
    }
  }
  return { maxUploadBytes, mediaOrigin }
}

/**
 * Discord upload limit per request by boost tier: tier 2 50 MiB, tier 3
 * 100 MiB, otherwise 25 MiB (the v2.2 contract's bot default).
 */
export function guildUploadLimit(premiumTier: number | null | undefined): number {
  if (premiumTier === 3) return 100 * MIB
  if (premiumTier === 2) return 50 * MIB
  return 25 * MIB
}

/** Discord attachments per message. */
const MAX_FILES = 10
const FETCH_TIMEOUT_MS = 30_000
/** Bytes read to detect APNG and animated WebP. */
const PROBE_BYTES = 4096
const RENDERABLE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp'])
/** Harmony render size for uploaded images (imgproxy, resize contain). */
const RENDER_BOX = 1600
const RENDER_QUALITY = 82

export interface PreparedUpload {
  /** harmonyFileKey of the part. */
  key: string
  name: string
  data: Buffer
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** File name whose extension matches the bytes; imgproxy may answer a PNG request in WebP. */
export function nameForImage(name: string, data: Uint8Array): string {
  const type = sniffImageType(data)
  if (!type) return name
  const ext = IMAGE_EXT[type]
  const dot = name.lastIndexOf('.')
  const current = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (current === ext || (ext === 'jpg' && current === 'jpeg')) return name
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`
}

/** True when the first bytes show an animated PNG (acTL before IDAT) or animated WebP (VP8X animation flag). */
export function isAnimatedImage(head: Uint8Array): boolean {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50) {
    let off = 8
    while (off + 8 <= head.length) {
      const len = ((head[off] << 24) | (head[off + 1] << 16) | (head[off + 2] << 8) | head[off + 3]) >>> 0
      const type = String.fromCharCode(head[off + 4], head[off + 5], head[off + 6], head[off + 7])
      if (type === 'acTL') return true
      if (type === 'IDAT') return false
      off += 12 + len
    }
    return false
  }
  if (head.length >= 21 && String.fromCharCode(...head.slice(8, 16)) === 'WEBPVP8X') return (head[20] & 0x02) !== 0
  return false
}

function extensionOf(part: HarmonyFilePart): string {
  const source = part.fileName || ''
  const fromName = source.includes('.') ? source.split('.').pop() ?? '' : ''
  if (fromName) return fromName.toLowerCase()
  try {
    return new URL(part.url).pathname.split('.').pop()?.toLowerCase() ?? ''
  } catch {
    return ''
  }
}

/**
 * Harmony file parts as Discord attachments. Files come only from Harmony's
 * public origin (or a public Supabase storage path). Static images are
 * fetched through Harmony's imgproxy render at 1600 px: the part's signed
 * `render_url` when the gateway sent one, else the public render endpoint.
 * A signed URL carries its transformation in the token, so a signed object
 * URL without `render_url` is fetched as the original.
 */
export class OutboundMedia {
  readonly harmonyOrigin: string

  constructor(
    harmonyBaseUrl: string,
    readonly options: MediaOptions,
    private readonly fetchImpl?: FetchLike,
  ) {
    this.harmonyOrigin = new URL(harmonyBaseUrl).origin
  }

  /** Same origin as Harmony, or Supabase storage on a public https host. */
  isFetchable(url: string): boolean {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return false
    }
    if (u.username || u.password) return false
    if (u.origin === this.harmonyOrigin) return true
    return isPublicHttpsUrl(url) && u.pathname.startsWith('/storage/v1/')
  }

  /** `url` with Harmony's public origin replaced by HARMONY_MEDIA_ORIGIN; path and query unchanged. */
  route(url: string): string {
    const origin = this.options.mediaOrigin
    if (!origin) return url
    try {
      const u = new URL(url)
      if (u.origin !== this.harmonyOrigin) return url
      return `${origin}${u.pathname}${u.search}`
    } catch {
      return url
    }
  }

  /**
   * Public render URL of a static JPEG, PNG or WebP; null for anything else.
   * PNG and WebP are probed first: imgproxy keeps one frame of APNG and
   * animated WebP.
   */
  async renderUrlFor(part: HarmonyFilePart): Promise<string | null> {
    const ext = extensionOf(part)
    if (!RENDERABLE_EXT.has(ext)) return null
    let u: URL
    try {
      u = new URL(part.url)
    } catch {
      return null
    }
    const marker = '/storage/v1/object/public/'
    if (!u.pathname.startsWith(marker)) return null
    if (ext === 'png' || ext === 'webp') {
      const head = await fetchPrefix(this.route(part.url), PROBE_BYTES, { timeoutMs: FETCH_TIMEOUT_MS, fetchImpl: this.fetchImpl })
      if (!head || isAnimatedImage(head)) return null
    }
    const path = u.pathname.slice(marker.length)
    return `${u.origin}/storage/v1/render/image/public/${path}?width=${RENDER_BOX}&height=${RENDER_BOX}&resize=contain&quality=${RENDER_QUALITY}`
  }

  /**
   * Fetches files in order while their sum stays within `budget` bytes and
   * the count within Discord's 10. A file that does not fit or fails to load
   * is skipped; the caller links it instead.
   */
  async prepare(files: HarmonyFilePart[], budget: number): Promise<PreparedUpload[]> {
    const out: PreparedUpload[] = []
    let used = 0
    for (const part of files) {
      if (out.length >= MAX_FILES) break
      const room = budget - used
      if (room <= 0) break
      if (!this.isFetchable(part.url)) continue
      const data = await this.fetchPart(part, room)
      if (!data) continue
      out.push({
        key: harmonyFileKey(part),
        name: nameForImage(part.fileName, data),
        data,
      })
      used += data.length
    }
    return out
  }

  private async fetchPart(part: HarmonyFilePart, maxBytes: number): Promise<Buffer | null> {
    const render = part.renderUrl && this.isFetchable(part.renderUrl)
      ? part.renderUrl
      : await this.renderUrlFor(part).catch(() => null)
    if (render) {
      const res = await fetchCapped(this.route(render), { maxBytes, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl: this.fetchImpl })
      if (res.ok && sniffImageType(res.data)) return res.data
    }
    if (part.fileSize !== null && part.fileSize > maxBytes) return null
    const res = await fetchCapped(this.route(part.url), { maxBytes, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl: this.fetchImpl })
    return res.ok && res.data.length > 0 ? res.data : null
  }
}
