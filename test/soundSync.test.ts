import { describe, expect, it, vi } from 'vitest'
import { desiredSound, harmonySyncItem, soundDiffers, soundUpdate, type DiscordSoundInput } from '../src/runtime/soundSync.js'
import type { HarmonyServerSound } from '../src/HarmonyClient.js'
import { Logger } from '../src/log.js'

const base: DiscordSoundInput = { soundId: 's1', name: ' airhorn ', volume: 0.5, emojiId: null, emojiName: null, available: true }
const row = (o: Partial<HarmonyServerSound> = {}): HarmonyServerSound => ({
  id: 'h1', name: 'airhorn', emoji: null, emoji_id: null, volume: '0.50', discord_sound_id: 's1', ...o,
})

describe('desiredSound', () => {
  it('trims the name and rounds/clamps the volume', () => {
    expect(desiredSound({ ...base, volume: 0.3333 }, () => null)).toMatchObject({ id: 's1', name: 'airhorn', volume: 0.33 })
    expect(desiredSound({ ...base, volume: 1.4 }, () => null).volume).toBe(1)
    expect(desiredSound({ ...base, volume: -1 }, () => null).volume).toBe(0)
  })
  it('drops an unimported custom emoji instead of using its name', () => {
    const d = desiredSound({ ...base, emojiId: 'e1', emojiName: 'pepe' }, () => null)
    expect(d).toMatchObject({ emoji: null, emojiId: null, hadUnimportedEmoji: true })
  })
  it('maps a linked custom emoji to its Harmony id', () => {
    const d = desiredSound({ ...base, emojiId: 'e1', emojiName: 'pepe' }, (id) => (id === 'e1' ? 'h-e1' : null))
    expect(d).toMatchObject({ emoji: null, emojiId: 'h-e1', hadUnimportedEmoji: false })
  })
  it('passes a unicode emoji through', () => {
    expect(desiredSound({ ...base, emojiName: '🔊' }, () => null)).toMatchObject({ emoji: '🔊', emojiId: null, hadUnimportedEmoji: false })
  })
})

describe('harmonySyncItem / soundDiffers', () => {
  it('maps a row', () => {
    const r = row()
    expect(harmonySyncItem(r)).toEqual({ id: 'h1', name: 'airhorn', discordId: 's1', row: r })
  })
  it('treats 0.5 and "0.50" as the same volume', () => {
    const d = desiredSound(base, () => null)
    expect(soundDiffers(d, harmonySyncItem(row({ volume: '0.50' })))).toBe(false)
    expect(soundDiffers(d, harmonySyncItem(row({ volume: 0.5 })))).toBe(false)
    expect(soundDiffers(d, harmonySyncItem(row({ volume: '0.60' })))).toBe(true)
  })
  it('detects a name change, including case', () => {
    const d = desiredSound({ ...base, name: 'Airhorn' }, () => null)
    expect(soundDiffers(d, harmonySyncItem(row()))).toBe(true)
  })
  it('detects an emoji link appearing later', () => {
    const d = desiredSound({ ...base, emojiId: 'e1' }, () => 'h-e1')
    expect(soundDiffers(d, harmonySyncItem(row()))).toBe(true)
    expect(soundDiffers(d, harmonySyncItem(row({ emoji_id: 'h-e1' })))).toBe(false)
  })
  it('sees no difference in an emoji it cannot map, and keeps the row emoji in an update', () => {
    const d = desiredSound({ ...base, emojiId: 'e1', emojiName: 'pepe' }, () => null)
    const kept = row({ emoji_id: 'h-e9' })
    expect(soundDiffers(d, harmonySyncItem(kept))).toBe(false)
    expect(soundUpdate(d, kept)).toEqual({ id: 's1', name: 'airhorn', volume: 0.5, emoji: null, emojiId: 'h-e9' })
    expect(soundUpdate(d, row({ emoji: '🔊' }))).toMatchObject({ emoji: '🔊', emojiId: null })
    const mapped = desiredSound({ ...base, emojiId: 'e1' }, () => 'h-e1')
    expect(soundUpdate(mapped, kept)).toMatchObject({ emojiId: 'h-e1' })
  })
  it('detects a unicode emoji change', () => {
    const d = desiredSound({ ...base, emojiName: '🔊' }, () => null)
    expect(soundDiffers(d, harmonySyncItem(row()))).toBe(true)
    expect(soundDiffers(d, harmonySyncItem(row({ emoji: '🔊' })))).toBe(false)
  })
})

describe('HarmonyClient sounds', () => {
  const mk = (fetchImpl: any) => import('../src/HarmonyClient.js').then(({ HarmonyClient }) =>
    new HarmonyClient('t', 'ws://127.0.0.1:9/gateway', 'http://127.0.0.1:9', { fetchImpl, log: new Logger('error', '', true) }))

  it('importDiscordSound sends the exact body', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ status: 'created', ...row() }, { status: 201 }))
    const client = await mk(fetchImpl)
    const d = desiredSound({ ...base, emojiName: '🔊' }, () => null)
    const out = await client.importDiscordSound('srv', d, true)
    expect(out.status).toBe('created')
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toContain('/servers/srv/sounds/discord')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ discord_sound_id: 's1', name: 'airhorn', emoji: '🔊', emoji_id: null, volume: 0.5, update: true })
  })
  it('getServerSounds fetches the list', async () => {
    const fetchImpl = vi.fn(async () => Response.json([row()]))
    const client = await mk(fetchImpl)
    expect(await client.getServerSounds('srv')).toEqual([row()])
    expect((fetchImpl.mock.calls[0] as any)[0]).toContain('/servers/srv/sounds')
  })
  it('getServerSounds refuses a body that is not a list', async () => {
    const client = await mk(vi.fn(async () => Response.json({ sounds: [row()] })))
    await expect(client.getServerSounds('srv')).rejects.toMatchObject({ code: 'LIST_MALFORMED' })
  })
  it('deleteServerSound accepts 204 and throws HarmonyHttpError otherwise', async () => {
    const { HarmonyHttpError } = await import('../src/HarmonyClient.js')
    const ok = await mk(vi.fn(async () => new Response(null, { status: 204 })))
    await expect(ok.deleteServerSound('srv', 'h1')).resolves.toBeUndefined()
    const bad = await mk(vi.fn(async () => Response.json({ error: 'nope' }, { status: 404 })))
    const err = await bad.deleteServerSound('srv', 'h1').catch(e => e)
    expect(err).toBeInstanceOf(HarmonyHttpError)
    expect(err.status).toBe(404)
  })
})
