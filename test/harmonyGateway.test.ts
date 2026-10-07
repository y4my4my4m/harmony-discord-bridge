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
})
