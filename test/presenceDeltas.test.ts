import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ActivityType, Events } from 'discord.js'
import {
  PresenceDeltaQueue,
  mapDiscordPresence,
  type PresenceDelta,
} from '../src/runtime/presenceDeltas.js'
import { BridgeRuntime } from '../src/runtime/BridgeRuntime.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { APPLICATION_FLAGS } from '../src/runtime/discordConnection.js'
import { silentLogger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'
import { FakeDiscordClient, appResponse, fakeMember, fakePresence } from './fakeDiscord.js'

const delta = (id: string, presenceStatus: PresenceDelta['presenceStatus'], customStatus: PresenceDelta['customStatus'] = null): PresenceDelta =>
  ({ id, presenceStatus, customStatus })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('mapDiscordPresence', () => {
  it('maps Discord statuses to Harmony statuses', () => {
    expect(mapDiscordPresence({ status: 'online' }).presenceStatus).toBe('online')
    expect(mapDiscordPresence({ status: 'idle' }).presenceStatus).toBe('away')
    expect(mapDiscordPresence({ status: 'dnd' }).presenceStatus).toBe('busy')
    expect(mapDiscordPresence({ status: 'invisible' }).presenceStatus).toBe('offline')
    expect(mapDiscordPresence(null)).toEqual({ presenceStatus: 'offline', customStatus: null })
  })

  it('keeps the custom status and ignores other activities', () => {
    expect(mapDiscordPresence({
      status: 'online',
      activities: [
        { type: ActivityType.Playing, state: 'Ranked' },
        { type: ActivityType.Custom, state: ' brb ', emoji: { name: '☕' } },
      ],
    })).toEqual({ presenceStatus: 'online', customStatus: { text: 'brb', emoji: '☕' } })
    expect(mapDiscordPresence({ status: 'online', activities: [{ type: ActivityType.Listening, state: 'Song' }] }))
      .toEqual({ presenceStatus: 'online', customStatus: null })
  })
})

describe('PresenceDeltaQueue', () => {
  function queue() {
    const sent: PresenceDelta[][] = []
    const q = new PresenceDeltaQueue(updates => { sent.push(updates); return true }, 5_000)
    return { q, sent }
  }

  it('sends only members Harmony received in op 6', async () => {
    const { q, sent } = queue()
    q.baseline([delta('a', 'offline')])
    q.push(delta('a', 'online'))
    q.push(delta('stranger', 'online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([[delta('a', 'online')]])
  })

  it('coalesces to the latest state per member and flushes at most every 5 s', async () => {
    const { q, sent } = queue()
    q.baseline([delta('a', 'offline'), delta('b', 'offline')])

    q.push(delta('a', 'online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(1)

    q.push(delta('a', 'away'))
    q.push(delta('b', 'online'))
    q.push(delta('a', 'busy'))
    await vi.advanceTimersByTimeAsync(4_900)
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual([delta('a', 'busy'), delta('b', 'online')])
  })

  it('drops a change that returns to the state Harmony holds within the window', async () => {
    const { q, sent } = queue()
    q.baseline([delta('a', 'online')])
    q.push(delta('a', 'away'))
    q.push(delta('a', 'online'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sent).toEqual([])
  })

  it('treats a new op 6 as the baseline and discards pending deltas', async () => {
    const { q, sent } = queue()
    q.baseline([delta('a', 'offline')])
    q.push(delta('a', 'online'))
    q.baseline([delta('a', 'online')])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sent).toEqual([])
  })

  it('resends after a failed send once the state changes again', async () => {
    let open = false
    const sent: PresenceDelta[][] = []
    const q = new PresenceDeltaQueue(updates => { if (open) sent.push(updates); return open }, 5_000)
    q.baseline([delta('a', 'offline')])
    q.push(delta('a', 'online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([])
    open = true
    q.push(delta('a', 'online'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sent).toEqual([[delta('a', 'online')]])
  })
})

// ---------------------------------------------------------------------------
// BridgeRuntime: PresenceUpdate → op 7, never op 6
// ---------------------------------------------------------------------------

const writer: PairWriter = { link: async () => {}, linkMany: async () => [], unlink: async () => false }
const ALL = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS | APPLICATION_FLAGS.GATEWAY_PRESENCE

describe('BridgeRuntime presence sync', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bridge-presence-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function setup(settings: Record<string, unknown> = { sync_member_list: true, sync_presence: true }) {
    const clients: FakeDiscordClient[] = []
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/applications/@me')) return appResponse(ALL)()
      if (u.includes('/members')) return Response.json([])
      return new Response('not found', { status: 404 })
    })
    const runtime = new BridgeRuntime({
      mode: 'v2',
      directory: new V2Directory({
        bridge_id: 'b', server_id: 's', mode: 'self', discord_guild_id: 'g1', settings,
        pairs: [{ discord_channel_id: 'd1', harmony_channel_id: 'h1', direction: 'both' }],
        harmony_channels: [],
      }),
      writer,
      discordToken: 'dtok',
      harmony: { token: 'htok', gatewayUrl: 'ws://127.0.0.1:9/gateway', apiUrl: 'http://127.0.0.1:9', baseUrl: 'https://h.example' },
      permissionStorePath: join(dir, 'permission-sync.yml'),
      log: silentLogger,
      fetchImpl,
      createDiscordClient: (options) => {
        const c = new FakeDiscordClient(options)
        c.addGuild('g1', ['d1'])
        clients.push(c)
        return c as any
      },
    })
    const op6 = vi.spyOn(runtime.harmony, 'registerBridgeData').mockReturnValue(true)
    const op7 = vi.spyOn(runtime.harmony, 'sendPresenceUpdates').mockReturnValue(true)

    await runtime.connectDiscord()
    clients[0].ready()
    runtime.harmony.emit('ready', { bot: { id: 'hb', username: 'bridge' } })
    await vi.advanceTimersByTimeAsync(0)

    const client = clients[0]
    client.emit(Events.GuildMemberAdd, fakeMember('g1', 'u1'))
    await vi.advanceTimersByTimeAsync(0)
    op6.mockClear()
    return { runtime, client, op6, op7 }
  }

  it('sends a status change once as op 7 and never re-sends op 6', async () => {
    const { runtime, client, op6, op7 } = await setup()

    client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u1', 'online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(op7).toHaveBeenCalledTimes(1)
    expect(op7.mock.calls[0][0]).toEqual([{ id: 'u1', presenceStatus: 'online', customStatus: null }])
    expect(runtime.getCachedDiscordMember('u1')?.presenceStatus).toBe('online')

    // Activity-only: same mapped status, no custom status change.
    client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u1', 'online', [{ type: ActivityType.Playing, name: 'Game' }]))
    client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u1', 'online', [{ type: ActivityType.Listening, name: 'Spotify' }]))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(op7).toHaveBeenCalledTimes(1)

    // Unsynced member and another guild: dropped.
    client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'stranger', 'dnd'))
    client.emit(Events.PresenceUpdate, null, fakePresence('g2', 'u1', 'dnd'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(op7).toHaveBeenCalledTimes(1)

    // Custom status change, then a burst: one more op 7 with the latest state.
    client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u1', 'online', [{ type: ActivityType.Custom, state: 'lunch', emoji: null }]))
    await vi.advanceTimersByTimeAsync(0)
    expect(op7).toHaveBeenCalledTimes(2)
    expect(op7.mock.calls[1][0]).toEqual([{ id: 'u1', presenceStatus: 'online', customStatus: { text: 'lunch', emoji: null } }])

    client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u1', 'idle'))
    client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u1', 'dnd'))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(op7).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(op7).toHaveBeenCalledTimes(3)
    expect(op7.mock.calls[2][0]).toEqual([{ id: 'u1', presenceStatus: 'busy', customStatus: null }])

    expect(op6).not.toHaveBeenCalled()
    await runtime.stop()
  })

  it('still sends presence fields with op 6 on membership changes', async () => {
    const { runtime, client, op6 } = await setup()
    client.emit(Events.GuildMemberAdd, { ...fakeMember('g1', 'u2'), presence: { status: 'idle', activities: [] } })
    expect(op6).toHaveBeenCalledTimes(1)
    const [channels] = op6.mock.calls[0]
    expect(channels[0].members?.find(m => m.id === 'u2')).toMatchObject({ presenceStatus: 'away', customStatus: null })
    await runtime.stop()
  })

  it('sends nothing while presence sync is off', async () => {
    const { runtime, client, op6, op7 } = await setup({ sync_member_list: true, sync_presence: false })
    client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u1', 'online'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(op7).not.toHaveBeenCalled()
    expect(op6).not.toHaveBeenCalled()
    await runtime.stop()
  })
})
