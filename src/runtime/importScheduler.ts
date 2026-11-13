import { BridgeApiError, type BridgeApi, type ImportJob } from '../v2/BridgeApi.js'
import type { ImportOutcome, ImportResult } from './historyImport.js'
import { errorText, type Logger } from '../log.js'
import type { Problem, ProblemCode } from '../problems.js'

/** Counting semaphore: how many imports run at once among the schedulers that share it. */
export class ImportSlots {
  private free: number
  private readonly waiters: { grant: () => void }[] = []

  constructor(max: number) {
    this.free = Math.max(1, Math.floor(max))
  }

  /** Resolves with a release function (idempotent). Rejects, leaving the queue, when `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const take = () => {
        let released = false
        resolve(() => {
          if (released) return
          released = true
          this.release()
        })
      }
      if (this.free > 0) {
        this.free--
        return take()
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(new Error('aborted'))
      }
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort)
          take()
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private release() {
    const next = this.waiters.shift()
    if (next) next.grant()
    else this.free++
  }
}

export interface ImportSchedulerDeps {
  api: Pick<BridgeApi, 'listImports' | 'getImport' | 'updateImport'>
  importer: { run(job: ImportJob, signal: AbortSignal): Promise<ImportResult | ImportOutcome> }
  slots: ImportSlots
  pollMs: number
  /** Whether the Message Content intent is on. Without it Discord returns empty history. */
  intentsOk(): boolean
  /** Whether Discord is connected; jobs wait (silently) until it is. Default: always. */
  ready?(): boolean
  /**
   * Problems of this bridge raised by imports. `clear(code)` drops the ones of that code;
   * `beginChannel` drops the notices an earlier import of the channel left.
   */
  problems?: { raise(problem: Problem): void; clear(code: ProblemCode): void; beginChannel?(discordChannelId: string): void }
  now?: () => number
  log?: Pick<Logger, 'info' | 'warn' | 'error' | 'debug'>
}

const PRIORITY: Partial<Record<ImportJob['state'], number>> = { running: 0, paused: 1, queued: 2 }

/** Consecutive pauses without any progress after which a job is failed as stalled. */
const STALL_LIMIT = 3
/** A job Harmony asked to wait for, with no Retry-After. */
const WAIT_DEFAULT_MS = 60_000

/** What counts as progress between two pauses of a job. */
const fingerprint = (j: ImportJob) =>
  JSON.stringify([j.reached_discord_message_id, j.phase, j.thread_cursor, j.threads_done])

/**
 * Picks the job to work on: jobs this process did not just pause first (`running` left by a crash,
 * then `paused`, then `queued` by creation time), then the ones it paused, least recently paused
 * first, so one stuck job never blocks the others. A job told to wait is skipped until `notBefore`.
 */
function nextJob(jobs: ImportJob[], pausedAt: ReadonlyMap<string, number>, notBefore: ReadonlyMap<string, number>, now: number): ImportJob | null {
  const pending = jobs.filter(j => PRIORITY[j.state] !== undefined && (notBefore.get(j.id) ?? 0) <= now)
  pending.sort((a, b) =>
    (pausedAt.get(a.id) ?? 0) - (pausedAt.get(b.id) ?? 0)
    || PRIORITY[a.state]! - PRIORITY[b.state]!
    || Date.parse(a.created_at) - Date.parse(b.created_at)
    || a.id.localeCompare(b.id))
  return pending[0] ?? null
}

const isRefusal = (err: unknown): boolean => err instanceof BridgeApiError && (err.status === 403 || err.status === 404)

/**
 * Runs one history import at a time for one bridge. While armed it polls GET /imports; a job
 * also needs a free slot of the process-wide ImportSlots before it starts. It is armed only
 * while Harmony's configuration enables import, and disarms itself when the import routes
 * answer 403 or 404: an unarmed scheduler sends nothing.
 */
export class ImportScheduler {
  private timer: NodeJS.Timeout | null = null
  private current: Promise<void> | null = null
  private polling = false
  private abort: AbortController | null = null
  private stopped = false
  private lastPollError = ''
  private readonly now: () => number
  /** In memory: when (a counter) this process last saw each job pause; 0/absent = not paused by us. */
  private readonly pausedAt = new Map<string, number>()
  private pauseCounter = 0
  /** In memory: the progress fingerprint at the last pause and how many pauses in a row left it unchanged. */
  private readonly stalls = new Map<string, { fingerprint: string; count: number }>()
  /** In memory: the time before which a job is not picked; Harmony asked for a wait. */
  private readonly notBefore = new Map<string, number>()

  constructor(private readonly deps: ImportSchedulerDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Whether the scheduler polls. */
  isArmed(): boolean {
    return this.timer !== null
  }

  /** Starts polling, at once and then every `pollMs`. No-op while armed or after stop(). */
  arm(): void {
    if (this.stopped || this.timer) return
    this.lastPollError = ''
    this.timer = setInterval(() => this.kick(), this.deps.pollMs)
    this.timer.unref?.()
    this.kick()
  }

  /** Stops polling and aborts the running job (the importer leaves it `paused`). arm() resumes. */
  disarm(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.abort?.abort()
  }

  /** Disarms for good and waits for the running job to unwind. */
  async stop(): Promise<void> {
    this.stopped = true
    this.disarm()
    await this.current
  }

  /** Polls now instead of at the next interval. No-op while not armed. */
  kick(): void {
    if (this.stopped || !this.timer || this.polling || this.current) return
    this.polling = true
    void this.poll().finally(() => { this.polling = false })
  }

  private async poll(): Promise<void> {
    const { api, problems, log } = this.deps
    let jobs: ImportJob[]
    try {
      jobs = await api.listImports()
      this.lastPollError = ''
    } catch (err) {
      if (isRefusal(err)) {
        // Import is off for this bridge, or the gateway has no import routes.
        log?.info(`History import is not available (${errorText(err)}); polling stops until the configuration changes`)
        this.disarm()
        return
      }
      const line = errorText(err)
      if (line !== this.lastPollError) {
        this.lastPollError = line
        log?.debug(`History import poll failed: ${line}`)
      }
      return
    }
    if (this.stopped || !this.timer || this.current) return

    for (const id of [...new Set([...this.pausedAt.keys(), ...this.notBefore.keys()])]) {
      if (!jobs.some(j => j.id === id && PRIORITY[j.state] !== undefined)) this.forget(id)
    }
    const job = nextJob(jobs, this.pausedAt, this.notBefore, this.now())
    if (!job) {
      if (!jobs.some(j => PRIORITY[j.state] !== undefined)) problems?.clear('message_content_needed_for_import')
      return
    }
    if (this.deps.ready && !this.deps.ready()) return
    if (!this.deps.intentsOk()) {
      problems?.raise({ code: 'message_content_needed_for_import' })
      return
    }
    problems?.clear('message_content_needed_for_import')

    const abort = new AbortController()
    this.abort = abort
    this.current = this.runJob(job, abort.signal).finally(() => {
      this.current = null
      this.abort = null
    })
  }

  private async runJob(first: ImportJob, signal: AbortSignal): Promise<void> {
    const { api, importer, slots, problems, log } = this.deps
    let release: (() => void) | null = null
    let outcome: ImportOutcome | null = null
    try {
      release = await slots.acquire(signal)
      // The wait for a slot can be long; the job may have been cancelled or changed meanwhile.
      const fresh = await api.getImport(first.id, { signal })
      if (PRIORITY[fresh.state] === undefined || signal.aborted) return
      problems?.beginChannel?.(fresh.discord_channel_id)
      const out = await importer.run(fresh, signal)
      outcome = typeof out === 'string' ? { result: out } : out
      log?.info(`History import ${first.id}: ${outcome.result}`)
    } catch (err) {
      if (signal.aborted) return
      if (isRefusal(err) && !(err instanceof BridgeApiError && err.code === 'import_not_found')) {
        this.disarm()
        return
      }
      log?.warn(`History import ${first.id} could not run: ${errorText(err)}`)
    } finally {
      release?.()
    }
    if (!outcome || signal.aborted) return
    const { result } = outcome
    if (result === 'disabled') {
      this.disarm()
      return
    }
    if (result === 'waiting') {
      // Harmony's own wait: not a pause, so no stall is counted.
      this.notBefore.set(first.id, this.now() + (outcome.retryAfterMs ?? WAIT_DEFAULT_MS))
      return
    }
    // A job still pending after pausing (or after a failed PATCH) waits for the normal poll.
    let again = true
    if (result === 'paused' || result === 'failed') again = !(await this.afterStop(first.id))
    else this.forget(first.id)
    if (again && !this.stopped) setImmediate(() => this.kick())
  }

  private forget(id: string): void {
    this.pausedAt.delete(id)
    this.stalls.delete(id)
    this.notBefore.delete(id)
  }

  /**
   * Bookkeeping after a job paused or failed: remembers the pause (so other jobs go first) and
   * fails a job that paused STALL_LIMIT times in a row without progress. Returns whether the job
   * is still pending on the server.
   */
  private async afterStop(id: string): Promise<boolean> {
    const { api, log } = this.deps
    let latest: ImportJob
    try {
      latest = await api.getImport(id)
    } catch (err) {
      if (err instanceof BridgeApiError && err.status === 404) {
        this.forget(id)
        return false
      }
      return true
    }
    if (PRIORITY[latest.state] === undefined) {
      this.forget(id)
      return false
    }
    this.pausedAt.set(id, ++this.pauseCounter)
    const fp = fingerprint(latest)
    const prev = this.stalls.get(id)
    const count = prev && prev.fingerprint === fp ? prev.count + 1 : 1
    this.stalls.set(id, { fingerprint: fp, count })
    if (count >= STALL_LIMIT) {
      log?.warn(`History import ${id}: no progress after ${count} pauses, failing it`)
      try {
        // Harmony only lets a running job fail; a queued or paused one goes to running first.
        if (latest.state !== 'running') await api.updateImport(id, { state: 'running' })
        await api.updateImport(id, { state: 'failed', error: 'bridge_stalled' })
        this.forget(id)
        return false
      } catch (err) {
        // A job Harmony will not let run now (its cap on imports) is waiting, not stalled.
        if (err instanceof BridgeApiError && err.status === 429) this.stalls.delete(id)
        log?.warn(`History import ${id}: could not PATCH it failed: ${errorText(err)}`)
      }
    }
    return true
  }
}
