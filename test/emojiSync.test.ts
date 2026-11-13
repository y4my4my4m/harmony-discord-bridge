import { describe, expect, it, vi } from 'vitest'
import { byDiscordId, desiredEmoji, emojiDiffers, harmonyEmojiSyncItem } from '../src/runtime/emojiSync.js'
import { HarmonyClient, HarmonyHttpError } from '../src/HarmonyClient.js'
import { silentLogger } from '../src/log.js'

describe('emojiSync mapping', () => {
  it('desiredEmoji sanitizes names and drops empty ones', () => {
    expect(desiredEmoji({ id: '1', name: 'a-b', animated: false, available: true })).toEqual({ id: '1', name: 'a_b', animated: false })
    const long = desiredEmoji({ id: '2', name: 'x'.repeat(40), animated: true, available: true })
    expect(long?.name).toBe('x'.repeat(32))
    expect(desiredEmoji({ id: '3', name: null, animated: false, available: true })).toBeNull()
    expect(desiredEmoji({ id: '4', name: '', animated: false, available: true })).toBeNull()
  })

  it('emojiDiffers is case-sensitive', () => {
    const d = { id: '1', name: 'Foo', animated: false }
    expect(emojiDiffers(d, { name: 'Foo' })).toBe(false)
    expect(emojiDiffers(d, { name: 'foo' })).toBe(true)
  })

  it('byDiscordId sorts 19-digit snowflakes numerically', () => {
    const ids = [{ id: '1234567890123456790' }, { id: '999999999999999999' }, { id: '1234567890123456789' }]
    expect(ids.sort(byDiscordId).map((x) => x.id)).toEqual(['999999999999999999', '1234567890123456789', '1234567890123456790'])
  })

  it('harmonyEmojiSyncItem maps fields', () => {
    expect(harmonyEmojiSyncItem({ id: 'h', name: 'n', url: null, discord_emoji_id: 'd', removed: true, imported: true, restorable: true }))
      .toEqual({ id: 'h', name: 'n', discordId: 'd', removed: true, removable: true, restorable: true })
  })

  it('harmonyEmojiSyncItem: a member emoji linked by name is not removable', () => {
    const item = harmonyEmojiSyncItem({ id: 'h', name: 'n', url: null, discord_emoji_id: 'd', removed: false, imported: false, restorable: false })
    expect(item.removable).toBe(false)
  })

  it('harmonyEmojiSyncItem without the gateway flags: a link stands in for imported, nothing is restorable', () => {
    const linked = harmonyEmojiSyncItem({ id: 'h', name: 'n', url: null, discord_emoji_id: 'd', removed: true })
    expect(linked.removable).toBe(true)
    expect(linked.restorable).toBe(false)
    expect(harmonyEmojiSyncItem({ id: 'h', name: 'n', url: null, discord_emoji_id: null, removed: false }).removable).toBe(false)
  })
})

describe('HarmonyClient emoji sync', () => {
  function client(respond: () => Response) {
    const fetchImpl = vi.fn(async (_url: any, _init?: any) => respond())
    const c = new HarmonyClient('tok', 'ws://unused', 'https://har.example/bot-gateway', {
      log: silentLogger,
      fetchImpl: fetchImpl as any,
      retry: { sleep: async () => {} },
    })
    return { c, fetchImpl }
  }

  it('getEmojiSyncState refuses a body without the list or the limit', async () => {
    for (const body of [{ limit: 50, rows: [] }, { emojis: [] }, []]) {
      const { c } = client(() => Response.json(body))
      await expect(c.getEmojiSyncState('s1')).rejects.toMatchObject({ code: 'LIST_MALFORMED' })
    }
  })

  it('getEmojiSyncState carries the code of a list too large to answer whole', async () => {
    const { c } = client(() => Response.json({ error: 'more than 10000 emoji rows', code: 'LIST_TOO_LARGE' }, { status: 500 }))
    await expect(c.getEmojiSyncState('s1')).rejects.toMatchObject({ status: 500, code: 'LIST_TOO_LARGE' })
  })

  it('getEmojiSyncState GETs the discord emoji list', async () => {
    const { c, fetchImpl } = client(() => Response.json({ limit: 50, emojis: [] }))
    expect(await c.getEmojiSyncState('s1')).toEqual({ limit: 50, emojis: [] })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://har.example/bot-gateway/api/v1/servers/s1/emojis/discord')
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('importDiscordEmoji omits update unless true', async () => {
    const { c, fetchImpl } = client(() => Response.json({ id: 'e', status: 'created' }, { status: 201 }))
    const emoji = { discordEmojiId: 'd1', name: 'foo', animated: true }
    await c.importDiscordEmoji('s1', emoji)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://har.example/bot-gateway/api/v1/servers/s1/emojis/discord')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ discord_emoji_id: 'd1', name: 'foo', animated: true })
    expect('update' in JSON.parse(init.body)).toBe(false)
    await c.importDiscordEmoji('s1', emoji, true)
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ discord_emoji_id: 'd1', name: 'foo', animated: true, update: true })
  })

  it('removeServerEmoji DELETEs the emoji', async () => {
    const { c, fetchImpl } = client(() => new Response(null, { status: 204 }))
    await c.removeServerEmoji('s1', 'e1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://har.example/bot-gateway/api/v1/servers/s1/emojis/e1')
    expect(init.method).toBe('DELETE')
  })

  it('a 409 surfaces as HarmonyHttpError with code', async () => {
    const { c } = client(() => Response.json({ error: 'full', code: 'EMOJI_LIMIT' }, { status: 409 }))
    const err = await c.importDiscordEmoji('s1', { discordEmojiId: 'd', name: 'n', animated: false }).catch((e) => e)
    expect(err).toBeInstanceOf(HarmonyHttpError)
    expect(err.code).toBe('EMOJI_LIMIT')
    expect(err.status).toBe(409)
  })
})
