import { createHash } from 'crypto'

/** Token bucket: `capacity` tokens, refilled continuously at `capacity` per `windowMs`. */
interface Bucket {
  tokens: number
  at: number
}

export interface AntiSpamLimits {
  perChannel: { capacity: number; windowMs: number }
  overall: { capacity: number; windowMs: number }
  /** Identical content from one author inside this window is dropped. */
  duplicateMs: number
}

/** v2.2 contract: 8 per 10 s per channel, 30 per 60 s across channels, duplicates within 30 s. */
export const DEFAULT_ANTI_SPAM: AntiSpamLimits = {
  perChannel: { capacity: 8, windowMs: 10_000 },
  overall: { capacity: 30, windowMs: 60_000 },
  duplicateMs: 30_000,
}

export type SpamVerdict = 'ok' | 'rate' | 'duplicate'

/** Checks between sweeps. A bucket idle for its window is full, the same as absent. */
const SWEEP_EVERY = 500

/**
 * Per Discord author limits applied before a message reaches Harmony.
 * Content is held only as a SHA-256 digest.
 */
export class DiscordAuthorLimiter {
  private readonly channelBuckets = new Map<string, Bucket>()
  private readonly authorBuckets = new Map<string, Bucket>()
  private readonly recent = new Map<string, number>()
  private calls = 0
  readonly dropped = { rate: 0, duplicate: 0 }

  constructor(
    private readonly limits: AntiSpamLimits = DEFAULT_ANTI_SPAM,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Digest of what makes two messages identical: text plus attachment and sticker identities. */
  static contentKey(content: string, extras: Iterable<string> = []): string {
    const h = createHash('sha256')
    h.update(content.trim())
    for (const extra of extras) h.update('\u0000').update(extra)
    return h.digest('base64')
  }

  /** Records the message when it passes; a dropped message consumes nothing. */
  check(authorId: string, channelId: string, contentKey: string): SpamVerdict {
    const now = this.now()
    if (++this.calls % SWEEP_EVERY === 0) this.sweep(now)

    const dupKey = `${authorId}\u0000${contentKey}`
    const seen = this.recent.get(dupKey)
    if (seen !== undefined && now - seen < this.limits.duplicateMs) {
      this.dropped.duplicate++
      return 'duplicate'
    }

    const channel = this.bucket(this.channelBuckets, `${authorId}\u0000${channelId}`, this.limits.perChannel, now)
    const overall = this.bucket(this.authorBuckets, authorId, this.limits.overall, now)
    if (channel.tokens < 1 || overall.tokens < 1) {
      this.dropped.rate++
      return 'rate'
    }
    channel.tokens -= 1
    overall.tokens -= 1
    this.recent.set(dupKey, now)
    return 'ok'
  }

  private bucket(
    map: Map<string, Bucket>,
    key: string,
    rule: { capacity: number; windowMs: number },
    now: number,
  ): Bucket {
    let b = map.get(key)
    if (!b) {
      b = { tokens: rule.capacity, at: now }
      map.set(key, b)
      return b
    }
    const refill = ((now - b.at) / rule.windowMs) * rule.capacity
    b.tokens = Math.min(rule.capacity, b.tokens + refill)
    b.at = now
    return b
  }

  private sweep(now: number) {
    for (const [key, at] of this.recent) if (now - at >= this.limits.duplicateMs) this.recent.delete(key)
    for (const [key, b] of this.channelBuckets) if (now - b.at >= this.limits.perChannel.windowMs) this.channelBuckets.delete(key)
    for (const [key, b] of this.authorBuckets) if (now - b.at >= this.limits.overall.windowMs) this.authorBuckets.delete(key)
  }

  /** Tracked entries, for tests. */
  size(): number {
    return this.recent.size + this.channelBuckets.size + this.authorBuckets.size
  }
}
