export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts?: number
  /** Longest single wait. A Retry-After beyond it ends the retries. */
  maxWaitMs?: number
  /** First backoff step for network errors and 5xx; doubles per attempt. */
  baseDelayMs?: number
  /** Per-attempt timeout; each attempt gets its own AbortSignal. */
  timeoutMs?: number
  fetchImpl?: FetchLike
  sleep?: (ms: number) => Promise<void>
  /** Called before each wait caused by a 429. */
  onRateLimited?: (info: { url: string; waitMs: number; attempt: number }) => void
}

export const DEFAULT_RETRY = {
  attempts: 4,
  maxWaitMs: 60_000,
  baseDelayMs: 1_000,
} as const

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])
const RETRYABLE_5XX = new Set([500, 502, 503, 504])

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Retry-After as milliseconds. Accepts delta-seconds (fractional allowed, as
 * Discord sends) or an HTTP-date. Null when absent or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value == null) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000))
  const date = Date.parse(trimmed)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return null
}

/** Rate-limit wait from headers, then a JSON `retry_after` (seconds; Discord and Harmony both send it). */
async function rateLimitWaitMs(res: Response): Promise<number | null> {
  const header = parseRetryAfter(res.headers.get('retry-after'))
  if (header !== null) return header
  try {
    const body = await res.clone().json() as { retry_after?: unknown }
    const seconds = Number(body?.retry_after)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  } catch {
    // Non-JSON body.
  }
  return null
}

/**
 * fetch with bounded retries.
 * - 429: waits Retry-After (header or JSON body), any method; 429 means not processed.
 * - 5xx and network errors: exponential backoff, idempotent methods only.
 * The final response is returned as-is (callers see the 429/5xx); a final
 * network error is rethrown.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_RETRY.attempts)
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_RETRY.maxWaitMs
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs
  const doFetch = options.fetchImpl ?? fetch
  const wait = options.sleep ?? sleep
  const method = (init.method ?? 'GET').toUpperCase()
  const idempotent = IDEMPOTENT.has(method)

  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts
    let res: Response
    try {
      res = await doFetch(url, options.timeoutMs
        ? { ...init, signal: AbortSignal.timeout(options.timeoutMs) }
        : init)
    } catch (err) {
      if (last || !idempotent) throw err
      await wait(Math.min(maxWaitMs, baseDelayMs * 2 ** (attempt - 1)))
      continue
    }

    if (res.status === 429 && !last) {
      const waitMs = (await rateLimitWaitMs(res)) ?? Math.min(maxWaitMs, baseDelayMs * 2 ** (attempt - 1))
      if (waitMs > maxWaitMs) return res
      options.onRateLimited?.({ url, waitMs, attempt })
      await res.body?.cancel().catch(() => {})
      await wait(waitMs)
      continue
    }

    if (RETRYABLE_5XX.has(res.status) && idempotent && !last) {
      await res.body?.cancel().catch(() => {})
      await wait(Math.min(maxWaitMs, baseDelayMs * 2 ** (attempt - 1)))
      continue
    }

    return res
  }
}

/** Exponential backoff schedule with a cap and ±20 % jitter. */
export class Backoff {
  private attempt = 0

  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
    private readonly jitter = 0.2,
    private readonly random: () => number = Math.random,
  ) {}

  next(): number {
    const raw = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 30)
    const spread = raw * this.jitter
    return Math.max(0, Math.round(raw - spread + this.random() * spread * 2))
  }

  reset() {
    this.attempt = 0
  }

  get attempts(): number {
    return this.attempt
  }
}
