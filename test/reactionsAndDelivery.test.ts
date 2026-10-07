import { describe, expect, it, vi } from 'vitest'
import { ReactionLedger } from '../src/utils/reactionLedger.js'
import { resolveDeliveryMode } from '../src/utils/deliveryMode.js'
import { loadInstanceIcon } from '../src/utils/instanceIcon.js'

describe('ReactionLedger', () => {
  it('keeps the bot reaction until the last Harmony holder removes theirs', () => {
    const ledger = new ReactionLedger()
    expect(ledger.add('m1', '👍', 'r-alice')).toBe(true)
    expect(ledger.add('m1', '👍', 'r-bob')).toBe(false)
    expect(ledger.count('m1', '👍')).toBe(2)

    expect(ledger.remove('r-alice')).toEqual({ messageId: 'm1', emoji: '👍', last: false, remaining: 1 })
    expect(ledger.remove('r-bob')).toEqual({ messageId: 'm1', emoji: '👍', last: true, remaining: 0 })
    expect(ledger.count('m1', '👍')).toBe(0)
    expect(ledger.add('m1', '👍', 'r-carol')).toBe(true)
  })

  it('counts per message and per emoji', () => {
    const ledger = new ReactionLedger()
    ledger.add('m1', '👍', 'r1')
    ledger.add('m1', '🎉', 'r2')
    ledger.add('m2', '👍', 'r3')
    expect(ledger.remove('r1')?.last).toBe(true)
    expect(ledger.count('m1', '🎉')).toBe(1)
    expect(ledger.count('m2', '👍')).toBe(1)
  })

  it('returns null for reactions it never saw (removal is left alone)', () => {
    expect(new ReactionLedger().remove('unknown')).toBeNull()
  })

  it('ignores a duplicate add of the same reaction', () => {
    const ledger = new ReactionLedger()
    ledger.add('m1', '👍', 'r1')
    ledger.add('m1', '👍', 'r1')
    expect(ledger.remove('r1')?.last).toBe(true)
  })
})

describe('resolveDeliveryMode', () => {
  const never = () => Promise.reject(new Error('should not fetch'))

  it('prefers the in-memory record, then send-time metadata', async () => {
    expect(await resolveDeliveryMode({ cached: false, metadata: { discord_via_webhook: true }, botUserId: 'bot', fetchDiscordMessage: never })).toBe(false)
    expect(await resolveDeliveryMode({ cached: undefined, metadata: { discord_via_webhook: false }, botUserId: 'bot', fetchDiscordMessage: never })).toBe(false)
  })

  it('falls back to the Discord message after a restart', async () => {
    const viaWebhook = await resolveDeliveryMode({
      cached: undefined,
      metadata: { discord_message_id: '1' },
      botUserId: 'bot',
      fetchDiscordMessage: async () => ({ webhookId: 'wh-1', author: { id: 'wh-1' } }),
    })
    expect(viaWebhook).toBe(true)

    const botPost = await resolveDeliveryMode({
      cached: undefined,
      metadata: {},
      botUserId: 'bot',
      fetchDiscordMessage: async () => ({ webhookId: null, author: { id: 'bot' } }),
    })
    expect(botPost).toBe(false)
  })

  it('is null when the Discord copy is gone or not ours', async () => {
    expect(await resolveDeliveryMode({ cached: undefined, metadata: null, botUserId: 'bot', fetchDiscordMessage: never })).toBeNull()
    expect(await resolveDeliveryMode({
      cached: undefined,
      metadata: null,
      botUserId: 'bot',
      fetchDiscordMessage: async () => ({ webhookId: null, author: { id: 'someone' } }),
    })).toBeNull()
  })
})

describe('loadInstanceIcon', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

  it('uses the NodeInfo instance icon', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u === 'https://h.example/nodeinfo/2.0') return Response.json({ metadata: { icon: '/media/icon.png' } })
      if (u === 'https://h.example/media/icon.png') return new Response(png, { headers: { 'Content-Type': 'image/png' } })
      return new Response('nope', { status: 404 })
    })
    const icon = await loadInstanceIcon('https://h.example/', fetchImpl)
    expect(icon && Array.from(icon)).toEqual(Array.from(png))
  })

  it('falls back to the stock favicon, then to none', async () => {
    const favicon = vi.fn(async (url: string | URL) =>
      String(url) === 'https://h.example/favicon/android-icon-192x192.png'
        ? new Response(png, { headers: { 'Content-Type': 'image/png' } })
        : new Response('nope', { status: 404 }))
    expect(await loadInstanceIcon('https://h.example', favicon)).not.toBeNull()

    const html = vi.fn(async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }))
    expect(await loadInstanceIcon('https://h.example', html)).toBeNull()
  })
})
