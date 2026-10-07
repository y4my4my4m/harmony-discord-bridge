import { describe, expect, it } from 'vitest'
import { DiscordAuthorLimiter } from '../src/runtime/antiSpam.js'

function limiter() {
  let now = 1_000_000
  const l = new DiscordAuthorLimiter(undefined, () => now)
  return { l, tick: (ms: number) => { now += ms } }
}

const key = (i: number) => DiscordAuthorLimiter.contentKey(`message ${i}`)

describe('DiscordAuthorLimiter', () => {
  it('allows 8 messages per 10 s in one channel, then refills', () => {
    const { l, tick } = limiter()
    for (let i = 0; i < 8; i++) expect(l.check('u1', 'c1', key(i))).toBe('ok')
    expect(l.check('u1', 'c1', key(8))).toBe('rate')
    // Another author is unaffected.
    expect(l.check('u2', 'c1', key(8))).toBe('ok')
    tick(1_250)
    expect(l.check('u1', 'c1', key(9))).toBe('ok')
    expect(l.check('u1', 'c1', key(10))).toBe('rate')
    expect(l.dropped.rate).toBe(2)
  })

  it('allows 30 messages per 60 s across channels', () => {
    const { l, tick } = limiter()
    let sent = 0
    for (let i = 0; i < 40; i++) {
      if (l.check('u1', `c${i % 5}`, key(i)) === 'ok') sent++
    }
    expect(sent).toBe(30)
    tick(2_000)
    expect(l.check('u1', 'c9', key(98))).toBe('ok')
    expect(l.check('u1', 'c9', key(99))).toBe('rate')
    tick(60_000)
    expect(l.check('u1', 'c9', key(100))).toBe('ok')
  })

  it('drops identical content from one author within 30 s, in any channel', () => {
    const { l, tick } = limiter()
    const same = DiscordAuthorLimiter.contentKey('buy now', ['a:pic.png:100'])
    expect(l.check('u1', 'c1', same)).toBe('ok')
    tick(29_000)
    expect(l.check('u1', 'c2', same)).toBe('duplicate')
    expect(l.check('u2', 'c1', same)).toBe('ok')
    expect(l.check('u1', 'c1', DiscordAuthorLimiter.contentKey('buy now', ['a:other.png:100']))).toBe('ok')
    tick(1_000)
    expect(l.check('u1', 'c1', same)).toBe('ok')
    expect(l.dropped.duplicate).toBe(1)
  })

  it('does not charge a dropped message and forgets idle authors', () => {
    const { l, tick } = limiter()
    const same = key(1)
    l.check('u1', 'c1', same)
    for (let i = 0; i < 20; i++) l.check('u1', 'c1', same)
    for (let i = 2; i < 9; i++) expect(l.check('u1', 'c1', key(i))).toBe('ok')
    tick(120_000)
    for (let i = 0; i < 500; i++) l.check(`x${i}`, 'c', key(i))
    expect(l.size()).toBeLessThan(1600)
  })

  it('keys content by digest, not by text', () => {
    expect(DiscordAuthorLimiter.contentKey('secret')).not.toContain('secret')
    expect(DiscordAuthorLimiter.contentKey(' hi ')).toBe(DiscordAuthorLimiter.contentKey('hi'))
  })
})
