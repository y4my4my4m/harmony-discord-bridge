import { describe, expect, it } from 'vitest'
import { MessageTranslator, joinDiscordSegments } from '../src/MessageTranslator.js'
import { splitDiscordContent } from '../src/utils/discordMessage.js'
import { silentLogger } from '../src/log.js'

function translator() {
  const t = new MessageTranslator(silentLogger)
  t.setHarmonyDomain('har.mony.lol')
  return t
}

describe('MessageTranslator.harmonyToDiscord', () => {
  it('keeps mentions inline with the surrounding text', () => {
    const out = translator().harmonyToDiscord({
      content_raw: [
        { type: 'text', text: 'hey ' },
        { type: 'mention', userId: '123456789012345678', username: 'bob', domain: 'discord.com' },
        { type: 'text', text: ' how are you, ' },
        { type: 'mention', userId: 'u-1', username: 'alice', domain: 'har.mony.lol' },
        { type: 'text', text: '?' },
      ],
    })
    expect(out).toBe('hey <@123456789012345678> how are you, @alice@har.mony.lol?')
    expect(out).not.toContain('\n')
  })

  it('resolves Harmony mentions through the Discord member cache', () => {
    const cache = new Map([['carol', '222']])
    const out = translator().harmonyToDiscord({
      content_raw: [
        { type: 'text', text: 'ping ' },
        { type: 'mention', userId: 'u-2', username: 'Carol', domain: 'har.mony.lol' },
        { type: 'text', text: ' now' },
      ],
    }, cache)
    expect(out).toBe('ping <@222> now')
  })

  it('keeps a "Something: text" first line', () => {
    const t = translator()
    expect(t.harmonyToDiscord({ content_raw: [{ type: 'text', text: 'Note: meeting at 5' }] })).toBe('Note: meeting at 5')
    expect(t.harmonyToDiscord({ content: 'Note: meeting at 5' })).toBe('Note: meeting at 5')
    expect(t.harmonyToDiscord({ content_raw: [{ type: 'text', text: 'TODO: a\nb: c' }] })).toBe('TODO: a\nb: c')
  })

  it('does not truncate long content', () => {
    const text = 'word '.repeat(1000).trim()
    const out = translator().harmonyToDiscord({ content_raw: [{ type: 'text', text }] })
    expect(out).toBe(text)
    expect(out.length).toBeGreaterThan(2000)
  })

  it('puts attachments on their own lines and separates glued URLs', () => {
    const out = translator().harmonyToDiscord({
      content_raw: [
        { type: 'text', text: 'look' },
        { type: 'file', url: 'https://cdn.example/a.png' },
        { type: 'file', url: 'https://cdn.example/b.png' },
        { type: 'url', url: 'https://x.example/page' },
        { type: 'url', url: 'https://y.example/' },
      ],
    })
    expect(out).toBe('look\nhttps://cdn.example/a.png\nhttps://cdn.example/b.png\nhttps://x.example/page https://y.example/')
  })

  it('joins url parts with prose without inventing spaces', () => {
    const out = translator().harmonyToDiscord({
      content_raw: [
        { type: 'text', text: 'see (' },
        { type: 'url', url: 'https://x.example' },
        { type: 'text', text: ') and ' },
        { type: 'url', url: 'https://y.example' },
        { type: 'text', text: ' ok' },
      ],
    })
    expect(out).toBe('see (https://x.example) and https://y.example ok')
  })

  it('renders bridged Discord emoji and hashtags inline', () => {
    const out = translator().harmonyToDiscord({
      content_raw: [
        { type: 'text', text: 'nice ' },
        { type: 'emoji', emoji: { name: 'pog', domain: 'discord.com', url: 'https://cdn.discordapp.com/emojis/42.gif' } },
        { type: 'text', text: ' ' },
        { type: 'hashtag', name: 'news' },
      ],
    })
    expect(out).toBe('nice <a:pog:42> #news')
  })
})

describe('joinDiscordSegments', () => {
  it('trims spaces around file boundaries', () => {
    expect(joinDiscordSegments([
      { kind: 'inline', text: 'pic: ' },
      { kind: 'file', text: 'https://a/b.png' },
      { kind: 'inline', text: ' after' },
    ])).toBe('pic:\nhttps://a/b.png\nafter')
  })
})

describe('splitDiscordContent', () => {
  it('returns short content unchanged', () => {
    expect(splitDiscordContent('hello')).toEqual(['hello'])
  })

  it('splits long content into chunks of at most 2000 characters, losing nothing', () => {
    const text = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ')
    const chunks = splitDiscordContent(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2000)
    expect(chunks.join(' ')).toBe(text)
  })

  it('prefers line breaks', () => {
    const a = 'a'.repeat(1500)
    const b = 'b'.repeat(1500)
    expect(splitDiscordContent(`${a}\n${b}`)).toEqual([a, b])
  })

  it('never cuts inside a mention', () => {
    const mention = '<@123456789012345678>'
    const text = 'x'.repeat(1990) + mention + 'y'.repeat(100)
    const chunks = splitDiscordContent(text)
    expect(chunks.some(c => c.includes(mention))).toBe(true)
    expect(chunks.join('')).toBe(text)
  })

  it('closes and reopens code fences across chunks', () => {
    const body = Array.from({ length: 300 }, (_, i) => `line ${i} ${'.'.repeat(5)}`).join('\n')
    const text = '```ts\n' + body + '\n```'
    const chunks = splitDiscordContent(text)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(2000)
      expect((c.match(/```/g) ?? []).length % 2).toBe(0)
    }
    expect(chunks[1].startsWith('```ts\n')).toBe(true)
  })

  it('hard-splits a single unbroken run', () => {
    const chunks = splitDiscordContent('z'.repeat(4500))
    expect(chunks.map(c => c.length)).toEqual([1996, 1996, 508])
  })
})
