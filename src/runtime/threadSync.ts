import { ChannelType, type AnyThreadChannel, type TextChannel } from 'discord.js'
import type { HarmonyClient } from '../HarmonyClient.js'
import { BoundedMap } from '../utils/BoundedMap.js'

/** Pairs kept in memory; the gateway holds the rest (discord_bridge_threads). */
const THREAD_PAIR_CAP = 10_000
/** Discord thread names: 1 to 100 characters. */
const THREAD_NAME_MAX = 100

export interface ThreadSyncDeps {
  harmony: Pick<HarmonyClient, 'createThread' | 'lookupThreadByDiscordId' | 'getThread' | 'pairThread'>
  /** The Harmony message a Discord message was bridged to, or null. */
  harmonyMessageFor(discordMessageId: string, harmonyChannelId: string): Promise<string | null>
  /** The Discord message a Harmony message was bridged to, or null. */
  discordMessageFor(harmonyMessageId: string, harmonyChannelId: string): Promise<string | null>
  log: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void }
}

export function threadName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim()
  return (trimmed || 'Thread').slice(0, THREAD_NAME_MAX)
}

/**
 * Threads across a bridged channel pair. A Discord thread maps to a Harmony thread of the
 * paired channel and back; either side's thread is created on first use. A Discord thread
 * started from a message shares that message's id, so its Harmony thread hangs off the
 * bridged copy of the message; a Harmony thread on a bridged message starts the Discord
 * thread on the Discord copy. One creation runs per thread at a time.
 */
export class ThreadSync {
  private readonly toHarmony = new BoundedMap<string, string>(THREAD_PAIR_CAP)
  private readonly toDiscord = new BoundedMap<string, string>(THREAD_PAIR_CAP)
  private readonly pending = new Map<string, Promise<string | null>>()

  constructor(private readonly deps: ThreadSyncDeps) {}

  remember(discordThreadId: string, harmonyThreadId: string): void {
    this.toHarmony.set(discordThreadId, harmonyThreadId)
    this.toDiscord.set(harmonyThreadId, discordThreadId)
  }

  /** Cached Discord thread of a Harmony thread, without a lookup. */
  knownDiscordThread(harmonyThreadId: string): string | undefined {
    return this.toDiscord.get(harmonyThreadId)
  }

  private once(key: string, run: () => Promise<string | null>): Promise<string | null> {
    const running = this.pending.get(key)
    if (running) return running
    const started = run().finally(() => this.pending.delete(key))
    this.pending.set(key, started)
    return started
  }

  /** The Harmony thread for a Discord thread whose parent is paired with `harmonyChannelId`. */
  async harmonyThreadFor(thread: Pick<AnyThreadChannel, 'id' | 'name'>, harmonyChannelId: string): Promise<string | null> {
    const cached = this.toHarmony.get(thread.id)
    if (cached) return cached
    return this.once(`d:${thread.id}`, async () => {
      const found = await this.deps.harmony.lookupThreadByDiscordId(harmonyChannelId, thread.id)
      if (found) {
        this.remember(thread.id, found.id)
        return found.id
      }
      const starter = await this.deps.harmonyMessageFor(thread.id, harmonyChannelId)
      const created = await this.deps.harmony.createThread(harmonyChannelId, threadName(thread.name), {
        messageId: starter,
        discordThreadId: thread.id,
      })
      this.remember(thread.id, created.id)
      this.deps.log.info(`Discord thread ${thread.id} → Harmony thread ${created.id}${starter ? ` on ${starter}` : ''}`)
      return created.id
    })
  }

  /**
   * The Discord thread for a Harmony thread of the channel paired with `parent`. `create`:
   * a Harmony thread without a pair gets a new Discord thread; otherwise it answers null (an
   * edit, delete or reaction never creates one). An archived Discord thread is reopened; a
   * locked one is not.
   */
  async discordThreadFor(
    harmonyThreadId: string,
    harmonyChannelId: string,
    parent: TextChannel,
    create = true,
  ): Promise<AnyThreadChannel | null> {
    const id = this.toDiscord.get(harmonyThreadId) ?? await this.once(`h:${harmonyThreadId}:${create}`, async () => {
      const info = await this.deps.harmony.getThread(harmonyThreadId)
      if (!info) return null
      if (info.discord_thread_id) {
        this.remember(info.discord_thread_id, harmonyThreadId)
        return info.discord_thread_id
      }
      if (!create) return null
      const created = await this.createDiscordThread(info.name, info.parent_message_id, harmonyChannelId, parent)
      // Another bridge process may have paired the thread first; its pair stands.
      const standing = await this.deps.harmony.pairThread(harmonyThreadId, created.id)
      if (standing && standing !== created.id) {
        await created.delete().catch(() => {})
        this.remember(standing, harmonyThreadId)
        return standing
      }
      this.remember(created.id, harmonyThreadId)
      this.deps.log.info(`Harmony thread ${harmonyThreadId} → Discord thread ${created.id}`)
      return created.id
    })
    if (!id) return null

    const thread = await parent.threads.fetch(id).catch(() => null)
    if (!thread) {
      this.deps.log.warn(`Discord thread ${id} of Harmony thread ${harmonyThreadId} is gone`)
      return null
    }
    if (thread.archived && !thread.locked) await thread.setArchived(false).catch(() => {})
    return thread
  }

  private async createDiscordThread(
    name: string,
    harmonyStarterId: string,
    harmonyChannelId: string,
    parent: TextChannel,
  ): Promise<AnyThreadChannel> {
    const starterId = await this.deps.discordMessageFor(harmonyStarterId, harmonyChannelId)
    const starter = starterId ? await parent.messages.fetch(starterId).catch(() => null) : null
    if (starter) {
      if (starter.hasThread && starter.thread) return starter.thread
      return starter.startThread({ name: threadName(name) })
    }
    return parent.threads.create({ name: threadName(name), type: ChannelType.PublicThread })
  }
}
