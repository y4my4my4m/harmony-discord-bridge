import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Collection, MessageType } from 'discord.js'
import { BridgeRuntime } from '../src/runtime/BridgeRuntime.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { APPLICATION_FLAGS } from '../src/runtime/discordConnection.js'
import { Logger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'
import type { HarmonyThread } from '../src/HarmonyClient.js'
import { FakeDiscordClient, appResponse, fakeTextChannel, fakeThread, fakeWebhook } from './fakeDiscord.js'

// Threads across the bridge (bridge 2.4 with the Harmony 1.7.5 gateway thread routes; thread
// starters from bridge 2.4.1 with Harmony 1.7.6).

const ALL = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS | APPLICATION_FLAGS.GATEWAY_PRESENCE
const writer: PairWriter = { link: async () => {}, linkMany: async () => [], unlink: async () => false }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-threads-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const thread = (over: Partial<HarmonyThread> = {}): HarmonyThread => ({
  id: 'ht-1', channel_id: 'h1', parent_message_id: 'hm-start', name: 'Plans',
  archived: false, locked: false, discord_thread_id: null, ...over,
})

async function setup() {
  const clients: FakeDiscordClient[] = []
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.endsWith('/applications/@me')) return appResponse(ALL)()
    if (u.includes('/members')) return Response.json([])
    return new Response('not found', { status: 404 })
  })
  const log = new Logger('debug', '', true)
  const webhook = fakeWebhook()
  const runtime = new BridgeRuntime({
    mode: 'v2',
    directory: new V2Directory({
      bridge_id: 'b', server_id: 's', mode: 'self', discord_guild_id: 'g1',
      settings: { sync_member_list: true },
      pairs: [{ discord_channel_id: '1001', harmony_channel_id: 'h1', harmony_channel_name: 'general', direction: 'both' }],
      harmony_channels: [],
    }),
    writer,
    discordToken: 'dtok',
    harmony: { token: 'htok', gatewayUrl: 'ws://127.0.0.1:9/gateway', apiUrl: 'http://127.0.0.1:9', baseUrl: 'https://h.example' },
    permissionStorePath: join(dir, 'permission-sync.yml'),
    log,
    fetchImpl,
    media: { maxUploadBytes: 8 * 1024 * 1024, mediaOrigin: null },
    appEmojiDir: null,
    createDiscordClient: (options) => {
      const c = new FakeDiscordClient(options)
      c.addGuild('g1', [])
      clients.push(c)
      return c as any
    },
  })
  const h = runtime.harmony
  const spies = {
    sendMessage: vi.spyOn(h, 'sendMessage').mockImplementation(async () => ({ id: `hm-${Math.random().toString(36).slice(2, 8)}` })),
    merge: vi.spyOn(h, 'mergeMessageMetadata').mockResolvedValue(undefined),
    getMessage: vi.spyOn(h, 'getMessage').mockResolvedValue(null),
    lookupMessage: vi.spyOn(h, 'lookupMessageByDiscordId').mockResolvedValue(null),
    loadRecent: vi.spyOn(h, 'loadRecentMessages').mockResolvedValue([]),
    getEmojis: vi.spyOn(h, 'getEmojis').mockResolvedValue([]),
    createThread: vi.spyOn(h, 'createThread').mockImplementation(async (channelId, name, opts) =>
      thread({ id: 'ht-new', channel_id: channelId, name, discord_thread_id: opts?.discordThreadId ?? null })),
    lookupThread: vi.spyOn(h, 'lookupThreadByDiscordId').mockResolvedValue(null),
    getThread: vi.spyOn(h, 'getThread').mockResolvedValue(thread()),
    pairThread: vi.spyOn(h, 'pairThread').mockImplementation(async (_id, discordId) => discordId),
    op6: vi.spyOn(h, 'registerBridgeData').mockReturnValue(true),
  }
  await runtime.connectDiscord()
  const client = clients[0]
  const channel = fakeTextChannel(client, 'g1', '1001', { webhook })
  client.ready()
  h.emit('ready', { bot: { id: 'hb', username: 'bridge' } })
  await vi.advanceTimersByTimeAsync(0)
  return { runtime, client, channel, webhook, h: spies, rt: runtime as any }
}

function discordMessage(over: Record<string, any> = {}) {
  return {
    id: 'dm-1',
    channelId: '1001',
    guildId: 'g1',
    partial: false,
    type: MessageType.Default,
    author: { id: 'du-1', bot: false, username: 'dana', discriminator: '0', globalName: null, displayAvatarURL: () => 'https://cdn.example/d.png' },
    member: { displayName: 'Dana', displayAvatarURL: () => 'https://cdn.example/m.png' },
    content: 'hi',
    attachments: new Collection(),
    stickers: new Collection(),
    embeds: [],
    mentions: { users: new Collection(), roles: new Collection(), channels: new Collection(), repliedUser: null },
    reference: null,
    messageSnapshots: new Collection(),
    flags: { has: () => false },
    guild: null,
    ...over,
  }
}

function harmonyMessage(over: Record<string, any> = {}) {
  return {
    id: 'hm-1',
    channel_id: 'h1',
    thread_id: null,
    author: { id: 'hu-1', username: 'alice', display_name: 'Alice', nickname: null, avatar: null },
    content: 'hello',
    content_raw: [{ type: 'text', text: 'hello' }],
    metadata: {},
    ...over,
  }
}

describe('Discord → Harmony threads', () => {
  it('a reply in a Discord thread started from a bridged message lands in a Harmony thread on that message', async () => {
    const { rt, runtime, client, channel, h } = await setup()
    rt.discordToHarmonyMessages.set('dm-start', 'hm-start')
    const dThread = fakeThread(client, channel, 'dm-start', { name: 'Plans' })

    await rt.onDiscordMessage(discordMessage({ id: 'dm-in-1', channelId: 'dm-start', channel: dThread, content: 'first reply' }))
    await rt.onDiscordMessage(discordMessage({ id: 'dm-in-2', channelId: 'dm-start', channel: dThread, content: 'second reply' }))

    expect(h.lookupThread).toHaveBeenCalledWith('h1', 'dm-start')
    expect(h.createThread).toHaveBeenCalledTimes(1)
    expect(h.createThread).toHaveBeenCalledWith('h1', 'Plans', { messageId: 'hm-start', discordThreadId: 'dm-start' })
    expect(h.sendMessage.mock.calls.map(c => [c[0], c[4]])).toEqual([['h1', 'ht-new'], ['h1', 'ht-new']])
    await runtime.stop()
  })

  it('a Discord thread with no bridged starter becomes a standalone Harmony thread; a paired one is reused', async () => {
    const { rt, runtime, client, channel, h } = await setup()
    const standalone = fakeThread(client, channel, 'dt-9', { name: 'Old thread' })
    await rt.onDiscordMessage(discordMessage({ id: 'dm-a', channelId: 'dt-9', channel: standalone }))
    expect(h.createThread).toHaveBeenCalledWith('h1', 'Old thread', { messageId: null, discordThreadId: 'dt-9' })

    h.lookupThread.mockResolvedValue(thread({ id: 'ht-known', discord_thread_id: 'dt-10' }))
    const known = fakeThread(client, channel, 'dt-10')
    await rt.onDiscordMessage(discordMessage({ id: 'dm-b', channelId: 'dt-10', channel: known, content: 'in the known thread' }))
    expect(h.createThread).toHaveBeenCalledTimes(1)
    expect(h.sendMessage.mock.calls.at(-1)![4]).toBe('ht-known')
    await runtime.stop()
  })

  it('does not relay Discord thread notices as messages, and pairs a new thread at once', async () => {
    const { rt, runtime, client, channel, h } = await setup()
    await rt.onDiscordMessage(discordMessage({ id: 'dm-notice', type: MessageType.ThreadCreated, content: 'Plans' }))
    expect(h.sendMessage).not.toHaveBeenCalled()

    await rt.onDiscordThreadCreate(fakeThread(client, channel, 'dt-new', { name: 'Fresh' }))
    expect(h.createThread).toHaveBeenCalledWith('h1', 'Fresh', { messageId: null, discordThreadId: 'dt-new' })

    // The bridge's own threads mirror Harmony threads and are paired as they are created.
    await rt.onDiscordThreadCreate(fakeThread(client, channel, 'dt-own', { ownerId: 'bot-user' }))
    expect(h.createThread).toHaveBeenCalledTimes(1)
    await runtime.stop()
  })

  it('names the Harmony notice after the member who started the Discord thread', async () => {
    const { rt, runtime, client, channel, h } = await setup()
    const dana = {
      id: 'du-7', displayName: 'Dana', displayAvatarURL: () => 'https://cdn.example/m.png', joinedAt: null,
      user: { id: 'du-7', username: 'dana', discriminator: '0', globalName: null, displayAvatarURL: () => 'https://cdn.example/d.png' },
    }
    channel.guild.members = { fetch: vi.fn(async (id: string) => { if (id === 'du-7') return dana; throw new Error('Unknown Member') }) }

    await rt.onDiscordThreadCreate(fakeThread(client, channel, 'dt-owned', { name: 'Owned', ownerId: 'du-7' }))
    expect(h.createThread).toHaveBeenLastCalledWith('h1', 'Owned', {
      messageId: null,
      discordThreadId: 'dt-owned',
      discordUser: { id: 'du-7', username: 'dana', discriminator: '0', display_name: 'Dana', avatar_url: 'https://cdn.example/m.png' },
    })

    // An owner Discord no longer knows leaves the notice under the bridge.
    await rt.onDiscordThreadCreate(fakeThread(client, channel, 'dt-gone', { name: 'Gone', ownerId: 'du-8' }))
    expect(h.createThread).toHaveBeenLastCalledWith('h1', 'Gone', { messageId: null, discordThreadId: 'dt-gone' })
    await runtime.stop()
  })

  it('routes edits and reactions in a Discord thread through the parent pair', async () => {
    const { rt, runtime, client, channel } = await setup()
    const dThread = fakeThread(client, channel, 'dt-1')
    expect(rt.discordPairId('dt-1', dThread)).toBe('1001')
    expect(rt.discordPairId('dt-1')).toBe('1001')
    expect(rt.discordPairId('1001')).toBe('1001')
    await runtime.stop()
  })
})

describe('Harmony → Discord threads', () => {
  it('a reply in a Harmony thread on a bridged message starts the Discord thread there and posts into it', async () => {
    const { rt, runtime, channel, webhook, h } = await setup()
    rt.harmonyToDiscordMessages.set('hm-start', 'dm-start')

    await rt.onHarmonyMessageCreate(harmonyMessage({ id: 'hm-r1', thread_id: 'ht-1', content: 'in thread', content_raw: [{ type: 'text', text: 'in thread' }] }))
    await rt.onHarmonyMessageCreate(harmonyMessage({ id: 'hm-r2', thread_id: 'ht-1', content: 'again', content_raw: [{ type: 'text', text: 'again' }] }))

    const starter = await channel.messages.fetch.mock.results[0].value
    expect(starter.startThread).toHaveBeenCalledWith({ name: 'Plans' })
    expect(h.pairThread).toHaveBeenCalledTimes(1)
    expect(h.pairThread).toHaveBeenCalledWith('ht-1', 'dm-start')
    expect(webhook.send.mock.calls.map(c => c[0].threadId)).toEqual(['dm-start', 'dm-start'])
    await runtime.stop()
  })

  it('a thread started on Harmony gets its Discord thread from the notice, on a message posted as its author', async () => {
    const { rt, runtime, channel, webhook, h } = await setup()
    h.getThread.mockResolvedValue(thread({ id: 'ht-2', parent_message_id: 'hm-notice', name: 'Standalone' }))
    await rt.onHarmonyMessageCreate(harmonyMessage({
      id: 'hm-notice', is_system: true, content: 'started a thread',
      metadata: { type: 'thread_created', thread_id: 'ht-2', thread_name: 'Standalone', standalone: true },
    }))
    expect(webhook.send).toHaveBeenCalledTimes(1)
    expect(webhook.send.mock.calls[0][0]).toMatchObject({ content: '-# started a thread', username: 'Alice', allowedMentions: { parse: [] } })
    expect(channel.threads.create).toHaveBeenCalledWith({ name: 'Standalone', startMessage: 'wh-1-msg-1' })
    expect(h.pairThread).toHaveBeenCalledWith('ht-2', 'wh-1-msg-1')
    await runtime.stop()
  })

  it('without a webhook, or when Discord refuses the thread on that message, the thread is created bare', async () => {
    const { rt, runtime, channel, webhook, h } = await setup()
    const notice = (threadId: string) => harmonyMessage({
      id: `hm-notice-${threadId}`, is_system: true, content: 'started a thread',
      metadata: { type: 'thread_created', thread_id: threadId, thread_name: 'Bare', standalone: true },
    })

    h.getThread.mockResolvedValue(thread({ id: 'ht-a', parent_message_id: 'hm-notice-ht-a', name: 'Bare' }))
    channel.threads.create.mockRejectedValueOnce(new Error('Missing Permissions'))
    await rt.onHarmonyMessageCreate(notice('ht-a'))
    expect(webhook.deleteMessage).toHaveBeenCalledWith('wh-1-msg-1')
    expect(channel.threads.create).toHaveBeenLastCalledWith({ name: 'Bare', type: 11 })

    vi.spyOn(rt, 'getOrCreateWebhook').mockResolvedValue(null)
    h.getThread.mockResolvedValue(thread({ id: 'ht-b', parent_message_id: 'hm-notice-ht-b', name: 'Bare' }))
    await rt.onHarmonyMessageCreate(notice('ht-b'))
    expect(webhook.send).toHaveBeenCalledTimes(1)
    expect(channel.threads.create).toHaveBeenLastCalledWith({ name: 'Bare', type: 11 })
    expect(h.pairThread.mock.calls.map(c => c[0])).toEqual(['ht-a', 'ht-b'])
    await runtime.stop()
  })

  it('a thread another bridge process paired first keeps that pair', async () => {
    const { rt, runtime, client, channel, webhook, h } = await setup()
    fakeThread(client, channel, 'dt-standing')
    h.getThread.mockResolvedValue(thread({ id: 'ht-3', parent_message_id: 'hm-x' }))
    h.pairThread.mockResolvedValue('dt-standing')
    const found = await runtime.threads.discordThreadFor('ht-3', 'h1', channel)
    expect(found?.id).toBe('dt-standing')
    const created = client.channels.cache.get('thread-1')
    expect(created).toBeUndefined()

    // A losing thread started on a message takes that message with it.
    h.getThread.mockResolvedValue(thread({ id: 'ht-4', parent_message_id: 'hm-y' }))
    const again = await runtime.threads.discordThreadFor('ht-4', 'h1', channel, true, { username: 'Alice' })
    expect(again?.id).toBe('dt-standing')
    expect(client.channels.cache.get('wh-1-msg-1')).toBeUndefined()
    expect(webhook.deleteMessage).toHaveBeenCalledWith('wh-1-msg-1')
    await runtime.stop()
  })

  it('edits and deletes in a Harmony thread reach the Discord thread, and never create one', async () => {
    const { rt, runtime, client, channel, webhook, h } = await setup()
    fakeThread(client, channel, 'dt-5')
    h.getThread.mockResolvedValue(thread({ id: 'ht-5', discord_thread_id: 'dt-5' }))
    rt.harmonyToDiscordMessages.set('hm-e', 'dm-e')
    rt.harmonyDiscordViaWebhook.set('hm-e', true)
    await rt.onHarmonyMessageUpdate(harmonyMessage({ id: 'hm-e', thread_id: 'ht-5', content: 'edited', content_raw: [{ type: 'text', text: 'edited' }] }))
    expect(webhook.editMessage.mock.calls[0][1]).toMatchObject({ threadId: 'dt-5' })

    await rt.onHarmonyMessageDelete(harmonyMessage({ id: 'hm-e', thread_id: 'ht-5' }))
    expect(webhook.deleteMessage).toHaveBeenCalledWith('dm-e', 'dt-5')

    h.getThread.mockResolvedValue(thread({ id: 'ht-6', discord_thread_id: null }))
    rt.harmonyToDiscordMessages.set('hm-f', 'dm-f')
    await rt.onHarmonyMessageUpdate(harmonyMessage({ id: 'hm-f', thread_id: 'ht-6', content: 'x', content_raw: [{ type: 'text', text: 'x' }] }))
    expect(channel.threads.create).not.toHaveBeenCalled()
    await runtime.stop()
  })
})
