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
  /** Aborts the request in flight and any wait between attempts. */
  signal?: AbortSignal
}

export const DEFAULT_RETRY = {
  attempts: 4,
  maxWaitMs: 60_000,
  baseDelayMs: 1_000,
} as const

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'])
const RETRYABLE_5XX = new Set([500, 502, 503, 504])

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : Object.assign(new Error('aborted'), { name: 'AbortError' })
}

/** Resolves after `ms`; rejects at once when `signal` aborts first. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal))
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** A signal that aborts with `signal` or after `timeoutMs`, whichever is first. */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
  if (!signal || !timeout) return signal ?? timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  // Node 20.0 to 20.2 (package.json allows them) has no AbortSignal.any.
  const both = new AbortController()
  for (const s of [signal, timeout]) {
    if (s.aborted) both.abort(s.reason)
    else s.addEventListener('abort', () => both.abort(s.reason), { once: true })
  }
  return both.signal
}

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
  const { signal } = options
  const wait = (ms: number): Promise<void> => (options.sleep ? options.sleep(ms) : abortableSleep(ms, signal))
  const method = (init.method ?? 'GET').toUpperCase()
  const idempotent = IDEMPOTENT.has(method)

  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts
    let res: Response
    try {
      const attemptSignal = requestSignal(signal, options.timeoutMs)
      res = await doFetch(url, attemptSignal ? { ...init, signal: attemptSignal } : init)
    } catch (err) {
      if (last || !idempotent || signal?.aborted) throw err
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
