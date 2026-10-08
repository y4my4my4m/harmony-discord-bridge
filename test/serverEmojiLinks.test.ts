import { describe, expect, it, vi } from 'vitest'
import { ServerEmojiLinks, SERVER_EMOJI_LINKS_TTL_MS } from '../src/runtime/serverEmojiLinks.js'

const row = (id: string, discord: string | null) => ({ id, name: `e${id}`, url: `https://x/${id}.png`, discord_emoji_id: discord })

describe('ServerEmojiLinks', () => {
  it('maps both ways, skips unlinked rows, and reloads only after the TTL', async () => {
    let now = 0
    const fetchRows = vi.fn(async () => [row('h1', '111'), row('h2', null)])
    const links = new ServerEmojiLinks(fetchRows, () => now)
    await Promise.all([links.ensure('s'), links.ensure('s')])
    expect(fetchRows).toHaveBeenCalledTimes(1)
    expect(links.harmonyFor('s', '111')?.id).toBe('h1')
    expect(links.discordFor('s', 'h1')).toBe('111')
    expect(links.discordFor('s', 'h2')).toBeNull()

    now = SERVER_EMOJI_LINKS_TTL_MS - 1
    await links.ensure('s')
    expect(fetchRows).toHaveBeenCalledTimes(1)
    now = SERVER_EMOJI_LINKS_TTL_MS
    await links.ensure('s')
    expect(fetchRows).toHaveBeenCalledTimes(2)
  })

  it('keeps old links when a reload fails, and treats an old Harmony as none', async () => {
    let now = 0
    const fetchRows = vi.fn()
      .mockResolvedValueOnce([row('h1', '111')])
      .mockRejectedValueOnce(new Error('404'))
    const links = new ServerEmojiLinks(fetchRows, () => now)
    await links.ensure('s')
    now = SERVER_EMOJI_LINKS_TTL_MS
    await links.ensure('s')
    expect(links.harmonyFor('s', '111')?.id).toBe('h1')

    const old = new ServerEmojiLinks(async () => { throw new Error('404') })
    await old.ensure('t')
    expect(old.harmonyFor('t', '111')).toBeNull()
  })

  it('records an import at once', () => {
    const links = new ServerEmojiLinks(async () => [])
    links.set('s', row('h9', '999'))
    expect(links.discordFor('s', 'h9')).toBe('999')
  })
})
