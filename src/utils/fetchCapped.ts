import type { FetchLike } from '../http.js'

export type CappedFetch =
  | { ok: true; data: Buffer; contentType: string | null }
  | { ok: false; reason: 'too_large' | 'http' | 'failed' }

/**
 * GET with a byte cap and a deadline covering headers and body. Redirects
 * fail: the URL was vetted, its redirect target was not.
 */
export async function fetchCapped(
  url: string,
  opts: { maxBytes: number; timeoutMs: number; fetchImpl?: FetchLike },
): Promise<CappedFetch> {
  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs) })
  } catch {
    return { ok: false, reason: 'failed' }
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    return { ok: false, reason: 'http' }
  }
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    await res.body?.cancel().catch(() => {})
    return { ok: false, reason: 'too_large' }
  }
  const contentType = res.headers.get('content-type')
  if (!res.body) return { ok: true, data: Buffer.alloc(0), contentType }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: 'failed' }
  }
  return { ok: true, data: Buffer.concat(chunks, total), contentType }
}

/**
 * The first `n` bytes of `url` (Range request; a server ignoring Range is
 * cut off after `n` bytes). Null on any failure.
 */
export async function fetchPrefix(
  url: string,
  n: number,
  opts: { timeoutMs: number; fetchImpl?: FetchLike },
): Promise<Uint8Array | null> {
  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      redirect: 'error',
      headers: { Range: `bytes=0-${n - 1}` },
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch {
    return null
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  const reader = res.body.getReader()
  const out = new Uint8Array(n)
  let filled = 0
  try {
    while (filled < n) {
      const { done, value } = await reader.read()
      if (done) break
      const take = Math.min(value.byteLength, n - filled)
      out.set(value.subarray(0, take), filled)
      filled += take
    }
  } catch {
    return null
  } finally {
    await reader.cancel().catch(() => {})
  }
  return out.subarray(0, filled)
}

/** Image type from magic bytes: the formats Discord accepts for emoji. */
export function sniffImageType(data: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  if (
    data.length >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return 'image/webp'
  return null
}

/**
 * True for an https URL whose host is a dotted name: no IP literal, no
 * single-label or `.local`/`.internal`/`localhost` host. Keeps fetches of
 * user-supplied URLs off a host-mode container's private network.
 */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host.includes('.')) return false
  if (host.startsWith('[') || /^[\d.]+$/.test(host)) return false
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host)) return false
  return true
}
