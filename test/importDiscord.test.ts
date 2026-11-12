import { describe, expect, it, vi } from 'vitest'
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js'
import { discordImportAccess } from '../src/runtime/importDiscord.js'
import { FakeDiscordClient, discordError } from './fakeDiscord.js'

const SNOW = (n: number) => String(1_000_000_000_000_000_000n + BigInt(n))

function thread(id: string, parentId: string, archivedAt: number | null, over: Record<string, unknown> = {}) {
  return {
    id, parentId, name: `t${id}`, ownerId: 'u1', createdAt: new Date(1_700_000_000_000),
    archived: archivedAt !== null, locked: false,
    archivedAt: archivedAt === null ? null : new Date(archivedAt),
    archiveTimestamp: archivedAt,
    ...over,
  }
}

function setup(opts: { manageThreads?: boolean; active?: any[]; publicPages?: any[][]; privatePages?: any[][] } = {}) {
  const client = new FakeDiscordClient({ intents: [] } as any)
  const guild = client.addGuild('g1', ['c1'])
  const channel = guild.channels.cache.get('c1')
  channel.guild = guild
  channel.permissionsFor = () => ({ has: (f: bigint) => f === PermissionFlagsBits.ManageThreads ? opts.manageThreads === true : true })
  ;(guild.channels as any).fetchActiveThreads = vi.fn(async () => ({
    threads: new Collection((opts.active ?? []).map((t: any) => [t.id, t])),
  }))
  const calls: any[] = []
  const pages = { public: [...(opts.publicPages ?? [[]])], private: [...(opts.privatePages ?? [[]])] }
  channel.threads = {
    fetchArchived: vi.fn(async (o: any) => {
      calls.push(o)
      const page = pages[o.type as 'public' | 'private'].shift() ?? []
      return { threads: new Collection(page.map((t: any) => [t.id, t])), hasMore: pages[o.type as 'public' | 'private'].length > 0 }
    }),
  }
  const access = discordImportAccess(() => client as any)
  return { client, channel, guild, access, calls }
}

describe('discordImportAccess.fetchPage', () => {
  it('fetches 100 messages before the cursor, newest first', async () => {
    const { channel, access } = setup()
    const msgs = [3, 1, 2].map(i => ({ id: SNOW(i) }))
    channel.messages = { fetch: vi.fn(async () => new Collection(msgs.map(m => [m.id, m]))) }
    const page = await access.fetchPage('c1', SNOW(9))
    expect(channel.messages.fetch).toHaveBeenCalledWith({ limit: 100, before: SNOW(9) })
    expect(page.map((m: any) => m.id)).toEqual([SNOW(3), SNOW(2), SNOW(1)])
  })

  it('omits before for the first page and reaches threads not in the cache', async () => {
    const { client, access } = setup()
    const fetch = vi.fn(async () => new Collection())
    client.channels.fetch.mockResolvedValueOnce({ messages: { fetch } } as any)
    await access.fetchPage('thread-9', undefined)
    expect(fetch).toHaveBeenCalledWith({ limit: 100 })
  })

  it('reports an unknown channel as Discord 10003 so the job fails readably', async () => {
    const { access } = setup()
    await expect(access.fetchPage('nope', undefined)).rejects.toMatchObject({ code: 10003 })
  })
})

describe('discordImportAccess.fetchPins', () => {
  it('answers no pins for a channel type that rejects the endpoint, but rethrows other errors', async () => {
    const { channel, access } = setup()
    channel.messages = { fetchPins: vi.fn().mockRejectedValueOnce(discordError(50024, 'Cannot execute action on this channel type')) }
    expect(await access.fetchPins('c1')).toEqual(new Set())
    channel.messages = { fetchPins: vi.fn().mockRejectedValueOnce(discordError(50013, 'Missing Permissions')) }
    await expect(access.fetchPins('c1')).rejects.toMatchObject({ code: 50013 })
  })

  it('collects pinned ids across pages', async () => {
    const { channel, access } = setup()
    channel.messages = {
      fetchPins: vi.fn()
        .mockResolvedValueOnce({ items: [{ message: { id: 'a' }, pinnedTimestamp: 20 }, { message: { id: 'b' }, pinnedTimestamp: 10 }], hasMore: true })
        .mockResolvedValueOnce({ items: [{ message: { id: 'c' }, pinnedTimestamp: 5 }], hasMore: false }),
    }
    expect(await access.fetchPins('c1')).toEqual(new Set(['a', 'b', 'c']))
    expect(channel.messages.fetchPins.mock.calls[1][0].before).toEqual(new Date(10))
  })
})

describe('discordImportAccess threads', () => {
  it.each([['voice', ChannelType.GuildVoice], ['stage', ChannelType.GuildStageVoice]])(
    'ends the listing after the active list in a %s channel, which has no thread manager',
    async (_name, type) => {
      const { channel, access } = setup({ active: [thread('11', 'c1', null), thread('99', 'other', null)] })
      channel.type = type
      delete channel.threads
      const first = await access.listThreads('c1', null)
      expect(first.threads.map(t => t.id)).toEqual(['11'])
      expect(first.next).toBeNull()
    },
  )

  it('ends a resumed archived listing in a voice channel without calling Discord', async () => {
    const { channel, access } = setup({})
    channel.type = ChannelType.GuildVoice
    delete channel.threads
    const page = await access.listThreads('c1', { list: 'public', before: '2024-01-01T00:00:00.000Z' })
    expect(page).toEqual({ threads: [], next: null })
  })

  it('lists active threads of the channel only, newest first, then moves to archived public', async () => {
    const { access } = setup({
      active: [thread('11', 'c1', null), thread('13', 'c1', null), thread('99', 'other', null), thread('12', 'c1', null)],
    })
    const first = await access.listThreads('c1', null)
    expect(first.threads.map(t => t.id)).toEqual(['13', '12', '11'])
    expect(first.next).toEqual({ list: 'public', before: null })
  })

  it('pages archived public threads newest-archived first with a before cursor', async () => {
    const { access, calls } = setup({
      publicPages: [[thread('1', 'c1', 5000), thread('2', 'c1', 9000), thread('3', 'c1', 7000)], [thread('4', 'c1', 1000)]],
    })
    const p1 = await access.listThreads('c1', { list: 'public', before: null })
    expect(p1.threads.map(t => t.id)).toEqual(['2', '3', '1'])
    expect(p1.next).toEqual({ list: 'public', before: new Date(5000).toISOString() })
    expect(calls[0]).toMatchObject({ type: 'public', limit: 100 })
    expect(calls[0].before).toBeUndefined()

    const p2 = await access.listThreads('c1', p1.next)
    expect(calls[1].before).toBe(new Date(5000).toISOString())
    expect(p2.threads.map(t => t.id)).toEqual(['4'])
    // Last public page without Manage Threads: nothing further.
    expect(p2.next).toBeNull()
  })

  it('drops private threads from the active list and counts them', async () => {
    const { access } = setup({
      active: [thread('11', 'c1', null), thread('12', 'c1', null, { type: ChannelType.PrivateThread }), thread('99', 'other', null, { type: ChannelType.PrivateThread })],
    })
    const first = await access.listThreads('c1', null)
    expect(first.threads.map(t => t.id)).toEqual(['11'])
    expect(first.skippedPrivate).toBe(1)
  })

  it('ends after the public list even with Manage Threads, and never asks for private ones', async () => {
    const t = setup({ manageThreads: true, publicPages: [[thread('1', 'c1', 5000)]], privatePages: [[thread('7', 'c1', 4000)]] })
    const pub = await t.access.listThreads('c1', { list: 'public', before: null })
    expect(pub.threads.map(x => x.id)).toEqual(['1'])
    expect(pub.next).toBeNull()
    expect(t.calls.filter(c => c.type === 'private')).toHaveLength(0)
  })

  it('a private thread in the archived list is filtered and counted', async () => {
    const t = setup({ publicPages: [[thread('1', 'c1', 5000), thread('2', 'c1', 4000, { type: ChannelType.PrivateThread })]] })
    const pub = await t.access.listThreads('c1', { list: 'public', before: null })
    expect(pub.threads.map(x => x.id)).toEqual(['1'])
    expect(pub.skippedPrivate).toBe(1)
  })

  it('a cursor saved by older code in the private list lists nothing', async () => {
    const t = setup({ manageThreads: true, privatePages: [[thread('7', 'c1', 4000)]] })
    expect(await t.access.listThreads('c1', { list: 'private', before: null })).toEqual({ threads: [], next: null })
    expect(t.calls).toHaveLength(0)
  })

  it('hasStarterMessage: true when the message with the thread id exists, false on 10008', async () => {
    const { channel, access } = setup()
    channel.messages = { fetch: vi.fn(async () => ({ id: '5' })) }
    expect(await access.hasStarterMessage('c1', '5')).toBe(true)
    channel.messages = { fetch: vi.fn(async () => { throw discordError(10008) }) }
    expect(await access.hasStarterMessage('c1', '5')).toBe(false)
    channel.messages = { fetch: vi.fn(async () => { throw discordError(50001) }) }
    await expect(access.hasStarterMessage('c1', '5')).rejects.toMatchObject({ code: 50001 })
  })
})
