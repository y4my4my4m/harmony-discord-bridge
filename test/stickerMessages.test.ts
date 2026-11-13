import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Collection } from 'discord.js'
import { BridgeRuntime } from '../src/runtime/BridgeRuntime.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { APPLICATION_FLAGS } from '../src/runtime/discordConnection.js'
import { silentLogger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'
import { FakeDiscordClient, appResponse } from './fakeDiscord.js'

const ALL = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS | APPLICATION_FLAGS.GATEWAY_PRESENCE
const writer: PairWriter = { link: async () => {}, linkMany: async () => [], unlink: async () => false }
const STICKER_URL = 'https://db.test/stickers/s/discord/st-1.png'
const row = (over: Record<string, any> = {}) => ({
  id: 'hs-1', discord_sticker_id: 'st-1', name: 'Wave', description: 'a waving hand', url: STICKER_URL, removed: false, ...over,
})
const refused = () => new HarmonyHttpError('sticker refused', 422, 'STICKER_REFUSED')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-stickers-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

async function setup() {
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
      settings: { sync_member_list: true },
      pairs: [{ discord_channel_id: '1001', harmony_channel_id: 'h1', harmony_channel_name: 'general', direction: 'both' }],
      harmony_channels: [],
    }),
    writer,
    discordToken: 'dtok',
    harmony: { token: 'htok', gatewayUrl: 'ws://127.0.0.1:9/gateway', apiUrl: 'http://127.0.0.1:9', baseUrl: 'https://h.example' },
    permissionStorePath: join(dir, 'permission-sync.yml'),
    log: silentLogger,
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
  }
  const rt = runtime as any
  rt.stickerLinks.replace('s', [row()])
  return { rt, h: spies }
}

function discordMessage(over: Record<string, any> = {}) {
  return {
    id: 'dm-1',
    channelId: '1001',
    guildId: 'g1',
    partial: false,
    author: { id: 'du-1', bot: false, username: 'user', discriminator: '0', globalName: null, displayAvatarURL: () => 'https://cdn.example/a.png' },
    member: { displayName: 'Dave', displayAvatarURL: () => 'https://cdn.example/m.png' },
    content: '',
    attachments: new Collection(),
    stickers: new Collection([['st-1', { id: 'st-1', name: 'wave', format: 1 }]]),
    embeds: [],
    mentions: { users: new Collection(), roles: new Collection(), channels: new Collection(), repliedUser: null },
    reference: null,
    messageSnapshots: new Collection(),
    flags: { has: () => false },
    guild: null,
    ...over,
  }
}

const hasSticker = (parts: any) => parts.some((p: any) => p.type === 'sticker')
const IMAGE = { type: 'file', url: 'https://media.discordapp.net/stickers/st-1.png', fileName: 'wave.png', fileType: 'image' }

describe('Discord stickers synced to Harmony', () => {
  it('sends a linked sticker as a native sticker part', async () => {
    const { rt, h } = await setup()
    await rt.onDiscordMessage(discordMessage())
    expect(h.sendMessage.mock.calls[0][1]).toEqual([
      { type: 'sticker', id: 'hs-1', url: STICKER_URL, name: 'Wave', description: 'a waving hand' },
      { type: 'file', fileType: 'image', stickerId: 'hs-1', url: STICKER_URL, fileName: 'Wave.png', altText: 'a waving hand' },
    ])
  })

  it('a refused sticker part is resent as the image and the link is dropped', async () => {
    const { rt, h } = await setup()
    h.sendMessage.mockRejectedValueOnce(refused())
    await rt.onDiscordMessage(discordMessage())
    expect(h.sendMessage).toHaveBeenCalledTimes(2)
    expect(hasSticker(h.sendMessage.mock.calls[0][1])).toBe(true)
    expect(h.sendMessage.mock.calls[1][1]).toEqual([IMAGE])
    expect(rt.stickerLinks.harmonyFor('s', 'st-1')).toBeNull()
    expect(rt.discordToHarmonyMessages.get('dm-1')).toBe('hm-new')
  })

  it('a new message with a retired sticker link is sent as the image', async () => {
    const { rt, h } = await setup()
    rt.stickerLinks.replace('s', [row({ removed: true })])
    await rt.onDiscordMessage(discordMessage())
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(hasSticker(h.sendMessage.mock.calls[0][1])).toBe(false)
    expect(h.sendMessage.mock.calls[0][1]).toContainEqual(IMAGE)
  })

  it('an edit of a message whose sticker was retired keeps the native part', async () => {
    const { rt, h } = await setup()
    rt.stickerLinks.replace('s', [row({ removed: true })])
    rt.discordToHarmonyMessages.set('dm-1', 'hm-1')
    await rt.onDiscordMessageUpdate(discordMessage({ content: 'edited' }))
    expect(h.editMessage).toHaveBeenCalledTimes(1)
    expect(hasSticker(h.editMessage.mock.calls[0][1])).toBe(true)
  })

  it('an edit that is refused falls back the same way', async () => {
    const { rt, h } = await setup()
    rt.discordToHarmonyMessages.set('dm-1', 'hm-1')
    h.editMessage.mockRejectedValueOnce(refused())
    await rt.onDiscordMessageUpdate(discordMessage({ content: 'edited' }))
    expect(h.editMessage).toHaveBeenCalledTimes(2)
    expect(hasSticker(h.editMessage.mock.calls[0][1])).toBe(true)
    expect(hasSticker(h.editMessage.mock.calls[1][1])).toBe(false)
    expect(h.editMessage.mock.calls[1][1]).toContainEqual(IMAGE)
    expect(rt.stickerLinks.harmonyFor('s', 'st-1')).toBeNull()
  })

  it('a refused edit keeps a retired link: later edits of messages that hold the sticker stay native', async () => {
    const { rt, h } = await setup()
    rt.stickerLinks.replace('s', [row({ removed: true })])
    rt.discordToHarmonyMessages.set('dm-1', 'hm-1')
    h.editMessage.mockRejectedValueOnce(refused())
    await rt.onDiscordMessageUpdate(discordMessage({ content: 'edited' }))
    expect(h.editMessage).toHaveBeenCalledTimes(2)
    expect(hasSticker(h.editMessage.mock.calls[1][1])).toBe(false)
    expect(rt.stickerLinks.harmonyFor('s', 'st-1')).toMatchObject({ id: 'hs-1', removed: true })

    await rt.onDiscordMessageUpdate(discordMessage({ content: 'edited again' }))
    expect(hasSticker(h.editMessage.mock.calls[2][1])).toBe(true)
  })

  it('with two stickers, drops the link of the one Harmony refused and resends both as images', async () => {
    const { rt, h } = await setup()
    rt.stickerLinks.replace('s', [
      row({ id: 'hs-a', discord_sticker_id: 'st-a', removed: true }),
      row({ id: 'hs-b', discord_sticker_id: 'st-b' }),
    ])
    h.sendMessage.mockRejectedValueOnce(refused())
    await rt.onDiscordMessage(discordMessage({
      stickers: new Collection([
        ['st-a', { id: 'st-a', name: 'first', format: 1 }],
        ['st-b', { id: 'st-b', name: 'second', format: 1 }],
      ]),
    }))
    expect(h.sendMessage).toHaveBeenCalledTimes(2)
    expect((h.sendMessage.mock.calls[0][1] as any[]).find(p => p.type === 'sticker').id).toBe('hs-b')
    expect(hasSticker(h.sendMessage.mock.calls[1][1])).toBe(false)
    expect((h.sendMessage.mock.calls[1][1] as any[]).map(p => p.fileName)).toEqual(['first.png', 'second.png'])
    expect(rt.stickerLinks.harmonyFor('s', 'st-a')).not.toBeNull()
    expect(rt.stickerLinks.harmonyFor('s', 'st-b')).toBeNull()
    expect(rt.discordToHarmonyMessages.get('dm-1')).toBe('hm-new')
  })

  it('translates a message once when Harmony accepts it', async () => {
    const { rt, h } = await setup()
    const translate = vi.spyOn(rt.translator, 'discordToHarmonyParts')
    await rt.onDiscordMessage(discordMessage())
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(translate).toHaveBeenCalledTimes(1)
  })

  it('other send errors are not retried', async () => {
    const { rt, h } = await setup()
    h.sendMessage.mockRejectedValue(new HarmonyHttpError('boom', 500))
    await rt.onDiscordMessage(discordMessage())
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(rt.stickerLinks.harmonyFor('s', 'st-1')).not.toBeNull()
  })

  it('other 422 codes are not retried', async () => {
    const { rt, h } = await setup()
    h.sendMessage.mockRejectedValue(new HarmonyHttpError('nope', 422, 'SOMETHING_ELSE'))
    await rt.onDiscordMessage(discordMessage())
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(rt.stickerLinks.harmonyFor('s', 'st-1')).not.toBeNull()
  })

  it("stickers from another bridged server's links are not used", async () => {
    const { rt, h } = await setup()
    rt.stickerLinks.replace('s', [])
    rt.stickerLinks.replace('s2', [row()])
    await rt.onDiscordMessage(discordMessage())
    expect(h.sendMessage.mock.calls[0][1]).toEqual([IMAGE])
  })
})
