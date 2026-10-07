import { describe, expect, it, vi } from 'vitest'
import { HostRunner, type HostedInstance } from '../src/v2/HostRunner.js'
import type { HostedEntry } from '../src/v2/BridgeApi.js'
import { silentLogger } from '../src/log.js'

interface Fake extends HostedInstance {
  entry: HostedEntry
  started: number
  stopped: number
}

function harness(initial: Array<HostedEntry[] | null | Error>) {
  const lists = [...initial]
  let current: HostedEntry[] | null | Error = lists[0] ?? []
  const instances: Fake[] = []
  const failStart = new Set<string>()
  const failCreate = new Set<string>()

  const runner = new HostRunner({
    log: silentLogger,
    intervalMs: 1_000_000,
    fetchHosted: async () => {
      if (lists.length) current = lists.shift()!
      if (current instanceof Error) throw current
      return current
    },
    createInstance: (entry) => {
      if (failCreate.has(entry.bridge_id)) throw new Error('bad entry')
      const inst: Fake = {
        entry,
        started: 0,
        stopped: 0,
        async start() {
          inst.started++
          if (failStart.has(entry.bridge_id)) throw new Error('discord down')
        },
        async stop() { inst.stopped++ },
        health: () => ({ ok: true, body: {} }),
      }
      instances.push(inst)
      return inst
    },
  })
  return {
    runner,
    instances,
    failStart,
    failCreate,
    setList(list: HostedEntry[] | null | Error) { lists.push(list) },
  }
}

const entry = (id: string, discord = `d-${id}`, harmony = `h-${id}`): HostedEntry =>
  ({ bridge_id: id, discord_token: discord, harmony_token: harmony })

describe('HostRunner', () => {
  it('starts one instance per hosted bridge', async () => {
    const h = harness([[entry('a'), entry('b')]])
    await h.runner.start()
    expect(h.runner.runningIds().sort()).toEqual(['a', 'b'])
    expect(h.instances.map(i => i.started)).toEqual([1, 1])
    expect(h.runner.health().ok).toBe(true)
    await h.runner.stop()
    expect(h.instances.map(i => i.stopped)).toEqual([1, 1])
  })

  it('stops removed bridges, restarts changed tokens, starts new ones', async () => {
    const h = harness([[entry('a'), entry('b'), entry('c')]])
    await h.runner.start()
    const [a, b, c] = h.instances

    h.setList([entry('a'), entry('b', 'd-b-rotated'), entry('d')])
    await h.runner.reconcile()

    expect(a.stopped).toBe(0)
    expect(b.stopped).toBe(1)
    expect(c.stopped).toBe(1)
    expect(h.runner.runningIds().sort()).toEqual(['a', 'b', 'd'])
    const newB = h.instances.find(i => i.entry.bridge_id === 'b' && i !== b)!
    expect(newB.entry.discord_token).toBe('d-b-rotated')
    expect(newB.started).toBe(1)
    expect(h.instances.find(i => i.entry.bridge_id === 'd')!.started).toBe(1)
  })

  it('leaves unchanged bridges alone across reconciles', async () => {
    const h = harness([[entry('a')], [entry('a')]])
    await h.runner.start()
    await h.runner.reconcile()
    expect(h.instances).toHaveLength(1)
    expect(h.instances[0].stopped).toBe(0)
  })

  it('isolates failures of individual bridges', async () => {
    const h = harness([[entry('bad-start'), entry('bad-create'), entry('good')]])
    h.failStart.add('bad-start')
    h.failCreate.add('bad-create')
    await h.runner.start()
    await new Promise(r => setTimeout(r, 0))
    expect(h.runner.runningIds().sort()).toEqual(['bad-start', 'good'])
    expect(h.instances.find(i => i.entry.bridge_id === 'good')!.started).toBe(1)
  })

  it('keeps bridges running when the list cannot be fetched', async () => {
    const h = harness([[entry('a')], new Error('ECONNREFUSED')])
    await h.runner.start()
    await h.runner.reconcile()
    expect(h.runner.runningIds()).toEqual(['a'])
    expect(h.instances[0].stopped).toBe(0)
    expect(h.runner.health().ok).toBe(false)
  })

  it('stops everything when hosting is disabled (404)', async () => {
    const h = harness([[entry('a'), entry('b')], null])
    await h.runner.start()
    await h.runner.reconcile()
    expect(h.runner.runningIds()).toEqual([])
    expect(h.instances.map(i => i.stopped)).toEqual([1, 1])
    expect(h.runner.health().body.hosting_enabled).toBe(false)
  })

  it('serializes overlapping reconciles', async () => {
    const h = harness([[entry('a')]])
    await Promise.all([h.runner.reconcile(), h.runner.reconcile(), h.runner.reconcile()])
    expect(h.instances).toHaveLength(1)
  })
})

describe('HostRunner timer', () => {
  it('reconciles every interval', async () => {
    vi.useFakeTimers()
    try {
      const fetchHosted = vi.fn(async () => [] as HostedEntry[])
      const runner = new HostRunner({ log: silentLogger, intervalMs: 60_000, fetchHosted, createInstance: () => { throw new Error('unused') } })
      await runner.start()
      await vi.advanceTimersByTimeAsync(180_000)
      expect(fetchHosted).toHaveBeenCalledTimes(4)
      await runner.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
