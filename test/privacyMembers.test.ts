import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Events } from 'discord.js'
import { BridgeRuntime, type RuntimeHooks } from '../src/runtime/BridgeRuntime.js'
import { handleInteraction } from '../src/runtime/commands.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'
import { OptOutList } from '../src/runtime/optOuts.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { APPLICATION_FLAGS } from '../src/runtime/discordConnection.js'
import { silentLogger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'
import { FakeDiscordClient, appResponse, fakeMember, fakePresence } from './fakeDiscord.js'

const ALL = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS | APPLICATION_FLAGS.GATEWAY_PRESENCE
const writer: PairWriter = { link: async () => {}, linkMany: async () => [], unlink: async () => false }

describe('OptOutList change notice', () => {
  it('fires when the set of users changes, and only then', () => {
    const onChange = vi.fn()
    const list = new OptOutList(onChange)
    list.add('1')
    list.add('1')
    expect(onChange).toHaveBeenCalledTimes(1)
    list.replace('v2', ['1'])
    expect(onChange).toHaveBeenCalledTimes(1)
    list.replace('v3', ['1', '2'])
    expect(onChange).toHaveBeenCalledTimes(2)
    list.replace('v4', ['2', '3'])
    expect(onChange).toHaveBeenCalledTimes(3)
    list.remove('9')
    expect(onChange).toHaveBeenCalledTimes(3)
    list.remove('2')
    expect(onChange).toHaveBeenCalledTimes(4)
    expect(list.version()).toBe('v4')
  })
})

describe('opted-out members and the Harmony member list', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-privacy-members-'))
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  /** A runtime with members u1 and u2 registered, two paired channels, and the op 6 and op 7 spies cleared. */
  async function setup(opts: { optedOutFirst?: string[]; hooks?: RuntimeHooks; settings?: Record<string, unknown> } = {}) {
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
        bridge_id: 'b', server_id: 's', mode: 'self', discord_guild_id: 'g1',
        settings: opts.settings ?? { sync_member_list: true, sync_presence: true },
        pairs: [
          { discord_channel_id: 'd1', harmony_channel_id: 'h1', direction: 'both' },
          { discord_channel_id: 'd2', harmony_channel_id: 'h2', direction: 'both' },
        ],
        harmony_channels: [],
      }),
      writer,
      discordToken: 'dtok',
      harmony: { token: 'htok', gatewayUrl: 'ws://127.0.0.1:9/gateway', apiUrl: 'http://127.0.0.1:9', baseUrl: 'https://h.example' },
      permissionStorePath: join(dir, 'permission-sync.yml'),
      log: silentLogger,
      fetchImpl,
      hooks: opts.hooks,
      createDiscordClient: (options) => {
        const c = new FakeDiscordClient(options)
        c.addGuild('g1', ['d1', 'd2'])
        clients.push(c)
        return c as any
      },
    })
    for (const id of opts.optedOutFirst ?? []) runtime.optOuts.add(id)
    const op6 = vi.spyOn(runtime.harmony, 'registerBridgeData').mockReturnValue(true)
    const op7 = vi.spyOn(runtime.harmony, 'sendPresenceUpdates').mockReturnValue(true)

    await runtime.connectDiscord()
    clients[0].ready()
    runtime.harmony.emit('ready', { bot: { id: 'hb', username: 'bridge' } })
    await vi.advanceTimersByTimeAsync(0)

    const client = clients[0]
    client.emit(Events.GuildMemberAdd, fakeMember('g1', 'u1'))
    client.emit(Events.GuildMemberAdd, fakeMember('g1', 'u2'))
    // op 6 waits out its 5 s interval after the READY registration.
    await vi.advanceTimersByTimeAsync(5_000)
    /** Member ids of each channel entry of the latest op 6. */
    const listed = () => (op6.mock.calls.at(-1)![0] as Array<{ members?: Array<{ id: string }> }>).map(ch => (ch.members ?? []).map(m => m.id).sort())
    /** Every member id any op 6 so far carried. */
    const everListed = () => new Set(op6.mock.calls.flatMap(c => (c[0] as Array<{ members?: Array<{ id: string }> }>).flatMap(ch => (ch.members ?? []).map(m => m.id))))
    return { runtime, rt: runtime as any, client, op6, op7, listed, everListed }
  }

  it('registers every member but the opted-out ones, in every channel entry', async () => {
    const t = await setup({ optedOutFirst: ['u1'] })
    expect(t.listed()).toEqual([['u2'], ['u2']])
    expect(t.everListed().has('u1')).toBe(false)
    await t.runtime.stop()
  })

  it('registers again without a member once they opt out, and with them once they opt in', async () => {
    const t = await setup()
    expect(t.listed()).toEqual([['u1', 'u2'], ['u1', 'u2']])
    t.op6.mockClear()

    t.runtime.optOuts.add('u1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op6).toHaveBeenCalledTimes(1)
    expect(t.listed()).toEqual([['u2'], ['u2']])

    t.runtime.optOuts.remove('u1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op6).toHaveBeenCalledTimes(2)
    expect(t.listed()).toEqual([['u1', 'u2'], ['u1', 'u2']])
    await t.runtime.stop()
  })

  it('registers again when a read of the list from Harmony changes who is in it, and not when it does not', async () => {
    const t = await setup()
    t.op6.mockClear()
    t.runtime.optOuts.replace('v2', ['u2', 'someone-not-here'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op6).toHaveBeenCalledTimes(1)
    expect(t.listed()).toEqual([['u1'], ['u1']])

    t.runtime.optOuts.replace('v3', ['someone-not-here', 'u2'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op6).toHaveBeenCalledTimes(1)
    await t.runtime.stop()
  })

  it('registers again without the author when Harmony refuses their message as opted out', async () => {
    const t = await setup()
    t.op6.mockClear()
    expect(t.rt.noteOptedOut(new HarmonyHttpError('opted out', 403, 'BRIDGE_AUTHOR_OPTED_OUT'), 'u2')).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op6).toHaveBeenCalledTimes(1)
    expect(t.listed()).toEqual([['u1'], ['u1']])
    await t.runtime.stop()
  })

  it('keeps an opted-out member out when they join, change their profile, or others do', async () => {
    const t = await setup({ optedOutFirst: ['u3'] })
    t.op6.mockClear()
    t.client.emit(Events.GuildMemberAdd, fakeMember('g1', 'u3'))
    await vi.advanceTimersByTimeAsync(5_000)
    const renamed = fakeMember('g1', 'u3', 'new-name')
    t.client.emit(Events.GuildMemberUpdate, fakeMember('g1', 'u3'), renamed)
    await vi.advanceTimersByTimeAsync(5_000)
    t.client.emit(Events.GuildMemberAdd, fakeMember('g1', 'u4'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op6.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(t.listed()).toEqual([['u1', 'u2', 'u4'], ['u1', 'u2', 'u4']])
    expect(t.everListed().has('u3')).toBe(false)
    await t.runtime.stop()
  })

  it('sends no presence of an opted-out member, and still sends everyone else', async () => {
    const t = await setup({ optedOutFirst: ['u1'] })
    t.client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u1', 'online'))
    t.client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u2', 'idle'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op7.mock.calls.flatMap(c => c[0].map((u: { id: string }) => u.id))).toEqual(['u2'])
    await t.runtime.stop()
  })

  it('drops a presence change already queued when its member opts out, before the list is registered again', async () => {
    const t = await setup()
    // The last op 6 went out at the end of setup, s. s + 2 s: one op 7 goes out, so the next
    // presence change waits until s + 7 s.
    await vi.advanceTimersByTimeAsync(2_000)
    t.client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u2', 'idle'))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.op7).toHaveBeenCalledTimes(1)
    t.op7.mockClear()
    // s + 5 s: a join registers the list at once, so the registration after the opt-out waits until s + 10 s.
    await vi.advanceTimersByTimeAsync(3_000)
    t.client.emit(Events.GuildMemberAdd, fakeMember('g1', 'u9'))
    await vi.advanceTimersByTimeAsync(0)
    expect(t.op6).toHaveBeenCalled()
    t.op6.mockClear()

    t.client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u1', 'online'))
    t.client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u2', 'dnd'))
    t.runtime.optOuts.add('u1')

    // s + 7 s: the queued changes are sent; the list has not been registered again yet.
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.op6).not.toHaveBeenCalled()
    expect(t.op7.mock.calls.flatMap(c => c[0].map((u: { id: string }) => u.id))).toEqual(['u2'])

    await vi.advanceTimersByTimeAsync(3_000)
    expect(t.op6).toHaveBeenCalledTimes(1)
    expect(t.listed()).toEqual([['u2', 'u9'], ['u2', 'u9']])
    await t.runtime.stop()
  })

  it('carries the current presence of a member who opts back in', async () => {
    const t = await setup({ optedOutFirst: ['u1'] })
    t.client.emit(Events.PresenceUpdate, null, fakePresence('g1', 'u1', 'online'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op7).not.toHaveBeenCalled()
    t.runtime.optOuts.remove('u1')
    await vi.advanceTimersByTimeAsync(5_000)
    const members = (t.op6.mock.calls.at(-1)![0] as any[])[0].members as Array<{ id: string; presenceStatus: string }>
    expect(members.find(m => m.id === 'u1')).toMatchObject({ presenceStatus: 'online' })
    await t.runtime.stop()
  })

  it('registers nothing more for an opt-out while the member list is not synced', async () => {
    const t = await setup({ settings: { sync_member_list: false } })
    t.op6.mockClear()
    t.runtime.optOuts.add('u1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op6).not.toHaveBeenCalled()
    await t.runtime.stop()
  })

  it.each([
    ['opt-out', { opted_out: true, since: null, source: 'self' as const }, [['u2'], ['u2']]],
    ['erase', { opted_out: true, since: null, source: 'self' as const }, [['u2'], ['u2']]],
  ])('/bridge-privacy %s takes the caller off the registered list', async (sub, standing, expected) => {
    const privacyApi = {
      getOptOut: vi.fn(async () => standing),
      putOptOut: vi.fn(async () => standing),
      deleteOptOut: vi.fn(async () => ({ opted_out: false, since: null, source: null })),
      erase: vi.fn(async () => ({ erased: 3, more: false })),
    }
    const t = await setup({ hooks: { privacyApi } })
    t.op6.mockClear()
    await handleInteraction(t.runtime, privacyInteraction(sub, 'u1'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op6).toHaveBeenCalledTimes(1)
    expect(t.listed()).toEqual(expected)
    await t.runtime.stop()
  })

  it('/bridge-privacy opt-in puts the caller back on the registered list', async () => {
    const privacyApi = {
      getOptOut: vi.fn(async () => ({ opted_out: false, since: null, source: null })),
      putOptOut: vi.fn(async () => ({ opted_out: true, since: null, source: 'self' as const })),
      deleteOptOut: vi.fn(async () => ({ opted_out: false, since: null, source: null })),
      erase: vi.fn(async () => ({ erased: 0, more: false })),
    }
    const t = await setup({ optedOutFirst: ['u1'], hooks: { privacyApi } })
    expect(t.listed()).toEqual([['u2'], ['u2']])
    t.op6.mockClear()
    await handleInteraction(t.runtime, privacyInteraction('opt-in', 'u1'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.op6).toHaveBeenCalledTimes(1)
    expect(t.listed()).toEqual([['u1', 'u2'], ['u1', 'u2']])
    await t.runtime.stop()
  })
})

function privacyInteraction(sub: string, userId: string): any {
  const message = {
    awaitMessageComponent: vi.fn(async () => ({ customId: 'confirm:i1', user: { id: userId }, update: vi.fn(async () => {}) })),
  }
  return {
    id: 'i1',
    user: { id: userId, username: `user-${userId}` },
    member: { permissions: { has: () => false } },
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    commandName: 'bridge-privacy',
    guild: { id: 'g1' },
    guildId: 'g1',
    options: { getSubcommand: () => sub },
    reply: vi.fn(async () => {}),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => message),
    followUp: vi.fn(async () => {}),
  }
}
