import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { V2Bridge, type RuntimeLike } from '../src/v2/V2Bridge.js'
import { V2Directory, normalizeV2Settings } from '../src/v2/V2Directory.js'
import type { BridgeV2Config } from '../src/v2/BridgeApi.js'
import type { BridgeRuntimeOptions } from '../src/runtime/BridgeRuntime.js'
import type { DiscordGuildView } from '../src/problems.js'
import { silentLogger } from '../src/log.js'

function config(overrides: Partial<BridgeV2Config> = {}): BridgeV2Config {
  return {
    bridge_id: 'b-1',
    server_id: 's-1',
    mode: 'self',
    discord_guild_id: 'g1',
    settings: {},
    pairs: [{ harmony_channel_id: 'h1', harmony_channel_name: 'general', discord_channel_id: 'd1', direction: 'both' }],
    harmony_channels: [{ id: 'h1', name: 'general', type: 0 }, { id: 'h2', name: 'random', type: 0 }],
    ...overrides,
  }
}

class FakeRuntime implements RuntimeLike {
  harmony = new EventEmitter()
  started = 0
  stopped = 0
  changes: unknown[] = []
  guilds: DiscordGuildView[] | null = [{ id: 'g1', name: 'G', icon: null, channels: [
    { id: 'd1', name: 'general', type: 0, parent_id: null, position: 0, can_view: true, can_send: true, can_manage_webhooks: true },
  ] }]
  constructor(readonly opts: BridgeRuntimeOptions) {}
  async start() { this.started++ }
  async stop() { this.stopped++ }
  async onDirectoryChanged(change: unknown) { this.changes.push(change) }
  connectionProblems() { return [] }
  guildViews() { return this.guilds }
  discordIdentity() {
    return {
      applicationId: 'app-1',
      botUser: { id: 'app-1', name: 'bot', avatar: null },
      intents: { message_content: true, members: true, presence: false },
    }
  }
  isDiscordConnected() { return true }
  isHarmonyConnected() { return true }
}

/** bot-gateway /bridge/v2 stub. */
function gateway() {
  const state = {
    config: config(),
    configStatus: 200,
    statuses: [] as any[],
    configCalls: 0,
  }
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.endsWith('/bridge/v2/config')) {
      state.configCalls++
      return state.configStatus === 200
        ? Response.json(state.config)
        : Response.json({ error: 'Invalid token' }, { status: state.configStatus })
    }
    if (u.endsWith('/bridge/v2/status')) {
      state.statuses.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  })
  return { state, fetchImpl }
}

function bridge(fetchImpl: any, runtimes: FakeRuntime[]) {
  return new V2Bridge({
    harmonyToken: 'tok',
    apiBase: 'https://har.example/bot-gateway',
    gatewayUrl: 'wss://har.example/bot-gateway/gateway',
    baseUrl: null,
    discordToken: 'dtok',
    dataDir: '/tmp/unused',
    log: silentLogger,
    version: '2.0.0',
    authHint: 'auth hint',
    fetchImpl,
    statusDebounceMs: 10,
    createRuntime: (opts) => {
      const r = new FakeRuntime(opts)
      runtimes.push(r)
      return r
    },
  })
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('V2Bridge configuration', () => {
  it('loads /config, builds the runtime from it and reports status', async () => {
    const { state, fetchImpl } = gateway()
    const runtimes: FakeRuntime[] = []
    const b = bridge(fetchImpl, runtimes)
    await b.start()

    expect(runtimes).toHaveLength(1)
    const rt = runtimes[0]
    expect(rt.started).toBe(1)
    expect(rt.opts.mode).toBe('v2')
    expect(rt.opts.harmony.baseUrl).toBe('https://har.example')
    expect(rt.opts.directory.getHarmonyChannel('d1')).toBe('h1')
    expect(rt.opts.hooks?.harmonyChannels?.().map(c => c.id)).toEqual(['h1', 'h2'])

    await vi.advanceTimersByTimeAsync(20)
    expect(state.statuses).toHaveLength(1)
    expect(state.statuses[0]).toMatchObject({
      version: '2.0.0',
      discord: { connected: true, application_id: 'app-1' },
      harmony: { connected: true },
      problems: [],
    })
    expect(state.statuses[0].guilds[0].channels[0]).toMatchObject({ id: 'd1', can_send: true })
    await b.stop()
    expect(rt.stopped).toBe(1)
  })

  it('refetches on BRIDGE_CONFIG_UPDATE and applies the difference', async () => {
    const { state, fetchImpl } = gateway()
    const runtimes: FakeRuntime[] = []
    const b = bridge(fetchImpl, runtimes)
    await b.start()
    const rt = runtimes[0]
    const callsBefore = state.configCalls

    state.config = config({
      pairs: [
        ...config().pairs,
        { harmony_channel_id: 'h2', discord_channel_id: 'd2', direction: 'to_discord' },
      ],
    })
    rt.harmony.emit('bridgeConfigUpdate', { bridge_id: 'b-1' })
    await vi.advanceTimersByTimeAsync(300)

    expect(state.configCalls).toBe(callsBefore + 1)
    expect(rt.changes).toEqual([{ pairsChanged: true, guildChanged: false, settingsChanged: false, addedHarmonyChannels: ['h2'] }])
    expect(rt.opts.directory.getDiscordChannel('h2')).toBe('d2')
    expect(rt.opts.directory.shouldBridgeFromDiscord('d2')).toBe(false)
    expect(rt.opts.directory.shouldBridgeFromHarmony('h2')).toBe(true)
    await b.stop()
  })

  it('ignores updates for another bridge and unchanged configs', async () => {
    const { state, fetchImpl } = gateway()
    const runtimes: FakeRuntime[] = []
    const b = bridge(fetchImpl, runtimes)
    await b.start()
    const rt = runtimes[0]
    const callsBefore = state.configCalls

    rt.harmony.emit('bridgeConfigUpdate', { bridge_id: 'other' })
    await vi.advanceTimersByTimeAsync(300)
    expect(state.configCalls).toBe(callsBefore)

    rt.harmony.emit('bridgeConfigUpdate', {})
    await vi.advanceTimersByTimeAsync(300)
    expect(state.configCalls).toBe(callsBefore + 1)
    expect(rt.changes).toEqual([])
    await b.stop()
  })

  it('debounces bursts of updates into one fetch', async () => {
    const { state, fetchImpl } = gateway()
    const runtimes: FakeRuntime[] = []
    const b = bridge(fetchImpl, runtimes)
    await b.start()
    const callsBefore = state.configCalls
    for (let i = 0; i < 5; i++) runtimes[0].harmony.emit('bridgeConfigUpdate', { bridge_id: 'b-1' })
    await vi.advanceTimersByTimeAsync(300)
    expect(state.configCalls).toBe(callsBefore + 1)
    await b.stop()
  })

  it('refreshes every 60 s and reports settings and guild changes', async () => {
    const { state, fetchImpl } = gateway()
    const runtimes: FakeRuntime[] = []
    const b = bridge(fetchImpl, runtimes)
    await b.start()

    state.config = config({ discord_guild_id: 'g2', settings: { sync_presence: true } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runtimes[0].changes).toEqual([{ pairsChanged: false, guildChanged: true, settingsChanged: true, addedHarmonyChannels: [] }])
    expect(runtimes[0].opts.directory.runtimeSettings().syncPresence).toBe(true)
    await b.stop()
  })

  it('reports detected problems in the heartbeat', async () => {
    const { state, fetchImpl } = gateway()
    state.config = config({ discord_guild_id: null, pairs: [] })
    const runtimes: FakeRuntime[] = []
    const b = bridge(fetchImpl, runtimes)
    await b.start()
    runtimes[0].guilds = [
      { id: 'g1', name: 'A', icon: null, channels: [] },
      { id: 'g2', name: 'B', icon: null, channels: [] },
    ]
    await vi.advanceTimersByTimeAsync(30_000)
    expect(state.statuses.at(-1).problems).toEqual([{ code: 'guild_not_selected' }])
    expect(b.health().body.problems).toEqual(['guild_not_selected'])
    await b.stop()
  })

  it('waits with backoff while Harmony rejects the token, without building a runtime', async () => {
    const { state, fetchImpl } = gateway()
    state.configStatus = 401
    const runtimes: FakeRuntime[] = []
    const b = bridge(fetchImpl, runtimes)
    await b.start()
    expect(runtimes).toHaveLength(0)
    expect(b.health()).toMatchObject({ ok: false, body: { problems: ['harmony_auth_failed'] } })

    // First retry after ~60 s (auth backoff), not immediately.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(state.configCalls).toBe(1)
    state.configStatus = 200
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.configCalls).toBe(2)
    expect(runtimes).toHaveLength(1)
    await b.stop()
  })
})

describe('V2Directory', () => {
  it('applies contract defaults to settings', () => {
    expect(normalizeV2Settings({})).toEqual({
      syncMemberList: true,
      syncPresence: false,
      syncReactions: true,
      syncEdits: true,
      syncDeletes: true,
      syncPermissions: false,
      cloneRoles: false,
    })
    expect(normalizeV2Settings({ sync_member_list: false, sync_edits: 'yes' }).syncMemberList).toBe(false)
    expect(normalizeV2Settings({ sync_edits: 'yes' }).syncEdits).toBe(true)
  })

  it('maps directions and guild scope', () => {
    const dir = new V2Directory(config({
      pairs: [
        { harmony_channel_id: 'h1', discord_channel_id: 'd1', direction: 'both' },
        { harmony_channel_id: 'h2', discord_channel_id: 'd2', direction: 'to_harmony' },
        { harmony_channel_id: 'h3', discord_channel_id: 'd3', direction: 'bogus' as any },
      ],
    }))
    expect(dir.shouldBridgeFromDiscord('d2')).toBe(true)
    expect(dir.shouldBridgeFromHarmony('h2')).toBe(false)
    expect(dir.getAllMappings().find(p => p.discord === 'd3')?.direction).toBe('both')
    expect(dir.getBridgeForDiscordGuild('g1')?.harmonyServerId).toBe('s-1')
    expect(dir.getAllMappings('other')).toEqual([])

    const noGuild = new V2Directory(config({ discord_guild_id: null }))
    expect(noGuild.getBridges()).toEqual([])
    expect(noGuild.getHarmonyServerIds()).toEqual(['s-1'])
  })
})
