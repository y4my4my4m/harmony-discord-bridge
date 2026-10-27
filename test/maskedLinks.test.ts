import { describe, expect, it } from 'vitest'
import { MessageTranslator } from '../src/MessageTranslator.js'
import { silentLogger } from '../src/log.js'

function translator() {
  const t = new MessageTranslator(silentLogger)
  t.setHarmonyDomain('har.mony.lol')
  return t
}

function discordMessage(content: string): any {
  return {
    content,
    mentions: { users: new Map(), roles: new Map(), channels: new Map() },
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
  }
}

describe('masked links, Harmony → Discord', () => {
  it('sends a labelled url part as Discord markdown', () => {
    const out = translator().harmonyToDiscord({
      content_raw: [
        { type: 'text', text: 'read ' },
        { type: 'url', url: 'https://docs.example/guide', label: 'the guide' },
      ],
    })
    expect(out).toBe('read [the guide](https://docs.example/guide)')
  })

  it('keeps preview suppression inside the masked link', () => {
    const out = translator().harmonyToDiscord({
      content_raw: [{ type: 'url', url: 'https://x.example/page', label: 'page', preview: false }],
    })
    expect(out).toBe('[page](<https://x.example/page>)')
  })

  it('sends the bare URL when the label is itself a link, which Discord refuses', () => {
    const out = translator().harmonyToDiscord({
      content_raw: [{ type: 'url', url: 'https://evil.example', label: 'https://bank.example' }],
    })
    expect(out).toBe('https://evil.example')
  })

  it('drops brackets from a label so the markdown stays one link', () => {
    const out = translator().harmonyToDiscord({
      content_raw: [{ type: 'url', url: 'https://x.example', label: 'a [b] c' }],
    })
    expect(out).toBe('[a  b  c](https://x.example)')
  })
})

describe('masked links, Discord → Harmony', () => {
  it('turns [label](url) into a labelled url part between text parts', () => {
    const parts = translator().discordToHarmonyParts(discordMessage('see [the guide](https://docs.example/guide) now'), {})
    expect(parts).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'url', url: 'https://docs.example/guide', preview: true, label: 'the guide' },
      { type: 'text', text: ' now' },
    ])
  })

  it('reads [label](<url>) as a link without preview', () => {
    const parts = translator().discordToHarmonyParts(discordMessage('[page](<https://x.example/page>)'), {})
    expect(parts).toEqual([{ type: 'url', url: 'https://x.example/page', preview: false, label: 'page' }])
  })

  it('leaves escaped and image syntax as text', () => {
    const parts = translator().discordToHarmonyParts(discordMessage('\\[no](https://x.example) ![img](https://y.example/a.png)'), {})
    expect(parts.some((p: any) => p.label)).toBe(false)
  })
})
