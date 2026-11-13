import { problemKey, type Problem, type ProblemCode } from '../problems.js'

/** How long a notice an import left stays in the status. */
export const IMPORT_NOTICE_TTL_MS = 60 * 60_000

/** A notice says what an import left out; nothing is wrong, and it outlives the job that raised it. */
const NOTICE_CODES: ReadonlySet<ProblemCode> = new Set(['private_threads_skipped'])

/**
 * Problems raised by history imports, for the bridge's status. A problem (the import is waiting
 * for an intent) lasts until it is cleared. A notice lasts IMPORT_NOTICE_TTL_MS, or until the
 * next import of its channel starts.
 */
export class ImportProblems {
  private readonly entries = new Map<string, { problem: Problem; until: number | null }>()

  constructor(
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** A problem of the same key replaces the one held: a new count is the count. */
  raise(problem: Problem): void {
    const key = problemKey(problem)
    const held = this.entries.get(key)
    const until = NOTICE_CODES.has(problem.code) ? this.now() + IMPORT_NOTICE_TTL_MS : null
    this.entries.set(key, { problem, until })
    if (!held || JSON.stringify(held.problem) !== JSON.stringify(problem)) this.onChange()
  }

  clear(code: ProblemCode): void {
    this.drop(p => p.code === code)
  }

  /** A new import of the channel starts: what the last one left out no longer describes it. */
  beginChannel(discordChannelId: string): void {
    this.drop(p => NOTICE_CODES.has(p.code) && p.params?.discord_channel_id === discordChannelId)
  }

  reset(): void {
    this.entries.clear()
  }

  current(): Problem[] {
    const now = this.now()
    for (const [key, { until }] of this.entries) {
      if (until !== null && until <= now) this.entries.delete(key)
    }
    return [...this.entries.values()].map(e => e.problem)
  }

  private drop(match: (p: Problem) => boolean): void {
    let changed = false
    for (const [key, { problem }] of this.entries) {
      if (!match(problem)) continue
      this.entries.delete(key)
      changed = true
    }
    if (changed) this.onChange()
  }
}
