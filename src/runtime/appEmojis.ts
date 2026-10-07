import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { FetchLike } from '../http.js'
import { Logger, errorText } from '../log.js'
import { fetchCapped, sniffImageType } from '../utils/fetchCapped.js'

/** Discord application emoji as used in `<:name:id>` and reactions. */
export interface AppEmoji {
  id: string
  name: string
  animated: boolean
}

interface StoredEmoji extends AppEmoji {
  lastUsed: number
}

interface StoreFile {
  version: 1
  emojis: Record<string, StoredEmoji>
}

/** Discord REST for one application's emojis (`/applications/{id}/emojis`). */
export interface AppEmojiApi {
  list(): Promise<Array<{ id: string; name: string; animated?: boolean }>>
  /** `image` is a data URI. */
  create(name: string, image: string): Promise<{ id: string; name: string; animated?: boolean }>
  delete(id: string): Promise<void>
}

/** A Harmony custom emoji: its image URL is the map key. */
export interface HarmonyEmojiSource {
  url: string
  name: string
}

/** Discord REST and image loading of the calling bridge. */
export interface AppEmojiIO {
  api: AppEmojiApi
  /** Image as a data URI of at most 256 KiB, or null. */
  loadImage(url: string): Promise<string | null>
}

/** Discord allows 2000 emojis per application; 100 stay free for other uses. */
export const APP_EMOJI_CAP = 1900
/** Discord's emoji image limit. */
export const APP_EMOJI_MAX_BYTES = 256 * 1024
/** Supabase image transform sizes tried when the original exceeds the limit. */
const RENDER_SIZES = [128, 64]
const IMAGE_TIMEOUT_MS = 15_000
/** A failed source is not retried before this. */
const FAILURE_RETRY_MS = 60 * 60 * 1000
/** lastUsed-only changes are written at most this often. */
const TOUCH_SAVE_MS = 60_000

/** Discord REST error codes. */
const UNKNOWN_EMOJI = 10014
const MAX_EMOJIS = 30008

function errorCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

/**
 * Discord emoji name for a Harmony emoji: 2–32 characters of [A-Za-z0-9_].
 * The suffix is derived from the source URL, so every process picks the
 * same name for the same image and a duplicate-name rejection identifies an
 * upload made elsewhere.
 */
export function appEmojiName(harmonyName: string, key: string): string {
  const base = harmonyName
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 25)
    .replace(/^_+|_+$/g, '') || 'emoji'
  const suffix = createHash('sha256').update(key).digest('hex').slice(0, 6)
  return `${base}_${suffix}`
}

/** `/storage/v1/object/public/…` → Supabase's transform endpoint at `size`×`size`. */
export function supabaseRenderUrl(url: string, size: number): string | null {
  if (!url.includes('/storage/v1/object/public/')) return null
  const rendered = url.replace('/storage/v1/object/public/', '/storage/v1/render/image/public/')
  const sep = rendered.includes('?') ? '&' : '?'
  return `${rendered}${sep}width=${size}&height=${size}&resize=contain&quality=80`
}

/**
 * Emoji image as a data URI of at most 256 KiB. No image library ships with
 * the bridge: an oversized original is requested again through Harmony's
 * Supabase transform endpoint at 128 and 64 px; null when nothing fits.
 */
export async function loadEmojiImage(
  url: string,
  fetchImpl?: FetchLike,
  maxBytes = APP_EMOJI_MAX_BYTES,
): Promise<string | null> {
  const candidates = [url, ...RENDER_SIZES.map(s => supabaseRenderUrl(url, s)).filter((u): u is string => !!u)]
  for (const candidate of candidates) {
    const res = await fetchCapped(candidate, { maxBytes, timeoutMs: IMAGE_TIMEOUT_MS, fetchImpl })
    if (!res.ok) {
      if (res.reason === 'too_large') continue
      return null
    }
    const type = sniffImageType(res.data)
    if (!type) return null
    return `data:${type};base64,${res.data.toString('base64')}`
  }
  return null
}

export interface AppEmojiStoreOptions {
  /** JSON file; null keeps the map in memory. */
  path: string | null
  log?: Logger
  cap?: number
  now?: () => number
}

/**
 * Harmony emoji image URL → Discord application emoji, persisted per
 * application and LRU-bounded by deleting the least recently used upload.
 * One store per file path per process: bridges sharing an application share
 * the map, and concurrent requests for one image share one upload.
 */
export class AppEmojiStore {
  private static readonly byPath = new Map<string, AppEmojiStore>()

  /** The store for `path`, created on first use; a null path gives a private in-memory store. */
  static forPath(path: string | null, opts: Omit<AppEmojiStoreOptions, 'path'> = {}): AppEmojiStore {
    if (!path) return new AppEmojiStore({ ...opts, path: null })
    let store = AppEmojiStore.byPath.get(path)
    if (!store) {
      store = new AppEmojiStore({ ...opts, path })
      AppEmojiStore.byPath.set(path, store)
    }
    return store
  }

  private readonly entries = new Map<string, StoredEmoji>()
  private readonly inflight = new Map<string, Promise<AppEmoji | null>>()
  private readonly failedAt = new Map<string, number>()
  private chain: Promise<unknown> = Promise.resolve()
  private touchTimer: NodeJS.Timeout | null = null
  private readonly log: Logger
  private readonly cap: number
  private readonly now: () => number

  constructor(private readonly opts: AppEmojiStoreOptions) {
    this.log = opts.log ?? new Logger()
    this.cap = opts.cap ?? APP_EMOJI_CAP
    this.now = opts.now ?? (() => Date.now())
    this.load()
  }

  get size(): number {
    return this.entries.size
  }

  /** Mapped emoji for `url`, marking it used; no upload. */
  peek(url: string): AppEmoji | null {
    const hit = this.entries.get(url)
    if (!hit) return null
    this.touch(hit)
    return { id: hit.id, name: hit.name, animated: hit.animated }
  }

  /** Mapped emoji for `url`, uploading it on first use. Null when the image cannot be used. */
  resolve(source: HarmonyEmojiSource, io: AppEmojiIO): Promise<AppEmoji | null> {
    const hit = this.peek(source.url)
    if (hit) return Promise.resolve(hit)
    const failed = this.failedAt.get(source.url)
    if (failed !== undefined && this.now() - failed < FAILURE_RETRY_MS) return Promise.resolve(null)

    let pending = this.inflight.get(source.url)
    if (!pending) {
      pending = this.serial(() => this.upload(source, io))
        .finally(() => this.inflight.delete(source.url))
      this.inflight.set(source.url, pending)
    }
    return pending
  }

  /** Discord no longer has the emoji (deleted elsewhere): forget it so the next use uploads again. */
  invalidate(url: string): void {
    if (this.entries.delete(url)) this.save()
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  private async upload(source: HarmonyEmojiSource, io: AppEmojiIO): Promise<AppEmoji | null> {
    const done = this.peek(source.url)
    if (done) return done

    const { api } = io
    const image = await io.loadImage(source.url).catch(() => null)
    if (!image) {
      this.failedAt.set(source.url, this.now())
      this.log.debug(`Application emoji: image for :${source.name}: unusable (over 256 KiB or not an image)`)
      return null
    }

    const name = appEmojiName(source.name, source.url)
    await this.evict(api, this.entries.size + 1 - this.cap)

    let created: { id: string; name: string; animated?: boolean } | null = null
    try {
      created = await api.create(name, image)
    } catch (err) {
      if (errorCode(err) === MAX_EMOJIS) {
        await this.evict(api, 10)
        created = await api.create(name, image).catch(() => null)
      }
      // The name derives from this image's URL: an emoji of that name is this image, uploaded by another process.
      created ??= (await api.list().catch(() => [])).find(e => e.name === name) ?? null
      if (!created) {
        this.failedAt.set(source.url, this.now())
        this.log.warn(`Application emoji upload failed: ${errorText(err)}`)
        return null
      }
    }

    const entry: StoredEmoji = {
      id: String(created.id),
      name: created.name || name,
      animated: created.animated === true,
      lastUsed: this.now(),
    }
    this.entries.set(source.url, entry)
    this.failedAt.delete(source.url)
    this.save()
    this.log.info(`Application emoji uploaded (${this.entries.size}/${this.cap})`)
    return { id: entry.id, name: entry.name, animated: entry.animated }
  }

  /** Deletes the `count` least recently used uploads. A failed delete still frees the slot in the map. */
  private async evict(api: AppEmojiApi, count: number): Promise<void> {
    if (count <= 0) return
    const victims = Array.from(this.entries.entries())
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, count)
    for (const [url, entry] of victims) {
      this.entries.delete(url)
      try {
        await api.delete(entry.id)
      } catch (err) {
        if (errorCode(err) !== UNKNOWN_EMOJI) this.log.warn(`Application emoji delete failed: ${errorText(err)}`)
      }
    }
    if (victims.length > 0) {
      this.log.info(`Application emoji: evicted ${victims.length} least recently used`)
      this.save()
    }
  }

  private touch(entry: StoredEmoji) {
    entry.lastUsed = this.now()
    if (!this.opts.path || this.touchTimer) return
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null
      this.save()
    }, TOUCH_SAVE_MS)
    this.touchTimer.unref?.()
  }

  private load() {
    const path = this.opts.path
    if (!path || !existsSync(path)) return
    try {
      const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreFile>
      for (const [url, e] of Object.entries(data.emojis ?? {})) {
        if (e && typeof e.id === 'string' && typeof e.name === 'string') {
          this.entries.set(url, { id: e.id, name: e.name, animated: e.animated === true, lastUsed: Number(e.lastUsed) || 0 })
        }
      }
    } catch (err) {
      this.log.warn(`Application emoji map ${path} unreadable (${errorText(err)}); starting empty`)
    }
  }

  private save() {
    const path = this.opts.path
    if (!path) return
    const data: StoreFile = { version: 1, emojis: Object.fromEntries(this.entries) }
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(data))
      renameSync(tmp, path)
    } catch (err) {
      this.log.warn(`Cannot write application emoji map ${path}: ${errorText(err)}`)
    }
  }

  /** Writes pending lastUsed changes. */
  flush(): void {
    if (this.touchTimer) clearTimeout(this.touchTimer)
    this.touchTimer = null
    this.save()
  }
}
