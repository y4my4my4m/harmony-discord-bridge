import { describe, expect, it, vi } from 'vitest'
import { Backoff, fetchWithRetry, parseRetryAfter, type FetchLike } from '../src/http.js'
import { HarmonyClient, HarmonyHttpError } from '../src/HarmonyClient.js'
import { silentLogger } from '../src/log.js'

function sequence(...responses: Array<Response | Error>) {
  const queue = [...responses]
  return vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error('no more responses')
    if (next instanceof Error) throw next
    return next
  })
}

const noSleep = () => {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => { waits.push(ms) } }
}

describe('parseRetryAfter', () => {
  it('reads delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter('0.25')).toBe(250)
    expect(parseRetryAfter('Wed, 07 Oct 2026 00:00:10 GMT', Date.parse('Wed, 07 Oct 2026 00:00:00 GMT'))).toBe(10_000)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('soon')).toBeNull()
  })
})

describe('fetchWithRetry', () => {
  it('waits Retry-After on 429 and retries', async () => {
    const { waits, sleep } = noSleep()
    const fetchImpl = sequence(
      new Response('', { status: 429, headers: { 'Retry-After': '3' } }),
      new Response('ok', { status: 200 }),
    )
    const res = await fetchWithRetry('https://x', { method: 'POST' }, { fetchImpl, sleep })
    expect(res.status).toBe(200)
    expect(waits).toEqual([3000])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('honors a JSON retry_after (bot-gateway and Discord bodies)', async () => {
    const { waits, sleep } = noSleep()
    const onRateLimited = vi.fn()
    const fetchImpl = sequence(
      Response.json({ error: 'Rate limit exceeded', retry_after: 60 }, { status: 429 }),
      Response.json({ message: 'You are being rate limited.', retry_after: 0.5 }, { status: 429 }),
      new Response('ok'),
    )
    const res = await fetchWithRetry('https://x', {}, { fetchImpl, sleep, onRateLimited })
    expect(res.status).toBe(200)
    expect(waits).toEqual([60_000, 500])
    expect(onRateLimited).toHaveBeenCalledTimes(2)
  })

  it('gives up immediately when Retry-After exceeds the bound', async () => {
    const { waits, sleep } = noSleep()
    const fetchImpl = sequence(new Response('', { status: 429, headers: { 'Retry-After': '3600' } }))
    const res = await fetchWithRetry('https://x', {}, { fetchImpl, sleep })
    expect(res.status).toBe(429)
    expect(waits).toEqual([])
  })

  it('stops after the attempt budget and returns the last 429', async () => {
    const { waits, sleep } = noSleep()
    const fetchImpl = vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '1' } }))
    const res = await fetchWithRetry('https://x', {}, { fetchImpl, sleep, attempts: 3 })
    expect(res.status).toBe(429)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([1000, 1000])
  })

  it('retries 5xx and network errors for GET only', async () => {
    const { waits, sleep } = noSleep()
    const get = sequence(new Error('ECONNRESET'), new Response('', { status: 503 }), new Response('ok'))
    expect((await fetchWithRetry('https://x', {}, { fetchImpl: get, sleep })).status).toBe(200)
    expect(waits).toEqual([1000, 2000])

    const post = sequence(new Response('', { status: 503 }))
    expect((await fetchWithRetry('https://x', { method: 'POST' }, { fetchImpl: post, sleep })).status).toBe(503)
    expect(post).toHaveBeenCalledTimes(1)

    const postNet = sequence(new Error('ECONNRESET'))
    await expect(fetchWithRetry('https://x', { method: 'POST' }, { fetchImpl: postNet, sleep })).rejects.toThrow('ECONNRESET')
  })
})

describe('Backoff', () => {
  it('doubles up to the cap', () => {
    const b = new Backoff(1000, 8000, 0)
    expect([b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([1000, 2000, 4000, 8000, 8000])
    b.reset()
    expect(b.next()).toBe(1000)
  })

  it('jitters within ±20 %', () => {
    const low = new Backoff(1000, 8000, 0.2, () => 0)
    const high = new Backoff(1000, 8000, 0.2, () => 1)
    expect(low.next()).toBe(800)
    expect(high.next()).toBe(1200)
  })
})

describe('HarmonyClient REST', () => {
  function client(fetchImpl: FetchLike) {
    const waits: number[] = []
    const c = new HarmonyClient('tok', 'ws://unused', 'https://har.example/bot-gateway', {
      log: silentLogger,
      fetchImpl,
      retry: { sleep: async (ms) => { waits.push(ms) } },
    })
    return { c, waits }
  }

  it('retries a rate-limited send and returns the message', async () => {
    const fetchImpl = sequence(
      Response.json({ error: 'Rate limit exceeded', retry_after: 60 }, { status: 429 }),
      Response.json({ id: 'm-1' }, { status: 201 }),
    )
    const { c, waits } = client(fetchImpl)
    const rateLimited = vi.fn()
    c.on('rateLimited', rateLimited)
    const res = await c.sendMessage('ch-1', [{ type: 'text', text: 'hi' }])
    expect(res).toEqual({ id: 'm-1' })
    expect(waits).toEqual([60_000])
    expect(rateLimited).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('https://har.example/bot-gateway/api/v1/channels/ch-1/messages')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bot tok')
  })

  it('throws a 429 HarmonyHttpError once retries are spent', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'Rate limit exceeded', retry_after: 1 }, { status: 429 }))
    const { c } = client(fetchImpl)
    const err = await c.sendMessage('ch-1', 'hi').catch(e => e)
    expect(err).toBeInstanceOf(HarmonyHttpError)
    expect(err.status).toBe(429)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('flags auth failure on 401', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'Invalid token' }, { status: 401 }))
    const { c } = client(fetchImpl)
    const authFailed = vi.fn()
    c.on('authFailed', authFailed)
    await expect(c.getServerChannels('s-1')).rejects.toThrow('Invalid token')
    expect(authFailed).toHaveBeenCalledOnce()
    expect(c.isAuthRejected()).toBe(true)
  })
})
