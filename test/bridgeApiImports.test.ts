import { describe, expect, it } from 'vitest'
import { BridgeApi, BridgeApiError, type ImportJob } from '../src/v2/BridgeApi.js'

interface Seen { url: string; method: string; body: unknown; auth: string | null; signal: AbortSignal | null }

function setup(status: number, payload: unknown) {
  const seen: Seen[] = []
  const fetchImpl = async (input: string | URL, init: RequestInit = {}) => {
    seen.push({
      url: String(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: (init.headers as Record<string, string>)?.Authorization ?? null,
      signal: (init.signal as AbortSignal | undefined) ?? null,
    })
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
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

  it('startImports exposes pair_not_importable', async () => {
    const { api } = setup(400, { code: 'pair_not_importable', discord_channel_id: '1' })
    await expect(api.startImports(['1'])).rejects.toMatchObject({ status: 400, code: 'pair_not_importable' })
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

  it('postImportMessages POSTs the batch with a long timeout', async () => {
    const res = { inserted: [{ discord_message_id: '5', id: 'u' }], skipped: ['6'] }
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
