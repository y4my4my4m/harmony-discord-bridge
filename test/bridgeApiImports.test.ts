import { describe, expect, it } from 'vitest'
import { BridgeApi, BridgeApiError, type ImportJob } from '../src/v2/BridgeApi.js'

interface Seen { url: string; method: string; body: unknown; auth: string | null; signal: AbortSignal | null }

function setup(status: number, payload: unknown, headers: Record<string, string> = {}) {
  const seen: Seen[] = []
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    seen.push({
      url: String(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: (init.headers as Record<string, string>)?.Authorization ?? null,
      signal: (init.signal as AbortSignal | undefined) ?? null,
    })
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } })
  }
  const api = new BridgeApi('https://api.test/', 'tok', { fetchImpl, retry: { attempts: 1 } })
  return { api, seen }
}

const job = { id: 'j1', state: 'queued' } as unknown as ImportJob

describe('BridgeApi imports', () => {
  it('listImports GETs /imports', async () => {
    const { api, seen } = setup(200, { imports: [job] })
    expect(await api.listImports()).toEqual([job])
    expect(seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/imports', method: 'GET', auth: 'Bot tok' })
  })

  it('startImports POSTs ids, or an empty object when omitted', async () => {
    const a = setup(201, { imports: [job] })
    expect(await a.api.startImports(['1', '2'])).toEqual([job])
    expect(a.seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/imports', method: 'POST', body: { discord_channel_ids: ['1', '2'] } })
    const b = setup(201, { imports: [] })
    await b.api.startImports()
    expect(b.seen[0].body).toEqual({})
  })

  it('startImports sends the Discord member who ran the command as requested_by', async () => {
    const { api, seen } = setup(201, { imports: [job] })
    await api.startImports(['1'], { id: '42', username: 'dana' })
    expect(seen[0].body).toEqual({ discord_channel_ids: ['1'], requested_by: { id: '42', username: 'dana' } })
  })

  it('startImports exposes pair_not_importable and the channel it names', async () => {
    const { api } = setup(400, { code: 'pair_not_importable', discord_channel_id: '1' })
    await expect(api.startImports(['1'])).rejects.toMatchObject({ status: 400, code: 'pair_not_importable', details: { discord_channel_id: '1' } })
  })

  it('getImport GETs one job', async () => {
    const { api, seen } = setup(200, { import: job })
    expect(await api.getImport('j1')).toEqual(job)
    expect(seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/imports/j1', method: 'GET' })
  })

  it('403 import_disabled carries the code and the reason', async () => {
    const { api } = setup(403, { code: 'import_disabled', reason: 'instance_off' })
    await expect(api.listImports()).rejects.toMatchObject({ status: 403, code: 'import_disabled', details: { reason: 'instance_off' } })
  })

  it('a 429 carries its code and Retry-After, from the header or the body', async () => {
    const header = setup(429, { code: 'import_busy', retry_after: 90 }, { 'Retry-After': '120' })
    await expect(header.api.updateImport('j1', { state: 'running' })).rejects.toMatchObject({ status: 429, code: 'import_busy', retryAfterMs: 120_000 })
    const body = setup(429, { code: 'import_rate_limited', retry_after: 7 })
    await expect(body.api.postImportMessages('j1', [])).rejects.toMatchObject({ code: 'import_rate_limited', retryAfterMs: 7_000 })
  })

  it('a call made for a job makes one attempt and is aborted with the job', async () => {
    let calls = 0
    const stop = new AbortController()
    const fetchImpl = async (_input: string | URL, init: RequestInit = {}) => {
      calls++
      if (calls === 1) return new Response(JSON.stringify({ code: 'import_rate_limited', retry_after: 0 }), { status: 429 })
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('aborted by the job')))
      })
    }
    const api = new BridgeApi('https://api.test/', 'tok', { fetchImpl })
    await expect(api.postImportMessages('j1', [], { signal: stop.signal })).rejects.toMatchObject({ status: 429 })
    expect(calls).toBe(1)
    const hanging = api.updateImport('j1', { state: 'running' }, { signal: stop.signal })
    stop.abort()
    await expect(hanging).rejects.toThrow('aborted by the job')
  })

  it('updateImport PATCHes and unwraps import', async () => {
    const { api, seen } = setup(200, { import: job })
    expect(await api.updateImport('j1', { state: 'running' })).toEqual(job)
    expect(seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/imports/j1', method: 'PATCH', body: { state: 'running' } })
  })

  it('updateImport 409 invalid_transition carries the code', async () => {
    const { api } = setup(409, { code: 'invalid_transition' })
    await expect(api.updateImport('j1', { state: 'done' })).rejects.toMatchObject({ status: 409, code: 'invalid_transition' })
  })

  it('postImportMessages answers the rejected messages with their reasons', async () => {
    const res = { inserted: [], skipped: ['5'], rejected: [{ discord_message_id: '5', reason: 'opted_out' }] }
    const { api } = setup(200, res)
    expect(await api.postImportMessages('j1', [])).toEqual(res)
  })

  it('postImportMessages POSTs the batch with a long timeout', async () => {
    const res = { inserted: [{ discord_message_id: '5', id: 'u' }], skipped: ['6'], rejected: [] }
    const { api, seen } = setup(200, res)
    const msg = { discord_message_id: '5', created_at: 'x', content: [], discord_user: {} }
    expect(await api.postImportMessages('j1', [msg])).toEqual(res)
    expect(seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/imports/j1/messages', method: 'POST', body: { messages: [msg] } })
    expect(seen[0].signal).toBeTruthy()
  })

  it('postImportMessages 409 import_not_running rejects with code', async () => {
    const { api } = setup(409, { code: 'import_not_running' })
    const err = await api.postImportMessages('j1', []).catch(e => e)
    expect(err).toBeInstanceOf(BridgeApiError)
    expect(err.status).toBe(409)
    expect(err.code).toBe('import_not_running')
  })

  it('404 import_not_found carries the code', async () => {
    const { api } = setup(404, { code: 'import_not_found' })
    await expect(api.linkImportReplies('nope')).rejects.toMatchObject({ status: 404, code: 'import_not_found' })
  })

  it('importThread returns thread_id', async () => {
    const { api, seen } = setup(200, { thread_id: 't1' })
    const body = { discord_thread_id: '9', name: 'n', created_at: 'x', archived: false, locked: false }
    expect(await api.importThread('j1', body)).toBe('t1')
    expect(seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/imports/j1/threads', method: 'POST', body })
  })

  it('linkImportReplies returns linked count', async () => {
    const { api, seen } = setup(200, { linked: 3 })
    expect(await api.linkImportReplies('j1')).toBe(3)
    expect(seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/imports/j1/replies/link', method: 'POST' })
  })

  it('cancelImport returns imports', async () => {
    const { api, seen } = setup(200, { imports: [job] })
    expect(await api.cancelImport('j1')).toEqual([job])
    expect(seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/imports/j1/cancel', method: 'POST' })
  })
})

describe('BridgeApi config', () => {
  const base = { bridge_id: 'b', server_id: 's', mode: 'self', discord_guild_id: null, settings: {}, pairs: [], harmony_channels: [] }

  it('reads history_import and privacy_version', async () => {
    const { api } = setup(200, { ...base, history_import: { enabled: true, reason: null }, privacy_version: 'v7' })
    const config = await api.getConfig()
    expect(config.history_import).toEqual({ enabled: true, reason: null })
    expect(config.privacy_version).toBe('v7')
  })

  it('reads a gateway without them as import disabled and no privacy routes', async () => {
    const { api } = setup(200, base)
    const config = await api.getConfig()
    expect(config.history_import).toEqual({ enabled: false, reason: null })
    expect(config.privacy_version).toBeNull()
  })

  it('keeps the reason import is off', async () => {
    const { api } = setup(200, { ...base, history_import: { enabled: false, reason: 'bridge_mode' } })
    expect((await api.getConfig()).history_import).toEqual({ enabled: false, reason: 'bridge_mode' })
  })
})

describe('BridgeApi privacy', () => {
  it('getOptOuts reads the version and the ids', async () => {
    const { api, seen } = setup(200, { version: 'v3', remote_user_ids: ['1', '2'] })
    expect(await api.getOptOuts()).toEqual({ version: 'v3', remoteUserIds: ['1', '2'] })
    expect(seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/privacy/optouts', method: 'GET', auth: 'Bot tok' })
  })

  it('getOptOuts refuses an answer without the list', async () => {
    const { api } = setup(200, { version: 'v3' })
    await expect(api.getOptOuts()).rejects.toBeInstanceOf(BridgeApiError)
  })

  it('getOptOut, putOptOut and deleteOptOut act on one Discord user id and answer the standing', async () => {
    const get = setup(200, { opted_out: true, since: '2026-11-01T00:00:00Z', source: 'self' })
    expect(await get.api.getOptOut('42')).toEqual({ opted_out: true, since: '2026-11-01T00:00:00Z', source: 'self' })
    expect(get.seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/privacy/optouts/42', method: 'GET' })

    const put = setup(200, { opted_out: true, since: '2026-11-02T00:00:00Z', source: 'self' })
    expect(await put.api.putOptOut('42', 'dana')).toEqual({ opted_out: true, since: '2026-11-02T00:00:00Z', source: 'self' })
    expect(put.seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/privacy/optouts/42', method: 'PUT', body: { username: 'dana' } })

    const del = setup(200, { opted_out: false, since: null, source: null })
    expect(await del.api.deleteOptOut('42')).toEqual({ opted_out: false, since: null, source: null })
    expect(del.seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/privacy/optouts/42', method: 'DELETE' })
  })

  it('deleteOptOut answers a removal by a manager as still opted out', async () => {
    const { api } = setup(200, { opted_out: true, since: '2026-11-01T00:00:00Z', source: 'manager' })
    expect(await api.deleteOptOut('42')).toEqual({ opted_out: true, since: '2026-11-01T00:00:00Z', source: 'manager' })
  })

  it('an id that is not a Discord id carries invalid_remote_user', async () => {
    const { api } = setup(400, { code: 'invalid_remote_user' })
    await expect(api.getOptOut('nope')).rejects.toMatchObject({ status: 400, code: 'invalid_remote_user' })
  })

  it('erase POSTs the Discord user id and answers the count', async () => {
    const { api, seen } = setup(202, { opted_out: true, erased: 12, more: true })
    expect(await api.erase('42')).toEqual({ erased: 12, more: true })
    expect(seen[0]).toMatchObject({ url: 'https://api.test/bridge/v2/privacy/erase', method: 'POST', body: { remote_user_id: '42' } })
  })

  it('erase makes one attempt: a recent erase is answered with its wait, not waited out', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return new Response(JSON.stringify({ code: 'erase_recent', retry_after: 41 }), { status: 429, headers: { 'Retry-After': '41' } })
    }
    const api = new BridgeApi('https://api.test/', 'tok', { fetchImpl })
    await expect(api.erase('42')).rejects.toMatchObject({ status: 429, code: 'erase_recent', retryAfterMs: 41_000 })
    expect(calls).toBe(1)
  })
})
