import type { Client, Message as DiscordMessage } from 'discord.js'
import { isPrivateThread, supportsThreads } from './threadSync.js'
import type { ImportThreadLike, ThreadListPage } from './historyImport.js'

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

/** The Discord-facing half of HistoryImporterDeps, over the live discord.js client. */
export interface DiscordImportAccess {
  fetchPage(channelId: string, before: string | undefined): Promise<DiscordMessage[]>
  fetchPins(channelId: string): Promise<Set<string>>
  listThreads(channelId: string, cursor: Record<string, unknown> | null): Promise<ThreadListPage>
  hasStarterMessage(channelId: string, threadId: string): Promise<boolean>
}

/**
 * Reads for the history importer. One request at a time; the importer's page delay is what keeps
 * live relay responsive on the shared client.
 */
export function discordImportAccess(getClient: () => Client | null): DiscordImportAccess {
  const client = (): Client => {
    const c = getClient()
    if (!c) throw new Error('Discord is not connected')
    return c
  }

  /** A channel or thread by id, from cache or REST. Unknown ids look like Discord's 10003. */
  async function channelOf(id: string): Promise<any> {
    const c = client()
    const channel = c.channels.cache.get(id) ?? await c.channels.fetch(id)
    if (!channel) throw Object.assign(new Error(`Unknown channel ${id}`), { code: UNKNOWN_CHANNEL, status: 404 })
    return channel
  }

  return {
    async fetchPage(channelId, before) {
      const channel = await channelOf(channelId)
      const page = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 })
      return (Array.from(page.values()) as DiscordMessage[]).sort(byIdDesc)
    },

    async fetchPins(channelId) {
      const channel = await channelOf(channelId)
      const pins = new Set<string>()
      let before: Date | undefined
      for (;;) {
        let res
        try {
          res = await channel.messages.fetchPins(before ? { before } : {})
        } catch (err) {
          // A channel type without pins has none to import; any other error is real.
          if (discordCode(err) === WRONG_CHANNEL_TYPE) return pins
          throw err
        }
        for (const item of res.items) pins.add(item.message.id)
        const last = res.items[res.items.length - 1]
        if (!res.hasMore || !last) break
        before = new Date(last.pinnedTimestamp)
      }
      return pins
    },

    async listThreads(channelId, rawCursor) {
      const cursor = parseCursor(rawCursor)
      // Private threads are never imported: Harmony has no private threads, so every imported
      // thread would be readable by the whole channel. A cursor saved by older code that was
      // already in the private list ends the listing.
      if (cursor.list === 'private') return { threads: [], next: null }
      const channel = await channelOf(channelId)

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
      const channel = await channelOf(channelId)
      try {
        await channel.messages.fetch(threadId)
        return true
      } catch (err) {
        if (discordCode(err) === UNKNOWN_MESSAGE) return false
        throw err
      }
    },
  }
}
