import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  CredentialsError,
  credentialsPath,
  hashSetupCode,
  loadCredentials,
  obtainCredentials,
} from '../src/v2/credentials.js'
import { EndpointError, normalizeHarmonyUrl, probeEndpoints } from '../src/v2/endpoints.js'

const REDEEMED = {
  bridge_id: 'b-1',
  server_id: 's-1',
  harmony_token: 'harmony-secret',
  api_url: 'https://har.example/bot-gateway',
  gateway_url: 'wss://har.example/bot-gateway/gateway',
  base_url: 'https://har.example',
}

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bridge-creds-'))
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function redeemFetch(status = 200, body: unknown = REDEEMED) {
  return vi.fn(async (_url: string | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

const base = { harmonyUrl: 'https://har.example', apiBase: 'https://har.example/bot-gateway' }

describe('obtainCredentials', () => {
  it('redeems the setup code on first run and saves credentials with mode 0600', async () => {
    const fetchImpl = redeemFetch()
    const result = await obtainCredentials({ ...base, setupCode: 'hb-aaaa-bbbb-cccc', dataDir, fetchImpl })

    expect(result.source).toBe('redeemed')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('https://har.example/bot-gateway/bridge/v2/redeem')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'hb-aaaa-bbbb-cccc' })

    const path = credentialsPath(dataDir)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved).toMatchObject({
      version: 1,
      bridge_id: 'b-1',
      harmony_token: 'harmony-secret',
      api_url: REDEEMED.api_url,
      gateway_url: REDEEMED.gateway_url,
      base_url: REDEEMED.base_url,
      harmony_url: 'https://har.example',
      setup_code_sha256: hashSetupCode('HB-AAAA-BBBB-CCCC'),
    })
  })

  it('reuses saved credentials for the same code without network', async () => {
    await obtainCredentials({ ...base, setupCode: 'HB-AAAA-BBBB-CCCC', dataDir, fetchImpl: redeemFetch() })
    const fetchImpl = redeemFetch()
    const result = await obtainCredentials({ ...base, setupCode: ' hb-aaaa-bbbb-cccc ', dataDir, fetchImpl })
    expect(result.source).toBe('saved')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reuses saved credentials when no code is set', async () => {
    await obtainCredentials({ ...base, setupCode: 'HB-AAAA-BBBB-CCCC', dataDir, fetchImpl: redeemFetch() })
    const result = await obtainCredentials({ ...base, setupCode: null, dataDir, fetchImpl: redeemFetch() })
    expect(result.source).toBe('saved')
    expect(result.creds.harmony_token).toBe('harmony-secret')
  })

  it('replaces credentials when a new code is given', async () => {
    await obtainCredentials({ ...base, setupCode: 'HB-AAAA-BBBB-CCCC', dataDir, fetchImpl: redeemFetch() })
    const fetchImpl = redeemFetch(200, { ...REDEEMED, harmony_token: 'rotated' })
    const result = await obtainCredentials({ ...base, setupCode: 'HB-DDDD-EEEE-FFFF', dataDir, fetchImpl })
    expect(result.source).toBe('redeemed')
    expect(loadCredentials(dataDir)?.harmony_token).toBe('rotated')
    expect(loadCredentials(dataDir)?.setup_code_sha256).toBe(hashSetupCode('HB-DDDD-EEEE-FFFF'))
  })

  it('keeps saved credentials when a new code is refused', async () => {
    await obtainCredentials({ ...base, setupCode: 'HB-AAAA-BBBB-CCCC', dataDir, fetchImpl: redeemFetch() })
    const warn = vi.fn()
    const result = await obtainCredentials({
      ...base,
      setupCode: 'HB-USED-USED-USED',
      dataDir,
      fetchImpl: redeemFetch(410, { error: 'Code already used' }),
      warn,
    })
    expect(result.source).toBe('saved')
    expect(result.creds.harmony_token).toBe('harmony-secret')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('fails with code_rejected when the first code is refused', async () => {
    const err = await obtainCredentials({
      ...base,
      setupCode: 'HB-XXXX-XXXX-XXXX',
      dataDir,
      fetchImpl: redeemFetch(404, { error: 'Unknown setup code' }),
    }).catch(e => e)
    expect(err).toBeInstanceOf(CredentialsError)
    expect(err.kind).toBe('code_rejected')
    expect(err.message).toContain('Unknown setup code')
    expect(loadCredentials(dataDir)).toBeNull()
  })

  it('fails with no_code without a code or saved credentials', async () => {
    const err = await obtainCredentials({ ...base, setupCode: null, dataDir, fetchImpl: redeemFetch() }).catch(e => e)
    expect(err).toBeInstanceOf(CredentialsError)
    expect(err.kind).toBe('no_code')
    expect(err.message).toContain('HARMONY_SETUP_CODE')
  })

  it('classifies network failures as unreachable (retryable)', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    const err = await obtainCredentials({ ...base, setupCode: 'HB-AAAA-BBBB-CCCC', dataDir, fetchImpl }).catch(e => e)
    expect(err.kind).toBe('unreachable')
  })

  it('rejects a corrupt credentials file with a clear message', async () => {
    writeFileSync(credentialsPath(dataDir), '{not json')
    const err = await obtainCredentials({ ...base, setupCode: null, dataDir, fetchImpl: redeemFetch() }).catch(e => e)
    expect(err.kind).toBe('storage')
  })
})

describe('endpoints', () => {
  it('normalizes HARMONY_URL', () => {
    expect(normalizeHarmonyUrl('har.mony.lol/')).toBe('https://har.mony.lol')
    expect(normalizeHarmonyUrl(' http://localhost:3002 ')).toBe('http://localhost:3002')
    expect(() => normalizeHarmonyUrl('ftp://x')).toThrow(/https/)
  })

  function healthFetch(okPaths: string[]) {
    return vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (okPaths.includes(u)) return Response.json({ status: 'ok' })
      if (u.endsWith('/health')) return new Response('<html>spa</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
      return new Response('not found', { status: 404 })
    })
  }

  it('finds bot-gateway behind the public /bot-gateway prefix', async () => {
    const ep = await probeEndpoints('https://har.example', healthFetch(['https://har.example/bot-gateway/health']))
    expect(ep).toEqual({
      apiBase: 'https://har.example/bot-gateway',
      gatewayUrl: 'wss://har.example/bot-gateway/gateway',
      direct: false,
    })
  })

  it('accepts a direct bot-gateway URL', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url) === 'http://localhost:3002/health'
        ? Response.json({ status: 'ok' })
        : new Response('Cannot GET', { status: 404 }))
    const ep = await probeEndpoints('http://localhost:3002', fetchImpl)
    expect(ep).toEqual({ apiBase: 'http://localhost:3002', gatewayUrl: 'ws://localhost:3002/gateway', direct: true })
  })

  it('reports a site without bot-gateway as a configuration error', async () => {
    const err = await probeEndpoints('https://example.org', healthFetch([])).catch(e => e)
    expect(err).toBeInstanceOf(EndpointError)
    expect(err.unreachable).toBe(false)
  })
})
