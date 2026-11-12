import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Collection, MessageFlags } from 'discord.js'
import { BridgeRuntime } from '../src/runtime/BridgeRuntime.js'
import { handleInteraction } from '../src/runtime/commands.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { APPLICATION_FLAGS } from '../src/runtime/discordConnection.js'
import { Logger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'
import { FakeDiscordClient, appResponse } from './fakeDiscord.js'

const ALL = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS | APPLICATION_FLAGS.GATEWAY_PRESENCE
const writer: PairWriter = { link: async () => {}, linkMany: async () => [], unlink: async () => false }
const optedOutRefusal = () => new HarmonyHttpError('The author opted out of the bridge', 403, 'BRIDGE_AUTHOR_OPTED_OUT')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-privacy-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.endsWith('/applications/@me')) return appResponse(ALL)()
    if (u.includes('/members')) return Response.json([])
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
    media: { maxUploadBytes: 8 * 1024 * 1024, mediaOrigin: null },
    appEmojiDir: null,
    createDiscordClient: (options) => {
      const c = new FakeDiscordClient(options)
      c.addGuild('g1', [])
      return c as any
    },
  })
  const h = runtime.harmony
  const spies = {
    sendMessage: vi.spyOn(h, 'sendMessage').mockImplementation(async () => ({ id: 'hm-new' })),
    editMessage: vi.spyOn(h, 'editMessage').mockResolvedValue({}),
    deleteMessage: vi.spyOn(h, 'deleteMessage').mockResolvedValue({ success: true }),
    addReaction: vi.spyOn(h, 'addReaction').mockResolvedValue({ success: true }),
    removeReaction: vi.spyOn(h, 'removeReaction').mockResolvedValue({ success: true }),
    createThread: vi.spyOn(h, 'createThread').mockResolvedValue({ id: 'ht-1' } as any),
    lookupThread: vi.spyOn(h, 'lookupThreadByDiscordId').mockResolvedValue(null),
  }
  const error = vi.spyOn(log, 'error')
  return { rt: runtime as any, runtime, h: spies, error }
}

function discordMessage(over: Record<string, any> = {}) {
  return {
    id: 'dm-1',
    channelId: '1001',
    guildId: 'g1',
    partial: false,
    author: { id: 'du-1', bot: false, username: 'user', discriminator: '0', globalName: null, displayAvatarURL: () => 'https://cdn.example/a.png' },
    member: { displayName: 'Dave', displayAvatarURL: () => 'https://cdn.example/m.png' },
    content: 'hello',
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

const reaction = (messageId = 'dm-1') => ({
  partial: false,
  emoji: { id: null, name: '👍' },
  message: { id: messageId, channelId: '1001', guildId: 'g1', channel: { isThread: () => false }, guild: null },
})
const user = (id: string) => ({ id, bot: false, username: 'user', discriminator: '0', globalName: null, displayAvatarURL: () => 'https://cdn.example/a.png' })

describe('live relay of opted-out Discord users', () => {
  it('sends nothing of an opted-out author: no message, no edit', async () => {
    const { rt, h } = setup()
    rt.optOuts.add('du-1')
    await rt.onDiscordMessage(discordMessage())
    rt.discordToHarmonyMessages.set('dm-0', 'hm-0')
    await rt.onDiscordMessageUpdate(discordMessage({ id: 'dm-0', content: 'edited' }))
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(h.editMessage).not.toHaveBeenCalled()
  })

  it('still relays everyone else', async () => {
    const { rt, h } = setup()
    rt.optOuts.add('du-2')
    await rt.onDiscordMessage(discordMessage())
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('still deletes the Harmony copy when an opted-out author deletes their message', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('dm-1', 'hm-1')
    rt.optOuts.add('du-1')
    await rt.onDiscordMessageDelete(discordMessage())
    expect(h.deleteMessage).toHaveBeenCalledWith('hm-1')
  })

  it('drops a refused message silently and sends nothing more of that author', async () => {
    const { rt, h, error } = setup()
    h.sendMessage.mockRejectedValueOnce(optedOutRefusal())
    await rt.onDiscordMessage(discordMessage())
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
    expect(rt.optOuts.has('du-1')).toBe(true)

    await rt.onDiscordMessage(discordMessage({ id: 'dm-2' }))
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('learns of an opt-out from a refused edit too', async () => {
    const { rt, h, error } = setup()
    rt.discordToHarmonyMessages.set('dm-1', 'hm-1')
    h.editMessage.mockRejectedValueOnce(optedOutRefusal())
    await rt.onDiscordMessageUpdate(discordMessage({ content: 'edited' }))
    expect(error).not.toHaveBeenCalled()
    expect(rt.optOuts.has('du-1')).toBe(true)
  })

  it('does not bridge a reaction of an opted-out user, but bridges its removal', async () => {
    const { rt, h } = setup()
    rt.discordToHarmonyMessages.set('dm-1', 'hm-1')
    rt.optOuts.add('du-1')
    await rt.onDiscordReactionAdd(reaction(), user('du-1'))
    expect(h.addReaction).not.toHaveBeenCalled()
    await rt.onDiscordReactionRemove(reaction(), user('du-1'))
    expect(h.removeReaction).toHaveBeenCalledTimes(1)
    await rt.onDiscordReactionAdd(reaction(), user('du-2'))
    expect(h.addReaction).toHaveBeenCalledTimes(1)
  })

  it('does not create a Harmony thread for the thread of an opted-out member', async () => {
    const { rt, h } = setup()
    const thread = (ownerId: string) => ({ id: `t-${ownerId}`, name: 'plans', type: 11, parentId: '1001', ownerId, guild: null })
    rt.optOuts.add('du-1')
    await rt.onDiscordThreadCreate(thread('du-1'))
    expect(h.createThread).not.toHaveBeenCalled()
    await rt.onDiscordThreadCreate(thread('du-2'))
    expect(h.createThread).toHaveBeenCalledTimes(1)
  })

  it('takes a message another bot already stored as final, without an error', async () => {
    const { rt, h, error } = setup()
    h.sendMessage.mockRejectedValue(new HarmonyHttpError('Discord message id already stored', 409, 'DISCORD_MESSAGE_ID_TAKEN'))
    await rt.onDiscordMessage(discordMessage())
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
    expect(rt.optOuts.has('du-1')).toBe(false)
  })
})

describe('/mention by an opted-out Discord user', () => {
  function mention(rt: any) {
    const interaction: any = {
      isAutocomplete: () => false,
      isChatInputCommand: () => true,
      commandName: 'mention',
      channelId: '1001',
      guildId: 'g1',
      user: { id: 'du-1', username: 'user', discriminator: '0', displayAvatarURL: () => 'https://cdn.example/a.png' },
      member: { displayName: 'Dave' },
      options: { getString: (name: string) => (name === 'user' ? 'hu-1' : name === 'message' ? 'hi' : null) },
      reply: vi.fn(async (_arg: any) => {}),
      deferReply: vi.fn(async () => {}),
      editReply: vi.fn(async (_arg: any) => ({ id: 'reply-1' })),
    }
    return { interaction, run: () => handleInteraction(rt, interaction) }
  }

  it('sends nothing and tells them why', async () => {
    const { rt, h } = setup()
    rt.optOuts.add('du-1')
    const m = mention(rt)
    await m.run()
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(m.interaction.reply.mock.calls[0][0]).toMatchObject({ flags: MessageFlags.Ephemeral })
    expect(m.interaction.reply.mock.calls[0][0].content).toContain('You are opted out of the Harmony bridge')
  })

  it('tells them when Harmony refuses it, and remembers', async () => {
    const { rt, h } = setup()
    h.sendMessage.mockRejectedValue(optedOutRefusal())
    const m = mention(rt)
    await m.run()
    expect(m.interaction.editReply.mock.calls.at(-1)![0].content).toContain('You are opted out of the Harmony bridge')
    expect(rt.optOuts.has('du-1')).toBe(true)
  })
})
