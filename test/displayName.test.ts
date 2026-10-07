import { describe, expect, it } from 'vitest'
import {
  WEBHOOK_NAME_FALLBACK,
  botPostPrefix,
  harmonyAuthorName,
  sanitizeWebhookUsername,
} from '../src/utils/discordDisplayName.js'

describe('sanitizeWebhookUsername', () => {
  it.each([
    ['Alice', 'Alice'],
    ['Clyde', WEBHOOK_NAME_FALLBACK],
    ['clydeFan', 'Fan'],
    ['DiScOrD mod', 'mod'],
    ['mydiscordname', 'myname'],
    ['discdiscordord', WEBHOOK_NAME_FALLBACK],
    ['  spaced   out  ', 'spaced out'],
    ['tab\tnew\nline', 'tab new line'],
    ['', WEBHOOK_NAME_FALLBACK],
    ['   ', WEBHOOK_NAME_FALLBACK],
    [null, WEBHOOK_NAME_FALLBACK],
    ['x'.repeat(100), 'x'.repeat(80)],
    ['🎉'.repeat(90), '🎉'.repeat(80)],
  ])('%j → %j', (input, expected) => {
    const out = sanitizeWebhookUsername(input as string | null)
    expect(out).toBe(expected)
    expect(Array.from(out).length).toBeGreaterThanOrEqual(1)
    expect(Array.from(out).length).toBeLessThanOrEqual(80)
    expect(out).not.toMatch(/clyde|discord/i)
  })
})

describe('harmonyAuthorName', () => {
  it('prefers the server nickname, then the display name, then the username', () => {
    expect(harmonyAuthorName({ nickname: 'Nick', display_name: 'Display', username: 'user' })).toBe('Nick')
    expect(harmonyAuthorName({ nickname: null, display_name: 'Display', username: 'user' })).toBe('Display')
    expect(harmonyAuthorName({ nickname: ':fire:', display_name: '', username: 'user' })).toBe('user')
    expect(harmonyAuthorName({ display_name: 'Cool :fire: guy', username: 'user' })).toBe('Cool guy')
    expect(harmonyAuthorName(null)).toBe('Harmony User')
  })
})

describe('botPostPrefix', () => {
  it('bolds the name and escapes Markdown in it', () => {
    expect(botPostPrefix('Alice')).toBe('**Alice**: ')
    expect(botPostPrefix('*star*_x_')).toBe('**\\*star\\*\\_x\\_**: ')
  })
})
