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
}

export interface ThreadListPage {
  threads: ImportThreadLike[]
  /** Opaque cursor for the next page; null when the listing is complete. */
  next: Record<string, unknown> | null
  /** Private threads left out of this page (they never cross the bridge). */
  skippedPrivate?: number
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
  /** Whether @everyone can view the channel. */
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
  /** Whether the thread was started from a message of the channel, i.e. a message with the thread's id exists. */
  hasStarterMessage(channelId: string, threadId: string): Promise<boolean>
  /** The Harmony discord_user of the member who started the thread, or null. */
  threadStarter(thread: ImportThreadLike): Promise<Record<string, unknown> | null>
  /** Opted-out Discord users of the server. Absent on a gateway without the privacy routes. */
  optOuts?: {
    /** Reads the list from Harmony. A run does not start on a list it could not read. */
    refresh(signal?: AbortSignal): Promise<void>
    has(discordUserId: string): boolean
    add(discordUserId: string): void
  }
  /** Harmony refused the native part of this Harmony sticker in a batch. */
  onStickerRefused?(harmonyStickerId: string): void
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
}

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
/** Longest `error` Harmony stores. */
const ERROR_MAX = 200
const NO_PINS: ReadonlySet<string> = new Set()

/** A thread's own Discord history is unreachable (deleted, no access): skip that thread, keep the job. */
class ThreadSkip extends Error {
  constructor(readonly reason: string) {
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
    }
    try {
      // Always: a no-op for a job left 'running' by a crash, a transition for queued/paused.
      await this.patch(run, { state: 'running' })
      run.started = true
      if (state.cancel_requested) await this.cancel(run)

      // A channel @everyone cannot view is imported only when someone on Discord asked for it.
      if (state.requested_via === 'harmony') {
        const open = await this.discordCall(run, () => this.deps.everyoneCanView(state.discord_channel_id))
        if (!open) {
          this.deps.log.warn(`History import ${state.id}: Discord channel ${state.discord_channel_id} is hidden from @everyone; it needs /bridge import-history on Discord`)
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
      await this.patch(run, { state: 'done' })
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
    // The notice tells the channel's members; the import runs without it.
    try {
      await untilAborted(this.deps.ensureNotice(channelId), run.signal)
    } catch (error) {
      if (!run.signal.aborted) this.deps.log.warn(`History import ${run.job.id}: could not post or pin the notice in Discord channel ${channelId}: ${errorText(error)}`)
    }
    const pins = await this.discordCall(run, () => this.deps.fetchPins(channelId))
    await this.importPages(run, { discordId: channelId, harmonyThreadId: null, pins })
  }

  private async threadsPhase(run: Run): Promise<void> {
    const { log } = this.deps
    const job = run.job
    const channelId = job.discord_channel_id
    const saved = job.thread_cursor as { at?: Record<string, unknown> | null; done?: unknown } | null
    let at = saved?.at ?? null
    // By id, not by position: a thread archived between runs shifts the list. A count saved by
    // an earlier build restarts its page; the server answers the repeats as skipped.
    let done = new Set<string>(Array.isArray(saved?.done) ? saved.done.filter((id): id is string => typeof id === 'string') : [])
    let threadsDone = job.threads_done
    let skippedPrivate = 0

    for (;;) {
      await this.checkAbort(run)
      const { threads, next, skippedPrivate: privateOnPage } = await this.discordCall(run, () => this.deps.listThreads(channelId, at))
      skippedPrivate += privateOnPage ?? 0
      const remaining = threads.filter(t => !done.has(t.id))
      // A lower bound until the last page is listed.
      const total = threadsDone + remaining.length
      if (job.threads_total !== total && (!next || total > (job.threads_total ?? 0))) {
        await this.patch(run, { threads_total: total })
        job.threads_total = total
      }

      for (const [i, thread] of remaining.entries()) {
        try {
          await this.importThread(run, thread)
        } catch (error) {
          if (!(error instanceof ThreadSkip)) throw error
          run.threadsSkipped++
          log.warn(`History import ${job.id}: skipping thread ${thread.id} (${error.reason}); ${run.threadsSkipped} skipped so far`)
        }
        threadsDone++
        done.add(thread.id)
        const progress: ThreadProgress = i === remaining.length - 1 && next ? { at: next, done: [] } : { at, done: [...done] }
        await this.patch(run, {
          threads_done: threadsDone,
          thread_cursor: { ...progress },
          ...(run.authorsSkipped !== run.authorsSkippedSent ? { authors_skipped: run.authorsSkipped } : {}),
        })
        run.authorsSkippedSent = run.authorsSkipped
        await this.pageWait(run)
        await this.checkServerState(run)
      }
      if (!next) {
        if (skippedPrivate > 0) {
          log.warn(`History import ${job.id}: left out ${skippedPrivate} private thread(s) of ${channelId}`)
          this.deps.reportProblem({ code: 'private_threads_skipped', params: { discord_channel_id: channelId, count: String(skippedPrivate) } })
        }
        if (run.threadsSkipped > 0) {
          log.warn(`History import ${job.id}: left out ${run.threadsSkipped} thread(s) of ${channelId} whose history Discord would not return`)
        }
        return
      }
      at = next
      done = new Set()
    }
  }

  private async importThread(run: Run, thread: ImportThreadLike): Promise<void> {
    if (isPrivateThread(thread)) return
    const { job, signal } = run
    const channelId = job.discord_channel_id
    // A read of the parent channel: losing access there ends the job, not this thread.
    const hasStarter = await this.discordCall(run, () => this.deps.hasStarterMessage(channelId, thread.id))
    const discordUser = await this.deps.threadStarter(thread).catch(() => null) ?? null
    const invalidThread = (e: BridgeApiError) => e.status === 400 && e.code === 'invalid_thread'
    let harmonyThreadId: string
    try {
      harmonyThreadId = await this.harmonyCall(run, () => this.deps.api.importThread(job.id, {
        discord_thread_id: thread.id,
        name: threadName(thread.name),
        created_at: (thread.createdAt ?? snowflakeTime(thread.id)).toISOString(),
        starter_discord_message_id: hasStarter ? thread.id : null,
        discord_user: discordUser,
        archived: thread.archived ?? false,
        locked: thread.locked ?? false,
      }, { signal }), invalidThread)
    } catch (error) {
      if (error instanceof BridgeApiError && invalidThread(error)) throw new ThreadSkip('Harmony refused the thread')
      throw error
    }
    // Each thread restarts below the recency cutoff; the server dedupes, so a repeat is safe.
    await this.importPages(run, { discordId: thread.id, harmonyThreadId, pins: NO_PINS }, true)
  }

  /**
   * Pages through a channel's (thread's) history, newest first, posting batches. The walk starts
   * below the recency cutoff. For the channel itself (no harmonyThreadId) the job's start and
   * reached markers are kept; threads restart from the cutoff every time.
   */
  private async importPages(
    run: Run,
    scope: { discordId: string; harmonyThreadId: string | null; pins: ReadonlySet<string> },
    skipOnLostAccess = false,
  ): Promise<void> {
    const job = run.job
    const isChannel = scope.harmonyThreadId === null
    let before = (isChannel ? job.reached_discord_message_id : null) ?? run.cutoff

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
      const skipped = run.authorsSkipped !== run.authorsSkippedSent ? { authors_skipped: run.authorsSkipped } : {}
      if (isChannel) {
        const reached = { reached_discord_message_id: oldest.id, reached_at: oldest.createdAt.toISOString() }
        await this.patch(run, { ...reached, ...skipped })
        Object.assign(job, reached)
        run.authorsSkippedSent = run.authorsSkipped
      }
      before = oldest.id

      await this.pageWait(run)
      await this.checkServerState(run)
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
    // its image, as the live relay does. Any other refusal is final.
    const asImage = new Set<string>()
    const withImage = async (refused: ImportMessage): Promise<ImportMessage | null> => {
      const sticker = hasNativeSticker(refused)
      const source = sources.get(refused.discord_message_id)
      if (!sticker || !source || asImage.has(refused.discord_message_id)) return null
      asImage.add(refused.discord_message_id)
      if (typeof sticker.id === 'string') this.deps.onStickerRefused?.(sticker.id)
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

  private patch(run: Run, patch: Partial<ImportJob>): Promise<unknown> {
    return this.harmonyCall(run, () => this.deps.api.updateImport(run.job.id, patch, { signal: run.signal }))
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
