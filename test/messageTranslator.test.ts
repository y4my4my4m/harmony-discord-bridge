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

  it('pings only explicit Discord mention parts, never a Harmony user by username', () => {
    const r = translator().renderHarmonyForDiscord({
      content_raw: [
        { type: 'text', text: 'ping ' },
        { type: 'mention', userId: 'u-2', username: 'Carol', domain: 'har.mony.lol' },
        { type: 'text', text: ' and ' },
        { type: 'mention', userId: '222', username: 'carol', domain: 'discord.com' },
        { type: 'mention', userId: '222', username: 'carol', domain: 'discord.com' },
        { type: 'mention', userId: 'not-a-snowflake', username: 'x', domain: 'discord.com' },
      ],
    })
    expect(r.content).toBe('ping @Carol@har.mony.lol and <@222><@222>@x@discord.com')
    expect(r.mentionUserIds).toEqual(['222'])
  })

  it('caps allowed mention users at 100', () => {
    const content_raw = Array.from({ length: 120 }, (_, i) => ({ type: 'mention', userId: String(1000 + i), username: `u${i}`, domain: 'discord.com' }))
    expect(translator().renderHarmonyForDiscord({ content_raw }).mentionUserIds).toHaveLength(100)
  })

  it('maps role and channel mentions to Discord, else plain names', () => {
    const ctx = {
      discordRoleFor: (id: string) => (id === 'hr-mod' ? '555' : undefined),
      discordChannelFor: (id: string) => (id === 'hc-general' ? '777' : null),
    }
    const out = translator().harmonyToDiscord({
      content_raw: [
        { type: 'role_mention', roleId: 'hr-mod', roleName: 'Mods', roleColor: null },
        { type: 'text', text: ' ' },
        { type: 'role_mention', roleId: 'hr-other', roleName: 'Artists', roleColor: null },
        { type: 'text', text: ' see ' },
        { type: 'channel_mention', channelId: 'hc-general', serverId: 's', name: 'general' },
        { type: 'text', text: ' or ' },
        { type: 'channel_mention', channelId: 'hc-x', serverId: 's', name: 'random' },
      ],
    }, ctx)
    expect(out).toBe('<@&555> @Artists see <#777> or #random')
  })

  it('suppresses embeds only when every link asked for no preview', () => {
    const t = translator()
    const quiet = t.renderHarmonyForDiscord({ content_raw: [{ type: 'text', text: 'see ' }, { type: 'url', url: 'https://x.example', preview: false }] })
    expect(quiet).toMatchObject({ content: 'see <https://x.example>', suppressEmbeds: true })
    const mixed = t.renderHarmonyForDiscord({ content_raw: [
      { type: 'url', url: 'https://x.example', preview: false },
      { type: 'text', text: ' and ' },
      { type: 'url', url: 'https://y.example', preview: true },
    ] })
    expect(mixed).toMatchObject({ content: '<https://x.example> and https://y.example', suppressEmbeds: false })
    expect(t.renderHarmonyForDiscord({ content_raw: [{ type: 'text', text: 'plain' }] }).suppressEmbeds).toBe(false)
  })

  it('renders Harmony custom emoji as application emoji when mapped, else :name:', () => {
    const apps: Record<string, { id: string; name: string; animated: boolean }> = {
      'e-1': { id: '901', name: 'party_abc123', animated: true },
    }
    const out = translator().harmonyToDiscord({
      content_raw: [
        { type: 'emoji', emoji: { id: 'e-1', name: 'party', url: 'https://h.example/e1.gif' } },
        { type: 'emoji', emoji: { id: 'e-2', name: 'blob', url: 'https://h.example/e2.png' } },
      ],
    }, { appEmojiFor: (e: any) => apps[e.id] ?? null })
    expect(out).toBe('<a:party_abc123:901>:blob:')
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

  it('renders files as masked links without a preview, never the bare signed URL', () => {
    const signed = 'https://h.example/storage/v1/object/sign/message_media/c/ch/u/a.png?token=abc.def'
    const out = translator().harmonyToDiscord({
      content_raw: [
        { type: 'text', text: 'look' },
        { type: 'file', url: signed, path: 'c/ch/u/a.png', fileName: 'holiday [1].png', fileSize: 44_040_192, fileType: 'image' },
        { type: 'file', url: 'https://cdn.example/b.pdf' },
        { type: 'url', url: 'https://x.example/page' },
        { type: 'url', url: 'https://y.example/' },
      ],
    })
    expect(out).toBe(`look\n[holiday \\[1\\].png · 42 MB](<${signed}>)\n[b.pdf](<https://cdn.example/b.pdf>)\nhttps://x.example/page https://y.example/`)
    expect(out).not.toMatch(/(^|\s)https:\/\/h\.example/)
  })

  it('sends GIF picker media as its bare URL so Discord embeds it', () => {
    const gif = 'https://static.klipy.com/ii/4493325008d34b7bf8cd6813cd5c1619/79/09/1SmrWHK2pCmD.gif'
    const only = translator().renderHarmonyForDiscord({
      content_raw: [{ type: 'file', url: `${gif}#harmony-klipy=item=https%3A%2F%2Fklipy.com%2Fgifs%2Fkangaroo-kick-3--klLjSIr5C`, fileType: 'image' }],
    })
    expect(only.content).toBe(gif)
    expect(only.suppressEmbeds).toBe(false)

    const clip = 'https://static.klipy.com/ii/abc/clip.mp4'
    const mixed = translator().renderHarmonyForDiscord({
      content_raw: [
        { type: 'text', text: 'lol' },
        { type: 'file', url: `${clip}#harmony-klipy=kind=clip`, fileType: 'video' },
        { type: 'url', url: 'https://x.example/page', preview: false },
      ],
    })
    expect(mixed.content).toBe(`lol\n${clip}\n<https://x.example/page>`)
    expect(mixed.suppressEmbeds).toBe(false)
  })

  it('keeps storage, private-host and non-media files as masked links', () => {
    const out = translator().harmonyToDiscord({
      content_raw: [
        { type: 'file', url: 'https://h.example/storage/v1/object/public/emojis/a.gif', fileType: 'image' },
        { type: 'file', url: 'https://cdn.example/x.gif', path: 'c/1/u/x.gif', fileType: 'image' },
        { type: 'file', url: 'http://cdn.example/plain.gif', fileType: 'image' },
        { type: 'file', url: 'https://media.local/a.gif', fileType: 'image' },
        { type: 'file', url: 'https://cdn.example/notes.gif', fileType: 'file' },
      ],
    })
    expect(out).toBe([
      '[a.gif](<https://h.example/storage/v1/object/public/emojis/a.gif>)',
      '[x.gif](<https://cdn.example/x.gif>)',
      '[plain.gif](<http://cdn.example/plain.gif>)',
      '[a.gif](<https://media.local/a.gif>)',
      '[notes.gif](<https://cdn.example/notes.gif>)',
    ].join('\n'))
  })

  it('leaves uploaded files out of the text and keeps the caption', () => {
    const out = translator().renderHarmonyForDiscord({
      content_raw: [
        { type: 'text', text: 'my cat' },
        { type: 'file', url: 'https://h.example/storage/v1/object/sign/message_media/c/1/u/cat.jpg?token=t2', path: 'c/1/u/cat.jpg', fileType: 'image' },
        { type: 'file', url: 'https://h.example/storage/v1/object/sign/message_media/c/1/u/big.mp4?token=t3', path: 'c/1/u/big.mp4', fileName: 'big.mp4', fileType: 'video' },
      ],
    }, { uploadedFiles: new Set(['c/1/u/cat.jpg']) })
    expect(out.content).toBe('my cat\n[big.mp4](<https://h.example/storage/v1/object/sign/message_media/c/1/u/big.mp4?token=t3>)')
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

function discordMessage(over: Record<string, unknown> = {}) {
  return {
    id: 'dm-1',
    channelId: 'dc-1',
    content: '',
    mentions: { users: new Map(), roles: new Map(), channels: new Map() },
    guild: { members: { cache: new Map() }, roles: { cache: new Map() }, channels: { cache: new Map() } },
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    flags: { has: () => false },
    reference: null,
    messageSnapshots: new Map(),
    ...over,
  }
}

describe('MessageTranslator embed links', () => {
  const ctx = { harmonyRoleFor: () => undefined, harmonyChannelFor: () => null }
  const urls = (parts: any[]) => parts.filter(p => p.type === 'url').map(p => p.url)

  it('does not repeat a youtu.be link under its resolved youtube.com URL', () => {
    const msg = discordMessage({
      content: 'https://youtu.be/e0G58LWVWNA',
      embeds: [{ type: 'video', url: 'https://www.youtube.com/watch?v=e0G58LWVWNA' }],
    })
    expect(urls(translator().discordToHarmonyParts(msg, ctx))).toEqual(['https://youtu.be/e0G58LWVWNA'])
  })

  it('does not repeat a shortened link Discord resolved', () => {
    const msg = discordMessage({
      content: 'look https://bit.ly/abc',
      embeds: [{ type: 'article', url: 'https://news.example/story/1' }],
    })
    expect(urls(translator().discordToHarmonyParts(msg, ctx))).toEqual(['https://bit.ly/abc'])
  })

  it('keeps two different YouTube videos apart', () => {
    const msg = discordMessage({
      content: 'https://www.youtube.com/watch?v=aaa https://www.youtube.com/watch?v=bbb',
      embeds: [
        { type: 'video', url: 'https://www.youtube.com/watch?v=aaa' },
        { type: 'video', url: 'https://www.youtube.com/watch?v=bbb' },
      ],
    })
    expect(urls(translator().discordToHarmonyParts(msg, ctx))).toEqual([
      'https://www.youtube.com/watch?v=aaa',
      'https://www.youtube.com/watch?v=bbb',
    ])
  })

  it('adds the link of a rich embed and of an embed on a message without links', () => {
    const rich = discordMessage({
      content: 'see https://a.example',
      embeds: [{ type: 'rich', url: 'https://b.example/report' }],
    })
    expect(urls(translator().discordToHarmonyParts(rich, ctx))).toEqual(['https://a.example', 'https://b.example/report'])
    const bare = discordMessage({ content: 'build finished', embeds: [{ type: 'rich', url: 'https://ci.example/1' }] })
    expect(urls(translator().discordToHarmonyParts(bare, ctx))).toEqual(['https://ci.example/1'])
  })
})

describe('MessageTranslator.discordToHarmonyParts', () => {
  const ctx = {
    harmonyRoleFor: (id: string) => (id === '555' ? 'hr-mod' : undefined),
    harmonyChannelFor: (id: string) => (id === '777' ? { id: 'hc-general', serverId: 's-1', name: 'general' } : null),
  }

  it('turns mapped role and paired channel mentions into Harmony parts, others into plain names', () => {
    const msg = discordMessage({
      content: '<@&555> <@&556> in <#777> and <#778>',
      mentions: {
        users: new Map(),
        roles: new Map([['555', { name: 'Mods', hexColor: '#ff0000' }], ['556', { name: 'Artists', hexColor: '#000000' }]]),
        channels: new Map([['777', { name: 'general-dc' }], ['778', { name: 'offtopic' }]]),
      },
    })
    expect(translator().discordToHarmonyParts(msg, ctx)).toEqual([
      { type: 'role_mention', roleId: 'hr-mod', roleName: 'Mods', roleColor: '#ff0000' },
      { type: 'text', text: ' ' },
      { type: 'text', text: '@Artists' },
      { type: 'text', text: ' in ' },
      { type: 'channel_mention', channelId: 'hc-general', serverId: 's-1', name: 'general' },
      { type: 'text', text: ' and ' },
      { type: 'text', text: '#offtopic' },
    ])
  })

  it('keeps a mapped role as text when Discord did not ping it', () => {
    const msg = discordMessage({
      content: '<@&555>',
      guild: { members: { cache: new Map() }, roles: { cache: new Map([['555', { name: 'Mods', hexColor: '#ff0000' }]]) }, channels: { cache: new Map() } },
    })
    expect(translator().discordToHarmonyParts(msg, ctx)).toEqual([{ type: 'text', text: '@Mods' }])
  })

  it('treats @word as a mention only at a word boundary, never inside an email or URL', () => {
    const t = translator()
    t.setHarmonyMemberLookup((username) => (username === 'bob' ? { id: 'h-bob', username: 'bob', displayName: 'Bob', domain: null, isLocal: true } : null))
    const parts = t.discordToHarmonyParts(discordMessage({ content: 'mail bob@example.com or (@bob), @alice@mastodon.social, @everyone' }))
    const mentions = parts.filter((p: any) => p.type === 'mention')
    expect(mentions.map((m: any) => [m.username, m.domain])).toEqual([['bob', 'har.mony.lol'], ['alice', 'mastodon.social']])
    expect(parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')).toContain('mail bob@example.com or (')
    expect(parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')).toContain('@everyone')

    const url = t.discordToHarmonyParts(discordMessage({ content: 'see https://mastodon.social/@bob/123' }))
    expect(url.some((p: any) => p.type === 'mention')).toBe(false)
  })

  it('marks voice messages and audio attachments as audio', () => {
    const voice = translator().discordToHarmonyParts(discordMessage({
      flags: { has: (bit: number) => bit === 1 << 13 },
      attachments: new Map([['a1', { id: 'a1', name: 'voice-message.ogg', contentType: 'audio/ogg', url: 'https://cdn.discordapp.com/v.ogg', size: 5000 }]]),
    }))
    expect(voice).toEqual([expect.objectContaining({ type: 'file', fileType: 'audio', fileSize: 5000, fileName: 'voice-message.ogg' })])

    const mp3 = translator().discordToHarmonyParts(discordMessage({
      attachments: new Map([['a2', { id: 'a2', name: 'song.mp3', contentType: null, url: 'https://cdn.discordapp.com/song.mp3' }]]),
    }))
    expect(mp3[0]).toMatchObject({ type: 'file', fileType: 'audio' })
  })

  it('bridges image stickers as files and Lottie stickers as text', () => {
    const parts = translator().discordToHarmonyParts(discordMessage({
      content: 'hi',
      stickers: new Map([
        ['s1', { id: 's1', name: 'wave', format: 1 }],
        ['s2', { id: 's2', name: 'dance', format: 4 }],
        ['s3', { id: 's3', name: 'lottie', format: 3 }],
      ]),
    }))
    expect(parts).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'file', url: 'https://media.discordapp.net/stickers/s1.png', fileName: 'wave.png', fileType: 'image' },
      { type: 'file', url: 'https://media.discordapp.net/stickers/s2.gif', fileName: 'dance.gif', fileType: 'image' },
      { type: 'text', text: '\n[sticker: lottie]' },
    ])
  })

  it('bridges a forward as an italic header, the snapshot text and its attachments', () => {
    const snapshot = discordMessage({
      id: 'orig-1',
      content: 'look at this',
      attachments: new Map([['a1', { id: 'a1', name: 'pic.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/pic.png' }]]),
    })
    const parts = translator().discordToHarmonyParts(discordMessage({
      reference: { type: 1, messageId: 'orig-1', channelId: 'other' },
      messageSnapshots: new Map([['orig-1', snapshot]]),
    }))
    expect(parts[0]).toEqual({ type: 'text', text: '*↪ Forwarded*\n' })
    expect(parts[1]).toEqual({ type: 'text', text: 'look at this' })
    expect(parts[2]).toMatchObject({ type: 'file', fileType: 'image', bridgeRef: { discordMessageId: 'dm-1', discordChannelId: 'dc-1' } })
  })

  it('keeps a reply reference out of the forward path', () => {
    const parts = translator().discordToHarmonyParts(discordMessage({ content: 'yes', reference: { type: 0, messageId: 'x' } }))
    expect(parts).toEqual([{ type: 'text', text: 'yes' }])
  })
})

describe('imported Discord emoji', () => {
  const row = { id: 'he-1', name: 'catjam', url: 'https://db.test/emojis/s/discord/111.gif' }

  it('maps a Discord emoji token to the Harmony server emoji imported from it', () => {
    const parts = translator().discordToHarmonyParts(discordMessage({ content: 'hi <a:catjam:111> <:other:222>' }), {
      harmonyEmojiFor: id => (id === '111' ? row : null),
    })
    expect(parts[1]).toEqual({
      type: 'emoji',
      emoji: { id: 'he-1', name: 'catjam', url: row.url, domain: null, display_name: 'catjam' },
    })
    expect(parts[3]).toMatchObject({ type: 'emoji', emoji: { id: null, domain: 'discord.com', name: 'other' } })
  })

  it('renders an imported Harmony emoji as its Discord emoji, not an application emoji', () => {
    const out = translator().renderHarmonyForDiscord(
      { content_raw: [{ type: 'emoji', emoji: { id: 'he-1', name: 'catjam', url: row.url } }] },
      {
        discordEmojiFor: e => (e.id === 'he-1' ? { id: '111', name: 'catjam', animated: true } : null),
        appEmojiFor: () => ({ id: '999', name: 'app', animated: false }),
      },
    )
    expect(out.content).toBe('<a:catjam:111>')
  })
})

describe('@everyone and @here', () => {
  const HERE = { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null }
  const EVERYONE = { type: 'role_mention', roleId: 'hr-default', roleName: 'everyone', roleColor: null }
  const pinged = (content: string) => discordMessage({
    content,
    mentions: { users: new Map(), roles: new Map(), channels: new Map(), everyone: true },
  })

  describe('Discord → Harmony', () => {
    const ctx = { harmonyDefaultRoleId: 'hr-default' }

    it('makes a pinged @here and @everyone Harmony parts', () => {
      expect(translator().discordToHarmonyParts(pinged('@here standup, @everyone too'), ctx)).toEqual([
        HERE,
        { type: 'text', text: ' standup, ' },
        EVERYONE,
        { type: 'text', text: ' too' },
      ])
    })

    it('keeps them text from a Discord webhook, which pings without a permission', () => {
      const fromWebhook = { ...pinged('@here deploy done'), webhookId: '42' }
      expect(translator().discordToHarmonyParts(fromWebhook, ctx)).toEqual([{ type: 'text', text: '@here deploy done' }])
    })

    it('keeps them text when Discord pinged no one', () => {
      expect(translator().discordToHarmonyParts(discordMessage({ content: '@here and @everyone' }), ctx))
        .toEqual([{ type: 'text', text: '@here and @everyone' }])
    })

    it('keeps @everyone text without the Harmony default role, and words Discord does not ping', () => {
      const parts = translator().discordToHarmonyParts(pinged('@everyone @Here @here@example.com'), {})
      expect(parts.filter((p: any) => p.type === 'role_mention')).toEqual([])
      expect(parts.map((p: any) => p.text).join('')).toBe('@everyone @Here @here@example.com')
    })
  })

  describe('Harmony → Discord', () => {
    const ctx = { harmonyDefaultRoleId: 'hr-default' }
    const render = (content_raw: any[], mention_everyone?: boolean) =>
      translator().renderHarmonyForDiscord({ content_raw, mention_everyone }, ctx)

    it('writes the words without a ping when the gateway reports no right', () => {
      for (const flag of [undefined, false]) {
        expect(render([HERE, { type: 'text', text: ' and ' }, EVERYONE], flag))
          .toMatchObject({ content: '@here and @everyone', mentionEveryone: false })
      }
    })

    it('pings them when the Harmony author held the right', () => {
      expect(render([{ type: 'text', text: 'standup ' }, HERE], true))
        .toMatchObject({ content: 'standup @here', mentionEveryone: true })
      expect(render([EVERYONE], true)).toMatchObject({ content: '@everyone', mentionEveryone: true })
    })

    it('breaks every other @everyone and @here so that only the parts ping', () => {
      const r = render([
        HERE,
        { type: 'text', text: ' not @everyone, nor @' },
        { type: 'text', text: 'everyone, nor \u0000everyone ' },
        { type: 'mention', userId: 'u-1', username: 'here', domain: 'h.example' },
      ], true)
      expect(r.content).toBe('@here not @​everyone, nor @​everyone, nor everyone @​here@h.example')
      expect(r.content.match(/@(everyone|here)/g)).toEqual(['@here'])
    })

    it('reports no ping when no part pings, whatever the gateway says', () => {
      const r = translator().renderHarmonyForDiscord(
        { content_raw: [{ type: 'role_mention', roleId: 'hr-default', roleName: 'everyone' }, { type: 'text', text: ' @here' }], mention_everyone: true },
        {},
      )
      expect(r).toMatchObject({ content: '@everyone @here', mentionEveryone: false })
    })
  })
})
