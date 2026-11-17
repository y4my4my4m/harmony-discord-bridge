import { describe, expect, it } from 'vitest'
import { hostBridgeFactories } from '../src/v2/launch.js'
import { V2Bridge } from '../src/v2/V2Bridge.js'
import { WorkerHostedInstance } from '../src/v2/WorkerHostedInstance.js'
import { Logger } from '../src/log.js'

const settings = { pollMs: 20_000, pageDelayMs: 500 }

function factories(mode: 'inline' | 'worker') {
  return hostBridgeFactories({
    apiBase: 'http://gw.test/bot-gateway',
    gatewayUrl: 'ws://gw.test/bot-gateway/ws',
    publicUrl: null,
    dataDir: '/tmp/bridge-host-test',
    log: new Logger('warn'),
    version: '2.8.0',
    isolation: { mode, heapMb: 128 },
    importSettings: settings,
  })
}

const importOf = (bridge: unknown) => (bridge as { opts: { import?: { slots: unknown; settings: unknown } } }).opts.import

describe('host mode history import wiring', () => {
  it('gives every instance bot bridge import wiring on one shared slot', () => {
    const f = factories('inline')
    const shared = {} as any
    const a = f.createInstanceBridge({ bridge_id: 'aaaaaaaa-1', harmony_token: 't1', discord_guild_id: '1' }, shared)
    const b = f.createInstanceBridge({ bridge_id: 'bbbbbbbb-2', harmony_token: 't2', discord_guild_id: '2' }, shared)
    expect(importOf(a)?.settings).toEqual(settings)
    expect(importOf(a)?.slots).toBeDefined()
    expect(importOf(a)?.slots).toBe(importOf(b)?.slots)
  })

  it('gives each inline own-bot bridge slots of its own', () => {
    const f = factories('inline')
    const instance = f.createInstanceBridge({ bridge_id: 'aaaaaaaa-1', harmony_token: 't1', discord_guild_id: '1' }, {} as any)
    const a = f.createHosted({ bridge_id: 'cccccccc-3', harmony_token: 't3', discord_token: 'd3' })
    const b = f.createHosted({ bridge_id: 'dddddddd-4', harmony_token: 't4', discord_token: 'd4' })
    expect(a).toBeInstanceOf(V2Bridge)
    expect(importOf(a)?.settings).toEqual(settings)
    expect(importOf(a)?.slots).not.toBe(importOf(b)?.slots)
    expect(importOf(a)?.slots).not.toBe(importOf(instance)?.slots)
  })

  it('hands the import settings to a worker thread', () => {
    const hosted = factories('worker').createHosted({ bridge_id: 'eeeeeeee-5', harmony_token: 't5', discord_token: 'd5' })
    expect(hosted).toBeInstanceOf(WorkerHostedInstance)
    expect((hosted as unknown as { opts: { workerData: { import?: unknown } } }).opts.workerData.import).toEqual(settings)
  })
})
