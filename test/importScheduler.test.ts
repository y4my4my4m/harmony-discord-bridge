import { describe, expect, it, vi } from 'vitest'
import { ImportScheduler, ImportSlots } from '../src/runtime/importScheduler.js'
import type { ImportJob } from '../src/v2/BridgeApi.js'
import type { ImportResult } from '../src/runtime/historyImport.js'
import type { Problem } from '../src/problems.js'
import { Logger } from '../src/log.js'

function job(id: string, over: Partial<ImportJob> = {}): ImportJob {
  return {
    id, harmony_channel_id: 'h1', discord_channel_id: '1001',
    state: 'queued', phase: 'messages', cancel_requested: false,
    start_discord_message_id: null, start_at: null,
    reached_discord_message_id: null, reached_at: null, channel_created_at: null,
    threads_total: null, threads_done: 0, thread_cursor: null,
    imported_count: 0, skipped_count: 0, pins_skipped: 0,
    error: null, requested_via: 'harmony',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', finished_at: null,
    ...over,
  }
}

const log = new Logger('error')

/** A run() that blocks until released, and records its signal. */
function gatedImporter() {
  const calls: { job: ImportJob; signal: AbortSignal; release: (r?: ImportResult) => void }[] = []
  const importer = {
    run: vi.fn((j: ImportJob, signal: AbortSignal) => new Promise<ImportResult>(resolve => {
      const call = { job: j, signal, release: (r: ImportResult = 'done') => resolve(r) }
      signal.addEventListener('abort', () => resolve('paused'))
      calls.push(call)
    })),
  }
  return { importer, calls }
}

function make(jobs: () => ImportJob[], over: Partial<ConstructorParameters<typeof ImportScheduler>[0]> = {}) {
  const gate = gatedImporter()
  const slots = new ImportSlots(1)
  const scheduler = new ImportScheduler({
    api: { listImports: vi.fn(async () => jobs()), updateImport: vi.fn(async () => job('x')) },
    importer: gate.importer,
    slots,
    pollMs: 3_600_000,
    intentsOk: () => true,
    log,
    ...over,
  })
  return { scheduler, slots, ...gate }
}

describe('ImportScheduler', () => {
  it('starts running before paused before queued, queued by created_at', async () => {
    const jobs = [
      job('q-late', { created_at: '2026-01-03T00:00:00Z' }),
      job('q-early', { created_at: '2026-01-02T00:00:00Z' }),
      job('p', { state: 'paused' }),
      job('r', { state: 'running' }),
    ]
    const order: string[] = []
    const a = make(() => jobs)
    a.scheduler.start()
    await vi.waitFor(() => expect(a.calls).toHaveLength(1))
    order.push(a.calls[0].job.id)
    jobs.splice(jobs.findIndex(j => j.id === 'r'), 1)
    a.calls[0].release('failed')
    await vi.waitFor(() => expect(a.calls).toHaveLength(2))
    order.push(a.calls[1].job.id)
    jobs.splice(jobs.findIndex(j => j.id === 'p'), 1)
    a.calls[1].release('failed')
    await vi.waitFor(() => expect(a.calls).toHaveLength(3))
    order.push(a.calls[2].job.id)
    expect(order).toEqual(['r', 'p', 'q-early'])
    await a.scheduler.stop()
  })

  it('never runs two jobs at once for one bridge', async () => {
    const jobs = [job('a'), job('b', { created_at: '2026-01-02T00:00:00Z' })]
    const { scheduler, importer, calls } = make(() => jobs)
    scheduler.start()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    scheduler.kick(); scheduler.kick()
    await new Promise(r => setTimeout(r, 20))
    expect(importer.run).toHaveBeenCalledTimes(1)
    await scheduler.stop()
  })

  it('makes the second bridge wait for the slot of ImportSlots(1)', async () => {
    const slots = new ImportSlots(1)
    const g1 = gatedImporter(); const g2 = gatedImporter()
    const mk = (id: string, g: ReturnType<typeof gatedImporter>) => new ImportScheduler({
      api: { listImports: vi.fn(async () => [job(id)]), updateImport: vi.fn(async () => job('x')) }, importer: g.importer, slots,
      pollMs: 3_600_000, intentsOk: () => true, log,
    })
    const s1 = mk('one', g1); const s2 = mk('two', g2)
    s1.start(); s2.start()
    await vi.waitFor(() => expect(g1.calls.length + g2.calls.length).toBe(1))
    await new Promise(r => setTimeout(r, 20))
    expect(g1.calls.length + g2.calls.length).toBe(1)
    const first = g1.calls.length ? g1 : g2
    const second = first === g1 ? g2 : g1
    first.calls[0].release('done')
    await vi.waitFor(() => expect(second.calls).toHaveLength(1))
    await s1.stop(); await s2.stop()
  })

  it('aborts the running job on stop() and waits for it', async () => {
    const { scheduler, calls } = make(() => [job('a')])
    scheduler.start()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].signal.aborted).toBe(false)
    await scheduler.stop()
    expect(calls[0].signal.aborted).toBe(true)
  })

  it('stop() also ends a job that is still waiting for a slot', async () => {
    const slots = new ImportSlots(1)
    const hold = await slots.acquire()
    const g = gatedImporter()
    const scheduler = new ImportScheduler({
      api: { listImports: vi.fn(async () => [job('a')]), updateImport: vi.fn(async () => job('x')) }, importer: g.importer, slots,
      pollMs: 3_600_000, intentsOk: () => true, log,
    })
    scheduler.start()
    await new Promise(r => setTimeout(r, 20))
    await scheduler.stop()
    expect(g.importer.run).not.toHaveBeenCalled()
    hold()
    await expect(Promise.race([slots.acquire().then(() => 'free'), new Promise(r => setTimeout(() => r('stuck'), 100))])).resolves.toBe('free')
  })

  it('does not run when the intent is off and raises the problem; clears it afterwards', async () => {
    let intent = false
    const raised: Problem[] = []
    const cleared: (string | undefined)[] = []
    const { scheduler, importer, calls } = make(() => [job('a')], {
      intentsOk: () => intent,
      problems: { raise: p => raised.push(p), clear: code => cleared.push(code) },
    })
    scheduler.start()
    await vi.waitFor(() => expect(raised.map(p => p.code)).toContain('message_content_needed_for_import'))
    expect(importer.run).not.toHaveBeenCalled()
    intent = true
    scheduler.kick()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(cleared).toContain('message_content_needed_for_import')
    await scheduler.stop()
  })

  it('clears import problems when a job ends and when nothing is queued', async () => {
    let jobs: ImportJob[] = [job('a')]
    const cleared: (string | undefined)[] = []
    const { scheduler, calls } = make(() => jobs, { problems: { raise: () => {}, clear: code => cleared.push(code) } })
    scheduler.start()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    cleared.length = 0
    jobs = []
    calls[0].release('done')
    await vi.waitFor(() => expect(cleared).toContain(undefined))
    cleared.length = 0
    scheduler.kick()
    await vi.waitFor(() => expect(cleared).toContain(undefined))
    await scheduler.stop()
  })

  it('keeps import problems when the job only paused (it will resume)', async () => {
    const cleared: (string | undefined)[] = []
    const { scheduler, calls } = make(() => [job('a', { state: 'paused' })], { problems: { raise: () => {}, clear: code => cleared.push(code) } })
    scheduler.start()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    cleared.length = 0
    calls[0].release('paused')
    await new Promise(r => setTimeout(r, 20))
    expect(cleared).not.toContain(undefined)
    await scheduler.stop()
  })

  it('moves on to the next queued job after a failed result', async () => {
    const jobs = [job('bad'), job('good', { created_at: '2026-01-02T00:00:00Z' })]
    const { scheduler, calls } = make(() => jobs)
    scheduler.start()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].job.id).toBe('bad')
    jobs.shift() // the server now reports it failed
    calls[0].release('failed')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].job.id).toBe('good')
    await scheduler.stop()
  })

  it('fails a job as bridge_stalled after 3 pauses without progress', async () => {
    const jobs = [job('a', { state: 'paused', reached_discord_message_id: '5' })]
    // Harmony's rule: a paused job may only go back to running; running may go to failed.
    const updateImport = vi.fn(async (_id: string, patch: Partial<ImportJob>) => {
      const from = jobs[0].state
      const ok = (from === 'paused' && patch.state === 'running') || (from === 'running' && patch.state === 'failed')
      if (!ok) throw new Error(`PATCH /bridge/v2/imports/:id failed (409 invalid_transition)`)
      jobs[0] = { ...jobs[0], state: patch.state! }
      return jobs[0]
    })
    const { scheduler, calls } = make(() => jobs, { api: { listImports: vi.fn(async () => jobs), updateImport } })
    scheduler.start()
    for (let n = 1; n <= 3; n++) {
      await vi.waitFor(() => expect(calls).toHaveLength(n))
      expect(updateImport).not.toHaveBeenCalled()
      calls[n - 1].release('paused')
      if (n < 3) { await vi.waitFor(() => expect(updateImport).not.toHaveBeenCalled()); await new Promise(r => setTimeout(r, 5)); scheduler.kick() }
    }
    await vi.waitFor(() => expect(jobs[0].state).toBe('failed'))
    expect(updateImport.mock.calls).toEqual([['a', { state: 'running' }], ['a', { state: 'failed', error: 'bridge_stalled' }]])
    await scheduler.stop()
  })

  it('resets the stall count when progress was made between pauses', async () => {
    const jobs = [job('a', { state: 'paused', reached_discord_message_id: '9' })]
    const updateImport = vi.fn(async () => job('a'))
    const { scheduler, calls } = make(() => jobs, { api: { listImports: vi.fn(async () => jobs), updateImport } })
    scheduler.start()
    for (let n = 1; n <= 5; n++) {
      await vi.waitFor(() => expect(calls).toHaveLength(n))
      jobs[0] = job('a', { state: 'paused', reached_discord_message_id: String(9 - Math.floor(n / 2)) })
      calls[n - 1].release('paused')
      await new Promise(r => setTimeout(r, 5))
      scheduler.kick()
    }
    await new Promise(r => setTimeout(r, 10))
    expect(updateImport).not.toHaveBeenCalled()
    await scheduler.stop()
  })

  it('lets a queued job run after another job just paused', async () => {
    const jobs = [job('stuck', { state: 'paused' }), job('fresh', { created_at: '2026-01-02T00:00:00Z' })]
    const { scheduler, calls } = make(() => jobs)
    scheduler.start()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].job.id).toBe('stuck')
    calls[0].release('paused')
    await new Promise(r => setTimeout(r, 5))
    scheduler.kick()
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].job.id).toBe('fresh')
    await scheduler.stop()
  })

  it('does not re-pick immediately a failed job that is still pending (its PATCH failed)', async () => {
    const jobs = [job('a', { state: 'running' })]
    const { scheduler, calls } = make(() => jobs)
    scheduler.start()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    calls[0].release('failed')
    await new Promise(r => setTimeout(r, 30))
    expect(calls).toHaveLength(1)
    await scheduler.stop()
  })

  it('skips a job cancelled while it waited for its slot', async () => {
    const slots = new ImportSlots(1)
    const hold = await slots.acquire()
    let jobs = [job('a')]
    const g = gatedImporter()
    const scheduler = new ImportScheduler({
      api: { listImports: vi.fn(async () => jobs), updateImport: vi.fn(async () => job('x')) }, importer: g.importer, slots,
      pollMs: 3_600_000, intentsOk: () => true, log,
    })
    scheduler.start()
    await new Promise(r => setTimeout(r, 20))
    jobs = [job('a', { state: 'cancelled' })]
    hold()
    await new Promise(r => setTimeout(r, 20))
    expect(g.importer.run).not.toHaveBeenCalled()
    await scheduler.stop()
  })

  it('survives a failing listImports and polls again', async () => {
    let fail = true
    const { scheduler, calls } = make(() => { if (fail) throw new Error('down'); return [job('a')] })
    scheduler.start()
    await new Promise(r => setTimeout(r, 20))
    fail = false
    scheduler.kick()
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await scheduler.stop()
  })
})

describe('ImportSlots', () => {
  it('hands out at most max slots and frees them in order', async () => {
    const slots = new ImportSlots(2)
    const a = await slots.acquire(); await slots.acquire()
    let third = false
    void slots.acquire().then(() => { third = true })
    await new Promise(r => setTimeout(r, 10))
    expect(third).toBe(false)
    a()
    await vi.waitFor(() => expect(third).toBe(true))
  })

  it('release is idempotent', async () => {
    const slots = new ImportSlots(1)
    const r = await slots.acquire()
    r(); r()
    let second = false
    void slots.acquire().then(() => { second = true })
    await vi.waitFor(() => expect(second).toBe(true))
    let third = false
    void slots.acquire().then(() => { third = true })
    await new Promise(r => setTimeout(r, 10))
    expect(third).toBe(false)
  })
})
