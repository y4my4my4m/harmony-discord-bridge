import { describe, expect, it, vi } from 'vitest'
import { ServerStickerLinks } from '../src/runtime/serverStickerLinks.js'
import { SERVER_EMOJI_LINKS_TTL_MS } from '../src/runtime/serverEmojiLinks.js'

const row = (id: string, discord: string | null, removed = false) => ({
  id, name: `s${id}`, description: `d${id}`, url: `https://x/${id}.png`, discord_sticker_id: discord, removed,
})

describe('ServerStickerLinks', () => {
  it('keeps retired linked rows', async () => {
    const links = new ServerStickerLinks(async () => [row('h1', '111', true)])
    await links.ensure('s')
    expect(links.harmonyFor('s', '111')).toEqual({
      id: 'h1', name: 'sh1', description: 'dh1', url: 'https://x/h1.png', removed: true,
    })
  })

  it('ignores unlinked rows', async () => {
    const links = new ServerStickerLinks(async () => [row('h1', null), row('h2', '222')])
    await links.ensure('s')
    expect(links.harmonyFor('s', 'h1')).toBeNull()
    expect(links.harmonyFor('s', '222')?.id).toBe('h2')
  })

  it('drop removes one link', async () => {
    const links = new ServerStickerLinks(async () => [row('h1', '111'), row('h2', '222')])
    await links.ensure('s')
    links.drop('s', '111')
    expect(links.harmonyFor('s', '111')).toBeNull()
    expect(links.harmonyFor('s', '222')?.id).toBe('h2')
  })

  it('a failed load keeps the old links', async () => {
    let now = 0
    const fetchRows = vi.fn()
      .mockResolvedValueOnce([row('h1', '111')])
      .mockRejectedValueOnce(new Error('404'))
    const links = new ServerStickerLinks(fetchRows, () => now)
    await links.ensure('s')
    now = SERVER_EMOJI_LINKS_TTL_MS
    await links.ensure('s')
    expect(links.harmonyFor('s', '111')?.id).toBe('h1')

    const old = new ServerStickerLinks(async () => { throw new Error('404') })
    await old.ensure('t')
    expect(old.harmonyFor('t', '111')).toBeNull()
  })

  it('reloads after the TTL', async () => {
    let now = 0
    const fetchRows = vi.fn(async () => [row('h1', '111')])
    const links = new ServerStickerLinks(fetchRows, () => now)
    await Promise.all([links.ensure('s'), links.ensure('s')])
    expect(fetchRows).toHaveBeenCalledTimes(1)
    now = SERVER_EMOJI_LINKS_TTL_MS - 1
    await links.ensure('s')
    expect(fetchRows).toHaveBeenCalledTimes(1)
    now = SERVER_EMOJI_LINKS_TTL_MS
    await links.ensure('s')
    expect(fetchRows).toHaveBeenCalledTimes(2)
  })
})
