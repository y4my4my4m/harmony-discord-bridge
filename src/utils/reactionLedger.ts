import { BoundedMap } from './BoundedMap.js'

/**
 * Harmony reactions mirrored as one bot reaction per (message, emoji) on
 * Discord. The bot reaction goes away only with the last Harmony holder.
 * REMOVE events carry only the reaction id, so each id maps back to its
 * message and emoji.
 */
export class ReactionLedger {
  private readonly holders: BoundedMap<string, Set<string>>
  private readonly byReaction: BoundedMap<string, { key: string; messageId: string; emoji: string }>

  constructor(capacity = 50_000) {
    this.holders = new BoundedMap(capacity)
    this.byReaction = new BoundedMap(capacity)
  }

  private static key(messageId: string, emoji: string): string {
    return `${messageId}\u0000${emoji}`
  }

  /** Records a holder; true when it is the first one (the bot should react). */
  add(messageId: string, emoji: string, reactionId: string): boolean {
    const key = ReactionLedger.key(messageId, emoji)
    const set = this.holders.get(key) ?? new Set<string>()
    const first = set.size === 0
    set.add(reactionId)
    this.holders.set(key, set)
    this.byReaction.set(reactionId, { key, messageId, emoji })
    return first
  }

  /**
   * Drops a holder. `last` is true when no holder remains (the bot should
   * unreact). Null for a reaction id never added here.
   */
  remove(reactionId: string): { messageId: string; emoji: string; last: boolean; remaining: number } | null {
    const entry = this.byReaction.get(reactionId)
    if (!entry) return null
    this.byReaction.delete(reactionId)
    const set = this.holders.get(entry.key)
    set?.delete(reactionId)
    const remaining = set?.size ?? 0
    if (remaining === 0) this.holders.delete(entry.key)
    return { messageId: entry.messageId, emoji: entry.emoji, last: remaining === 0, remaining }
  }

  count(messageId: string, emoji: string): number {
    return this.holders.get(ReactionLedger.key(messageId, emoji))?.size ?? 0
  }
}
