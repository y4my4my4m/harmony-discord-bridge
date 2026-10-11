import { ChannelType, type AnyThreadChannel, type TextChannel } from 'discord.js'
import type { HarmonyClient } from '../HarmonyClient.js'
import { BoundedMap } from '../utils/BoundedMap.js'
import { errorText } from '../log.js'

/** Pairs kept in memory; the gateway holds the rest (discord_bridge_threads). */
const THREAD_PAIR_CAP = 10_000
/** Discord thread names: 1 to 100 characters. */
const THREAD_NAME_MAX = 100

/** The Harmony author a Discord thread is posted as. */
export interface ThreadAuthor {
  username: string
  avatarURL?: string
}

/** The message a standalone Discord thread starts from. */
export interface ThreadAnchor {
  id: string
  remove(): Promise<unknown>
}

type DiscordThreadLike = Pick<AnyThreadChannel, 'id' | 'name' | 'ownerId'>

export interface ThreadSyncDeps {
  harmony: Pick<HarmonyClient, 'createThread' | 'lookupThreadByDiscordId' | 'getThread' | 'pairThread'>
  /** The Harmony discord_user of the member who started a Discord thread, or null. */
  threadStarter?(thread: DiscordThreadLike): Promise<Record<string, unknown> | null>
  /** Posts a standalone thread's starting message as `author`; null when it cannot. */
  postAnchor?(parent: TextChannel, author: ThreadAuthor): Promise<ThreadAnchor | null>
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
  async harmonyThreadFor(thread: DiscordThreadLike, harmonyChannelId: string): Promise<string | null> {
    const cached = this.toHarmony.get(thread.id)
    if (cached) return cached
    return this.once(`d:${thread.id}`, async () => {
      const found = await this.deps.harmony.lookupThreadByDiscordId(harmonyChannelId, thread.id)
      if (found) {
        this.remember(thread.id, found.id)
        return found.id
      }
      const starter = await this.deps.harmonyMessageFor(thread.id, harmonyChannelId)
      const discordUser = await this.deps.threadStarter?.(thread).catch(() => null) ?? null
      const created = await this.deps.harmony.createThread(harmonyChannelId, threadName(thread.name), {
        messageId: starter,
        discordThreadId: thread.id,
        ...(discordUser ? { discordUser } : {}),
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
   * locked one is not. `author` is the Harmony thread's creator, whom a new standalone
   * Discord thread is posted as.
   */
  async discordThreadFor(
    harmonyThreadId: string,
    harmonyChannelId: string,
    parent: TextChannel,
    create = true,
    author: ThreadAuthor | null = null,
  ): Promise<AnyThreadChannel | null> {
    const id = this.toDiscord.get(harmonyThreadId) ?? await this.once(`h:${harmonyThreadId}:${create}`, async () => {
      const info = await this.deps.harmony.getThread(harmonyThreadId)
      if (!info) return null
      if (info.discord_thread_id) {
        this.remember(info.discord_thread_id, harmonyThreadId)
        return info.discord_thread_id
      }
      if (!create) return null
      const { thread: created, discard } = await this.createDiscordThread(info.name, info.parent_message_id, harmonyChannelId, parent, author)
      // Another bridge process may have paired the thread first; its pair stands.
      const standing = await this.deps.harmony.pairThread(harmonyThreadId, created.id)
      if (standing && standing !== created.id) {
        await discard()
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
    author: ThreadAuthor | null,
  ): Promise<{ thread: AnyThreadChannel; discard(): Promise<void> }> {
    const made = (thread: AnyThreadChannel, anchor: ThreadAnchor | null = null) => ({
      thread,
      discard: async () => {
        await thread.delete().catch(() => {})
        await anchor?.remove().catch(() => {})
      },
    })
    const starterId = await this.deps.discordMessageFor(harmonyStarterId, harmonyChannelId)
    const starter = starterId ? await parent.messages.fetch(starterId).catch(() => null) : null
    if (starter) {
      if (starter.hasThread && starter.thread) return made(starter.thread)
      return made(await starter.startThread({ name: threadName(name) }))
    }
    // A thread created without a message is announced in the channel as started by the bot;
    // one started from a message posted as the Harmony author is not.
    const anchor = author && this.deps.postAnchor ? await this.deps.postAnchor(parent, author) : null
    if (anchor) {
      try {
        return made(await parent.threads.create({ name: threadName(name), startMessage: anchor.id }), anchor)
      } catch (error) {
        await anchor.remove().catch(() => {})
        this.deps.log.warn(`Thread from message ${anchor.id} failed (${errorText(error)}); creating it without one`)
      }
    }
    return made(await parent.threads.create({ name: threadName(name), type: ChannelType.PublicThread }))
  }
}
