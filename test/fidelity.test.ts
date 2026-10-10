import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Collection, Events, MessageFlags, PermissionFlagsBits, Routes } from 'discord.js'
import { BridgeRuntime } from '../src/runtime/BridgeRuntime.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { APPLICATION_FLAGS } from '../src/runtime/discordConnection.js'
import { appEmojiName } from '../src/runtime/appEmojis.js'
import { Logger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'
import {
  FakeDiscordClient,
  appResponse,
  discordError,
  fakeMember,
  fakeTextChannel,
  fakeWebhook,
} from './fakeDiscord.js'

const ALL = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS | APPLICATION_FLAGS.GATEWAY_PRESENCE
const MIB = 1024 * 1024
const writer: PairWriter = { link: async () => {}, linkMany: async () => [], unlink: async () => false }
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const STORAGE = 'https://h.example/storage/v1/object/sign/message_media/c/h1/hu-1'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-fidelity-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

interface SetupOptions {
  perms?: bigint[]
  webhook?: ReturnType<typeof fakeWebhook> | null
  maxUploadMb?: number
  files?: Record<string, Buffer>
}

async function setup(o: SetupOptions = {}) {
  const clients: FakeDiscordClient[] = []
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.endsWith('/applications/@me')) return appResponse(ALL)()
    if (u.includes('/members')) return Response.json([])
    const file = o.files?.[u]
    if (file) return new Response(file)
    return new Response('not found', { status: 404 })
  })
  const log = new Logger('debug', '', true)
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
    media: { maxUploadBytes: (o.maxUploadMb ?? 8) * MIB, mediaOrigin: null },
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
    deleteMessage: vi.spyOn(h, 'deleteMessage').mockResolvedValue({ success: true }),
    merge: vi.spyOn(h, 'mergeMessageMetadata').mockResolvedValue(undefined),
    getMessage: vi.spyOn(h, 'getMessage').mockResolvedValue(null),
    getEmojis: vi.spyOn(h, 'getEmojis').mockResolvedValue([]),
    addReaction: vi.spyOn(h, 'addReaction').mockResolvedValue({ success: true }),
    loadRecent: vi.spyOn(h, 'loadRecentMessages').mockResolvedValue([]),
    op6: vi.spyOn(h, 'registerBridgeData').mockReturnValue(true),
  }
  await runtime.connectDiscord()
  const client = clients[0]
  const channel = fakeTextChannel(client, 'g1', '1001', { perms: o.perms, webhook: o.webhook })
  client.ready()
  h.emit('ready', { bot: { id: 'hb', username: 'bridge' } })
  await vi.advanceTimersByTimeAsync(0)
  const warn = vi.spyOn(log, 'warn')
  return { runtime, client, channel, h: spies, log, warn, fetchImpl, rt: runtime as any }
}

function harmonyMessage(over: Record<string, any> = {}) {
  return {
    id: 'hm-1',
    channel_id: 'h1',
    author: { id: 'hu-1', username: 'alice', display_name: 'Alice', nickname: null, avatar: 'https://h.example/a.png' },
    content: 'hello',
    content_raw: [{ type: 'text', text: 'hello' }],
    metadata: {},
    ...over,
  }
}

function discordAuthor(id = 'du-1') {
  return { id, bot: false, username: `user-${id}`, discriminator: '0', globalName: null, displayAvatarURL: () => `https://cdn.example/${id}.png` }
}

function discordMessage(over: Record<string, any> = {}) {
  return {
    id: 'dm-1',
    channelId: '1001',
    guildId: 'g1',
    partial: false,
    author: discordAuthor(),
    member: { displayName: 'Dave', displayAvatarURL: () => 'https://cdn.example/m.png' },
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

const lastWebhookPayload = (w: ReturnType<typeof fakeWebhook>) => w.send.mock.calls.at(-1)![0]

describe('Harmony → Discord posting', () => {
  it('puppets with the server nickname under a sanitised webhook name', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime } = await setup({ webhook })
    await rt.onHarmonyMessageCreate(harmonyMessage({
      author: { id: 'hu-1', username: 'alice', display_name: 'Alice', nickname: 'Discord Dave', avatar: null },
    }))
    expect(lastWebhookPayload(webhook)).toMatchObject({ content: 'hello', username: 'Dave' })
    await runtime.stop()
  })

  it('lists only explicit Discord mention parts in allowed_mentions, never a username match', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime, client } = await setup({ webhook })
    client.emit(Events.GuildMemberAdd, fakeMember('g1', '999', 'bob'))
    await rt.onHarmonyMessageCreate(harmonyMessage({
      content_raw: [
        { type: 'mention', userId: 'hu-bob', username: 'bob', domain: 'h.example', isLocal: true },
        { type: 'text', text: ' and ' },
        { type: 'mention', userId: '111', username: 'carol', domain: 'discord.com' },
      ],
    }))
    const payload = lastWebhookPayload(webhook)
    expect(payload.content).toBe('@bob@h.example and <@111>')
    expect(payload.allowedMentions).toEqual({ parse: [], users: ['111'] })
    await runtime.stop()
  })

  it('maps Harmony role and channel mentions through the bridge mappings without pinging roles', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime } = await setup({ webhook })
    runtime.permissionSyncStore.setMapping('555', 'hr-mod', 'Mods')
    await rt.onHarmonyMessageCreate(harmonyMessage({
      content_raw: [
        { type: 'role_mention', roleId: 'hr-mod', roleName: 'Mods', roleColor: null },
        { type: 'text', text: ' see ' },
        { type: 'channel_mention', channelId: 'h1', serverId: 's', name: 'general' },
      ],
    }))
    const payload = lastWebhookPayload(webhook)
    expect(payload.content).toBe('<@&555> see <#1001>')
    expect(payload.allowedMentions).toEqual({ parse: [] })
    await runtime.stop()
  })

  it('lets @here and @everyone ping Discord only when the Harmony author held the right', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime } = await setup({ webhook })
    runtime.permissionSyncStore.setDefaultHarmonyRoleId('hr-default')
    const content_raw = [
      { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null },
      { type: 'text', text: ' and ' },
      { type: 'role_mention', roleId: 'hr-default', roleName: 'everyone', roleColor: null },
    ]

    await rt.onHarmonyMessageCreate(harmonyMessage({ id: 'hm-quiet', content_raw }))
    expect(lastWebhookPayload(webhook)).toMatchObject({ content: '@here and @everyone', allowedMentions: { parse: [] } })

    await rt.onHarmonyMessageCreate(harmonyMessage({ id: 'hm-loud', content_raw, mention_everyone: true }))
    expect(lastWebhookPayload(webhook)).toMatchObject({ content: '@here and @everyone', allowedMentions: { parse: ['everyone'] } })
    await runtime.stop()
  })

  it('mentions a reply parent only by its recorded Discord author', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime, client, h } = await setup({ webhook })
    client.emit(Events.GuildMemberAdd, fakeMember('g1', '999', 'bob'))
    rt.harmonyToDiscordMessages.set('parent-h', 'parent-d')
    rt.harmonyToDiscordMessages.set('parent-d2', 'parent-dd')

    // Harmony-origin parent whose author shares a Discord member's username: no ping.
    h.getMessage.mockResolvedValueOnce({ id: 'parent-h', author: { id: 'hu-bob', username: 'bob' }, metadata: { bridge_source: 'harmony' } })
    await rt.onHarmonyMessageCreate(harmonyMessage({ id: 'r1', reply_to: 'parent-h' }))
    expect(lastWebhookPayload(webhook).content).toBe('https://discord.com/channels/g1/1001/parent-d\nhello')
    expect(lastWebhookPayload(webhook).allowedMentions).toEqual({ parse: [] })

    // Discord-origin parent: its author is pinged.
    h.getMessage.mockResolvedValueOnce({ id: 'parent-d2', metadata: { bridge_source: 'discord', discord_user: { id: '321', username: 'eve' } } })
    await rt.onHarmonyMessageCreate(harmonyMessage({ id: 'r2', reply_to: 'parent-d2' }))
    expect(lastWebhookPayload(webhook).content).toBe('https://discord.com/channels/g1/1001/parent-dd\n<@321> hello')
    expect(lastWebhookPayload(webhook).allowedMentions).toEqual({ parse: [], users: ['321'] })
    await runtime.stop()
  })

  it('falls back to a bot post with a bold author prefix when the webhook send fails', async () => {
    const webhook = fakeWebhook()
    webhook.send.mockRejectedValueOnce(discordError(50035, 'Invalid Form Body'))
    const { rt, runtime, channel, h } = await setup({ webhook })
    await rt.onHarmonyMessageCreate(harmonyMessage({ author: { id: 'hu-1', username: 'alice', display_name: '*Al*', avatar: null } }))
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.send.mock.calls[0][0]).toMatchObject({ content: '**\\*Al\\***: hello', allowedMentions: { parse: [] } })
    expect(h.merge).toHaveBeenCalledWith('hm-1', expect.objectContaining({ discord_message_id: 'bot-msg-1', discord_via_webhook: false }))
    await runtime.stop()
  })

  /** A webhook deleted on Discord: listed until the first post finds out. */
  function deletedWebhook(id: string, channelRef: { current: any }) {
    const w = fakeWebhook(id)
    w.send.mockImplementation(async () => {
      channelRef.current.webhooks.splice(0)
      throw discordError(10015, 'Unknown Webhook', 404)
    })
    return w
  }

  it('drops a deleted webhook (10015) and recreates it', async () => {
    const ref = { current: null as any }
    const stale = deletedWebhook('wh-stale', ref)
    const { rt, runtime, channel } = await setup({ webhook: stale })
    ref.current = channel
    await rt.onHarmonyMessageCreate(harmonyMessage())
    expect(channel.createWebhook).toHaveBeenCalledTimes(1)
    expect(channel.created[0].send).toHaveBeenCalledTimes(1)
    expect(channel.send).not.toHaveBeenCalled()

    await runtime.stop()
  })

  it('posts as the bot when the recreated webhook fails as well', async () => {
    const ref = { current: null as any }
    const stale = deletedWebhook('wh-stale', ref)
    const { rt, runtime, channel } = await setup({ webhook: stale })
    ref.current = channel
    channel.createWebhook.mockResolvedValue(deletedWebhook('wh-doomed', ref))
    await rt.onHarmonyMessageCreate(harmonyMessage())
    expect(channel.createWebhook).toHaveBeenCalledTimes(1)
    expect(channel.send).toHaveBeenCalledTimes(1)
    expect(channel.send.mock.calls[0][0].content).toBe('**Alice**: hello')
    await runtime.stop()
  })

  it('sets SUPPRESS_EMBEDS when the author disabled the link preview', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime } = await setup({ webhook })
    await rt.onHarmonyMessageCreate(harmonyMessage({
      content_raw: [{ type: 'text', text: 'docs: ' }, { type: 'url', url: 'https://x.example/doc', preview: false }],
    }))
    expect(lastWebhookPayload(webhook)).toMatchObject({ content: 'docs: <https://x.example/doc>', flags: MessageFlags.SuppressEmbeds })

    await rt.onHarmonyMessageCreate(harmonyMessage({
      id: 'hm-2',
      content_raw: [{ type: 'url', url: 'https://x.example/doc', preview: true }],
    }))
    expect(lastWebhookPayload(webhook).flags).toBeUndefined()
    await runtime.stop()
  })
})

describe('Harmony → Discord files', () => {
  const small = `${STORAGE}/small.jpg?token=t1`
  const big = `${STORAGE}/big.mp4?token=t1`

  it('uploads files within MAX_UPLOAD_MB as attachments with no URL text, and links larger ones', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime, h } = await setup({
      webhook,
      maxUploadMb: 1,
      files: { [small]: JPEG, [big]: Buffer.alloc(2 * MIB) },
    })
    await rt.onHarmonyMessageCreate(harmonyMessage({
      content_raw: [
        { type: 'text', text: 'trip' },
        { type: 'file', url: small, path: 'c/h1/hu-1/small.jpg', fileName: 'small.jpg', fileType: 'image', fileSize: JPEG.length },
        { type: 'file', url: big, path: 'c/h1/hu-1/big.mp4', fileName: 'big.mp4', fileType: 'video', fileSize: 2 * MIB },
      ],
    }))
    const payload = lastWebhookPayload(webhook)
    expect(payload.files).toEqual([{ attachment: JPEG, name: 'small.jpg' }])
    expect(payload.content).toBe(`trip\n[big.mp4 · 2 MB](<${big}>)`)
    expect(payload.content).not.toContain('small.jpg')
    expect(h.merge).toHaveBeenCalledWith('hm-1', expect.objectContaining({ discord_uploaded_files: ['c/h1/hu-1/small.jpg'] }))
    await runtime.stop()
  })

  it('sends an attachment-only message without content', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime } = await setup({ webhook, files: { [small]: JPEG } })
    await rt.onHarmonyMessageCreate(harmonyMessage({
      content_raw: [{ type: 'file', url: small, path: 'c/h1/hu-1/small.jpg', fileName: 'small.jpg', fileType: 'image' }],
    }))
    const payload = lastWebhookPayload(webhook)
    expect(payload.content).toBeUndefined()
    expect(payload.files).toHaveLength(1)
    await runtime.stop()
  })

  it('links the files when Discord refuses the attachment size', async () => {
    const webhook = fakeWebhook()
    webhook.send.mockRejectedValueOnce(discordError(40005, 'Request entity too large', 413))
    const { rt, runtime, channel } = await setup({ webhook, files: { [small]: JPEG } })
    await rt.onHarmonyMessageCreate(harmonyMessage({
      content_raw: [
        { type: 'text', text: 'pic' },
        { type: 'file', url: small, path: 'c/h1/hu-1/small.jpg', fileName: 'small.jpg', fileType: 'image' },
      ],
    }))
    expect(webhook.send).toHaveBeenCalledTimes(2)
    const payload = lastWebhookPayload(webhook)
    expect(payload.files).toBeUndefined()
    expect(payload.content).toBe(`pic\n[small.jpg](<${small}>)`)
    expect(channel.send).not.toHaveBeenCalled()

    // The learned limit keeps the next message from trying the upload.
    await rt.onHarmonyMessageCreate(harmonyMessage({
      id: 'hm-2',
      content_raw: [{ type: 'file', url: small, path: 'c/h1/hu-1/small.jpg', fileName: 'small.jpg', fileType: 'image' }],
    }))
    expect(webhook.send).toHaveBeenCalledTimes(3)
    expect(lastWebhookPayload(webhook).files).toBeUndefined()
    await runtime.stop()
  })

  it('keeps uploaded files out of edits although the signed URL changed', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime } = await setup({ webhook, files: { [small]: JPEG } })
    await rt.onHarmonyMessageCreate(harmonyMessage({
      content_raw: [
        { type: 'text', text: 'pic' },
        { type: 'file', url: small, path: 'c/h1/hu-1/small.jpg', fileName: 'small.jpg', fileType: 'image' },
      ],
    }))
    await rt.onHarmonyMessageUpdate(harmonyMessage({
      content_raw: [
        { type: 'text', text: 'pic (edited)' },
        { type: 'file', url: `${STORAGE}/small.jpg?token=t2`, path: 'c/h1/hu-1/small.jpg', fileName: 'small.jpg', fileType: 'image' },
      ],
    }))
    expect(webhook.editMessage).toHaveBeenCalledWith('wh-1-msg-1', expect.objectContaining({ content: 'pic (edited)' }))
    await runtime.stop()
  })
})

describe('moderation sync', () => {
  const discordOrigin = (id = 'hm-d1', discordId = 'dm-1') => ({
    id, channel_id: 'h1', metadata: { bridge_source: 'discord', discord_message_id: discordId },
  })

  it('deletes the Discord original of a Discord-origin message deleted on Harmony', async () => {
    const { rt, runtime, channel } = await setup({
      perms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.ManageMessages],
    })
    await rt.onHarmonyMessageDelete(discordOrigin())
    expect(channel.messages.delete).toHaveBeenCalledWith('dm-1')
    await runtime.stop()
  })

  it('keeps the Discord original without Manage Messages and logs once per channel', async () => {
    const { rt, runtime, channel, warn } = await setup()
    await rt.onHarmonyMessageDelete(discordOrigin('hm-a', 'dm-a'))
    await rt.onHarmonyMessageDelete(discordOrigin('hm-b', 'dm-b'))
    expect(channel.messages.delete).not.toHaveBeenCalled()
    expect(warn.mock.calls.filter(c => String(c[0]).includes('Manage Messages'))).toHaveLength(1)
    await runtime.stop()
  })

  it('does not echo a Discord delete back to Discord', async () => {
    const { rt, runtime, channel, h } = await setup({
      perms: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages],
    })
    rt.discordToHarmonyMessages.set('dm-1', 'hm-d1')
    await rt.onDiscordMessageDelete({ id: 'dm-1', channelId: '1001', author: null })
    expect(h.deleteMessage).toHaveBeenCalledWith('hm-d1')
    await rt.onHarmonyMessageDelete(discordOrigin())
    expect(channel.messages.delete).not.toHaveBeenCalled()
    await runtime.stop()
  })

  it('MESSAGE_DELETE_BULK deletes the Harmony copies of Discord messages only', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime, client, h } = await setup({ webhook })
    rt.discordToHarmonyMessages.set('dm-a', 'hm-a')
    rt.discordToHarmonyMessages.set('dm-b', 'hm-b')
    await rt.onHarmonyMessageCreate(harmonyMessage({ id: 'hm-h' }))
    const copyId = webhook.send.mock.results[0].value
    const copy = (await copyId).id

    client.emit(Events.MessageBulkDelete, new Collection([
      ['dm-a', { id: 'dm-a', channelId: '1001', partial: true }],
      ['dm-b', { id: 'dm-b', channelId: '1001', partial: true }],
      [copy, { id: copy, channelId: '1001', partial: true }],
      ['dm-x', { id: 'dm-x', channelId: '1001', partial: true }],
    ]), { id: '1001', guildId: 'g1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.deleteMessage.mock.calls.map(c => c[0]).sort()).toEqual(['hm-a', 'hm-b'])
    await runtime.stop()
  })
})

describe('Discord → Harmony', () => {
  it('sends role and channel mentions as Harmony parts', async () => {
    const { rt, runtime, h } = await setup()
    runtime.permissionSyncStore.setMapping('555', 'hr-mod', 'Mods')
    await rt.onDiscordMessage(discordMessage({
      content: '<@&555> look in <#1001>',
      mentions: {
        users: new Collection(),
        roles: new Collection([['555', { name: 'Mods', hexColor: '#00ff00' }]]),
        channels: new Collection([['1001', { name: 'general-dc' }]]),
        repliedUser: null,
      },
    }))
    expect(h.sendMessage.mock.calls[0][1]).toEqual([
      { type: 'role_mention', roleId: 'hr-mod', roleName: 'Mods', roleColor: '#00ff00' },
      { type: 'text', text: ' look in ' },
      { type: 'channel_mention', channelId: 'h1', serverId: 's', name: 'general' },
    ])
    await runtime.stop()
  })

  it('sends a pinged @here and @everyone as Harmony parts, an unpinged one as text', async () => {
    const { rt, runtime, h } = await setup()
    runtime.permissionSyncStore.setDefaultHarmonyRoleId('hr-default')
    const mentions = (everyone: boolean) => ({
      users: new Collection(), roles: new Collection(), channels: new Collection(), repliedUser: null, everyone,
    })
    await rt.onDiscordMessage(discordMessage({ id: 'dm-ping', content: '@here and @everyone', mentions: mentions(true) }))
    await rt.onDiscordMessage(discordMessage({
      id: 'dm-text', author: discordAuthor('du-2'), content: '@here and @everyone', mentions: mentions(false),
    }))
    expect(h.sendMessage.mock.calls[0][1]).toEqual([
      { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null },
      { type: 'text', text: ' and ' },
      { type: 'role_mention', roleId: 'hr-default', roleName: 'everyone', roleColor: null },
    ])
    expect(h.sendMessage.mock.calls[1][1]).toEqual([{ type: 'text', text: '@here and @everyone' }])
    await runtime.stop()
  })

  it('drops floods and repeats from one Discord author before Harmony', async () => {
    const { rt, runtime, h, warn } = await setup()
    for (let i = 0; i < 10; i++) await rt.onDiscordMessage(discordMessage({ id: `dm-${i}`, content: `msg ${i}` }))
    expect(h.sendMessage).toHaveBeenCalledTimes(8)
    await rt.onDiscordMessage(discordMessage({ id: 'other', author: discordAuthor('du-2'), content: 'msg 1' }))
    expect(h.sendMessage).toHaveBeenCalledTimes(9)

    vi.advanceTimersByTime(20_000)
    await rt.onDiscordMessage(discordMessage({ id: 'dup', content: 'msg 3' }))
    expect(h.sendMessage).toHaveBeenCalledTimes(9)
    await rt.onDiscordMessage(discordMessage({ id: 'new', content: 'fresh' }))
    expect(h.sendMessage).toHaveBeenCalledTimes(10)

    expect(runtime.antiSpam.dropped).toEqual({ rate: 2, duplicate: 1 })
    const logged = warn.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('Anti-spam'))
    expect(logged).toHaveLength(1)
    expect(logged[0]).not.toContain('msg ')
    await runtime.stop()
  })

  it('sends a .gif remote_emoji_url for an animated custom emoji reaction', async () => {
    const { rt, runtime, h } = await setup()
    rt.discordToHarmonyMessages.set('dm-r', 'hm-r')
    const guild = { members: { cache: new Map(), fetch: vi.fn(async () => null) }, emojis: { cache: new Collection([['43', { animated: true }]]) } }
    const user = { ...discordAuthor('du-9'), bot: false }
    await rt.onDiscordReactionAdd({ partial: false, emoji: { id: '42', name: 'pog', animated: true }, message: { id: 'dm-r', channelId: '1001', guild } }, user)
    await rt.onDiscordReactionAdd({ partial: false, emoji: { id: '43', name: 'wave', animated: null }, message: { id: 'dm-r', channelId: '1001', guild } }, user)
    await rt.onDiscordReactionAdd({ partial: false, emoji: { id: '44', name: 'still', animated: false }, message: { id: 'dm-r', channelId: '1001', guild } }, user)
    expect(h.addReaction.mock.calls.map(c => [c[2], (c[3] as any).remote_emoji_url])).toEqual([
      ['discord:pog:42', 'https://cdn.discordapp.com/emojis/42.gif'],
      ['discord:wave:43', 'https://cdn.discordapp.com/emojis/43.gif'],
      ['discord:still:44', 'https://cdn.discordapp.com/emojis/44.png'],
    ])
    await runtime.stop()
  })
})

describe('Harmony custom emoji on Discord', () => {
  const emojiUrl = 'https://h.example/storage/v1/object/public/emojis/s/party.png'

  it('uploads the emoji once as an application emoji for text and reactions', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime, client, channel, h } = await setup({ webhook, files: { [emojiUrl]: PNG } })
    h.getEmojis.mockResolvedValue([{ id: 'e1', name: 'party', url: emojiUrl }, { id: 'e2', name: 'other', url: null }])
    const name = appEmojiName('party', emojiUrl)
    client.rest.post.mockImplementation(async (_route: string, opts: any) => ({ id: '900', name: opts.body.name, animated: false }))

    await rt.onHarmonyMessageCreate(harmonyMessage({
      content_raw: [{ type: 'text', text: 'yay ' }, { type: 'emoji', emoji: { id: 'e1', name: 'party', url: 'https://evil.example/x.png' } }],
    }))
    expect(lastWebhookPayload(webhook).content).toBe(`yay <:${name}:900>`)
    expect(client.rest.post).toHaveBeenCalledTimes(1)
    expect(client.rest.post.mock.calls[0][0]).toBe(Routes.applicationEmojis('app-1'))
    expect((client.rest.post.mock.calls[0][1] as any).body.image).toBe(`data:image/png;base64,${PNG.toString('base64')}`)

    rt.harmonyToDiscordMessages.set('hm-target', 'dm-target')
    await rt.onHarmonyReactionAdd({ reaction_id: 'r1', message_id: 'hm-target', channel_id: 'h1', emoji: { id: 'e1', name: 'party' } })
    expect(channel.reactions).toEqual([`${name}:900`])
    expect(client.rest.post).toHaveBeenCalledTimes(1)
    expect(h.getEmojis).toHaveBeenCalledTimes(1)
    await runtime.stop()
  })

  it('falls back to :name: when the emoji cannot be uploaded', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime, client, h } = await setup({ webhook })
    h.getEmojis.mockResolvedValue([])
    await rt.onHarmonyMessageCreate(harmonyMessage({
      content_raw: [{ type: 'emoji', emoji: { id: 'gone', name: 'gone', url: emojiUrl } }],
    }))
    expect(lastWebhookPayload(webhook).content).toBe(':gone:')
    expect(client.rest.post).not.toHaveBeenCalled()
    await runtime.stop()
  })
})

describe('gateway frame limit', () => {
  it('reports rate_limited after a 4008 close', async () => {
    const { runtime } = await setup()
    expect(runtime.connectionProblems().map(p => p.code)).not.toContain('rate_limited')
    runtime.harmony.emit('gatewayRateLimited', { code: 4008, reason: 'rate limited' })
    expect(runtime.connectionProblems().map(p => p.code)).toContain('rate_limited')
    await runtime.stop()
  })
})

describe('Harmony 1.6.16 wire', () => {
  const emojiUrl = 'https://h.example/storage/v1/object/public/emojis/s/wave.png'

  it('uploads a reaction emoji from the event url without asking Harmony', async () => {
    const { rt, runtime, client, channel, h } = await setup({ files: { [emojiUrl]: PNG } })
    client.rest.post.mockImplementation(async (_route: string, opts: any) => ({ id: '901', name: opts.body.name, animated: false }))
    rt.harmonyToDiscordMessages.set('hm-t', 'dm-t')
    await rt.onHarmonyReactionAdd({
      reaction_id: 'r1', message_id: 'hm-t', channel_id: 'h1',
      emoji: { id: 'e9', name: 'wave', url: emojiUrl, animated: false },
    })
    expect(channel.reactions).toEqual([`${appEmojiName('wave', emojiUrl)}:901`])
    expect(h.getEmojis).not.toHaveBeenCalled()
    await runtime.stop()
  })

  it('uses a Discord CDN url from the event as that Discord emoji', async () => {
    const { rt, runtime, client, channel } = await setup()
    rt.harmonyToDiscordMessages.set('hm-t', 'dm-t')
    await rt.onHarmonyReactionAdd({
      reaction_id: 'r2', message_id: 'hm-t', channel_id: 'h1',
      emoji: { id: 'e10', name: 'pog', url: 'https://cdn.discordapp.com/emojis/4242.gif', animated: true },
    })
    expect(channel.reactions).toEqual(['a:pog:4242'])
    expect(client.rest.post).not.toHaveBeenCalled()
    await runtime.stop()
  })

  it('never caches or uploads a lookup row whose id differs from the requested one', async () => {
    const { rt, runtime, client, channel, h } = await setup({ files: { [emojiUrl]: PNG } })
    // Harmony before 1.6.16: `?id=` ignored, every row returned.
    h.getEmojis.mockResolvedValue([
      { id: 'other-1', name: 'wave', url: emojiUrl },
      { id: 'other-2', name: 'x', url: 'https://h.example/x.png' },
    ])
    rt.harmonyToDiscordMessages.set('hm-t', 'dm-t')
    await rt.onHarmonyReactionAdd({ reaction_id: 'r3', message_id: 'hm-t', channel_id: 'h1', emoji: { id: 'wanted', name: 'wave' } })
    expect(channel.reactions).toEqual([])
    expect(client.rest.post).not.toHaveBeenCalled()

    // A row for 'other-1' was not cached from that answer: asking for it looks it up again.
    h.getEmojis.mockResolvedValue([{ id: 'other-1', name: 'wave', url: emojiUrl }])
    client.rest.post.mockImplementation(async (_route: string, opts: any) => ({ id: '902', name: opts.body.name, animated: false }))
    await rt.onHarmonyReactionAdd({ reaction_id: 'r4', message_id: 'hm-t', channel_id: 'h1', emoji: { id: 'other-1', name: 'wave' } })
    expect(h.getEmojis).toHaveBeenCalledTimes(2)
    expect(h.getEmojis.mock.calls.map(c => c[0])).toEqual(['wanted', 'other-1'])
    expect(channel.reactions).toEqual([`${appEmojiName('wave', emojiUrl)}:902`])
    await runtime.stop()
  })

  it('does not retry a relay AutoMod blocked and logs it without content', async () => {
    const { rt, runtime, h, warn } = await setup()
    const { HarmonyHttpError } = await import('../src/HarmonyClient.js')
    h.sendMessage.mockRejectedValue(new HarmonyHttpError('Blocked: bad words here', 403, 'AUTOMOD_BLOCKED'))
    await rt.onDiscordMessage(discordMessage({ id: 'am-1', content: 'secret spam text' }))
    await rt.onDiscordMessage(discordMessage({ id: 'am-2', content: 'more spam text' }))
    expect(h.sendMessage).toHaveBeenCalledTimes(2)
    expect(runtime.automodBlocked).toBe(2)
    const lines = warn.mock.calls.map(c => c.join(' '))
    expect(lines.filter(l => l.includes('AutoMod'))).toHaveLength(1)
    expect(lines.join('\n')).not.toMatch(/spam|bad words/)
    await runtime.stop()
  })

  it('sends the Discord author id as a string and the member join time', async () => {
    const { rt, runtime, h } = await setup()
    const joined = new Date('2026-10-01T12:00:00Z')
    await rt.onDiscordMessage(discordMessage({
      member: { displayName: 'Dave', joinedAt: joined, displayAvatarURL: () => 'https://cdn.example/m.png' },
    }))
    const metadata = h.sendMessage.mock.calls[0][2]
    expect(metadata.discord_user).toMatchObject({ id: 'du-1', username: 'user-du-1', joined_at: joined.toISOString() })

    await rt.onDiscordMessage(discordMessage({ id: 'dm-2', content: 'no member', member: null }))
    expect(h.sendMessage.mock.calls[1][2].discord_user).not.toHaveProperty('joined_at')
    await runtime.stop()
  })

  it('accepts absolute avatar URLs and resolves paths against Harmony', async () => {
    const webhook = fakeWebhook()
    const { rt, runtime } = await setup({ webhook })
    await rt.onHarmonyMessageCreate(harmonyMessage({
      author: { id: 'hu-2', username: 'carol', avatar: 'https://h.example/default_avatar.webp' },
    }))
    expect(lastWebhookPayload(webhook).avatarURL).toBe('https://h.example/default_avatar.webp')
    expect(runtime.webhookAvatarUrl('/default_avatar.webp')).toBe('https://h.example/default_avatar.webp')
    expect(runtime.webhookAvatarUrl('http://localhost:5173/a.png')).toBeUndefined()
    expect(runtime.webhookAvatarUrl('data:image/png;base64,AAAA')).toBeUndefined()
    expect(runtime.webhookAvatarUrl(null)).toBeUndefined()
    await runtime.stop()
  })
})

describe('HarmonyClient errors', () => {
  it('surfaces AUTOMOD_BLOCKED from a relay and sends it once', async () => {
    const { HarmonyClient, isAutomodBlocked } = await import('../src/HarmonyClient.js')
    const fetchImpl = vi.fn(async () => Response.json({ error: 'Blocked by AutoMod', code: 'AUTOMOD_BLOCKED' }, { status: 403 }))
    const client = new HarmonyClient('t', 'ws://127.0.0.1:9/gateway', 'http://127.0.0.1:9', { fetchImpl, log: new Logger('error', '', true) })
    const err = await client.sendMessage('h1', [{ type: 'text', text: 'x' }]).catch(e => e)
    expect(isAutomodBlocked(err)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reads ?id= answered as one emoji object (Harmony 1.6.16) or as rows (older)', async () => {
    const { HarmonyClient } = await import('../src/HarmonyClient.js')
    const emoji = { id: 'e1', name: 'ananas', url: 'https://h.example/storage/v1/object/public/emojis/a.webp' }
    for (const [body, expected] of [[emoji, [emoji]], [[emoji], [emoji]], [null, []]] as const) {
      const fetchImpl = vi.fn(async () => Response.json(body))
      const client = new HarmonyClient('t', 'ws://127.0.0.1:9/gateway', 'http://127.0.0.1:9', { fetchImpl, log: new Logger('error', '', true) })
      expect(await client.getEmojis('e1')).toEqual(expected)
    }
  })
})
