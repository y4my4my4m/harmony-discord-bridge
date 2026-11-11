import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { V2Bridge, type RuntimeLike } from '../src/v2/V2Bridge.js'
import { V2Directory, normalizeV2Settings } from '../src/v2/V2Directory.js'
import type { BridgeV2Config } from '../src/v2/BridgeApi.js'
import type { BridgeRuntimeOptions } from '../src/runtime/BridgeRuntime.js'
import type { DiscordGuildView } from '../src/problems.js'
import { silentLogger } from '../src/log.js'
import { ImportSlots } from '../src/runtime/importScheduler.js'

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

function bridge(fetchImpl: any, runtimes: FakeRuntime[], extra: Partial<ConstructorParameters<typeof V2Bridge>[0]> = {}) {
  return new V2Bridge({
    ...extra,
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
    createRuntime: extra.createRuntime ?? ((opts) => {
      const r = new FakeRuntime(opts)
      runtimes.push(r)
      return r
    }),
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
    expect(b.configLoaded()).toBe(true)
    expect(b.linkedGuildId()).toBe('g1')

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

  it('instance bridge: hands the shared client to the runtime and reports bot_not_in_guild', async () => {
    const { state, fetchImpl } = gateway()
    state.config = config({ mode: 'instance', discord_guild_id: 'g9' })
    const runtimes: FakeRuntime[] = []
    const shared = {} as any
    const b = bridge(fetchImpl, runtimes, { sharedDiscord: shared, discordToken: '' })
    await b.start()
    expect(runtimes[0].opts.sharedDiscord).toBe(shared)
    // Shared client: guild views hold the linked guild only, here absent.
    runtimes[0].guilds = []
    await vi.advanceTimersByTimeAsync(30_000)
    expect(state.statuses.at(-1).problems).toEqual([{ code: 'bot_not_in_guild', params: { guild_id: 'g9' } }])
    await b.stop()
  })

  it('waits with backoff while Harmony rejects the token, without building a runtime', async () => {
    const { state, fetchImpl } = gateway()
    state.configStatus = 401
    const runtimes: FakeRuntime[] = []
    const b = bridge(fetchImpl, runtimes)
    await b.start()
    expect(runtimes).toHaveLength(0)
    expect(b.configLoaded()).toBe(false)
    expect(b.linkedGuildId()).toBeNull()
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

describe('V2Bridge history import', () => {
  const queuedJob = { id: 'j1', state: 'queued', phase: 'messages', created_at: '2026-01-01T00:00:00Z', cancel_requested: false }

  function importGateway(intent: boolean) {
    const g = gateway()
    const imports: any[] = [queuedJob]
    const inner = g.fetchImpl.getMockImplementation()!
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/bridge/v2/imports') && (init?.method ?? 'GET') === 'GET') return Response.json({ imports })
      return inner(url, init)
    })
    class ImportRuntime extends FakeRuntime {
      discordIdentity() {
        return { ...super.discordIdentity(), intents: { message_content: intent, members: true, presence: false } }
      }
      discordClientForImport() { return null }
      translateForImport = vi.fn(async () => null)
      threadStarterForImport = vi.fn(async () => null)
    }
    return { ...g, imports, fetchImpl, ImportRuntime }
  }

  function importBridge(g: ReturnType<typeof importGateway>, runtimes: FakeRuntime[]) {
    return bridge(g.fetchImpl, runtimes, {
      import: { slots: new ImportSlots(1), settings: { pollMs: 3_600_000, pageDelayMs: 0 } },
      createRuntime: (opts) => { const r = new g.ImportRuntime(opts); runtimes.push(r); return r },
    })
  }

  it('reports message_content_needed_for_import while a job is queued and the intent is off', async () => {
    const g = importGateway(false)
    const runtimes: FakeRuntime[] = []
    const b = importBridge(g, runtimes)
    await b.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(b.currentProblems().map(p => p.code)).toContain('message_content_needed_for_import')
    expect(g.state.statuses.at(-1).problems.map((p: any) => p.code)).toContain('message_content_needed_for_import')

    // The job goes away: the next poll drops the problem.
    g.imports.length = 0
    runtimes[0].opts.hooks!.kickImports!()
    await vi.advanceTimersByTimeAsync(50)
    expect(b.currentProblems().map(p => p.code)).not.toContain('message_content_needed_for_import')
    await b.stop()
  })

  it('starts the job when the intent is on, and leaves imports unwired without options', async () => {
    const g = importGateway(true)
    const patches: string[] = []
    const inner = g.fetchImpl.getMockImplementation()!
    g.fetchImpl.mockImplementation(async (url: any, init?: RequestInit) => {
      if (init?.method === 'PATCH') { patches.push(String(url)); return Response.json({ import: { ...queuedJob, state: 'running' } }) }
      return inner(url, init)
    })
    const b = importBridge(g, [])
    await b.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(patches.some(u => u.endsWith('/imports/j1'))).toBe(true)
    // The unconnected client makes the importer back off; stop() waits for it to pause.
    const stopping = b.stop()
    await vi.advanceTimersByTimeAsync(40_000)
    await stopping

    const plain = gateway()
    const none = bridge(plain.fetchImpl, [])
    await none.start()
    none.kickImports()
    await vi.advanceTimersByTimeAsync(50)
    expect(plain.fetchImpl.mock.calls.some(c => String(c[0]).includes('/imports'))).toBe(false)
    await none.stop()
  })
})
