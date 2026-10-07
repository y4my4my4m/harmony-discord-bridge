import { fetchWithRetry, type FetchLike } from '../http.js'

export interface HarmonyEndpoints {
  /** bot-gateway root: REST is `${apiBase}/api/v1`, bridge API `${apiBase}/bridge/v2`. */
  apiBase: string
  gatewayUrl: string
  /** HARMONY_URL points at bot-gateway itself (co-located), not the public site. */
  direct: boolean
}

export class EndpointError extends Error {
  constructor(message: string, readonly unreachable: boolean) {
    super(message)
    this.name = 'EndpointError'
  }
}

/** Validates and normalizes HARMONY_URL. Throws with a user-facing message. */
export function normalizeHarmonyUrl(raw: string): string {
  let value = raw.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`HARMONY_URL "${raw}" is not a valid address (expected something like https://har.mony.lol)`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`HARMONY_URL must start with https:// or http:// (got ${url.protocol})`)
  }
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export function websocketUrlFor(apiBase: string): string {
  return `${apiBase.replace(/^http/i, 'ws').replace(/\/+$/, '')}/gateway`
}

export function endpointsFor(apiBase: string, direct: boolean): HarmonyEndpoints {
  const base = apiBase.replace(/\/+$/, '')
  return { apiBase: base, gatewayUrl: websocketUrlFor(base), direct }
}

async function answersHealth(url: string, fetchImpl?: FetchLike): Promise<boolean> {
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } }, {
    fetchImpl,
    attempts: 2,
    timeoutMs: 10_000,
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    return false
  }
  const body = await res.json().catch(() => null) as { status?: unknown } | null
  return body?.status === 'ok'
}

/**
 * Locates bot-gateway from HARMONY_URL:
 * - URL ending in /bot-gateway: used as is.
 * - `${url}/bot-gateway/health` answers: public site with the standard proxy prefix.
 * - `${url}/health` answers: bot-gateway itself (e.g. http://localhost:3002).
 */
export async function probeEndpoints(harmonyUrl: string, fetchImpl?: FetchLike): Promise<HarmonyEndpoints> {
  const base = harmonyUrl.replace(/\/+$/, '')
  if (/\/bot-gateway$/i.test(base)) return endpointsFor(base, false)

  let networkError: unknown = null
  for (const [candidate, direct] of [[`${base}/bot-gateway`, false], [base, true]] as const) {
    try {
      if (await answersHealth(`${candidate}/health`, fetchImpl)) return endpointsFor(candidate, direct)
    } catch (err) {
      networkError = err
    }
  }
  if (networkError) {
    const detail = networkError instanceof Error ? networkError.message : String(networkError)
    throw new EndpointError(`Cannot reach Harmony at ${base} (${detail})`, true)
  }
  throw new EndpointError(
    `No Harmony bot-gateway found at ${base}/bot-gateway or ${base}. Check HARMONY_URL.`,
    false,
  )
}
