import { fetchWithRetry, type FetchLike } from '../http.js'

/** Discord rejects webhook avatars above 8 MiB. */
const MAX_ICON_BYTES = 8 * 1024 * 1024
/** Ships with every Harmony web build (public/favicon). */
const FALLBACK_ICON_PATH = '/favicon/android-icon-192x192.png'

async function fetchImage(url: string, fetchImpl?: FetchLike): Promise<Buffer | null> {
  const res = await fetchWithRetry(url, {}, { fetchImpl, attempts: 2, timeoutMs: 10_000 })
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok || !type.startsWith('image/')) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  const buf = Buffer.from(await res.arrayBuffer())
  return buf.length > 0 && buf.length <= MAX_ICON_BYTES ? buf : null
}

/**
 * Harmony instance icon for the bridge webhook: NodeInfo metadata.icon
 * (admin-configured instance_icon), else the stock favicon. Null when
 * neither loads; the webhook then has Discord's default avatar.
 */
export async function loadInstanceIcon(baseUrl: string, fetchImpl?: FetchLike): Promise<Buffer | null> {
  const base = baseUrl.replace(/\/+$/, '')
  try {
    const res = await fetchWithRetry(`${base}/nodeinfo/2.0`, { headers: { Accept: 'application/json' } }, {
      fetchImpl,
      attempts: 1,
      timeoutMs: 10_000,
    })
    if (res.ok) {
      const info = await res.json().catch(() => null) as { metadata?: { icon?: unknown } } | null
      const icon = info?.metadata?.icon
      if (typeof icon === 'string' && icon) {
        const image = await fetchImage(new URL(icon, `${base}/`).toString(), fetchImpl).catch(() => null)
        if (image) return image
      }
    } else {
      await res.body?.cancel().catch(() => {})
    }
  } catch {
    // NodeInfo is optional.
  }
  return fetchImage(`${base}${FALLBACK_ICON_PATH}`, fetchImpl).catch(() => null)
}
