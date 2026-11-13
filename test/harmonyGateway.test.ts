import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import { HarmonyClient } from '../src/HarmonyClient.js'
import { silentLogger } from '../src/log.js'

let server: WebSocketServer | null = null
let client: HarmonyClient | null = null

afterEach(async () => {
  client?.disconnect()
  client = null
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

/** bot-gateway stand-in: `onIdentify` decides the reply to op 2. */
async function gateway(onIdentify: (ws: WebSocket, token: string) => void) {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>(resolve => server!.once('listening', () => resolve()))
  let connections = 0
  server.on('connection', ws => {
    connections++
    ws.on('message', raw => {
      const payload = JSON.parse(raw.toString())
      if (payload.op === 2) onIdentify(ws, payload.d.token)
    })
  })
  const { port } = server.address() as AddressInfo
  return { url: `ws://127.0.0.1:${port}/gateway`, connections: () => connections }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('HarmonyClient gateway', () => {
  it('surfaces close 4004 as an auth failure and backs off', async () => {
    const gw = await gateway(ws => ws.close(4004, 'Authentication failed'))
    client = new HarmonyClient('bad', gw.url, 'http://127.0.0.1:1', {
      log: silentLogger,
      reconnectBaseMs: 20,
      authRetryBaseMs: 1000,
      authRetryMaxMs: 1000,
    })
    const failures: Array<{ code: number; reason: string }> = []
    client.on('authFailed', e => failures.push(e))
    await client.connect()
    await sleep(300)

    expect(failures).toEqual([{ code: 4004, reason: 'Authentication failed' }])
    expect(client.isAuthRejected()).toBe(true)
    expect(client.isConnected()).toBe(false)
    expect(gw.connections()).toBe(1)

    // Auth retries wait 800–1200 ms (±20 % jitter), not the 20 ms ordinary reconnect.
    await sleep(1200)
    expect(gw.connections()).toBe(2)
  })

  it('becomes connected on READY and dispatches BRIDGE_CONFIG_UPDATE', async () => {
    const gw = await gateway(ws => {
      ws.send(JSON.stringify({ op: 0, t: 'READY', d: { bot: { id: 'b', username: 'bridge' }, session_id: 's', heartbeat_interval: 30000 } }))
      ws.send(JSON.stringify({ op: 0, t: 'BRIDGE_CONFIG_UPDATE', d: { bridge_id: 'x' } }))
    })
    client = new HarmonyClient('good', gw.url, 'http://127.0.0.1:1', { log: silentLogger })
    const updates: unknown[] = []
    const states: boolean[] = []
    client.on('bridgeConfigUpdate', d => updates.push(d))
    client.on('connectionState', s => states.push(s))
    await client.connect()
    await sleep(200)

    expect(client.isConnected()).toBe(true)
    expect(updates).toEqual([{ bridge_id: 'x' }])
    expect(states).toEqual([true])
    client.disconnect()
    expect(states).toEqual([true, false])
  })

  it('reconnects after a 4008 rate-limit close with a growing backoff, reset only after a quiet window', async () => {
    const gw = await gateway(ws => {
      ws.send(JSON.stringify({ op: 0, t: 'READY', d: { bot: { id: 'b', username: 'bridge' }, session_id: 's', heartbeat_interval: 30000 } }))
      setTimeout(() => ws.close(4008, 'rate limited'), 10)
    })
    client = new HarmonyClient('good', gw.url, 'http://127.0.0.1:1', {
      log: silentLogger,
      reconnectBaseMs: 100,
      reconnectMaxMs: 10_000,
    })
    const limited: Array<{ code: number }> = []
    client.on('gatewayRateLimited', e => limited.push(e))
    await client.connect()
    // Delays 100, 200, 400 ms (±20 %): READY after a 4008 does not reset them.
    await sleep(500)
    expect(limited.length).toBeGreaterThanOrEqual(2)
    const early = gw.connections()
    await sleep(500)
    expect(gw.connections() - early).toBeLessThanOrEqual(2)
    expect(limited[0]).toMatchObject({ code: 4008 })
  })
})

describe('HarmonyClient capabilities', () => {
  const ready = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ op: 0, t: 'READY', d: { bot: { id: 'b', username: 'bridge' }, session_id: 's', heartbeat_interval: 30000, ...extra } })

  it('reads the feature list of READY', async () => {
    const gw = await gateway(ws => ws.send(ready({ capabilities: ['bridge_emoji_sync', 'bridge_privacy'] })))
    client = new HarmonyClient('good', gw.url, 'http://127.0.0.1:1', { log: silentLogger })
    expect(client.capabilitiesKnown()).toBe(false)
    expect(client.hasCapability('bridge_emoji_sync')).toBe(false)
    await client.connect()
    await sleep(200)
    expect(client.capabilitiesKnown()).toBe(true)
    expect(client.hasCapability('bridge_emoji_sync')).toBe(true)
    expect(client.hasCapability('bridge_privacy')).toBe(true)
    expect(client.hasCapability('bridge_history_import')).toBe(false)
  })

  it('reads a READY without the list as a gateway with none', async () => {
    const gw = await gateway(ws => ws.send(ready()))
    client = new HarmonyClient('good', gw.url, 'http://127.0.0.1:1', { log: silentLogger })
    await client.connect()
    await sleep(200)
    expect(client.capabilitiesKnown()).toBe(true)
    expect(client.hasCapability('bridge_sound_sync')).toBe(false)
  })

  it('reads the list from GET /users/@me before READY', async () => {
    const seen: string[] = []
    const fetchImpl = async (url: string | URL) => {
      seen.push(String(url))
      return Response.json({ id: 'b', username: 'bridge', capabilities: ['bridge_sticker_sync'] })
    }
    client = new HarmonyClient('good', 'ws://127.0.0.1:1/gateway', 'http://api.test', { log: silentLogger, fetchImpl })
    await client.loadCapabilities()
    expect(seen).toEqual(['http://api.test/api/v1/users/@me'])
    expect(client.hasCapability('bridge_sticker_sync')).toBe(true)
    expect(client.hasCapability('bridge_emoji_sync')).toBe(false)
  })

  it('leaves the list unknown when GET /users/@me fails', async () => {
    client = new HarmonyClient('good', 'ws://127.0.0.1:1/gateway', 'http://api.test', {
      log: silentLogger, fetchImpl: async () => new Response('down', { status: 503 }), retry: { attempts: 1 },
    })
    await expect(client.loadCapabilities()).rejects.toBeTruthy()
    expect(client.capabilitiesKnown()).toBe(false)
  })
})
