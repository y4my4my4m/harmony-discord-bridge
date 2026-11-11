import { describe, expect, it, vi } from 'vitest'
import { desiredSticker, harmonyStickerSyncItem, isStickerSkip, stickerDiffers } from '../src/runtime/stickerSync.js'
import { HarmonyClient, HarmonyHttpError } from '../src/HarmonyClient.js'
import { silentLogger } from '../src/log.js'

const base = { id: '1', name: 'wave', description: 'hi', formatType: 1, available: true }

describe('stickerSync mapping', () => {
  it('desiredSticker strips control characters, trims, cuts names to 30 code points', () => {
    const d = desiredSticker({ ...base, name: '  wa\u0000v\u0007e\n ' })
    expect(d).toEqual({ id: '1', name: 'wave', description: 'hi', formatType: 1 })
    expect((desiredSticker({ ...base, name: 'a\u007fb\u0085c' }) as any).name).toBe('abc')
    const spaced = desiredSticker({ ...base, name: 'a'.repeat(29) + ' ' + 'x'.repeat(10) }) as any
    expect(spaced.name).toBe('a'.repeat(29))
    const long = desiredSticker({ ...base, name: '😀'.repeat(40) })
    expect(isStickerSkip(long)).toBe(false)
    expect(Array.from((long as any).name)).toHaveLength(30)
  })

  it('desiredSticker uses the name when the description is empty or null', () => {
    expect((desiredSticker({ ...base, description: null }) as any).description).toBe('wave')
    expect((desiredSticker({ ...base, description: '   ' }) as any).description).toBe('wave')
  })

  it('desiredSticker cuts a description to 300', () => {
    const d = desiredSticker({ ...base, description: ' ' + 'x'.repeat(400) + ' ' }) as any
    expect(d.description).toBe('x'.repeat(300))
  })

  it('desiredSticker skips Lottie and too-short names with a reason', () => {
    expect(desiredSticker({ ...base, formatType: 3 })).toEqual({ id: '1', name: 'wave', reason: 'lottie' })
    const s = desiredSticker({ ...base, name: ' a ' })
    expect(isStickerSkip(s)).toBe(true)
    expect(s).toMatchObject({ id: '1', reason: 'name' })
    expect(desiredSticker({ ...base, name: null })).toMatchObject({ reason: 'name' })
  })

  it('stickerDiffers sees name case and description changes', () => {
    const d = { id: '1', name: 'wave', description: 'hi', formatType: 1 }
    expect(stickerDiffers(d, { name: 'wave', description: 'hi' })).toBe(false)
    expect(stickerDiffers(d, { name: 'Wave', description: 'hi' })).toBe(true)
    expect(stickerDiffers(d, { name: 'wave', description: 'yo' })).toBe(true)
  })

  it('harmonyStickerSyncItem maps a row', () => {
    expect(harmonyStickerSyncItem({ id: 'h', name: 'n', description: '', url: 'u', discord_sticker_id: 'd', removed: true }))
      .toEqual({ id: 'h', name: 'n', description: '', discordId: 'd', removed: true })
  })
})

describe('HarmonyClient sticker sync', () => {
  function client(respond: () => Response) {
    const fetchImpl = vi.fn(async (_url: any, _init?: any) => respond())
    const c = new HarmonyClient('tok', 'ws://unused', 'https://har.example/bot-gateway', {
      log: silentLogger,
      fetchImpl: fetchImpl as any,
      retry: { sleep: async () => {} },
    })
    return { c, fetchImpl }
  }
  const d = { id: 'd1', name: 'wave', description: 'hi', formatType: 2 }

  it('getStickerSyncState GETs the discord sticker list', async () => {
    const { c, fetchImpl } = client(() => Response.json({ limit: 5, stickers: [] }))
    expect(await c.getStickerSyncState('s1')).toEqual({ limit: 5, stickers: [] })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://har.example/bot-gateway/api/v1/servers/s1/stickers/discord')
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('importDiscordSticker omits update unless true', async () => {
    const { c, fetchImpl } = client(() => Response.json({ id: 'x', status: 'created' }, { status: 201 }))
    await c.importDiscordSticker('s1', d)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://har.example/bot-gateway/api/v1/servers/s1/stickers/discord')
    expect(init.method).toBe('POST')
    const body = { discord_sticker_id: 'd1', name: 'wave', description: 'hi', format_type: 2 }
    expect(JSON.parse(init.body)).toEqual(body)
    expect('update' in JSON.parse(init.body)).toBe(false)
    await c.importDiscordSticker('s1', d, true)
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ ...body, update: true })
  })

  it('removeServerSticker DELETEs the sticker', async () => {
    const { c, fetchImpl } = client(() => new Response(null, { status: 204 }))
    await c.removeServerSticker('s1', 'st1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://har.example/bot-gateway/api/v1/servers/s1/stickers/st1')
    expect(init.method).toBe('DELETE')
  })

  it('a 422 surfaces as HarmonyHttpError with code and details.reason', async () => {
    const { c } = client(() => Response.json({ error: 'bad', code: 'STICKER_FILE', reason: 'size' }, { status: 422 }))
    const err = await c.importDiscordSticker('s1', d).catch((e) => e)
    expect(err).toBeInstanceOf(HarmonyHttpError)
    expect(err.status).toBe(422)
    expect(err.code).toBe('STICKER_FILE')
    expect(err.details.reason).toBe('size')
  })
})
