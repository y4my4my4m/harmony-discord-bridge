import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Collection, Events, GatewayIntentBits, Routes } from 'discord.js'
import { SharedDiscordClient, ROUTED_EVENTS, type SharedDiscordSink } from '../src/runtime/SharedDiscordClient.js'
import { APPLICATION_FLAGS, type DiscordConnState } from '../src/runtime/discordConnection.js'
import { BridgeRuntime } from '../src/runtime/BridgeRuntime.js'
import { HarmonyClient } from '../src/HarmonyClient.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { detectProblems } from '../src/problems.js'
import { silentLogger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'
import { FakeDiscordClient, appResponse, fakeMember } from './fakeDiscord.js'

const ALL_GRANTS = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT
  | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS
  | APPLICATION_FLAGS.GATEWAY_PRESENCE

interface FakeSink extends SharedDiscordSink {
  received: Array<[string, unknown[]]>
  states: DiscordConnState[]
  readies: number
  bound: number
  unbound: number
  guild: string | null
  wants: { syncMemberList: boolean; syncPresence: boolean }
}

function sink(guild: string | null, wants = { syncMemberList: false, syncPresence: false }): FakeSink {
  const s: FakeSink = {
    received: [],
    states: [],
    readies: 0,
    bound: 0,
    unbound: 0,
    guild,
    wants,
    guildId: () => s.guild,
    needs: () => s.wants,
    events: new EventEmitter(),
    rest: new EventEmitter(),
    bindClient: () => { s.bound++ },
    onReady: () => { s.readies++ },
    onState: (state) => { s.states.push(state) },
    unbindClient: () => { s.unbound++ },
  }
  for (const event of Object.keys(ROUTED_EVENTS)) {
    s.events.on(event, (...args: unknown[]) => s.received.push([event, args]))
  }
  s.rest.on('rateLimited', (info: unknown) => s.received.push(['rateLimited', [info]]))
  return s
}

function harness(opts: { presence?: boolean; flags?: number; app?: () => Response } = {}) {
  const clients: FakeDiscordClient[] = []
  const appCalls = { n: 0 }
  const app = opts.app ?? appResponse(opts.flags ?? ALL_GRANTS)
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.endsWith('/applications/@me')) {
      appCalls.n++
      return app()
    }
    if (u.includes('/members')) return Response.json([])
    return new Response('not found', { status: 404 })
  })
  const shared = new SharedDiscordClient({
    token: 'instance-token',
    presence: opts.presence ?? false,
    log: silentLogger,
    fetchImpl,
    settleMs: 100,
    createClient: (options) => {
      const c = new FakeDiscordClient(options)
      clients.push(c)
      return c as any
    },
  })
  return { shared, clients, appCalls, fetchImpl }
}

const has = (c: FakeDiscordClient, bit: GatewayIntentBits) => c.intents().includes(bit)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-shared-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** Starts the shared client and lets the settle period and login pass. */
async function connect(shared: SharedDiscordClient, clients: FakeDiscordClient[]) {
  shared.start()
  await vi.advanceTimersByTimeAsync(150)
  clients.at(-1)!.ready()
  await vi.advanceTimersByTimeAsync(0)
}

describe('SharedDiscordClient routing', () => {
  it('delivers each event only to the bridge linked to its guild', async () => {
    const { shared, clients } = harness()
    const a = sink('gA')
    const b = sink('gB')
    shared.attach(a)
    shared.attach(b)
    await connect(shared, clients)
    const client = clients[0]
    client.addGuild('gA', ['cA'])
    client.addGuild('gB', ['cB'])

    client.emit(Events.MessageCreate, { guildId: 'gA', channelId: 'cA' })
    // Partial reaction without guildId: resolved through the channel cache.
    client.emit(Events.MessageReactionAdd, { message: { guildId: null, channelId: 'cB' } }, { id: 'u' })
    client.emit(Events.GuildMemberAdd, { guild: { id: 'gB' } })
    client.emit(Events.PresenceUpdate, null, { guild: { id: 'gA' } })
    client.emit(Events.InteractionCreate, { guildId: 'gB' })
    client.emit(Events.ChannelUpdate, {}, { guildId: 'gA' })
    client.emit(Events.MessageBulkDelete, new Collection(), { id: 'cB', guildId: 'gB' })
    // Unlinked guild and DM: nobody.
    client.emit(Events.MessageCreate, { guildId: 'gOther', channelId: 'cX' })
    client.emit(Events.MessageCreate, { guildId: null, channelId: 'dm' })
    client.emit(Events.InteractionCreate, { guildId: null })

    expect(a.received.map(([e]) => e)).toEqual([Events.MessageCreate, Events.PresenceUpdate, Events.ChannelUpdate])
    expect(b.received.map(([e]) => e)).toEqual([Events.MessageReactionAdd, Events.GuildMemberAdd, Events.InteractionCreate, Events.MessageBulkDelete])
    expect((a.received[0][1][0] as any).guildId).toBe('gA')
    await shared.stop()
  })

  it('attributes REST rate limits to the guild of the route', async () => {
    const { shared, clients } = harness()
    const a = sink('gA')
    const b = sink('gB')
    shared.attach(a)
    shared.attach(b)
    await connect(shared, clients)
    clients[0].addGuild('gB', ['cB'])

    clients[0].rest.emit('rateLimited', { global: false, majorParameter: 'cB', timeToReset: 20_000, route: '/channels/:id' })
    clients[0].rest.emit('rateLimited', { global: false, majorParameter: 'webhook-1', timeToReset: 20_000, route: '/webhooks/:id' })
    expect(a.received).toEqual([])
    expect(b.received.map(([e]) => e)).toEqual(['rateLimited'])

    clients[0].rest.emit('rateLimited', { global: true, majorParameter: 'global', timeToReset: 20_000, route: '/x' })
    expect(a.received.map(([e]) => e)).toEqual(['rateLimited'])
    await shared.stop()
  })

  it('follows a re-linked guild', async () => {
    const { shared, clients } = harness()
    const a = sink('gA')
    shared.attach(a)
    await connect(shared, clients)

    a.guild = 'gC'
    shared.reindex()
    clients[0].emit(Events.MessageCreate, { guildId: 'gA', channelId: 'x' })
    clients[0].emit(Events.MessageCreate, { guildId: 'gC', channelId: 'y' })
    expect(a.received.map(([, args]) => (args[0] as any).guildId)).toEqual(['gC'])
    await shared.stop()
  })
})

describe('SharedDiscordClient lifecycle', () => {
  it('batches bridges starting together into one connection with the union of their intents', async () => {
    const { shared, clients } = harness()
    shared.start()
    shared.attach(sink('g1'))
    shared.attach(sink('g2', { syncMemberList: true, syncPresence: false }))
    await vi.advanceTimersByTimeAsync(150)

    expect(clients).toHaveLength(1)
    expect(clients[0].login).toHaveBeenCalledWith('instance-token')
    expect(has(clients[0], GatewayIntentBits.Guilds)).toBe(true)
    expect(has(clients[0], GatewayIntentBits.GuildMessages)).toBe(true)
    expect(has(clients[0], GatewayIntentBits.MessageContent)).toBe(true)
    expect(has(clients[0], GatewayIntentBits.GuildMembers)).toBe(true)
    expect(has(clients[0], GatewayIntentBits.GuildPresences)).toBe(false)
    await shared.stop()
  })

  it('adds and removes bridges without restarting the client', async () => {
    const { shared, clients } = harness()
    const a = sink('g1')
    shared.attach(a)
    await connect(shared, clients)
    expect(a.readies).toBe(1)

    const b = sink('g2')
    shared.attach(b)
    await vi.advanceTimersByTimeAsync(500)
    expect(b.bound).toBe(1)
    expect(b.readies).toBe(1)
    expect(b.states.at(-1)).toBe('ready')

    shared.detach(a)
    await vi.advanceTimersByTimeAsync(500)
    expect(clients).toHaveLength(1)
    expect(clients[0].destroy).not.toHaveBeenCalled()
    clients[0].emit(Events.MessageCreate, { guildId: 'g1', channelId: 'x' })
    expect(a.received).toEqual([])
    expect(shared.attachedCount()).toBe(1)
    await shared.stop()
  })

  it('reconnects when the required intent set changes', async () => {
    const { shared, clients } = harness()
    const a = sink('g1')
    shared.attach(a)
    await connect(shared, clients)
    expect(has(clients[0], GatewayIntentBits.GuildMembers)).toBe(false)

    // A bridge that syncs its member list: GuildMembers.
    const b = sink('g2', { syncMemberList: true, syncPresence: true })
    shared.attach(b)
    await vi.advanceTimersByTimeAsync(150)
    expect(clients).toHaveLength(2)
    expect(clients[0].destroy).toHaveBeenCalled()
    expect(a.unbound).toBe(1)
    expect(has(clients[1], GatewayIntentBits.GuildMembers)).toBe(true)
    expect(has(clients[1], GatewayIntentBits.GuildPresences)).toBe(false)
    clients[1].ready()
    await vi.advanceTimersByTimeAsync(0)
    expect(a.readies).toBe(2)

    // Presence needs the instance switch.
    shared.setPresence(true)
    await vi.advanceTimersByTimeAsync(150)
    expect(clients).toHaveLength(3)
    expect(has(clients[2], GatewayIntentBits.GuildPresences)).toBe(true)
    clients[2].ready()

    // Same set: no reconnect.
    shared.attach(sink('g3', { syncMemberList: true, syncPresence: false }))
    await vi.advanceTimersByTimeAsync(150)
    expect(clients).toHaveLength(3)

    // Last presence bridge gone: smaller set, reconnect.
    shared.detach(b)
    await vi.advanceTimersByTimeAsync(150)
    expect(clients).toHaveLength(4)
    expect(has(clients[3], GatewayIntentBits.GuildPresences)).toBe(false)
    expect(has(clients[3], GatewayIntentBits.GuildMembers)).toBe(true)
    await shared.stop()
  })

  it('lists guilds once ready and leaves only guilds no bridge routes', async () => {
    const { shared, clients } = harness()
    shared.attach(sink('gA'))
    expect(shared.guildIds()).toBeNull()
    await connect(shared, clients)
    const linked = clients[0].addGuild('gA')
    const orphan = clients[0].addGuild('gOrphan')
    expect(shared.guildIds()?.sort()).toEqual(['gA', 'gOrphan'])

    expect(await shared.leaveGuild('gA')).toBeNull()
    expect(linked.leave).not.toHaveBeenCalled()
    expect(await shared.leaveGuild('gOrphan')).toBe('guild-gOrphan')
    expect(orphan.leave).toHaveBeenCalledTimes(1)
    expect(shared.guildIds()).toEqual(['gA'])
    await shared.stop()
  })

  it('reconnects with a new token', async () => {
    const { shared, clients } = harness()
    shared.attach(sink('g1'))
    await connect(shared, clients)
    shared.setToken('rotated')
    await vi.advanceTimersByTimeAsync(0)
    expect(clients).toHaveLength(2)
    expect(clients[1].login).toHaveBeenCalledWith('rotated')
    expect(shared.token()).toBe('rotated')
    await shared.stop()
  })

  it('reports a refused token to every bridge and backs off', async () => {
    const { shared, clients, appCalls } = harness({ app: () => Response.json({ message: '401: Unauthorized' }, { status: 401 }) })
    const a = sink('g1')
    const b = sink('g2')
    shared.attach(a)
    shared.attach(b)
    shared.start()
    await vi.advanceTimersByTimeAsync(150)

    expect(clients).toHaveLength(0)
    expect(a.states.at(-1)).toBe('token_invalid')
    expect(b.states.at(-1)).toBe('token_invalid')
    expect(appCalls.n).toBe(1)

    // Attaching another bridge does not bypass the backoff.
    shared.attach(sink('g3'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(appCalls.n).toBe(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(appCalls.n).toBe(2)
    await shared.stop()
  })

  it('reports a refused intent set per bridge, by what each bridge asks for', async () => {
    const { shared, clients } = harness({ flags: APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT })
    shared.attach(sink('g1'))
    shared.attach(sink('g2', { syncMemberList: true, syncPresence: false }))
    await connect(shared, clients)

    expect(has(clients[0], GatewayIntentBits.GuildMembers)).toBe(false)
    expect(shared.selectionFor({ syncMemberList: false, syncPresence: false })?.missing).toEqual([])
    expect(shared.selectionFor({ syncMemberList: true, syncPresence: false })?.missing).toEqual(['members'])
    await shared.stop()
  })
})

// ---------------------------------------------------------------------------
// BridgeRuntime on the shared client
// ---------------------------------------------------------------------------

const writer: PairWriter = { link: async () => {}, linkMany: async () => [], unlink: async () => false }

function runtimeFor(shared: SharedDiscordClient, bridge: string, guild: string | null, pairs: Array<[string, string]>, settings: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.includes('/members')) return Response.json([])
    return new Response('not found', { status: 404 })
  })
  return new BridgeRuntime({
    mode: 'v2',
    directory: new V2Directory({
      bridge_id: bridge,
      server_id: `s-${bridge}`,
      mode: 'instance',
      discord_guild_id: guild,
      settings: { sync_member_list: true, ...settings },
      pairs: pairs.map(([d, h]) => ({ discord_channel_id: d, harmony_channel_id: h, direction: 'both' as const })),
      harmony_channels: [],
    }),
    writer,
    discordToken: '',
    sharedDiscord: shared,
    harmony: { token: `htok-${bridge}`, gatewayUrl: 'ws://127.0.0.1:9/gateway', apiUrl: 'http://127.0.0.1:9', baseUrl: 'https://h.example' },
    permissionStorePath: join(dir, bridge, 'permission-sync.yml'),
    log: silentLogger,
    fetchImpl,
  })
}

async function twoBridges() {
  vi.spyOn(HarmonyClient.prototype, 'connect').mockResolvedValue(undefined)
  const { shared, clients } = harness()
  const a = runtimeFor(shared, 'A', 'gA', [['cA', 'hA']])
  const b = runtimeFor(shared, 'B', 'gB', [['cB', 'hB']])
  await a.start()
  await b.start()
  shared.start()
  await vi.advanceTimersByTimeAsync(150)
  const client = clients[0]
  client.addGuild('gA', ['cA'])
  client.addGuild('gB', ['cB'])
  client.addGuild('gOther', ['cX'])
  client.ready()
  await vi.advanceTimersByTimeAsync(0)
  return { shared, clients, client, a, b }
}

describe('BridgeRuntime on the instance bot', () => {
  it('never hands an event of guild A to bridge B', async () => {
    const { shared, client, a, b } = await twoBridges()
    const onMessageA = vi.spyOn(a as any, 'onDiscordMessage').mockResolvedValue(undefined)
    const onMessageB = vi.spyOn(b as any, 'onDiscordMessage').mockResolvedValue(undefined)

    client.emit(Events.MessageCreate, { guildId: 'gA', channelId: 'cA', author: { bot: false } })
    client.emit(Events.GuildMemberAdd, fakeMember('gA', 'u1'))
    client.emit(Events.MessageCreate, { guildId: 'gOther', channelId: 'cX', author: { bot: false } })

    expect(onMessageA).toHaveBeenCalledTimes(1)
    expect(onMessageB).not.toHaveBeenCalled()
    expect(a.getCachedDiscordMember('u1')?.guildId).toBe('gA')
    expect(b.getCachedDiscordMember('u1')).toBeUndefined()

    await a.stop()
    await b.stop()
    await shared.stop()
  })

  it('subscribes only to events the shared client routes', async () => {
    const { shared } = harness()
    const rt = runtimeFor(shared, 'A', 'gA', [])
    const names = ((rt as any).sharedSink.events as EventEmitter).eventNames().map(String)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) expect(Object.keys(ROUTED_EVENTS)).toContain(name)
  })

  it('registers slash commands in each linked guild only', async () => {
    const { shared, client, a, b } = await twoBridges()
    const routes = client.rest.put.mock.calls.map(([route]) => route)
    expect(routes.sort()).toEqual([
      Routes.applicationGuildCommands('app-1', 'gA'),
      Routes.applicationGuildCommands('app-1', 'gB'),
    ].sort())
    await a.stop()
    await b.stop()
    await shared.stop()
  })

  it('reports only the linked guild, and bot_not_in_guild when the bot is not in it', async () => {
    vi.spyOn(HarmonyClient.prototype, 'connect').mockResolvedValue(undefined)
    const { shared, clients } = harness()
    const linked = runtimeFor(shared, 'A', 'gA', [['cA', 'hA']])
    const missing = runtimeFor(shared, 'M', 'gMissing', [])
    await linked.start()
    await missing.start()
    shared.start()
    await vi.advanceTimersByTimeAsync(150)
    clients[0].addGuild('gA', ['cA'])
    clients[0].addGuild('gOther', ['cX'])
    clients[0].ready()
    await vi.advanceTimersByTimeAsync(0)

    expect(linked.guildViews()?.map(g => g.id)).toEqual(['gA'])
    expect(missing.guildViews()).toEqual([])
    const problems = detectProblems({
      connection: missing.connectionProblems(),
      guilds: missing.guildViews(),
      scopedToSelection: true,
      config: { discord_guild_id: 'gMissing', pairs: [], harmony_channels: null },
    })
    expect(problems).toEqual([{ code: 'bot_not_in_guild', params: { guild_id: 'gMissing' } }])

    await linked.stop()
    await missing.stop()
    await shared.stop()
  })

  it('does not post to a paired channel outside the linked guild', async () => {
    const { shared, client, a, b } = await twoBridges()
    const foreign = client.channels.cache.get('cB')
    const webhook = { name: 'Harmony Bridge', token: 'wt', send: vi.fn(async () => ({ id: 'dm1' })) }
    Object.assign(foreign, {
      client,
      guild: { id: 'gB', emojis: { cache: new Collection() } },
      isTextBased: () => true,
      fetchWebhooks: vi.fn(async () => new Collection([['w', webhook]])),
      send: vi.fn(async () => ({ id: 'dm2' })),
    })
    // Stale pair: hA → cB (guild gB) on bridge A.
    ;(a.dir as V2Directory).update({
      bridge_id: 'A', server_id: 's-A', mode: 'instance', discord_guild_id: 'gA',
      settings: {}, pairs: [{ discord_channel_id: 'cB', harmony_channel_id: 'hA', direction: 'both' }], harmony_channels: [],
    })
    a.harmony.emit('messageCreate', { id: 'm1', channel_id: 'hA', author: { id: 'u', username: 'u' }, content: 'hi', content_raw: [{ type: 'text', text: 'hi' }] })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(client.channels.fetch).toHaveBeenCalledWith('cB')
    expect(foreign.fetchWebhooks).not.toHaveBeenCalled()
    expect(webhook.send).not.toHaveBeenCalled()
    expect(foreign.send).not.toHaveBeenCalled()
    await a.stop()
    await b.stop()
    await shared.stop()
  })

  it('loads the member list when a setting change needs no reconnect', async () => {
    vi.spyOn(HarmonyClient.prototype, 'connect').mockResolvedValue(undefined)
    const { shared, clients } = harness()
    const a = runtimeFor(shared, 'A', 'gA', [['cA', 'hA']], { sync_member_list: true })
    const b = runtimeFor(shared, 'B', 'gB', [['cB', 'hB']], { sync_member_list: false })
    await a.start()
    await b.start()
    shared.start()
    await vi.advanceTimersByTimeAsync(150)
    const client = clients[0]
    client.addGuild('gA', ['cA'])
    const guildB = client.addGuild('gB', ['cB'])
    client.ready()
    await vi.advanceTimersByTimeAsync(0)
    expect(guildB.members.fetch).not.toHaveBeenCalled()

    ;(b.dir as V2Directory).update({
      bridge_id: 'B', server_id: 's-B', mode: 'instance', discord_guild_id: 'gB',
      settings: { sync_member_list: true }, pairs: [{ discord_channel_id: 'cB', harmony_channel_id: 'hB', direction: 'both' }], harmony_channels: [],
    })
    await b.onDirectoryChanged({ settingsChanged: true, pairsChanged: false, addedHarmonyChannels: [] })
    await vi.advanceTimersByTimeAsync(500)

    expect(clients).toHaveLength(1)
    expect(guildB.members.fetch).toHaveBeenCalledTimes(1)
    await a.stop()
    await b.stop()
    await shared.stop()
  })

  it('reports presence as unavailable while the instance switch is off', async () => {
    const { shared, a, b } = await twoBridges()
    expect(a.discordIdentity().intents).toEqual({ message_content: true, members: true, presence: false })
    shared.setPresence(true)
    expect(a.discordIdentity().intents.presence).toBe(true)
    await a.stop()
    await b.stop()
    await shared.stop()
  })

  it('stays attached when another bridge on the client stops', async () => {
    const { shared, clients, client, a, b } = await twoBridges()
    await b.stop()
    await vi.advanceTimersByTimeAsync(500)
    expect(clients).toHaveLength(1)
    expect(a.isDiscordConnected()).toBe(true)
    const onMessageA = vi.spyOn(a as any, 'onDiscordMessage').mockResolvedValue(undefined)
    client.emit(Events.MessageCreate, { guildId: 'gA', channelId: 'cA', author: { bot: false } })
    expect(onMessageA).toHaveBeenCalledTimes(1)
    await a.stop()
    await shared.stop()
  })
})
