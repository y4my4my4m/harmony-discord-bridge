import { describe, expect, it, vi } from 'vitest'
import { InstanceHost, ORPHAN_GRACE_MS, type InstanceBridge, type SharedClientLike } from '../src/v2/InstanceHost.js'
import { HostRunner } from '../src/v2/HostRunner.js'
import { BridgeApi, type InstanceBridgeEntry, type InstanceHosted } from '../src/v2/BridgeApi.js'
import { silentLogger } from '../src/log.js'

interface FakeShared extends SharedClientLike {
  token: string
  presence: boolean
  started: number
  stopped: number
  tokens: string[]
  presences: boolean[]
  /** Guilds the fake client is in; null while not ready. */
  guilds: string[] | null
  left: string[]
}

interface FakeBridge extends InstanceBridge {
  entry: InstanceBridgeEntry
  shared: FakeShared
  started: number
  stopped: number
  loaded: boolean
  /** /config discord_guild_id; defaults to the list entry's. */
  configGuild: string | null
}

function harness(initial: Array<InstanceHosted | null | Error>, clock = { now: 0 }) {
  const lists = [...initial]
  let current: InstanceHosted | null | Error = lists[0] ?? null
  const shareds: FakeShared[] = []
  const bridges: FakeBridge[] = []
  const host = new InstanceHost<FakeShared>({
    log: silentLogger,
    now: () => clock.now,
    fetchInstance: async () => {
      if (lists.length) current = lists.shift()!
      if (current instanceof Error) throw current
      return current
    },
    createShared: ({ token, presence }) => {
      const s: FakeShared = {
        token, presence, started: 0, stopped: 0, tokens: [], presences: [], guilds: null, left: [],
        start() { s.started++ },
        async stop() { s.stopped++ },
        setToken(t) { s.tokens.push(t) },
        setPresence(p) { s.presences.push(p) },
        guildIds: () => s.guilds,
        async leaveGuild(id) {
          s.left.push(id)
          s.guilds = s.guilds?.filter(g => g !== id) ?? null
          return `guild-${id}`
        },
        health: () => ({ state: 'ready' }),
      }
      shareds.push(s)
      return s
    },
    createBridge: (entry, shared) => {
      const b: FakeBridge = {
        entry, shared, started: 0, stopped: 0, loaded: true, configGuild: entry.discord_guild_id,
        async start() { b.started++ },
        async stop() { b.stopped++ },
        configLoaded: () => b.loaded,
        linkedGuildId: () => b.configGuild,
        health: () => ({ ok: true, body: { bridge_id: entry.bridge_id } }),
      }
      bridges.push(b)
      return b
    },
  })
  return { host, shareds, bridges, clock, push(list: InstanceHosted | null | Error) { lists.push(list) } }
}

const bridge = (id: string, harmony = `h-${id}`, guild: string | null = `g-${id}`): InstanceBridgeEntry =>
  ({ bridge_id: id, harmony_token: harmony, discord_guild_id: guild })

const instance = (bridges: InstanceBridgeEntry[], token = 'inst-token', presence = false): InstanceHosted =>
  ({ application_id: 'app', discord_token: token, presence, bridges })

describe('InstanceHost', () => {
  it('runs no shared client while /hosted/instance answers 404', async () => {
    const h = harness([null])
    await h.host.reconcile()
    expect(h.shareds).toHaveLength(0)
    expect(h.host.hasSharedClient()).toBe(false)
    expect(h.host.health()).toMatchObject({ ok: true, body: { enabled: false, discord: null, bridges: [] } })
  })

  it('serves every linked bridge with one shared client, connecting once they started', async () => {
    const h = harness([instance([bridge('a'), bridge('b')])])
    await h.host.reconcile()
    expect(h.shareds[0].started).toBe(0)
    await new Promise(r => setTimeout(r, 0))
    expect(h.shareds).toHaveLength(1)
    expect(h.shareds[0]).toMatchObject({ token: 'inst-token', presence: false, started: 1 })
    expect(h.host.runningIds().sort()).toEqual(['a', 'b'])
    expect(h.bridges.every(b => b.shared === h.shareds[0] && b.started === 1)).toBe(true)
  })

  it('adds and removes bridges without touching the shared client', async () => {
    const h = harness([instance([bridge('a'), bridge('b')])])
    await h.host.reconcile()
    const [a, b] = h.bridges

    h.push(instance([bridge('a'), bridge('c')]))
    await h.host.reconcile()

    expect(h.shareds).toHaveLength(1)
    expect(h.shareds[0]).toMatchObject({ stopped: 0, tokens: [], presences: [] })
    expect(a.stopped).toBe(0)
    expect(b.stopped).toBe(1)
    expect(h.host.runningIds().sort()).toEqual(['a', 'c'])
  })

  it('hands token and presence changes to the shared client; restarts a bridge whose Harmony token changed', async () => {
    const h = harness([instance([bridge('a'), bridge('b')])])
    await h.host.reconcile()
    const [a, b] = h.bridges

    h.push(instance([bridge('a'), bridge('b', 'h-b-rotated')], 'new-token', true))
    await h.host.reconcile()

    expect(h.shareds).toHaveLength(1)
    expect(h.shareds[0].tokens).toEqual(['new-token'])
    expect(h.shareds[0].presences).toEqual([true])
    expect(a.stopped).toBe(0)
    expect(b.stopped).toBe(1)
    expect(h.bridges.at(-1)!.entry.harmony_token).toBe('h-b-rotated')

    // Unchanged list: nothing happens.
    h.push(instance([bridge('a'), bridge('b', 'h-b-rotated')], 'new-token', true))
    await h.host.reconcile()
    expect(h.shareds[0].tokens).toEqual(['new-token'])
    expect(h.shareds[0].presences).toEqual([true])
  })

  it('stops the bridges and the client when the instance bot is disabled', async () => {
    const h = harness([instance([bridge('a')]), null])
    await h.host.reconcile()
    await h.host.reconcile()
    expect(h.bridges[0].stopped).toBe(1)
    expect(h.shareds[0].stopped).toBe(1)
    expect(h.host.hasSharedClient()).toBe(false)
    expect(h.host.health().body.enabled).toBe(false)
  })

  it('keeps everything running when the list cannot be fetched', async () => {
    const h = harness([instance([bridge('a')]), new Error('ECONNREFUSED')])
    await h.host.reconcile()
    await h.host.reconcile()
    expect(h.host.runningIds()).toEqual(['a'])
    expect(h.shareds[0].stopped).toBe(0)
    expect(h.host.health().ok).toBe(false)
  })
})

describe('InstanceHost orphan guilds', () => {
  const MIN = 60_000

  /** Instance with bridge `a` linked to g-a; the client is in g-a and gX. */
  async function orphanHarness() {
    const list = instance([bridge('a')])
    const h = harness([list])
    await h.host.reconcile()
    h.shareds[0].guilds = ['g-a', 'gX']
    const poll = async (at: number, next: InstanceHosted | null | Error = list) => {
      h.clock.now = at
      h.push(next)
      await h.host.reconcile()
    }
    return { h, poll, list }
  }

  it('leaves a guild after 10 minutes unlinked, not before', async () => {
    const { h, poll } = await orphanHarness()
    expect(ORPHAN_GRACE_MS).toBe(10 * MIN)
    for (const at of [0, 1, 5, 9, 9.99]) await poll(at * MIN)
    expect(h.shareds[0].left).toEqual([])
    await poll(10 * MIN)
    expect(h.shareds[0].left).toEqual(['gX'])
    await poll(11 * MIN)
    await poll(30 * MIN)
    expect(h.shareds[0].left).toEqual(['gX'])
  })

  it('forgets a guild that is linked again, through /config or the list', async () => {
    const { h, poll } = await orphanHarness()
    const a = h.bridges[0]
    await poll(0)
    // Re-link of bridge a to gX, seen in its /config.
    a.configGuild = 'gX'
    await poll(5 * MIN)
    a.configGuild = 'g-a'
    await poll(12 * MIN)
    await poll(21 * MIN)
    expect(h.shareds[0].left).toEqual([])
    // Linked by a list entry whose /config has not caught up yet.
    await poll(22 * MIN, instance([bridge('a'), bridge('b', 'h-b', 'gX')]))
    await poll(40 * MIN, instance([bridge('a'), bridge('b', 'h-b', 'gX')]))
    expect(h.shareds[0].left).toEqual([])
    // Unlinked again: the timer starts over.
    await poll(41 * MIN)
    await poll(50 * MIN)
    expect(h.shareds[0].left).toEqual([])
    await poll(51 * MIN)
    expect(h.shareds[0].left).toEqual(['gX'])
  })

  it('does not count a failed fetch; observation restarts on the next success', async () => {
    const { h, poll } = await orphanHarness()
    await poll(0)
    await poll(5 * MIN)
    await poll(10 * MIN, new Error('ECONNREFUSED'))
    expect(h.shareds[0].left).toEqual([])
    await poll(11 * MIN)
    await poll(20 * MIN)
    expect(h.shareds[0].left).toEqual([])
    await poll(21 * MIN)
    expect(h.shareds[0].left).toEqual(['gX'])
  })

  it('leaves nothing while a bridge /config has not loaded', async () => {
    const { h, poll } = await orphanHarness()
    h.bridges[0].loaded = false
    await poll(0)
    await poll(15 * MIN)
    await poll(30 * MIN)
    expect(h.shareds[0].left).toEqual([])
    h.bridges[0].loaded = true
    await poll(31 * MIN)
    expect(h.shareds[0].left).toEqual(['gX'])
  })

  it('leaves nothing on a 404 and observes nothing while the client is not ready', async () => {
    const { h, poll } = await orphanHarness()
    const shared = h.shareds[0]
    shared.guilds = null
    await poll(0)
    await poll(20 * MIN)
    expect(shared.left).toEqual([])
    shared.guilds = ['g-a', 'gX']
    await poll(21 * MIN)
    await poll(25 * MIN, null)
    expect(shared.left).toEqual([])
    expect(shared.stopped).toBe(1)
  })
})

describe('HostRunner with instance bridges', () => {
  it('reconciles instance bridges on the same tick, also when /hosted fails', async () => {
    const reconcile = vi.fn(async () => {})
    const stop = vi.fn(async () => {})
    const runner = new HostRunner({
      log: silentLogger,
      intervalMs: 1_000_000,
      fetchHosted: async () => { throw new Error('down') },
      createInstance: () => { throw new Error('unused') },
      instance: { reconcile, stop, health: () => ({ ok: true, body: { enabled: true } }) },
    })
    await runner.start()
    await runner.reconcile()
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(runner.health().body.instance).toEqual({ enabled: true })
    await runner.stop()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('BridgeApi.hostedInstance', () => {
  it('returns null on 404', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 }))
    expect(await BridgeApi.hostedInstance('https://h.example/bot-gateway', 'sec', fetchImpl)).toBeNull()
  })

  it('reads the instance bot and its bridges with the host secret', async () => {
    let url = ''
    let secret = ''
    const fetchImpl = vi.fn(async (u: string | URL, init?: RequestInit) => {
      url = String(u)
      secret = (init?.headers as Record<string, string>)['X-Bridge-Host-Secret']
      return Response.json({
        application_id: 'app',
        discord_token: 'tok',
        presence: true,
        bridges: [
          { bridge_id: 'a', harmony_token: 'ha', discord_guild_id: '123' },
          { bridge_id: 'b', harmony_token: 'hb', discord_guild_id: null },
          { bridge_id: 'broken' },
        ],
      })
    })
    const result = await BridgeApi.hostedInstance('https://h.example/bot-gateway/', 'sec', fetchImpl)
    expect(url).toBe('https://h.example/bot-gateway/bridge/v2/hosted/instance')
    expect(secret).toBe('sec')
    expect(result).toEqual({
      application_id: 'app',
      discord_token: 'tok',
      presence: true,
      bridges: [
        { bridge_id: 'a', harmony_token: 'ha', discord_guild_id: '123' },
        { bridge_id: 'b', harmony_token: 'hb', discord_guild_id: null },
      ],
    })
  })
})
