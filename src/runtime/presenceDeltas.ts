import { ActivityType } from 'discord.js'

export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline'

export interface MappedPresence {
  presenceStatus: PresenceStatus
  customStatus: { text: string; emoji: string | null } | null
}

/** BRIDGE_PRESENCE_UPDATE (op 7) entry; `id` is the Discord user id. */
export interface PresenceDelta extends MappedPresence {
  id: string
}

interface PresenceLike {
  status?: string | null
  activities?: ReadonlyArray<{
    type: number
    state?: string | null
    emoji?: { name?: string | null } | null
  }> | null
}

/**
 * Discord → Harmony status: online → online, idle → away, dnd → busy,
 * invisible and offline → offline. Of the activities only the custom status
 * is kept; games, music and streams do not map.
 */
export function mapDiscordPresence(presence: PresenceLike | null | undefined): MappedPresence {
  const status = presence?.status ?? 'offline'
  const presenceStatus: PresenceStatus =
    status === 'online' ? 'online'
      : status === 'idle' ? 'away'
        : status === 'dnd' ? 'busy'
          : 'offline'

  const custom = presence?.activities?.find(a => a.type === ActivityType.Custom)
  const text = custom?.state?.trim() ?? ''
  const emoji = custom?.emoji?.name ?? null
  if (!custom || (!text && !emoji)) return { presenceStatus, customStatus: null }
  return { presenceStatus, customStatus: { text, emoji } }
}

function presenceKey(p: MappedPresence): string {
  return JSON.stringify([p.presenceStatus, p.customStatus?.text ?? null, p.customStatus?.emoji ?? null])
}

export function samePresence(a: MappedPresence, b: MappedPresence): boolean {
  return presenceKey(a) === presenceKey(b)
}

/** Entries per op 7 frame. */
const MAX_UPDATES_PER_FRAME = 500

/**
 * op 7 coalescing: the latest state per member, sent at most once per
 * interval, only for members Harmony received in op 6, and only when it
 * differs from the state Harmony last received.
 */
export class PresenceDeltaQueue {
  private readonly pending = new Map<string, PresenceDelta>()
  /** Member id → presence key Harmony holds, from op 6 or a later op 7. */
  private readonly delivered = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  private lastSentAt = -Infinity

  constructor(
    private readonly send: (updates: PresenceDelta[]) => boolean,
    private readonly intervalMs = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** op 6 delivered these members with their presence; pending deltas are superseded. */
  baseline(members: Iterable<PresenceDelta>): void {
    this.delivered.clear()
    for (const m of members) this.delivered.set(m.id, presenceKey(m))
    this.pending.clear()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  push(delta: PresenceDelta): void {
    if (!this.delivered.has(delta.id)) return
    this.pending.set(delta.id, delta)
    if (this.timer) return
    const wait = Math.max(0, this.lastSentAt + this.intervalMs - this.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, wait)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const updates = Array.from(this.pending.values()).filter(d => {
      const held = this.delivered.get(d.id)
      return held !== undefined && held !== presenceKey(d)
    })
    this.pending.clear()
    if (updates.length === 0) return
    this.lastSentAt = this.now()
    for (let i = 0; i < updates.length; i += MAX_UPDATES_PER_FRAME) {
      const batch = updates.slice(i, i + MAX_UPDATES_PER_FRAME)
      // Socket closed: the op 6 sent on reconnect carries current presence.
      if (!this.send(batch)) return
      for (const u of batch) this.delivered.set(u.id, presenceKey(u))
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }

  pendingCount(): number {
    return this.pending.size
  }
}
