import { MessageType, type GuildMember, type Message as DiscordMessage } from 'discord.js'
import { BridgeApiError, type BridgeApi, type ImportBatchResult, type ImportJob, type ImportMessage } from '../v2/BridgeApi.js'
import { abortableSleep } from '../http.js'
import { errorText, type Logger } from '../log.js'
import type { Problem } from '../problems.js'
import { isPrivateThread, threadName } from './threadSync.js'

/**
 * How a run of a job ended. `waiting`: Harmony asked for a wait (its cap on running imports);
 * the job keeps its state and is tried again later. `disabled`: import is off for this bridge.
 */
export type ImportResult = 'done' | 'cancelled' | 'failed' | 'paused' | 'waiting' | 'disabled'

export interface ImportOutcome {
  result: ImportResult
  /** With `waiting`: how long Harmony asked to wait. */
  retryAfterMs?: number
}

/** The parts of a Discord thread the importer reads. */
export interface ImportThreadLike {
  id: string
  name: string | null
  ownerId: string | null
  createdAt: Date | null
  archived: boolean | null
  locked: boolean | null
  /** Discord channel type; private threads (12) are never imported. */
  type?: number
  /** When Discord last archived the thread, in ms. */
  archiveTimestamp?: number | null
}

export interface ThreadListPage {
  threads: ImportThreadLike[]
  /** Opaque cursor for the next page; null when the listing is complete. */
  next: Record<string, unknown> | null
  /** Private threads left out of this page (they never cross the bridge). */
  skippedPrivate?: number
}

/**
 * The starter of an imported thread. `discordUser`: Harmony's discord_user, or null. `plainTitle`:
 * Discord titles a thread with its starter's words, so the thread of a starter who left the guild
 * or opted out is imported as 'Thread'.
 */
export interface ImportThreadStarter {
  discordUser: Record<string, unknown> | null
  plainTitle: boolean
}

/** An import row before the importer adds its thread and pin. */
export type TranslatedImport = Omit<ImportMessage, 'thread_id' | 'pinned'>

export interface HistoryImporterDeps {
  api: Pick<BridgeApi, 'updateImport' | 'postImportMessages' | 'importThread' | 'linkImportReplies' | 'getImport'>
  /** One page of a channel's (or thread's) history, newest first, at most 100; `before` is exclusive. */
  fetchPage(channelId: string, before: string | undefined): Promise<DiscordMessage[]>
  /** Ids of the channel's pinned messages. */
  fetchPins(channelId: string): Promise<Set<string>>
  /**
   * The current guild members among `userIds` (at most 100), in one request. An id missing from
   * the answer is not a member: left, banned, or a deleted account.
   */
  fetchMembers(channelId: string, userIds: string[]): Promise<Map<string, GuildMember>>
  /** Whether @everyone can view the channel and read its history. */
  everyoneCanView(channelId: string): Promise<boolean>
  /** Makes sure the channel holds the bot's pinned notice about the bridge and the import. */
  ensureNotice(channelId: string): Promise<void>
  /** The import row of a message of `member`. `nativeStickers` false renders every sticker as its image. */
  translate(msg: DiscordMessage, member: GuildMember, opts: { nativeStickers: boolean }): Promise<TranslatedImport | null>
  /**
   * Threads of a channel: active ones (guild-wide list filtered to the channel), then archived
   * public. Private threads are never listed. The cursor is opaque to the
   * importer and records which list it is in and the `before` timestamp; null starts from the top.
   */
  listThreads(channelId: string, cursor: Record<string, unknown> | null): Promise<ThreadListPage>
  /**
   * The Discord id of the author of the channel's message the thread was started from (the
   * message with the thread's id); null when the thread has none.
   */
  starterMessageAuthor(channelId: string, threadId: string): Promise<string | null>
  /** A thread of the channel by id; null when it is gone, private or another channel's. */
  fetchThread?(channelId: string, threadId: string): Promise<ImportThreadLike | null>
  /** Who started the thread, as Harmony gets it. Rejects when Discord could not say. */
  threadStarter(thread: ImportThreadLike): Promise<ImportThreadStarter>
  /** Opted-out Discord users of the server. Absent on a gateway without the privacy routes. */
  optOuts?: {
    /** Reads the list from Harmony. A run does not start on a list it could not read. */
    refresh(signal?: AbortSignal): Promise<void>
    has(discordUserId: string): boolean
    add(discordUserId: string): void
  }
  /** Harmony refused the native part of this Harmony sticker in a batch. */
  onStickerRefused?(harmonyStickerId: string): void
  /** Discord messages Harmony now holds: the relay's remembered lookup misses for them go. */
  onImported?(discordMessageIds: string[]): void
  /** Raises a problem (shown in /bridge status and reported to Harmony). */
  reportProblem(problem: Problem): void
  pageDelayMs: number
  now?: () => number
  /** Rejects when `signal` aborts first. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  log: Logger
}

/** Progress inside the threads phase, stored as the job's `thread_cursor`. */
interface ThreadProgress {
  /** The listThreads cursor of the page being worked through; null is the first page. */
  at: Record<string, unknown> | null
  /** Ids of the threads of that page already imported. */
  done: string[]
  /** Ids of the threads the first page listed as active. Absent on a cursor of an earlier build. */
  active?: string[]
  /** When the first page was listed (ISO). Absent on a cursor of an earlier build. */
  since?: string
  /** The thread being walked and the oldest of its messages posted, to resume below it. */
  current?: { id: string; before: string }
  /** Threads walked outside their archived page (a resume, the active page); later pages skip them. */
  finished?: string[]
}

/**
 * The cursors of the pass after the archived threads, for threads revived while those were
 * paged: the active ones the first page did not list, then (`archived`) public threads archived
 * since the first listing, newest first, from `before`.
 */
const RECHECK_CURSOR = { list: 'recheck' } as const
type RecheckCursor = { list: 'recheck'; archived?: boolean; before?: string | null }

const stringIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string') : [])

/** State of one run() call. */
interface Run {
  job: ImportJob
  signal: AbortSignal
  /** The PATCH to `running` succeeded: the job can be paused or failed. */
  started: boolean
  /** Snowflake of now − RECENCY_MARGIN_MS: nothing newer is imported. */
  cutoff: string
  /** Guild membership by author id, for this run. Null: not a member. */
  members: Map<string, GuildMember | null>
  /** Messages left out because of their author, cumulative for the job's run. */
  authorsSkipped: number
  /** The count the server holds. */
  authorsSkippedSent: number
  /** Threads whose own history could not be read. */
  threadsSkipped: number
  /** now() of the last PATCH that succeeded. */
  lastPatchAt: number
}

const DISCORD_EPOCH_MS = 1420070400000n
/** Missing access, missing permissions, unknown channel: Discord history is gone for good. */
const ACCESS_LOST_CODES = new Set([50001, 50013, 10003])
/** Backoff before each retry of a transient failure; the call is made once more after each wait. */
const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]
/**
 * Messages newer than this are left to the live relay. A newer message imported first would be
 * stored as history and its live copy answered as a duplicate: no notification, no unread
 * count. The margin also covers a Harmony clock behind Discord's.
 */
export const RECENCY_MARGIN_MS = 5 * 60_000
/** Upper bound of the pause between pages, whatever BRIDGE_IMPORT_PAGE_DELAY_MS says. */
export const PAGE_DELAY_CAP_MS = 10_000
/** Wait on a 429 that names no Retry-After. */
const RATE_WAIT_DEFAULT_MS = 5_000
/** Longest single wait on a 429. */
const RATE_WAIT_CAP_MS = 10 * 60_000
/** Timeout of the PATCH that parks a job while the bridge stops. */
const PARK_TIMEOUT_MS = 5_000
/**
 * Longest stretch without a PATCH while a job runs. Every PATCH sets the job's updated_at, and a
 * running job quiet for 10 minutes is paused when another job starts (discord_bridge_import_update,
 * c_stale). A walk of an imported thread posts only messages Harmony already holds, which leave
 * updated_at as it was.
 */
export const KEEPALIVE_MS = 3 * 60_000
/** Longest `error` Harmony stores. */
const ERROR_MAX = 200
const NO_PINS: ReadonlySet<string> = new Set()

/** A thread's own Discord history is unreachable (deleted, no access): skip that thread, keep the job. */
class ThreadSkip extends Error {
  /** `deleted`: a person deleted the thread's Harmony copy; the skip is the intended outcome. */
  constructor(readonly reason: string, readonly deleted = false) {
    super(`thread skipped: ${reason}`)
  }
}

/** Unwinds run() with its result. */
class Stop extends Error {
  constructor(readonly result: ImportResult, readonly retryAfterMs?: number) {
    super(`import stopped: ${result}`)
  }
}

/** A channel the importer cannot read as a channel of this bridge; `importError` becomes the job's `error`. */
export function importUnsupported(message: string): Error {
  return Object.assign(new Error(message), { importError: 'discord_channel_unsupported' })
}

const snowflakeTime = (id: string) => new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS))
/** The smallest snowflake of a millisecond. */
export const snowflakeAt = (ms: number): string => String((BigInt(Math.max(ms, Number(DISCORD_EPOCH_MS))) - DISCORD_EPOCH_MS) << 22n)
const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b)

/** Messages history import copies: a person's own messages. Bots and webhooks can carry any name. */
export function isImportableMessage(msg: Pick<DiscordMessage, 'author' | 'webhookId' | 'type'>): boolean {
  if (msg.author.bot || msg.webhookId) return false
  return msg.type === MessageType.Default || msg.type === MessageType.Reply
}

/** `work`, or a rejection as soon as `signal` aborts. The work itself is not cancelled. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

const hasNativeSticker = (m: ImportMessage): { id?: unknown } | undefined =>
  (m.content as Array<{ type?: string; id?: unknown }>).find(p => p?.type === 'sticker')

/** Copies Discord history into a Harmony channel through the bridge import API. */
export class HistoryImporter {
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number

  constructor(private readonly deps: HistoryImporterDeps) {
    this.sleep = deps.sleep ?? abortableSleep
    this.now = deps.now ?? Date.now
  }

  /**
   * Runs one job through its messages, threads and replies phases, starting at the job's phase.
   * Resumable: progress is read from `reached_discord_message_id` (messages) and `thread_cursor`
   * (threads). 'paused': the scheduler picks the job up again later (abort, retries exhausted,
   * or the server paused it). 'waiting': Harmony asked for a wait. 'failed': the job is over.
   * 'cancelled': on request. 'done': the PATCH to state done has been made.
   */
  async run(job: ImportJob, signal: AbortSignal): Promise<ImportOutcome> {
    const state = { ...job }
    // A job without a start marker has not sent a page: its count starts at zero.
    const resumed = state.phase !== 'messages' || !!state.start_discord_message_id
    const skipped = resumed ? Math.max(0, Number(state.authors_skipped) || 0) : 0
    const run: Run = {
      job: state,
      signal,
      started: false,
      cutoff: snowflakeAt(this.now() - RECENCY_MARGIN_MS),
      members: new Map(),
      authorsSkipped: skipped,
      authorsSkippedSent: skipped,
      threadsSkipped: 0,
      lastPatchAt: this.now(),
    }
    try {
      // Always: a no-op for a job left 'running' by a crash, a transition for queued/paused.
      await this.patch(run, { state: 'running' })
      run.started = true
      if (state.cancel_requested) await this.cancel(run)

      // A channel whose history @everyone cannot read is imported when someone on Discord asked
      // for it, or when the Harmony-side start carried consent for private channels.
      if (state.requested_via === 'harmony' && state.private_approved !== true) {
        const open = await this.discordCall(run, () => this.deps.everyoneCanView(state.discord_channel_id))
        if (!open) {
          this.deps.log.warn(`History import ${state.id}: Discord channel ${state.discord_channel_id} or its history is hidden from @everyone, and the start from Harmony did not include private channels`)
          await this.fail(run, 'discord_approval_required')
        }
      }
      const optOuts = this.deps.optOuts
      if (optOuts) await this.harmonyCall(run, () => optOuts.refresh(signal))

      if (state.phase === 'messages') {
        await this.messagesPhase(run)
        await this.patch(run, { phase: 'threads' })
        state.phase = 'threads'
      }
      if (state.phase === 'threads') {
        await this.threadsPhase(run)
        await this.patch(run, { phase: 'replies' })
        state.phase = 'replies'
      }
      await this.harmonyCall(run, () => this.deps.api.linkImportReplies(state.id, { signal }))
      // A finished job's thread cursor is never read again: a new run starts over.
      await this.patch(run, { state: 'done', thread_cursor: null })
      return { result: 'done' }
    } catch (error) {
      if (error instanceof Stop) return { result: error.result, ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) }
      this.deps.log.error(`History import ${job.id} crashed: ${errorText(error)}`)
      await this.park(run)
      return { result: 'paused' }
    }
  }

  private async messagesPhase(run: Run): Promise<void> {
    const channelId = run.job.discord_channel_id
    // The notice tells the channel's members; the import runs without it. A job whose start
    // marker is set ran this step in an earlier run: an unpinned notice is invisible to the pin
    // search, so asking again would post it again.
    if (!run.job.start_discord_message_id) {
      try {
        await untilAborted(this.deps.ensureNotice(channelId), run.signal)
      } catch (error) {
        if (!run.signal.aborted) this.deps.log.warn(`History import ${run.job.id}: could not post or pin the notice in Discord channel ${channelId}: ${errorText(error)}`)
      }
    }
    const pins = await this.discordCall(run, () => this.deps.fetchPins(channelId))
    await this.importPages(run, { discordId: channelId, harmonyThreadId: null, pins })
  }

  private async threadsPhase(run: Run): Promise<void> {
    const { log } = this.deps
    const job = run.job
    const channelId = job.discord_channel_id
    const saved = job.thread_cursor as Partial<Record<keyof ThreadProgress, unknown>> | null
    let at = (saved?.at ?? null) as Record<string, unknown> | null
    // By id, not by position: a thread archived between runs shifts the list. A count saved by
    // an earlier build restarts its page; the server answers the repeats as skipped.
    let done = new Set<string>(stringIds(saved?.done))
    // A cursor saved by an earlier build holds no active list: its job has no last pass.
    let active: string[] | null = Array.isArray(saved?.active) ? stringIds(saved.active) : at === null ? [] : null
    let since = typeof saved?.since === 'string' ? saved.since : null
    const finished = new Set<string>(stringIds(saved?.finished))
    const savedCurrent = saved?.current as { id?: unknown; before?: unknown } | null | undefined
    let current = typeof savedCurrent?.id === 'string' && typeof savedCurrent.before === 'string'
      ? { id: savedCurrent.id, before: savedCurrent.before }
      : null
    let threadsDone = job.threads_done
    let skippedPrivate = 0

    const progress = (over: Partial<ThreadProgress> = {}): ThreadProgress => ({
      at,
      done: [...done],
      ...(active ? { active } : {}),
      ...(since ? { since } : {}),
      ...(finished.size > 0 ? { finished: [...finished] } : {}),
      ...over,
    })
    const walkedFor = (threadId: string) => async (before: string) => {
      await this.patch(run, { thread_cursor: { ...progress({ current: { id: threadId, before } }) }, ...this.skippedPatch(run) })
      run.authorsSkippedSent = run.authorsSkipped
    }
    const walk = async (thread: ImportThreadLike, resumeBefore: string | null): Promise<void> => {
      try {
        await this.importThread(run, thread, resumeBefore, walkedFor(thread.id))
      } catch (error) {
        if (!(error instanceof ThreadSkip)) throw error
        if (error.deleted) {
          log.info(`History import ${job.id}: thread ${thread.id} was deleted in Harmony; not importing it again`)
          return
        }
        run.threadsSkipped++
        log.warn(`History import ${job.id}: skipping thread ${thread.id} (${error.reason}); ${run.threadsSkipped} skipped so far`)
      }
    }

    // An earlier run stopped inside a thread: it is finished first, wherever a listing now puts it.
    if (current && this.deps.fetchThread) {
      const resume = current
      const thread = await this.discordCall(run, () => this.deps.fetchThread!(channelId, resume.id))
      if (thread) {
        await walk(thread, resume.before)
        threadsDone++
        finished.add(thread.id)
      }
      current = null
      await this.patch(run, { threads_done: threadsDone, thread_cursor: { ...progress() }, ...this.skippedPatch(run) })
      run.authorsSkippedSent = run.authorsSkipped
    }

    for (;;) {
      await this.checkAbort(run)
      const recheck = at?.list === RECHECK_CURSOR.list ? at as RecheckCursor : null
      const listCursor = !recheck ? at : recheck.archived ? { list: 'public', before: recheck.before ?? null } : null
      const listed = await this.discordCall(run, () => this.deps.listThreads(channelId, listCursor))
      let threads = listed.threads
      if (recheck) {
        // Threads started after the cutoff are the live relay's.
        const first = new Set(active ?? [])
        const sinceMs = since ? Date.parse(since) : null
        threads = threads.filter(t => !first.has(t.id) && !newer(t.id, run.cutoff)
          && (!recheck.archived || sinceMs === null || (t.archiveTimestamp ?? Infinity) > sinceMs))
      } else {
        skippedPrivate += listed.skippedPrivate ?? 0
        if (at === null) {
          // A resumed first page keeps the first listing's threads and time.
          active = [...new Set([...(active ?? []), ...threads.map(t => t.id)])]
          since ??= new Date(this.now()).toISOString()
        }
      }
      let following: Record<string, unknown> | null
      if (!recheck) following = listed.next ?? (active ? RECHECK_CURSOR : null)
      else if (!recheck.archived) following = since ? { list: 'recheck', archived: true, before: null } : null
      else {
        const nextBefore = typeof listed.next?.before === 'string' ? listed.next.before : null
        following = nextBefore && since && nextBefore > since ? { list: 'recheck', archived: true, before: nextBefore } : null
      }
      const remaining = threads.filter(t => !done.has(t.id) && !finished.has(t.id))
      // A lower bound until the last page is listed.
      const total = threadsDone + remaining.length
      if (job.threads_total !== total && (!following || total > (job.threads_total ?? 0))) {
        await this.patch(run, { threads_total: total })
        job.threads_total = total
      }

      for (const [i, thread] of remaining.entries()) {
        await walk(thread, null)
        threadsDone++
        done.add(thread.id)
        // A thread of the active page archives during the import and is listed again among the
        // archived ones: finished keeps it from being walked twice.
        if (at === null) finished.add(thread.id)
        const last = i === remaining.length - 1 && following
        await this.patch(run, {
          threads_done: threadsDone,
          thread_cursor: { ...(last ? progress({ at: following, done: [] }) : progress()) },
          ...this.skippedPatch(run),
        })
        run.authorsSkippedSent = run.authorsSkipped
        await this.pageWait(run)
        await this.checkServerState(run)
      }
      if (!following) {
        if (skippedPrivate > 0) {
          log.warn(`History import ${job.id}: left out ${skippedPrivate} private thread(s) of ${channelId}`)
          this.deps.reportProblem({ code: 'private_threads_skipped', params: { discord_channel_id: channelId, count: String(skippedPrivate) } })
        }
        if (run.threadsSkipped > 0) {
          log.warn(`History import ${job.id}: left out ${run.threadsSkipped} thread(s) of ${channelId} whose history Discord would not return`)
        }
        return
      }
      at = following
      done = new Set()
    }
  }

  /** The skip count, when it changed since the last PATCH that carried it. */
  private skippedPatch(run: Run): { authors_skipped?: number } {
    return run.authorsSkipped !== run.authorsSkippedSent ? { authors_skipped: run.authorsSkipped } : {}
  }

  /**
   * Imports one thread. `resumeBefore`: the walk of an earlier run stopped below this message.
   * `walked` records each page's oldest message.
   */
  private async importThread(
    run: Run,
    thread: ImportThreadLike,
    resumeBefore: string | null,
    walked: (before: string) => Promise<void>,
  ): Promise<void> {
    if (isPrivateThread(thread)) return
    const { job, signal } = run
    const channelId = job.discord_channel_id
    // A read of the parent channel: losing access there ends the job, not this thread.
    const starterAuthor = await this.discordCall(run, () => this.deps.starterMessageAuthor(channelId, thread.id))
    const starter = await this.discordCall(run, () => this.deps.threadStarter(thread))
    const invalidThread = (e: BridgeApiError) => e.status === 400 && e.code === 'invalid_thread'
    let harmonyThreadId: string
    try {
      harmonyThreadId = await this.harmonyCall(run, () => this.deps.api.importThread(job.id, {
        discord_thread_id: thread.id,
        name: starter.plainTitle ? 'Thread' : threadName(thread.name),
        created_at: (thread.createdAt ?? snowflakeTime(thread.id)).toISOString(),
        starter_discord_message_id: starterAuthor !== null ? thread.id : null,
        // Discord titles a thread on a message from the message: Harmony 1.9.8 weighs its author's
        // opt-out when the import left the message out.
        starter_discord_user_id: starterAuthor,
        discord_user: starter.discordUser,
        archived: thread.archived ?? false,
        locked: thread.locked ?? false,
      }, { signal }), invalidThread)
    } catch (error) {
      if (error instanceof BridgeApiError && invalidThread(error)) {
        // Harmony 1.9.8: a thread a person deleted there answers invalid_thread with this reason.
        if (error.details.reason === 'thread_deleted') throw new ThreadSkip('deleted in Harmony', true)
        throw new ThreadSkip('Harmony refused the thread')
      }
      throw error
    }
    // A thread starts below the recency cutoff, or below where an earlier run's walk stopped.
    await this.importPages(run, { discordId: thread.id, harmonyThreadId, pins: NO_PINS, resumeBefore, walked }, true)
  }

  /**
   * Pages through a channel's (thread's) history, newest first, posting batches. The walk starts
   * below the recency cutoff, or below the channel's reached marker or the thread's
   * `resumeBefore`. For the channel itself (no harmonyThreadId) the job's start and reached
   * markers are kept; a thread's position goes to `walked`, which records it in thread_cursor.
   */
  private async importPages(
    run: Run,
    scope: {
      discordId: string
      harmonyThreadId: string | null
      pins: ReadonlySet<string>
      resumeBefore?: string | null
      walked?: (before: string) => Promise<void>
    },
    skipOnLostAccess = false,
  ): Promise<void> {
    const job = run.job
    const isChannel = scope.harmonyThreadId === null
    let before = (isChannel ? job.reached_discord_message_id : scope.resumeBefore) ?? run.cutoff

    for (;;) {
      await this.checkAbort(run)

      const raw = await this.discordCall(run, () => this.deps.fetchPage(scope.discordId, before), skipOnLostAccess)
      if (raw.length === 0) return
      // Newest first, whatever order the fetcher produced.
      const page = [...raw].sort((a, b) => (newer(b.id, a.id) ? 1 : newer(a.id, b.id) ? -1 : 0))
      const old = page.filter(m => !newer(m.id, run.cutoff))

      if (isChannel && !job.start_discord_message_id && old.length > 0) {
        const newest = old[0]
        const patch = {
          start_discord_message_id: newest.id,
          start_at: newest.createdAt.toISOString(),
          channel_created_at: snowflakeTime(job.discord_channel_id).toISOString(),
        }
        await this.patch(run, patch)
        Object.assign(job, patch)
      }

      await this.importPage(run, old, scope)

      const oldest = page[page.length - 1]
      if (isChannel) {
        const reached = { reached_discord_message_id: oldest.id, reached_at: oldest.createdAt.toISOString() }
        await this.patch(run, { ...reached, ...this.skippedPatch(run) })
        Object.assign(job, reached)
        run.authorsSkippedSent = run.authorsSkipped
      } else {
        await scope.walked?.(oldest.id)
      }
      before = oldest.id

      await this.pageWait(run)
      await this.checkServerState(run)
      await this.keepAlive(run)
    }
  }

  /** Translates and posts the messages of one page whose authors are members and not opted out. */
  private async importPage(
    run: Run,
    page: DiscordMessage[],
    scope: { harmonyThreadId: string | null; pins: ReadonlySet<string> },
  ): Promise<void> {
    const { log, optOuts } = this.deps
    const job = run.job
    const candidates = page.filter(isImportableMessage)
    const optedOut = (m: DiscordMessage) => optOuts?.has(m.author.id) === true

    // One membership request per page. A failed request fails the page: an author who could not
    // be checked is not imported.
    const unknown = [...new Set(candidates.filter(m => !optedOut(m)).map(m => m.author.id))].filter(id => !run.members.has(id))
    if (unknown.length > 0) {
      const found = await this.discordCall(run, () => this.deps.fetchMembers(job.discord_channel_id, unknown))
      for (const id of unknown) run.members.set(id, found.get(id) ?? null)
    }

    const sources = new Map<string, { msg: DiscordMessage; member: GuildMember }>()
    const extras = (msg: DiscordMessage) => ({
      pinned: scope.pins.has(msg.id),
      ...(scope.harmonyThreadId ? { thread_id: scope.harmonyThreadId } : {}),
    })
    const build = async (msg: DiscordMessage, member: GuildMember, nativeStickers: boolean): Promise<ImportMessage | null> => {
      const translated = await this.deps.translate(msg, member, { nativeStickers })
      return translated ? { ...translated, ...extras(msg) } : null
    }

    const batch: ImportMessage[] = []
    for (const msg of candidates) {
      const member = optedOut(msg) ? null : run.members.get(msg.author.id)
      if (!member) {
        run.authorsSkipped++
        continue
      }
      try {
        const row = await build(msg, member, true)
        if (!row) continue
        batch.push(row)
        sources.set(msg.id, { msg, member })
      } catch (error) {
        log.warn(`History import ${job.id}: skipping Discord message ${msg.id}, translation failed: ${errorText(error)}`)
      }
    }

    // A message Harmony refuses with a native sticker part is sent once more with the sticker as
    // its image, as the live relay does. Any other refusal is final. A refusal does not say which
    // part it was for: the live link is forgotten once the image version is stored.
    const asImage = new Map<string, string | null>()
    const withImage = async (refused: ImportMessage): Promise<ImportMessage | null> => {
      const sticker = hasNativeSticker(refused)
      const source = sources.get(refused.discord_message_id)
      if (!sticker || !source || asImage.has(refused.discord_message_id)) return null
      asImage.set(refused.discord_message_id, typeof sticker.id === 'string' ? sticker.id : null)
      return build(source.msg, source.member, false).catch(() => null)
    }

    let pending = batch
    while (pending.length > 0) {
      const named = (e: BridgeApiError) => e.status === 400 && typeof e.details.discord_message_id === 'string'
      let result: ImportBatchResult
      try {
        result = await this.harmonyCall(run, () => this.deps.api.postImportMessages(job.id, pending, { signal: run.signal }), named)
      } catch (error) {
        // A gateway that refuses the whole batch for one message names it: that message goes, the rest is sent again.
        if (!(error instanceof BridgeApiError) || !named(error)) throw error
        const badId = error.details.discord_message_id as string
        const bad = pending.find(m => m.discord_message_id === badId)
        if (!bad) throw new Stop(await this.failed(run, error.code ?? `harmony_${error.status}`))
        const again = await withImage(bad)
        if (!again) log.warn(`History import ${job.id}: Harmony refused Discord message ${badId} (${error.code ?? error.status}); left out`)
        pending = pending.flatMap(m => (m !== bad ? [m] : again ? [again] : []))
        continue
      }

      for (const stored of result.inserted) {
        const stickerId = asImage.get(stored.discord_message_id)
        if (stickerId) this.deps.onStickerRefused?.(stickerId)
      }
      // Skipped ids may be stored too: a batch the bridge timed out on and the gateway committed.
      const answered = [...result.inserted.map(r => r.discord_message_id), ...result.skipped]
      if (answered.length > 0) this.deps.onImported?.(answered)

      const resend: ImportMessage[] = []
      const reasons = new Map<string, number>()
      for (const r of result.rejected) {
        const refused = pending.find(m => m.discord_message_id === r.discord_message_id)
        if (r.reason === 'opted_out') {
          const author = sources.get(r.discord_message_id)?.msg.author.id
          if (author) optOuts?.add(author)
        }
        const again = refused && (r.reason === 'invalid' || r.reason === 'check_violation') ? await withImage(refused) : null
        if (again) resend.push(again)
        else reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1)
      }
      if (reasons.size > 0) {
        log.info(`History import ${job.id}: Harmony left out ${[...reasons].map(([reason, n]) => `${n} ${reason}`).join(', ')}`)
      }
      pending = resend
    }
  }

  /** Re-reads the job from the server: an operator may have cancelled or paused it, or it may be gone. */
  private async checkServerState(run: Run): Promise<void> {
    const latest = await this.harmonyCall(run, () => this.deps.api.getImport(run.job.id, { signal: run.signal }))
    if (latest.state === 'failed') throw new Stop('failed')
    if (latest.state === 'cancelled') throw new Stop('cancelled')
    if (latest.state !== 'running') throw new Stop('paused')
    if (latest.cancel_requested) await this.cancel(run)
  }

  /** PATCHes cancelled, then unwinds run(). A PATCH that failed leaves the job for the next poll. */
  private async cancel(run: Run): Promise<never> {
    const cancelled = await this.bestEffortPatch(run.job.id, { state: 'cancelled' })
    throw new Stop(cancelled ? 'cancelled' : 'paused')
  }

  /** PATCHes failed with `error`, then unwinds run(). */
  private async fail(run: Run, error: string): Promise<never> {
    throw new Stop(await this.failed(run, error))
  }

  private async failed(run: Run, error: string): Promise<ImportResult> {
    await this.bestEffortPatch(run.job.id, { state: 'failed', error: error.slice(0, ERROR_MAX) })
    return 'failed'
  }

  /** Leaves the job paused on the server. A job that never reached `running` keeps its state. */
  private async park(run: Run): Promise<void> {
    if (run.started) await this.bestEffortPatch(run.job.id, { state: 'paused' })
  }

  /** Unwinds run() with 'paused' once the run is aborted. */
  private async checkAbort(run: Run): Promise<void> {
    if (!run.signal.aborted) return
    await this.park(run)
    throw new Stop('paused')
  }

  /** Sleeps `ms`, or unwinds run() as soon as the run is aborted. */
  private async wait(run: Run, ms: number): Promise<void> {
    await this.sleep(ms, run.signal).catch(() => {})
    await this.checkAbort(run)
  }

  private pageWait(run: Run): Promise<void> {
    return this.wait(run, Math.min(Math.max(this.deps.pageDelayMs, 0), PAGE_DELAY_CAP_MS))
  }

  /** One attempt with a short timeout and no abort signal: it also runs while the bridge stops. */
  private async bestEffortPatch(id: string, patch: Partial<ImportJob>): Promise<boolean> {
    try {
      await this.deps.api.updateImport(id, patch, { timeoutMs: PARK_TIMEOUT_MS })
      return true
    } catch (error) {
      this.deps.log.warn(`History import ${id}: could not PATCH ${JSON.stringify(patch)}: ${errorText(error)}`)
      return false
    }
  }

  private async patch(run: Run, patch: Partial<ImportJob>): Promise<unknown> {
    const result = await this.harmonyCall(run, () => this.deps.api.updateImport(run.job.id, patch, { signal: run.signal }))
    run.lastPatchAt = this.now()
    return result
  }

  /**
   * A PATCH of the skip count last sent when the job has had none for KEEPALIVE_MS: it changes no
   * state and no count. A partial count of a thread would be counted again by a resumed walk.
   */
  private async keepAlive(run: Run): Promise<void> {
    if (this.now() - run.lastPatchAt < KEEPALIVE_MS) return
    await this.patch(run, { authors_skipped: run.authorsSkippedSent })
  }

  /**
   * One Harmony call under the job's error policy.
   * - Network error, timeout, 5xx: retried after 1s, 2s, 4s, 8s, 16s, then the job is paused.
   * - 429: a wait Harmony asked for, of Retry-After. `import_busy` ends the run as 'waiting';
   *   any other 429 waits here and repeats the call. Neither counts as a retry or PATCHes.
   * - 409: the job is not in the state the call needs; the server's row decides (conflict()).
   * - 403 import_disabled: import was turned off; the run ends as 'disabled'.
   * - 404 import_not_found: the job is gone; 'failed' with no PATCH.
   * - Any other 4xx fails the job with the server's code as its `error`.
   * `passThrough` errors are rethrown as they are, for the caller to handle.
   */
  private async harmonyCall<T>(run: Run, call: () => Promise<T>, passThrough?: (error: BridgeApiError) => boolean): Promise<T> {
    const { log } = this.deps
    const id = run.job.id
    for (let attempt = 0; ;) {
      await this.checkAbort(run)
      try {
        return await untilAborted(call(), run.signal)
      } catch (error) {
        await this.checkAbort(run)
        if (!(error instanceof BridgeApiError) || error.status >= 500) {
          await this.backoffOrPause(run, attempt++, error)
          continue
        }
        if (passThrough?.(error)) throw error
        if (error.status === 429) {
          const waitMs = Math.min(error.retryAfterMs ?? RATE_WAIT_DEFAULT_MS, RATE_WAIT_CAP_MS)
          if (error.code === 'import_busy') {
            log.info(`History import ${id}: the instance runs its maximum number of imports; waiting ${Math.ceil(waitMs / 1000)} s`)
            throw new Stop('waiting', waitMs)
          }
          log.debug(`History import ${id}: Harmony asked to wait ${waitMs} ms (${error.code ?? 429})`)
          await this.wait(run, waitMs)
          continue
        }
        if (error.status === 409) {
          await this.conflict(run, error)
          await this.backoffOrPause(run, attempt++, error)
          continue
        }
        if (error.status === 403 && error.code === 'import_disabled') {
          log.warn(`History import ${id}: import is turned off for this bridge (${String(error.details.reason ?? 'no reason given')})`)
          throw new Stop('disabled')
        }
        if (error.status === 404 && error.code === 'import_not_found') {
          log.warn(`History import ${id}: the job is gone`)
          throw new Stop('failed')
        }
        log.error(`History import ${id}: Harmony rejected a request: ${errorText(error)}`)
        throw new Stop(await this.failed(run, error.code ?? `harmony_${error.status}`))
      }
    }
  }

  /**
   * A 409: the server's row says what the job is now. Ended jobs end the run with their state. A
   * queued or paused job goes back to the scheduler with no PATCH. A job still `running` lost a
   * race; the caller repeats its call.
   */
  private async conflict(run: Run, error: BridgeApiError): Promise<void> {
    const id = run.job.id
    this.deps.log.warn(`History import ${id}: Harmony answered ${error.code ?? 409}; reading the job's state`)
    let latest: ImportJob
    try {
      latest = await untilAborted(this.deps.api.getImport(id, { signal: run.signal }), run.signal)
    } catch (readError) {
      await this.checkAbort(run)
      if (readError instanceof BridgeApiError && readError.status === 404) throw new Stop('failed')
      if (readError instanceof BridgeApiError && readError.code === 'import_disabled') throw new Stop('disabled')
      throw new Stop('paused')
    }
    if (latest.state === 'failed' || latest.state === 'cancelled' || latest.state === 'done') throw new Stop(latest.state)
    if (latest.state !== 'running') throw new Stop('paused')
  }

  /**
   * One Discord read. Lost access fails the job (for a thread's own reads, `skipThread`, it skips
   * the thread instead); a channel the bridge cannot import fails it with that code; other
   * errors are retried with the same backoff, then the job is paused.
   */
  private async discordCall<T>(run: Run, call: () => Promise<T>, skipThread = false): Promise<T> {
    const id = run.job.id
    for (let attempt = 0; ; attempt++) {
      await this.checkAbort(run)
      try {
        return await untilAborted(call(), run.signal)
      } catch (error) {
        await this.checkAbort(run)
        const importError = (error as { importError?: unknown } | null)?.importError
        if (typeof importError === 'string') {
          if (skipThread) throw new ThreadSkip(importError)
          this.deps.log.warn(`History import ${id}: ${errorText(error)}`)
          await this.fail(run, importError)
        }
        const code = (error as { code?: unknown } | null)?.code
        if (typeof code === 'number' && ACCESS_LOST_CODES.has(code)) {
          if (skipThread) throw new ThreadSkip(`Discord error ${code}`)
          this.deps.log.warn(`History import ${id}: Discord access lost (${code})`)
          await this.fail(run, 'discord_access_lost')
        }
        await this.backoffOrPause(run, attempt, error)
      }
    }
  }

  private async backoffOrPause(run: Run, attempt: number, error: unknown): Promise<void> {
    const id = run.job.id
    if (attempt >= RETRY_BACKOFF_MS.length) {
      this.deps.log.warn(`History import ${id}: pausing after repeated failures: ${errorText(error)}`)
      await this.park(run)
      throw new Stop('paused')
    }
    this.deps.log.warn(`History import ${id}: transient failure, retry ${attempt + 1}/${RETRY_BACKOFF_MS.length}: ${errorText(error)}`)
    await this.wait(run, RETRY_BACKOFF_MS[attempt])
  }
}
