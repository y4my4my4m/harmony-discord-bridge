import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { V2Bridge, type RuntimeLike } from '../src/v2/V2Bridge.js'
import { V2Directory, normalizeV2Settings } from '../src/v2/V2Directory.js'
import type { BridgeV2Config } from '../src/v2/BridgeApi.js'
import type { BridgeRuntimeOptions } from '../src/runtime/BridgeRuntime.js'
import type { DiscordGuildView } from '../src/problems.js'
import { silentLogger } from '../src/log.js'
import { ImportSlots } from '../src/runtime/importScheduler.js'
import { OptOutList } from '../src/runtime/optOuts.js'

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
  const queuedJob = { id: 'j1', state: 'queued', phase: 'messages', created_at: '2026-01-01T00:00:00Z', cancel_requested: false, requested_via: 'discord', discord_channel_id: 'd1' }
  const ON = { history_import: { enabled: true, reason: null } }

  function importGateway(intent: boolean, over: Partial<BridgeV2Config> = ON) {
    const g = gateway()
    g.state.config = config(over)
    const imports: any[] = [queuedJob]
    const calls: string[] = []
    const control = { refuse: null as null | { status: number; body: unknown } }
    const inner = g.fetchImpl.getMockImplementation()!
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      if (u.includes('/bridge/v2/imports')) {
        calls.push(`${method} ${u.slice(u.indexOf('/imports'))}`)
        if (control.refuse) return Response.json(control.refuse.body, { status: control.refuse.status })
        if (method === 'GET' && u.endsWith('/imports')) return Response.json({ imports })
        if (method === 'GET') {
          const found = imports.find(j => u.endsWith(`/imports/${j.id}`))
          return found ? Response.json({ import: found }) : Response.json({ code: 'import_not_found' }, { status: 404 })
        }
        if (method === 'PATCH') return Response.json({ import: { ...queuedJob, state: 'running' } })
      }
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
    return { ...g, imports, calls, control, fetchImpl, ImportRuntime }
  }

  function importBridge(g: ReturnType<typeof importGateway>, runtimes: FakeRuntime[], extra: Partial<ConstructorParameters<typeof V2Bridge>[0]> = {}) {
    return bridge(g.fetchImpl, runtimes, {
      import: { slots: new ImportSlots(1), settings: { pollMs: 3_600_000, pageDelayMs: 0 } },
      createRuntime: (opts) => { const r = new g.ImportRuntime(opts); runtimes.push(r); return r },
      ...extra,
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

  it('starts the job when the configuration enables import, and stops without waiting on it', async () => {
    const g = importGateway(true)
    const b = importBridge(g, [])
    await b.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(g.calls).toContain('PATCH /imports/j1')
    // The unconnected client has the importer in a retry wait; stop() does not sit it out.
    let stopped = false
    void b.stop().then(() => { stopped = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(true)
  })

  it.each([
    ['no history_import in the configuration (an older gateway)', {}],
    ['history_import off on the instance', { history_import: { enabled: false, reason: 'instance_off' as const } }],
    ['a bridge mode that never imports', { history_import: { enabled: false, reason: 'bridge_mode' as const } }],
  ])('sends no import request with %s', async (_name, over) => {
    const g = importGateway(true, over)
    const runtimes: FakeRuntime[] = []
    const b = importBridge(g, runtimes)
    await b.start()
    runtimes[0].opts.hooks!.kickImports!()
    b.kickImports()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(g.calls).toEqual([])
    expect(runtimes[0].opts.hooks!.importEnabled!()).toBe(false)
    await b.stop()
  })

  it('never imports on the instance bot, whatever the configuration says', async () => {
    const g = importGateway(true)
    const runtimes: FakeRuntime[] = []
    const b = importBridge(g, runtimes, { sharedDiscord: {} as any })
    await b.start()
    b.kickImports()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(g.calls).toEqual([])
    expect(runtimes[0].opts.hooks!.importApi).toBeUndefined()
    expect(runtimes[0].opts.hooks!.importEnabled!()).toBe(false)
    await b.stop()
  })

  it('offers no import routes to the runtime of a bridge built without import', async () => {
    const plain = gateway()
    plain.state.config = config(ON)
    const runtimes: FakeRuntime[] = []
    const none = bridge(plain.fetchImpl, runtimes)
    await none.start()
    none.kickImports()
    await vi.advanceTimersByTimeAsync(50)
    expect(plain.fetchImpl.mock.calls.some(c => String(c[0]).includes('/imports'))).toBe(false)
    expect(runtimes[0].opts.hooks!.importApi).toBeUndefined()
    await none.stop()
  })

  it('starts polling when a configuration read turns import on, and stops when it turns off', async () => {
    const g = importGateway(false, {})
    const b = importBridge(g, [])
    await b.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(g.calls).toEqual([])

    g.state.config = config(ON)
    await b.refreshConfig('test')
    await vi.advanceTimersByTimeAsync(50)
    expect(g.calls).toEqual(['GET /imports'])

    g.state.config = config({ history_import: { enabled: false, reason: 'instance_off' } })
    await b.refreshConfig('test')
    b.kickImports()
    await vi.advanceTimersByTimeAsync(50)
    expect(g.calls).toEqual(['GET /imports'])
    await b.stop()
  })

  it('stops polling on a refusal and polls again on Harmony READY', async () => {
    const g = importGateway(false)
    g.control.refuse = { status: 403, body: { code: 'import_disabled', reason: 'instance_off' } }
    const runtimes: FakeRuntime[] = []
    const b = importBridge(g, runtimes)
    await b.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(g.calls).toEqual(['GET /imports'])
    // Three poll intervals pass without a request.
    await vi.advanceTimersByTimeAsync(3 * 3_600_000)
    expect(g.calls).toEqual(['GET /imports'])

    g.control.refuse = null
    runtimes[0].harmony.emit('ready', {})
    await vi.advanceTimersByTimeAsync(50)
    expect(g.calls).toEqual(['GET /imports', 'GET /imports'])
    await b.stop()
  })

  it('polls again after a refusal when the Discord command queued a job', async () => {
    const g = importGateway(false)
    g.control.refuse = { status: 403, body: { code: 'import_disabled', reason: 'instance_off' } }
    const runtimes: FakeRuntime[] = []
    const b = importBridge(g, runtimes)
    await b.start()
    await vi.advanceTimersByTimeAsync(50)
    expect(g.calls).toEqual(['GET /imports'])

    g.control.refuse = null
    runtimes[0].opts.hooks!.kickImports!()
    await vi.advanceTimersByTimeAsync(50)
    expect(g.calls).toEqual(['GET /imports', 'GET /imports'])
    await b.stop()
  })
})

describe('V2Bridge opt-out list', () => {
  function privacyGateway(version: string | null) {
    const g = gateway()
    g.state.config = config(version === null ? {} : { privacy_version: version })
    const list = { ids: ['111'], reads: 0, fail: false, version }
    const inner = g.fetchImpl.getMockImplementation()!
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/bridge/v2/privacy/optouts')) {
        list.reads++
        if (list.fail) return new Response('down', { status: 503 })
        return Response.json({ version: list.version, remote_user_ids: list.ids })
      }
      return inner(url, init)
    })
    class PrivacyRuntime extends FakeRuntime {
      optOuts = new OptOutList()
      startedWith: string[] | null = null
      async start() { this.startedWith = ['111', '222'].filter(id => this.optOuts.has(id)); await super.start() }
    }
    const runtimes: PrivacyRuntime[] = []
    const b = bridge(fetchImpl, runtimes, {
      createRuntime: (opts) => { const r = new PrivacyRuntime(opts); runtimes.push(r); return r },
    })
    return { ...g, list, b, runtimes }
  }

  it('reads the list before the runtime starts relaying', async () => {
    const g = privacyGateway('v1')
    await g.b.start()
    expect(g.runtimes[0].startedWith).toEqual(['111'])
    expect(g.runtimes[0].optOuts.version()).toBe('v1')
    await g.b.stop()
  })

  it('reads it again only when privacy_version changes', async () => {
    const g = privacyGateway('v1')
    await g.b.start()
    await g.b.refreshConfig('test')
    await vi.advanceTimersByTimeAsync(10)
    expect(g.list.reads).toBe(1)

    g.list.ids = ['111', '222']
    g.list.version = 'v2'
    g.state.config = config({ privacy_version: 'v2' })
    await g.b.refreshConfig('test')
    await vi.advanceTimersByTimeAsync(10)
    expect(g.list.reads).toBe(2)
    expect(g.runtimes[0].optOuts.has('222')).toBe(true)
    await g.b.stop()
  })

  it('tries again at the next configuration read after a failed read', async () => {
    const g = privacyGateway('v1')
    g.list.fail = true
    await g.b.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(g.runtimes[0].optOuts.has('111')).toBe(false)
    const reads = g.list.reads

    g.list.fail = false
    g.state.config = config({ privacy_version: 'v1', pairs: [] })
    await g.b.refreshConfig('test')
    await vi.advanceTimersByTimeAsync(10)
    expect(g.list.reads).toBeGreaterThan(reads)
    expect(g.runtimes[0].optOuts.has('111')).toBe(true)
    await g.b.stop()
  })

  it('asks nothing of a gateway without the privacy routes', async () => {
    const g = privacyGateway(null)
    await g.b.start()
    g.runtimes[0].harmony.emit('ready', {})
    await vi.advanceTimersByTimeAsync(10)
    expect(g.list.reads).toBe(0)
    await g.b.stop()
  })

  it('gives every v2 runtime the privacy routes, the instance bot included', async () => {
    const g = privacyGateway('v1')
    await g.b.start()
    expect(g.runtimes[0].opts.hooks!.privacyApi).toBeDefined()
    await g.b.stop()
  })
})
