import { PermissionFlagsBits, type Client, type GuildMember, type Message as DiscordMessage } from 'discord.js'
import { isPrivateThread, supportsThreads } from './threadSync.js'
import { importUnsupported, type ImportThreadLike, type ThreadListPage } from './historyImport.js'

/** Discord REST: unknown channel / unknown message. */
const UNKNOWN_CHANNEL = 10003
const UNKNOWN_MESSAGE = 10008
/** Discord REST: cannot execute action on this channel type. */
const WRONG_CHANNEL_TYPE = 50024

const byIdDesc = (a: { id: string }, b: { id: string }) => (BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0)

function discordCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

/** Where a thread listing stands: which list, and the archive time (ISO) it continues before. */
interface ThreadCursor {
  list: 'active' | 'public' | 'private'  // 'private' only from jobs saved by older code
  before: string | null
}

function parseCursor(cursor: Record<string, unknown> | null): ThreadCursor {
  const list = cursor?.list
  if (list === 'public' || list === 'private') {
    return { list, before: typeof cursor?.before === 'string' ? cursor.before : null }
  }
  return { list: 'active', before: null }
}

/** Archive time of a thread in ms; 0 when unknown (sorts last). */
function archivedMs(thread: { archiveTimestamp?: number | null; archivedAt?: Date | null }): number {
  return thread.archiveTimestamp ?? thread.archivedAt?.getTime() ?? 0
}

/** Fixed start of the pinned notice; the bot's notice in a channel is found by it. */
export const IMPORT_NOTICE_MARKER = '**This channel is bridged to Harmony.**'
export const IMPORT_NOTICE_TEXT = `${IMPORT_NOTICE_MARKER} Messages here also appear in a Harmony channel, and older messages are being copied there now. \`/bridge-privacy\` opts you out or erases your copied messages.`
/** Wait for the gateway's answer to one membership request. */
const MEMBER_FETCH_TIMEOUT_MS = 20_000

/** The Discord-facing half of HistoryImporterDeps, over the live discord.js client. */
export interface DiscordImportAccess {
  fetchPage(channelId: string, before: string | undefined): Promise<DiscordMessage[]>
  fetchPins(channelId: string): Promise<Set<string>>
  fetchMembers(channelId: string, userIds: string[]): Promise<Map<string, GuildMember>>
  everyoneCanView(channelId: string): Promise<boolean>
  ensureNotice(channelId: string): Promise<void>
  listThreads(channelId: string, cursor: Record<string, unknown> | null): Promise<ThreadListPage>
  hasStarterMessage(channelId: string, threadId: string): Promise<boolean>
}

/**
 * Reads for the history importer, and its one write: the pinned notice. One request at a time;
 * the importer's page delay keeps live relay responsive. Fetched messages stay out of the
 * client's message cache, which the live relay's entries live in. `guildId` is the bridge's
 * guild: a channel of any other guild is refused.
 */
export function discordImportAccess(getClient: () => Client | null, guildId: () => string | null): DiscordImportAccess {
  const client = (): Client => {
    const c = getClient()
    if (!c) throw new Error('Discord is not connected')
    return c
  }

  /** A channel or thread by id, from cache or REST. Unknown ids look like Discord's 10003. */
  async function channelOf(id: string): Promise<any> {
    const c = client()
    const channel: any = c.channels.cache.get(id) ?? await c.channels.fetch(id)
    if (!channel) throw Object.assign(new Error(`Unknown channel ${id}`), { code: UNKNOWN_CHANNEL, status: 404 })
    const bridged = guildId()
    if (!bridged || (channel.guildId ?? channel.guild?.id) !== bridged) {
      throw importUnsupported(`Discord channel ${id} is not in this bridge's server`)
    }
    if (channel.isTextBased?.() !== true) throw importUnsupported(`Discord channel ${id} holds no messages (type ${channel.type})`)
    return channel
  }

  /** A paired channel: text-based and not a thread. */
  async function pairChannel(id: string): Promise<any> {
    const channel = await channelOf(id)
    if (channel.isThread?.() === true) throw importUnsupported(`Discord channel ${id} is a thread`)
    return channel
  }

  /** The channel's pins, newest first, a page at a time. Empty for a channel type without pins. */
  async function* pinPages(channel: any): AsyncGenerator<any[]> {
    let before: Date | undefined
    for (;;) {
      let res
      try {
        res = await channel.messages.fetchPins({ cache: false, ...(before ? { before } : {}) })
      } catch (err) {
        // A channel type without pins has none; any other error is real.
        if (discordCode(err) === WRONG_CHANNEL_TYPE) return
        throw err
      }
      yield res.items
      const last = res.items[res.items.length - 1]
      if (!res.hasMore || !last) return
      before = new Date(last.pinnedTimestamp)
    }
  }

  return {
    async fetchPage(channelId, before) {
      const channel = await channelOf(channelId)
      if (isPrivateThread(channel)) throw importUnsupported(`Discord thread ${channelId} is private`)
      const page = await channel.messages.fetch({ limit: 100, cache: false, ...(before ? { before } : {}) })
      return (Array.from(page.values()) as DiscordMessage[]).sort(byIdDesc)
    },

    async fetchPins(channelId) {
      const channel = await pairChannel(channelId)
      const pins = new Set<string>()
      for await (const items of pinPages(channel)) {
        for (const item of items) pins.add(item.message.id)
      }
      return pins
    },

    async fetchMembers(channelId, userIds) {
      const channel = await pairChannel(channelId)
      const found = await channel.guild.members.fetch({ user: userIds, time: MEMBER_FETCH_TIMEOUT_MS })
      return new Map<string, GuildMember>(found)
    },

    async everyoneCanView(channelId) {
      const channel = await pairChannel(channelId)
      const everyone = channel.guild?.roles?.everyone
      if (!everyone) return false
      return channel.permissionsFor(everyone)?.has(PermissionFlagsBits.ViewChannel) === true
    },

    async ensureNotice(channelId) {
      const channel = await pairChannel(channelId)
      const botId = client().user?.id
      for await (const items of pinPages(channel)) {
        for (const item of items) {
          const message = item.message
          if (message?.author?.id === botId && typeof message.content === 'string' && message.content.startsWith(IMPORT_NOTICE_MARKER)) return
        }
      }
      const notice = await channel.send({ content: IMPORT_NOTICE_TEXT, allowedMentions: { parse: [] } })
      await notice.pin()
    },

    async listThreads(channelId, rawCursor) {
      const cursor = parseCursor(rawCursor)
      // Private threads are never imported: Harmony has no private threads, so every imported
      // thread would be readable by the whole channel. A cursor saved by older code that was
      // already in the private list ends the listing.
      if (cursor.list === 'private') return { threads: [], next: null }
      const channel = await pairChannel(channelId)

      if (cursor.list === 'active') {
        const active = await channel.guild.channels.fetchActiveThreads()
        const inChannel = (Array.from(active.threads.values()) as any[]).filter(t => t.parentId === channelId)
        const threads = inChannel.filter(t => !isPrivateThread(t)).sort(byIdDesc)
        return {
          threads: threads as ImportThreadLike[],
          next: supportsThreads(channel) ? { list: 'public', before: null } : null,
          skippedPrivate: inChannel.length - threads.length,
        }
      }

      // A job saved mid-listing before voice and stage channels were recognised resumes here.
      if (!supportsThreads(channel)) return { threads: [], next: null }

      const res = await channel.threads.fetchArchived({
        type: 'public',
        limit: 100,
        ...(cursor.before ? { before: cursor.before } : {}),
      })
      const all = (Array.from(res.threads.values()) as any[])
        .sort((a, b) => archivedMs(b) - archivedMs(a) || byIdDesc(a, b))
      const threads = all.filter(t => !isPrivateThread(t))
      const next: ThreadCursor | null = res.hasMore && all.length > 0
        ? { list: 'public', before: new Date(archivedMs(all[all.length - 1])).toISOString() }
        : null
      return { threads: threads as ImportThreadLike[], next: next as Record<string, unknown> | null, skippedPrivate: all.length - threads.length }
    },

    async hasStarterMessage(channelId, threadId) {
      const channel = await pairChannel(channelId)
      try {
        await channel.messages.fetch({ message: threadId, cache: false, force: true })
        return true
      } catch (err) {
        if (discordCode(err) === UNKNOWN_MESSAGE) return false
        throw err
      }
    },
  }
}
