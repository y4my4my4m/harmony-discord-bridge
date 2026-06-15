const DISCORD_API = 'https://discord.com/api/v10'
const REFRESH_BATCH = 50 // Discord's max per refresh-urls call

function isDiscordCdnUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.endsWith('discordapp.com') || host.endsWith('discordapp.net')
  } catch {
    return false
  }
}

/** Strip the signed query (`?ex=&is=&hm=`) so we can match parts regardless of which signature they carry. */
function baseOf(url: string): string {
  return url.split('?')[0]
}

/**
 * Re-sign expired Discord CDN URLs in a message's content parts via Discord's
 * `attachments/refresh-urls` endpoint. Returns a new content array with fresh
 * URLs, or `null` if there was nothing to refresh (so callers can skip the write).
 */
export async function refreshDiscordAttachmentParts(
  content: any[],
  botToken: string,
): Promise<any[] | null> {
  if (!Array.isArray(content)) return null

  const urls = Array.from(
    new Set(
      content
        .filter((p) => p?.type === 'file' && typeof p.url === 'string' && isDiscordCdnUrl(p.url))
        .map((p) => p.url as string),
    ),
  )
  if (urls.length === 0) return null

  const refreshedByBase = new Map<string, string>()
  for (let i = 0; i < urls.length; i += REFRESH_BATCH) {
    const batch = urls.slice(i, i + REFRESH_BATCH)
    const res = await fetch(`${DISCORD_API}/attachments/refresh-urls`, {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachment_urls: batch }),
    })
    if (!res.ok) {
      throw new Error(`Discord refresh-urls failed (${res.status})`)
    }
    const data = (await res.json()) as {
      refreshed_urls?: Array<{ original: string; refreshed: string }>
    }
    for (const r of data.refreshed_urls ?? []) {
      if (r.refreshed) refreshedByBase.set(baseOf(r.original || ''), r.refreshed)
    }
  }
  if (refreshedByBase.size === 0) return null

  let changed = false
  const out = content.map((p) => {
    if (p?.type === 'file' && typeof p.url === 'string') {
      const fresh = refreshedByBase.get(baseOf(p.url))
      if (fresh && fresh !== p.url) {
        changed = true
        return { ...p, url: fresh }
      }
    }
    return p
  })
  return changed ? out : null
}
