import type { Message as DiscordMessage } from 'discord.js'
import { BridgeApiError, type BridgeApi, type ImportJob, type ImportMessage } from '../v2/BridgeApi.js'
import { errorText, type Logger } from '../log.js'
import type { Problem } from '../problems.js'
import { isPrivateThread, threadName } from './threadSync.js'

export type ImportResult = 'done' | 'cancelled' | 'failed' | 'paused'

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

export interface HistoryImporterDeps {
  api: Pick<BridgeApi, 'updateImport' | 'postImportMessages' | 'importThread' | 'linkImportReplies' | 'listImports'>
  /** One page of a channel's (or thread's) history, newest first, at most 100; `before` is exclusive. */
  fetchPage(channelId: string, before: string | undefined): Promise<DiscordMessage[]>
  /** Ids of the channel's pinned messages. */
  fetchPins(channelId: string): Promise<Set<string>>
  translate(msg: DiscordMessage): Promise<Omit<ImportMessage, 'thread_id' | 'pinned'> | null>
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
  /** Raises a problem (shown in /bridge status and reported to Harmony). */
  reportProblem(problem: Problem): void
  pageDelayMs: number
  sleep?: (ms: number) => Promise<void>
  log: Logger
}

/** Progress inside the threads phase, stored as the job's `thread_cursor`. */
interface ThreadProgress {
  /** The listThreads cursor of the page being worked through; null is the first page. */
  at: Record<string, unknown> | null
  /** Threads of that page already imported. */
  done: number
}

const DISCORD_EPOCH_MS = 1420070400000n
/** Missing access, missing permissions, unknown channel: Discord history is gone for good. */
const ACCESS_LOST_CODES = new Set([50001, 50013, 10003])
/** Backoff before each retry of a transient failure; the call is made once more after each wait. */
const RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000]
const NO_PINS: ReadonlySet<string> = new Set()

/** A thread's own Discord history is unreachable (deleted, no access): skip that thread, keep the job. */
class ThreadSkip extends Error {
  constructor(readonly code: number) {
    super(`thread skipped: Discord error ${code}`)
  }
}

/** Unwinds run() with its result. */
class Stop extends Error {
  constructor(readonly result: ImportResult) {
    super(`import stopped: ${result}`)
  }
}

const snowflakeTime = (id: string) => new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS))

/** Transient Harmony failure: network error, timeout, 5xx, or a 429 that survived the client's own retry. */
function isTransientApiError(error: unknown): boolean {
  if (!(error instanceof BridgeApiError)) return true
  return error.status >= 500 || error.status === 429
}

/** Copies Discord history into a Harmony channel through the bridge import API. */
export class HistoryImporter {
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly deps: HistoryImporterDeps) {
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /**
   * Runs one job through its messages, threads and replies phases, starting at the job's phase.
   * Resumable: progress is read from `reached_discord_message_id` (messages) and `thread_cursor`
   * (threads). Returns 'paused' when the scheduler should pick the job up again later (abort, or
   * retries exhausted or the server paused it), 'failed' when the job is over, 'cancelled' on
   * request, 'done' when the job finished (the PATCH to state done has been made).
   */
  async run(job: ImportJob, signal: AbortSignal): Promise<ImportResult> {
    const state = { ...job }
    try {
      // Always: a no-op for a job left 'running' by a crash, a transition for queued/paused.
      await this.patch(state, { state: 'running' })
      if (state.cancel_requested) await this.cancel(state)

      if (state.phase === 'messages') {
        await this.messagesPhase(state, signal)
        await this.patch(state, { phase: 'threads' })
        state.phase = 'threads'
      }
      if (state.phase === 'threads') {
        await this.threadsPhase(state, signal)
        await this.patch(state, { phase: 'replies' })
        state.phase = 'replies'
      }
      await this.harmonyCall(state, signal, () => this.deps.api.linkImportReplies(state.id))
      await this.patch(state, { state: 'done' }, signal)
      return 'done'
    } catch (error) {
      if (error instanceof Stop) return error.result
      this.deps.log.error(`History import ${job.id} crashed: ${errorText(error)}`)
      await this.bestEffortPatch(job.id, { state: 'paused' })
      return 'paused'
    }
  }

  private async messagesPhase(job: ImportJob, signal: AbortSignal): Promise<void> {
    const pins = await this.discordCall(job, signal, () => this.deps.fetchPins(job.discord_channel_id))
    await this.importPages(job, signal, { discordId: job.discord_channel_id, harmonyThreadId: null, pins })
  }

  private async threadsPhase(job: ImportJob, signal: AbortSignal): Promise<void> {
    const { log } = this.deps
    const channelId = job.discord_channel_id
    const saved = job.thread_cursor as Partial<ThreadProgress> | null
    let at = saved?.at ?? null
    let skip = saved?.done ?? 0
    let threadsDone = job.threads_done
    // Only a run that starts from the very top knows the full count.
    let fresh = !saved && threadsDone === 0
    let skippedThreads = 0

    let skippedPrivate = 0

    for (;;) {
      if (signal.aborted) return this.stop(await this.pause(job))
      const { threads, next, skippedPrivate: privateOnPage } = await this.discordCall(job, signal, () => this.deps.listThreads(channelId, at))
      skippedPrivate += privateOnPage ?? 0
      if (fresh && next === null) await this.patch(job, { threads_total: threads.length })
      fresh = false

      for (let i = skip; i < threads.length; i++) {
        try {
          await this.importThread(job, signal, threads[i])
        } catch (error) {
          if (!(error instanceof ThreadSkip)) throw error
          skippedThreads++
          log.warn(`History import ${job.id}: skipping thread ${threads[i].id} (Discord error ${error.code}); ${skippedThreads} skipped so far`)
        }
        threadsDone++
        const progress: ThreadProgress = i === threads.length - 1 && next ? { at: next, done: 0 } : { at, done: i + 1 }
        await this.patch(job, { threads_done: threadsDone, thread_cursor: { ...progress } }, signal)
        if (signal.aborted) return this.stop(await this.pause(job))
        await this.sleep(this.deps.pageDelayMs)
        if (signal.aborted) return this.stop(await this.pause(job))
        await this.checkServerState(job, signal)
      }
      if (!next) {
        if (skippedPrivate > 0) {
          log.warn(`History import ${job.id}: left out ${skippedPrivate} private thread(s) of ${channelId}`)
          this.deps.reportProblem({ code: 'private_threads_skipped', params: { discord_channel_id: channelId, count: String(skippedPrivate) } })
        }
        return
      }
      at = next
      skip = 0
    }
  }

  private async importThread(job: ImportJob, signal: AbortSignal, thread: ImportThreadLike): Promise<void> {
    if (isPrivateThread(thread)) return
    const channelId = job.discord_channel_id
    const hasStarter = await this.discordCall(job, signal, () => this.deps.hasStarterMessage(channelId, thread.id), true)
    const discordUser = await this.deps.threadStarter(thread).catch(() => null) ?? null
    const harmonyThreadId = await this.harmonyCall(job, signal, () => this.deps.api.importThread(job.id, {
      discord_thread_id: thread.id,
      name: threadName(thread.name),
      created_at: (thread.createdAt ?? snowflakeTime(thread.id)).toISOString(),
      starter_discord_message_id: hasStarter ? thread.id : null,
      discord_user: discordUser,
      archived: thread.archived ?? false,
      locked: thread.locked ?? false,
    }))
    // Each thread restarts from its newest message; the server dedupes, so a repeat is safe.
    await this.importPages(job, signal, { discordId: thread.id, harmonyThreadId, pins: NO_PINS }, true)
  }

  /**
   * Pages through a channel's (thread's) history, newest first, posting batches. For the channel
   * itself (no harmonyThreadId) the job's start and reached markers are kept; threads restart
   * from the newest message every time.
   */
  private async importPages(
    job: ImportJob,
    signal: AbortSignal,
    scope: { discordId: string; harmonyThreadId: string | null; pins: ReadonlySet<string> },
    skipOnLostAccess = false,
  ): Promise<void> {
    const { api, log } = this.deps
    const isChannel = scope.harmonyThreadId === null
    let before = isChannel ? job.reached_discord_message_id ?? undefined : undefined

    for (;;) {
      if (signal.aborted) return this.stop(await this.pause(job))

      const raw = await this.discordCall(job, signal, () => this.deps.fetchPage(scope.discordId, before), skipOnLostAccess)
      if (raw.length === 0) return
      // Newest first, whatever order the fetcher produced.
      const page = [...raw].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : BigInt(a.id) > BigInt(b.id) ? -1 : 0))

      if (isChannel && !job.start_discord_message_id) {
        const newest = page[0]
        const patch = {
          start_discord_message_id: newest.id,
          start_at: newest.createdAt.toISOString(),
          channel_created_at: snowflakeTime(job.discord_channel_id).toISOString(),
        }
        await this.patch(job, patch)
        Object.assign(job, patch)
      }

      const batch: ImportMessage[] = []
      for (const msg of page) {
        let translated: Awaited<ReturnType<HistoryImporterDeps['translate']>>
        try {
          translated = await this.deps.translate(msg)
        } catch (error) {
          log.warn(`History import ${job.id}: skipping Discord message ${msg.id}, translation failed: ${errorText(error)}`)
          continue
        }
        if (!translated) continue
        batch.push({
          ...translated,
          pinned: scope.pins.has(msg.id),
          ...(scope.harmonyThreadId ? { thread_id: scope.harmonyThreadId } : {}),
        })
      }
      if (batch.length > 0) {
        // `skipped` mixes empty and already-present ids; it says nothing about progress.
        await this.harmonyCall(job, signal, () => api.postImportMessages(job.id, batch))
      }

      const oldest = page[page.length - 1]
      if (isChannel) {
        const reached = { reached_discord_message_id: oldest.id, reached_at: oldest.createdAt.toISOString() }
        await this.patch(job, reached, signal)
        Object.assign(job, reached)
      }
      before = oldest.id

      if (signal.aborted) return this.stop(await this.pause(job))
      await this.sleep(this.deps.pageDelayMs)
      if (signal.aborted) return this.stop(await this.pause(job))

      await this.checkServerState(job, signal)
    }
  }

  /** Re-reads the job from the server: an operator may have cancelled or paused it, or it may be gone. */
  private async checkServerState(job: ImportJob, signal: AbortSignal): Promise<void> {
    const latest = (await this.harmonyCall(job, signal, () => this.deps.api.listImports())).find(j => j.id === job.id)
    if (!latest || latest.state === 'failed') throw new Stop('failed')
    if (latest.state === 'paused') throw new Stop('paused')
    if (latest.state === 'cancelled') throw new Stop('cancelled')
    if (latest.cancel_requested) await this.cancel(job)
  }

  private stop(result: ImportResult): never {
    throw new Stop(result)
  }

  /** PATCHes cancelled, then unwinds run() with 'cancelled'. */
  private async cancel(job: ImportJob): Promise<never> {
    await this.bestEffortPatch(job.id, { state: 'cancelled' })
    throw new Stop('cancelled')
  }

  private async pause(job: ImportJob): Promise<ImportResult> {
    await this.bestEffortPatch(job.id, { state: 'paused' })
    return 'paused'
  }

  private async bestEffortPatch(id: string, patch: Partial<ImportJob>): Promise<void> {
    try {
      await this.deps.api.updateImport(id, patch)
    } catch (error) {
      this.deps.log.warn(`History import ${id}: could not PATCH ${JSON.stringify(patch)}: ${errorText(error)}`)
    }
  }

  private patch(job: ImportJob, patch: Partial<ImportJob>, signal?: AbortSignal): Promise<unknown> {
    return this.harmonyCall(job, signal, () => this.deps.api.updateImport(job.id, patch))
  }

  /**
   * One Harmony call with the retry policy: transient failures are retried after 1s, 2s, 4s, 8s,
   * 16s, then the job is paused for the scheduler. 409: the server already stopped the job, so
   * 'failed' with no PATCH. Any other 4xx is not retried and fails the job.
   */
  private async harmonyCall<T>(job: ImportJob, signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call()
      } catch (error) {
        if (error instanceof BridgeApiError && error.status === 409) {
          this.deps.log.warn(`History import ${job.id}: stopped by the server (${error.code ?? 409})`)
          throw new Stop('failed')
        }
        if (!isTransientApiError(error)) {
          this.deps.log.error(`History import ${job.id}: Harmony rejected a request: ${errorText(error)}`)
          await this.bestEffortPatch(job.id, { state: 'failed', error: `harmony_${(error as BridgeApiError).status}` })
          throw new Stop('failed')
        }
        await this.backoffOrPause(job, signal, attempt, error)
      }
    }
  }

  /**
   * One Discord read. Lost access fails the job (for a thread's own reads, `skipThread`, it skips the thread instead); other errors are retried with the same backoff,
   * then the job is paused.
   */
  private async discordCall<T>(job: ImportJob, signal: AbortSignal, call: () => Promise<T>, skipThread = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call()
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        if (typeof code === 'number' && ACCESS_LOST_CODES.has(code)) {
          if (skipThread) throw new ThreadSkip(code)
          this.deps.log.warn(`History import ${job.id}: Discord access lost (${code})`)
          await this.bestEffortPatch(job.id, { state: 'failed', error: 'discord_access_lost' })
          throw new Stop('failed')
        }
        await this.backoffOrPause(job, signal, attempt, error)
      }
    }
  }

  private async backoffOrPause(job: ImportJob, signal: AbortSignal | undefined, attempt: number, error: unknown): Promise<void> {
    if (signal?.aborted || attempt >= RETRY_BACKOFF_MS.length) {
      this.deps.log.warn(`History import ${job.id}: pausing after repeated failures: ${errorText(error)}`)
      await this.bestEffortPatch(job.id, { state: 'paused' })
      throw new Stop('paused')
    }
    this.deps.log.warn(`History import ${job.id}: transient failure, retry ${attempt + 1}/${RETRY_BACKOFF_MS.length}: ${errorText(error)}`)
    await this.sleep(RETRY_BACKOFF_MS[attempt])
  }
}
