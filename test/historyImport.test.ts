import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Collection, MessageType } from 'discord.js'
import { HistoryImporter, PAGE_DELAY_CAP_MS, RECENCY_MARGIN_MS, importUnsupported, isImportableMessage, snowflakeAt } from '../src/runtime/historyImport.js'
import { BridgeApiError, type ImportJob, type ImportMessage } from '../src/v2/BridgeApi.js'
import { BridgeRuntime } from '../src/runtime/BridgeRuntime.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { APPLICATION_FLAGS } from '../src/runtime/discordConnection.js'
import { Logger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'
import { FakeDiscordClient, appResponse, discordError, fakeMember, fakeTextChannel } from './fakeDiscord.js'

// Snowflake ids are strictly increasing; newer messages have larger ids.
const SNOW = (n: number) => String(1_000_000_000_000_000_000n + BigInt(n))
const DAY0 = Date.parse('2026-01-01T00:00:00Z')
/** The importer's clock: SNOW ids are years older than its recency cutoff. */
const NOW = Date.parse('2026-06-01T12:00:00Z')
const CUTOFF = snowflakeAt(NOW - RECENCY_MARGIN_MS)

function job(over: Partial<ImportJob> = {}): ImportJob {
  return {
    id: 'job-1', harmony_channel_id: 'h1', discord_channel_id: '1001',
    state: 'queued', phase: 'messages', cancel_requested: false,
    start_discord_message_id: null, start_at: null,
    reached_discord_message_id: null, reached_at: null, channel_created_at: null,
    threads_total: null, threads_done: 0, thread_cursor: null,
    imported_count: 0, skipped_count: 0, pins_skipped: 0,
    error: null, requested_via: 'discord',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', finished_at: null,
    ...over,
  }
}

/** Discord messages numbered 1..n, oldest = 1; returned newest-first like Discord. */
function history(n: number, over: (i: number) => Record<string, any> = () => ({})) {
  return Array.from({ length: n }, (_, k) => {
    const i = n - k
    return {
      id: SNOW(i), createdAt: new Date(DAY0 + i * 1000), content: `m${i}`,
      author: { id: 'u1', bot: false }, type: MessageType.Default, ...over(i),
    } as any
  })
}

/** fetchPage over a newest-first history: `before` is exclusive. */
function pager(all: any[]) {
  return vi.fn(async (_channel: string, before: string | undefined) => {
    const rest = before ? all.filter(m => BigInt(m.id) < BigInt(before)) : all
    return rest.slice(0, 100)
  })
}

function setup(opts: {
  all?: any[]
  jobOver?: Partial<ImportJob>
  translate?: (m: any, member: any, o: { nativeStickers: boolean }) => Promise<any>
  pins?: Set<string>
  /** What GET /imports/:id answers; default: the job, running. */
  getImport?: () => Promise<ImportJob>
  /** Author ids that are not guild members. */
  absent?: string[]
  /** Author ids on the opt-out list. Undefined: a gateway without the privacy routes. */
  optedOut?: string[]
  everyoneCanView?: boolean
  pageDelayMs?: number
  /** Pages of threads handed out by listThreads, keyed by the cursor's `page` (0 = first). */
  threadPages?: any[][]
  threadMessages?: Record<string, any[]>
  starters?: Set<string>
  /** Private threads each listing page reports as filtered out. */
  skippedPrivate?: number[]
  listThreads?: (channel: string, cursor: Record<string, unknown> | null) => Promise<any>
} = {}) {
  const all = opts.all ?? []
  const patches: Array<Record<string, unknown>> = []
  const posts: ImportMessage[][] = []
  const api = {
    updateImport: vi.fn(async (_id: string, patch: any, _o?: unknown) => { patches.push(patch); return job() }),
    postImportMessages: vi.fn(async (_id: string, messages: ImportMessage[], _o?: unknown) => {
      posts.push(messages)
      return {
        inserted: messages.map(m => ({ discord_message_id: m.discord_message_id, id: `hm-${m.discord_message_id}` })),
        skipped: [] as string[],
        rejected: [] as { discord_message_id: string; reason: string }[],
      }
    }),
    importThread: vi.fn(async (_id: string, _body: any, _o?: unknown) => 'thread-1'),
    linkImportReplies: vi.fn(async (_id: string, _o?: unknown) => 0),
    getImport: vi.fn(async (_id: string, _o?: unknown) => (opts.getImport ? opts.getImport() : job({ ...opts.jobOver, state: 'running' }))),
  }
  const channelPager = pager(all)
  const threadPagers = new Map(Object.entries(opts.threadMessages ?? {}).map(([id, msgs]) => [id, pager(msgs)]))
  const fetchPage = vi.fn((channel: string, before: string | undefined) =>
    (threadPagers.get(channel) ?? channelPager)(channel, before))
  const threadPages = opts.threadPages ?? []
  const listThreads = vi.fn(opts.listThreads ?? (async (_channel: string, cursor: Record<string, unknown> | null) => {
    const page = typeof cursor?.page === 'number' ? cursor.page : 0
    const threads = threadPages[page] ?? []
    return { threads, next: page + 1 < threadPages.length ? { page: page + 1 } : null, skippedPrivate: opts.skippedPrivate?.[page] }
  }))
  const absent = new Set(opts.absent ?? [])
  const fetchMembers = vi.fn(async (_channel: string, ids: string[]) =>
    new Map(ids.filter(id => !absent.has(id)).map(id => [id, { id } as any])))
  const optedOut = opts.optedOut ? new Set(opts.optedOut) : null
  const optOuts = optedOut && {
    refresh: vi.fn(async (_signal?: AbortSignal) => {}),
    has: (id: string) => optedOut.has(id),
    add: vi.fn((id: string) => { optedOut.add(id) }),
  }
  const everyoneCanView = vi.fn(async () => opts.everyoneCanView ?? true)
  const ensureNotice = vi.fn(async (_channel: string) => {})
  const onStickerRefused = vi.fn()
  const reportProblem = vi.fn()
  const sleeps: number[] = []
  const log = new Logger('debug', '', true)
  const importer = new HistoryImporter({
    api,
    fetchPage,
    fetchPins: vi.fn(async () => opts.pins ?? new Set<string>()),
    fetchMembers,
    everyoneCanView,
    ensureNotice,
    translate: opts.translate ?? (async (m: any, member: any) => !isImportableMessage(m) ? null : ({
      discord_message_id: m.id, created_at: m.createdAt.toISOString(), edited_at: null,
      content: [{ type: 'text', text: m.content }], discord_user: { id: member.id },
      reply_to_discord_message_id: null,
    })),
    listThreads,
    hasStarterMessage: vi.fn(async (_c: string, threadId: string) => opts.starters?.has(threadId) ?? false),
    threadStarter: vi.fn(async (t: any) => (t.ownerId ? { id: t.ownerId } : null)),
    ...(optOuts ? { optOuts } : {}),
    onStickerRefused,
    reportProblem,
    pageDelayMs: opts.pageDelayMs ?? 7,
    now: () => NOW,
    sleep: async (ms: number) => { sleeps.push(ms) },
    log,
  })
  const j = job({ ...opts.jobOver })
  return { importer, api, patches, posts, fetchPage, fetchMembers, everyoneCanView, ensureNotice, onStickerRefused, optOuts, sleeps, j, listThreads, reportProblem, log }
}

const stateOf = (patches: Array<Record<string, unknown>>) => patches.filter(p => 'state' in p).map(p => p.state)
/** Runs the job to its end and answers how it ended. */
const run = async (importer: HistoryImporter, j: ImportJob, signal = new AbortController().signal) => (await importer.run(j, signal)).result
const ids = (batch: ImportMessage[]) => batch.map(m => m.discord_message_id)

describe('HistoryImporter messages phase', () => {
  it('pages newest-first below the recency cutoff, patches reached after each page and freezes start once', async () => {
    const { importer, api, patches, posts, fetchPage, j } = setup({ all: history(250) })
    expect(await run(importer, j)).toBe('done')

    expect(posts.map(p => p.length)).toEqual([100, 100, 50])
    expect(posts[0][0].discord_message_id).toBe(SNOW(250))
    expect(posts[2].at(-1)!.discord_message_id).toBe(SNOW(1))
    expect(fetchPage.mock.calls.map(c => c[1])).toEqual([CUTOFF, SNOW(151), SNOW(51), SNOW(1)])
    expect(patches[0]).toEqual({ state: 'running' })
    const starts = patches.filter(p => 'start_discord_message_id' in p)
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject({
      start_discord_message_id: SNOW(250),
      start_at: new Date(DAY0 + 250_000).toISOString(),
      channel_created_at: new Date(Number((BigInt('1001') >> 22n) + 1420070400000n)).toISOString(),
    })
    expect(patches.filter(p => 'reached_discord_message_id' in p).map(p => p.reached_discord_message_id))
      .toEqual([SNOW(151), SNOW(51), SNOW(1)])
    expect(patches.slice(-4)).toEqual([{ phase: 'threads' }, { threads_total: 0 }, { phase: 'replies' }, { state: 'done' }])
    expect(api.getImport).toHaveBeenCalled()
  })

  it('resumes paging before the reached message and does not refreeze start', async () => {
    const { importer, patches, posts, fetchPage, j } = setup({
      all: history(30),
      jobOver: { state: 'running', reached_discord_message_id: SNOW(11), start_discord_message_id: SNOW(30), start_at: 'x', channel_created_at: 'y' },
    })
    expect(await run(importer, j)).toBe('done')
    expect(fetchPage.mock.calls[0][1]).toBe(SNOW(11))
    expect(posts).toHaveLength(1)
    expect(posts[0]).toHaveLength(10)
    expect(patches[0]).toEqual({ state: 'running' })
    expect(patches.some(p => 'start_discord_message_id' in p)).toBe(false)
  })

  it('does not post bot, webhook and system messages', async () => {
    const all = history(8, i => i === 2 ? { author: { id: 'b', bot: true } }
      : i === 4 ? { type: MessageType.ChannelPinnedMessage }
        : i === 6 ? { webhookId: 'wh-1', author: { id: 'wh-1', bot: false } } : {})
    const { importer, posts, patches, fetchMembers, j } = setup({ all })
    await run(importer, j)
    expect(ids(posts[0])).toEqual([SNOW(8), SNOW(7), SNOW(5), SNOW(3), SNOW(1)])
    // Their authors are never looked up either.
    expect(fetchMembers.mock.calls.map(c => c[1])).toEqual([['u1']])
    // Progress still reaches the oldest message of the page, dropped or not.
    expect(patches.find(p => 'reached_discord_message_id' in p)!.reached_discord_message_id).toBe(SNOW(1))
  })

  it('sets pinned from the pin set', async () => {
    const { importer, posts, j } = setup({ all: history(3), pins: new Set([SNOW(2)]) })
    await run(importer, j)
    expect(posts[0].map(m => [m.discord_message_id, m.pinned])).toEqual([[SNOW(3), false], [SNOW(2), true], [SNOW(1), false]])
  })

  it('moves an empty channel straight to threads without posting', async () => {
    const { importer, posts, patches, j } = setup({ all: [] })
    expect(await run(importer, j)).toBe('done')
    expect(posts).toHaveLength(0)
    expect(patches).toEqual([{ state: 'running' }, { phase: 'threads' }, { threads_total: 0 }, { phase: 'replies' }, { state: 'done' }])
  })

  it('returns cancelled and patches cancelled when cancel_requested is set after a page', async () => {
    const { importer, patches, posts, j } = setup({
      all: history(250),
      getImport: async () => job({ state: 'running', cancel_requested: true }),
    })
    expect(await run(importer, j)).toBe('cancelled')
    expect(posts).toHaveLength(1)
    expect(patches.at(-1)).toEqual({ state: 'cancelled' })
  })

  it('returns paused, not cancelled, when the PATCH to cancelled fails', async () => {
    const { importer, api, patches, j } = setup({ all: history(5), jobOver: { cancel_requested: true } })
    api.updateImport.mockImplementation(async (_id: string, patch: any) => {
      if (patch.state === 'cancelled') throw new BridgeApiError('down', 503)
      patches.push(patch)
      return job()
    })
    expect(await run(importer, j)).toBe('paused')
    expect(stateOf(patches)).toEqual(['running'])
  })

  it('returns paused and patches paused when aborted', async () => {
    const ac = new AbortController()
    const { importer, patches, posts, api, j } = setup({ all: history(250) })
    api.postImportMessages.mockImplementationOnce(async (_id: string, messages: ImportMessage[]) => {
      posts.push(messages)
      ac.abort()
      return { inserted: [], skipped: [], rejected: [] }
    })
    expect(await run(importer, j, ac.signal)).toBe('paused')
    expect(posts).toHaveLength(1)
    expect(patches.at(-1)).toEqual({ state: 'paused' })
  })

  it.each([50001, 50013, 10003])('patches failed discord_access_lost on Discord error %i', async (code) => {
    const { importer, patches, fetchPage, j } = setup({ all: history(5) })
    fetchPage.mockRejectedValue(discordError(code))
    expect(await run(importer, j)).toBe('failed')
    expect(patches.at(-1)).toEqual({ state: 'failed', error: 'discord_access_lost' })
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('fails at once with discord_channel_unsupported for a channel that cannot be imported', async () => {
    const { importer, patches, fetchPage, sleeps, j } = setup({ all: history(5) })
    fetchPage.mockRejectedValue(importUnsupported('Discord channel 1001 holds no messages (type 15)'))
    expect(await run(importer, j)).toBe('failed')
    expect(patches.at(-1)).toEqual({ state: 'failed', error: 'discord_channel_unsupported' })
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })

  it('retries other Discord errors with backoff, then pauses', async () => {
    const { importer, patches, fetchPage, sleeps, j } = setup({ all: history(5) })
    fetchPage.mockRejectedValue(discordError(500, 'boom', 500))
    expect(await run(importer, j)).toBe('paused')
    expect(fetchPage).toHaveBeenCalledTimes(6)
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(patches.at(-1)).toEqual({ state: 'paused' })
  })

  it('retries a batch post through two 503s and continues', async () => {
    const { importer, api, posts, sleeps, j } = setup({ all: history(150) })
    const real = api.postImportMessages.getMockImplementation()!
    api.postImportMessages
      .mockRejectedValueOnce(new BridgeApiError('down', 503))
      .mockRejectedValueOnce(new BridgeApiError('down', 503))
      .mockImplementation(real)
    expect(await run(importer, j)).toBe('done')
    expect(api.postImportMessages).toHaveBeenCalledTimes(4)
    expect(posts.map(p => p.length)).toEqual([100, 50])
    expect(sleeps.slice(0, 2)).toEqual([1000, 2000])
  })

  it('pauses after six failed batch posts', async () => {
    const { importer, api, patches, sleeps, j } = setup({ all: history(5) })
    api.postImportMessages.mockRejectedValue(new TypeError('fetch failed'))
    expect(await run(importer, j)).toBe('paused')
    expect(api.postImportMessages).toHaveBeenCalledTimes(6)
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(patches.at(-1)).toEqual({ state: 'paused' })
    expect(patches.some(p => 'reached_discord_message_id' in p)).toBe(false)
  })

  it('retries a PATCH that fails transiently', async () => {
    const { importer, api, patches, j } = setup({ all: [] })
    api.updateImport.mockRejectedValueOnce(new BridgeApiError('down', 502))
    expect(await run(importer, j)).toBe('done')
    expect(patches).toEqual([{ state: 'running' }, { phase: 'threads' }, { threads_total: 0 }, { phase: 'replies' }, { state: 'done' }])
  })

  it('returns cancelled at once when cancel_requested is already set at run start', async () => {
    const { importer, patches, fetchPage, j } = setup({ all: history(5), jobOver: { cancel_requested: true } })
    expect(await run(importer, j)).toBe('cancelled')
    expect(fetchPage).not.toHaveBeenCalled()
    expect(patches).toEqual([{ state: 'running' }, { state: 'cancelled' }])
  })

  it('returns failed without a PATCH when the job is gone from the server', async () => {
    const { importer, patches, posts, j } = setup({
      all: history(250),
      getImport: async () => { throw new BridgeApiError('GET failed (404 import_not_found)', 404, 'import_not_found') },
    })
    expect(await run(importer, j)).toBe('failed')
    expect(posts).toHaveLength(1)
    expect(stateOf(patches)).toEqual(['running'])
  })

  it.each([
    ['failed', 'failed', ['running']],
    ['paused', 'paused', ['running']],
    ['cancelled', 'cancelled', ['running']],
  ] as const)('follows server state %s found on the page re-read', async (serverState, result, states) => {
    const { importer, patches, posts, j } = setup({
      all: history(250), getImport: async () => job({ state: serverState }),
    })
    expect(await run(importer, j)).toBe(result)
    expect(posts).toHaveLength(1)
    expect(stateOf(patches)).toEqual(states)
  })

  it('reads its own job after each page, one GET /imports/:id', async () => {
    const { importer, api, j } = setup({ all: history(250) })
    await run(importer, j)
    expect(api.getImport.mock.calls.length).toBe(3)
    expect(api.getImport.mock.calls.every(c => c[0] === 'job-1')).toBe(true)
  })
})

describe('HistoryImporter recency margin', () => {
  const at = (msAgo: number, n = 0) => String(BigInt(snowflakeAt(NOW - msAgo)) + BigInt(n))
  const msg = (id: string) => ({
    id, createdAt: new Date(Number((BigInt(id) >> 22n) + 1420070400000n)), content: id,
    author: { id: 'u1', bot: false }, type: MessageType.Default,
  }) as any

  it('starts the walk five minutes back, in the channel and in every thread', async () => {
    const T = SNOW(500)
    const { importer, fetchPage, j } = setup({
      all: [msg(at(60_000)), msg(at(10 * 60_000))],
      threadPages: [[{ id: T, name: 't', ownerId: null, createdAt: new Date(DAY0), archived: false, locked: false }]],
      threadMessages: { [T]: [msg(at(30_000)), msg(at(20 * 60_000))] },
    })
    expect(await run(importer, j)).toBe('done')
    expect(fetchPage.mock.calls.filter(c => c[0] === '1001')[0][1]).toBe(CUTOFF)
    expect(fetchPage.mock.calls.filter(c => c[0] === T)[0][1]).toBe(CUTOFF)
  })

  it('leaves a message of the last five minutes to the live relay', async () => {
    const fresh = msg(at(60_000))
    const old = msg(at(10 * 60_000))
    const { importer, posts, patches, j } = setup({ all: [fresh, old] })
    expect(await run(importer, j)).toBe('done')
    expect(posts.map(ids)).toEqual([[old.id]])
    expect(patches.find(p => 'start_discord_message_id' in p)).toMatchObject({ start_discord_message_id: old.id })
  })

  it('drops a newer message even when Discord returns one', async () => {
    const fresh = msg(at(60_000))
    const old = msg(at(10 * 60_000))
    const { importer, posts, fetchPage, j } = setup({ all: [] })
    fetchPage.mockResolvedValueOnce([fresh, old]).mockResolvedValue([])
    expect(await run(importer, j)).toBe('done')
    expect(posts.map(ids)).toEqual([[old.id]])
  })
})

describe('HistoryImporter authors', () => {
  it('skips messages of authors who are not guild members and reports the count', async () => {
    const all = history(6, i => ({ author: { id: i % 2 === 0 ? 'gone' : 'u1', bot: false } }))
    const { importer, posts, patches, j } = setup({ all, absent: ['gone'] })
    expect(await run(importer, j)).toBe('done')
    expect(ids(posts[0])).toEqual([SNOW(5), SNOW(3), SNOW(1)])
    expect(patches.find(p => 'reached_discord_message_id' in p)).toMatchObject({ authors_skipped: 3 })
  })

  it('asks once per page for the authors it has not seen, and remembers them for the run', async () => {
    const all = history(250, i => ({ author: { id: i > 150 ? (i % 2 ? 'a' : 'b') : i > 50 ? (i % 2 ? 'a' : 'c') : 'a', bot: false } }))
    const { importer, fetchMembers, j } = setup({ all })
    await run(importer, j)
    expect(fetchMembers.mock.calls.map(c => [...c[1]].sort())).toEqual([['a', 'b'], ['c']])
  })

  it('does not import a page whose membership request failed, and does not move past it', async () => {
    const { importer, fetchMembers, posts, patches, sleeps, j } = setup({ all: history(5) })
    fetchMembers.mockRejectedValue(new Error('GuildMembersTimeout'))
    expect(await run(importer, j)).toBe('paused')
    expect(fetchMembers).toHaveBeenCalledTimes(6)
    expect(sleeps).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(posts).toEqual([])
    expect(patches.some(p => 'reached_discord_message_id' in p)).toBe(false)
  })

  it('skips messages of opted-out authors without asking Discord about them', async () => {
    const all = history(4, i => ({ author: { id: i === 2 ? 'out' : 'u1', bot: false } }))
    const { importer, posts, fetchMembers, patches, optOuts, j } = setup({ all, optedOut: ['out'] })
    expect(await run(importer, j)).toBe('done')
    expect(optOuts!.refresh).toHaveBeenCalledTimes(1)
    expect(ids(posts[0])).toEqual([SNOW(4), SNOW(3), SNOW(1)])
    expect(fetchMembers.mock.calls.map(c => c[1])).toEqual([['u1']])
    expect(patches.find(p => 'reached_discord_message_id' in p)).toMatchObject({ authors_skipped: 1 })
  })

  it('does not start on an opt-out list it could not read', async () => {
    const { importer, optOuts, fetchPage, posts, j } = setup({ all: history(3), optedOut: [] })
    optOuts!.refresh.mockRejectedValue(new BridgeApiError('down', 503))
    expect(await run(importer, j)).toBe('paused')
    expect(fetchPage).not.toHaveBeenCalled()
    expect(posts).toEqual([])
  })

  it('counts on from the job when it resumes, and from zero on a fresh run', async () => {
    const all = history(2, () => ({ author: { id: 'gone', bot: false } }))
    const resumed = setup({ all, absent: ['gone'], jobOver: { state: 'running', start_discord_message_id: SNOW(9), start_at: 'x', channel_created_at: 'y', authors_skipped: 40 } })
    await run(resumed.importer, resumed.j)
    expect(resumed.patches.find(p => 'authors_skipped' in p)).toMatchObject({ authors_skipped: 42 })
    const fresh = setup({ all, absent: ['gone'], jobOver: { authors_skipped: 40 } })
    await run(fresh.importer, fresh.j)
    expect(fresh.patches.find(p => 'authors_skipped' in p)).toMatchObject({ authors_skipped: 2 })
  })

  it('reports authors skipped inside a thread with that thread', async () => {
    const T = SNOW(500)
    const { importer, patches, j } = setup({
      all: [],
      absent: ['gone'],
      threadPages: [[{ id: T, name: 't', ownerId: null, createdAt: new Date(DAY0), archived: false, locked: false }]],
      threadMessages: { [T]: history(3, () => ({ author: { id: 'gone', bot: false } })) },
    })
    await run(importer, j)
    expect(patches.find(p => 'threads_done' in p)).toMatchObject({ threads_done: 1, authors_skipped: 3 })
  })
})

describe('HistoryImporter Discord-side approval and notice', () => {
  it('fails a job started from Harmony at once when @everyone cannot view the channel', async () => {
    const { importer, patches, fetchPage, ensureNotice, j } = setup({ all: history(3), everyoneCanView: false, jobOver: { requested_via: 'harmony' } })
    expect(await run(importer, j)).toBe('failed')
    expect(patches).toEqual([{ state: 'running' }, { state: 'failed', error: 'discord_approval_required' }])
    expect(fetchPage).not.toHaveBeenCalled()
    expect(ensureNotice).not.toHaveBeenCalled()
  })

  it('imports a channel @everyone can view when the job came from Harmony', async () => {
    const { importer, posts, j } = setup({ all: history(3), everyoneCanView: true, jobOver: { requested_via: 'harmony' } })
    expect(await run(importer, j)).toBe('done')
    expect(posts.flat()).toHaveLength(3)
  })

  it('imports a hidden channel when the job was started on Discord', async () => {
    const { importer, posts, everyoneCanView, j } = setup({ all: history(3), everyoneCanView: false, jobOver: { requested_via: 'discord' } })
    expect(await run(importer, j)).toBe('done')
    expect(posts.flat()).toHaveLength(3)
    expect(everyoneCanView).not.toHaveBeenCalled()
  })

  it('makes sure of the pinned notice before the first page', async () => {
    const order: string[] = []
    const { importer, ensureNotice, fetchPage, j } = setup({ all: history(3) })
    ensureNotice.mockImplementation(async (channel: string) => { order.push(`notice:${channel}`) })
    const realFetch = fetchPage.getMockImplementation()!
    fetchPage.mockImplementation((c: string, b: string | undefined) => { order.push('page'); return realFetch(c, b) })
    await run(importer, j)
    expect(order.slice(0, 2)).toEqual(['notice:1001', 'page'])
    expect(ensureNotice).toHaveBeenCalledTimes(1)
  })

  it('imports all the same when the notice cannot be posted or pinned, and logs it', async () => {
    const { importer, ensureNotice, posts, log, j } = setup({ all: history(3) })
    const warn = vi.spyOn(log, 'warn')
    ensureNotice.mockRejectedValue(discordError(50013, 'Missing Permissions', 403))
    expect(await run(importer, j)).toBe('done')
    expect(posts.flat()).toHaveLength(3)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not post or pin the notice'))
  })

  it('does not post the notice again when a job resumes past the messages phase', async () => {
    const { importer, ensureNotice, j } = setup({ all: history(3), jobOver: { phase: 'replies', state: 'running' } })
    await run(importer, j)
    expect(ensureNotice).not.toHaveBeenCalled()
  })
})

describe('HistoryImporter Harmony error policy', () => {
  const busy = (retryAfterMs: number | null) => new BridgeApiError('PATCH failed (429 import_busy)', 429, 'import_busy', {}, retryAfterMs)

  it('ends as waiting, with the wait Harmony named, when the instance runs its maximum of imports', async () => {
    const { importer, api, patches, sleeps, j } = setup({ all: history(3) })
    api.updateImport.mockRejectedValue(busy(90_000))
    expect(await importer.run(j, new AbortController().signal)).toEqual({ result: 'waiting', retryAfterMs: 90_000 })
    expect(api.updateImport).toHaveBeenCalledTimes(1)
    expect(patches).toEqual([])
    expect(sleeps).toEqual([])
  })

  it('waits out a rate-limited batch and sends the same batch again, without counting retries', async () => {
    const { importer, api, posts, sleeps, j } = setup({ all: history(3) })
    const real = api.postImportMessages.getMockImplementation()!
    const limited = new BridgeApiError('POST failed (429 import_rate_limited)', 429, 'import_rate_limited', {}, 42_000)
    for (let i = 0; i < 9; i++) api.postImportMessages.mockRejectedValueOnce(limited)
    api.postImportMessages.mockImplementation(real)
    expect(await run(importer, j)).toBe('done')
    expect(api.postImportMessages).toHaveBeenCalledTimes(10)
    expect(sleeps.filter(ms => ms === 42_000)).toHaveLength(9)
    expect(ids(posts[0])).toEqual([SNOW(3), SNOW(2), SNOW(1)])
  })

  it('never resends a rejected message and carries on with the next page', async () => {
    const { importer, api, posts, patches, j } = setup({ all: history(150) })
    api.postImportMessages.mockImplementationOnce(async (_id: string, messages: ImportMessage[]) => {
      posts.push(messages)
      return {
        inserted: [], skipped: [SNOW(150), SNOW(149)],
        rejected: [{ discord_message_id: SNOW(150), reason: 'future_date' }, { discord_message_id: SNOW(149), reason: 'too_long' }],
      }
    })
    expect(await run(importer, j)).toBe('done')
    expect(posts.map(p => p.length)).toEqual([100, 50])
    expect(posts.flat().filter(m => m.discord_message_id === SNOW(150))).toHaveLength(1)
    expect(patches.at(-1)).toEqual({ state: 'done' })
  })

  it('adds the author of a message Harmony rejects as opted_out to the list', async () => {
    const all = history(2, i => ({ author: { id: i === 2 ? 'late' : 'u1', bot: false } }))
    const { importer, api, optOuts, j } = setup({ all, optedOut: [] })
    api.postImportMessages.mockImplementationOnce(async () => ({
      inserted: [], skipped: [SNOW(2)], rejected: [{ discord_message_id: SNOW(2), reason: 'opted_out' }],
    }))
    await run(importer, j)
    expect(optOuts!.add).toHaveBeenCalledWith('late')
  })

  it('drops the one message an older gateway refuses a batch for, and sends the rest again', async () => {
    const { importer, api, posts, patches, j } = setup({ all: history(4) })
    api.postImportMessages.mockRejectedValueOnce(
      new BridgeApiError('POST failed (400 invalid_batch)', 400, 'invalid_batch', { code: 'invalid_batch', discord_message_id: SNOW(3) }),
    )
    expect(await run(importer, j)).toBe('done')
    expect(api.postImportMessages).toHaveBeenCalledTimes(2)
    expect(ids(posts[0])).toEqual([SNOW(4), SNOW(2), SNOW(1)])
    expect(patches.find(p => 'reached_discord_message_id' in p)!.reached_discord_message_id).toBe(SNOW(1))
  })

  it('fails the job with the code Harmony answered on any other 4xx', async () => {
    const { importer, api, patches, j } = setup({ all: history(5) })
    api.postImportMessages.mockRejectedValue(new BridgeApiError('bad', 400, 'invalid_batch'))
    expect(await run(importer, j)).toBe('failed')
    expect(api.postImportMessages).toHaveBeenCalledTimes(1)
    expect(patches.at(-1)).toEqual({ state: 'failed', error: 'invalid_batch' })
  })

  it('names the status when a 4xx carries no code', async () => {
    const { importer, api, patches, j } = setup({ all: history(5) })
    api.postImportMessages.mockRejectedValue(new BridgeApiError('too large', 413))
    expect(await run(importer, j)).toBe('failed')
    expect(patches.at(-1)).toEqual({ state: 'failed', error: 'harmony_413' })
  })

  it('ends as disabled, with no PATCH, when import is turned off mid-run', async () => {
    const { importer, api, patches, j } = setup({ all: history(5) })
    api.postImportMessages.mockRejectedValue(new BridgeApiError('off', 403, 'import_disabled', { reason: 'instance_off' }))
    expect(await run(importer, j)).toBe('disabled')
    expect(stateOf(patches)).toEqual(['running'])
  })

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['done', 'done'],
    ['paused', 'paused'],
    ['queued', 'paused'],
  ] as const)('on a 409 reads the job: state %s ends the run as %s with no PATCH', async (serverState, result) => {
    const { importer, api, patches, j } = setup({ all: history(250), getImport: async () => job({ state: serverState }) })
    api.postImportMessages.mockRejectedValue(new BridgeApiError('stopped', 409, 'import_not_running'))
    expect(await run(importer, j)).toBe(result)
    expect(api.postImportMessages).toHaveBeenCalledTimes(1)
    expect(stateOf(patches)).toEqual(['running'])
  })

  it('does not fail a queued job whose PATCH to running answers 409', async () => {
    const { importer, api, patches, j } = setup({ all: history(3), getImport: async () => job({ state: 'queued' }) })
    api.updateImport.mockRejectedValue(new BridgeApiError('no', 409, 'invalid_transition'))
    expect(await run(importer, j)).toBe('paused')
    expect(api.updateImport).toHaveBeenCalledTimes(1)
    expect(patches).toEqual([])
  })

  it('repeats the call after a 409 when the job is still running', async () => {
    const { importer, api, posts, sleeps, j } = setup({ all: history(3) })
    const real = api.postImportMessages.getMockImplementation()!
    api.postImportMessages.mockRejectedValueOnce(new BridgeApiError('race', 409, 'import_not_running')).mockImplementation(real)
    expect(await run(importer, j)).toBe('done')
    expect(posts).toHaveLength(1)
    expect(sleeps[0]).toBe(1000)
  })
})

describe('HistoryImporter stickers Harmony refuses', () => {
  const native = (m: any) => [{ type: 'sticker', id: 'hs-1' }, { type: 'file', stickerId: 'hs-1', url: 'https://h/s.png' }, { type: 'text', text: m.content }]
  const image = (m: any) => [{ type: 'file', url: 'https://media.discordapp.net/stickers/st-1.png' }, { type: 'text', text: m.content }]
  const translate = async (m: any, member: any, o: { nativeStickers: boolean }) => ({
    discord_message_id: m.id, created_at: m.createdAt.toISOString(), edited_at: null,
    content: m.sticker ? (o.nativeStickers ? native(m) : image(m)) : [{ type: 'text', text: m.content }],
    discord_user: { id: member.id }, reply_to_discord_message_id: null,
  })
  const all = () => history(3, i => (i === 2 ? { sticker: true } : {}))

  it('sends a message whose sticker part is rejected once more with the sticker as its image', async () => {
    const { importer, api, posts, onStickerRefused, j } = setup({ all: all(), translate })
    api.postImportMessages.mockImplementationOnce(async (_id: string, messages: ImportMessage[]) => {
      posts.push(messages)
      return { inserted: [], skipped: [SNOW(2)], rejected: [{ discord_message_id: SNOW(2), reason: 'invalid' }] }
    })
    expect(await run(importer, j)).toBe('done')
    expect(posts).toHaveLength(2)
    expect(ids(posts[1])).toEqual([SNOW(2)])
    expect(posts[1][0].content).toEqual(image({ content: 'm2' }))
    expect(onStickerRefused).toHaveBeenCalledWith('hs-1')
  })

  it('gives up on the message when the image is rejected too', async () => {
    const { importer, api, posts, j } = setup({ all: all(), translate })
    api.postImportMessages.mockImplementation(async (_id: string, messages: ImportMessage[]) => {
      posts.push(messages)
      return { inserted: [], skipped: [SNOW(2)], rejected: messages.some(m => m.discord_message_id === SNOW(2)) ? [{ discord_message_id: SNOW(2), reason: 'invalid' }] : [] }
    })
    expect(await run(importer, j)).toBe('done')
    expect(posts).toHaveLength(2)
  })

  it('falls back the same way when an older gateway refuses the batch for the sticker message', async () => {
    const { importer, api, posts, j } = setup({ all: all(), translate })
    api.postImportMessages.mockRejectedValueOnce(
      new BridgeApiError('POST failed (400 invalid_batch)', 400, 'invalid_batch', { discord_message_id: SNOW(2) }),
    )
    expect(await run(importer, j)).toBe('done')
    expect(ids(posts[0])).toEqual([SNOW(3), SNOW(2), SNOW(1)])
    expect(posts[0][1].content).toEqual(image({ content: 'm2' }))
  })
})

describe('HistoryImporter stopping', () => {
  it('stops in the middle of a page wait and parks the job with one PATCH', async () => {
    const ac = new AbortController()
    const { importer, api, patches, posts, j } = setup({ all: history(250), pageDelayMs: 600_000 })
    const patient = new HistoryImporter({
      ...(importer as any).deps,
      // The real sleep: it rejects on abort, and a 10 minute delay is capped.
      sleep: undefined,
    })
    const running = run(patient, j, ac.signal)
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    const started = Date.now()
    ac.abort()
    expect(await running).toBe('paused')
    expect(Date.now() - started).toBeLessThan(1000)
    expect(patches.at(-1)).toEqual({ state: 'paused' })
    expect(api.updateImport.mock.calls.at(-1)![2]).toEqual({ timeoutMs: 5000 })
  })

  it('stops while a Harmony request is in flight, without waiting for its answer', async () => {
    const ac = new AbortController()
    const { importer, api, j } = setup({ all: history(5) })
    api.postImportMessages.mockImplementation(() => new Promise(() => {}))
    const running = run(importer, j, ac.signal)
    await vi.waitFor(() => expect(api.postImportMessages).toHaveBeenCalledTimes(1))
    expect((api.postImportMessages.mock.calls[0][2] as any).signal).toBe(ac.signal)
    ac.abort()
    expect(await running).toBe('paused')
  })

  it('stops while a Discord read is in flight', async () => {
    const ac = new AbortController()
    const { importer, fetchPage, j } = setup({ all: history(5) })
    fetchPage.mockImplementation(() => new Promise(() => {}))
    const running = run(importer, j, ac.signal)
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1))
    ac.abort()
    expect(await running).toBe('paused')
  })

  it('leaves a job that never reached running as it is', async () => {
    const ac = new AbortController()
    ac.abort()
    const { importer, api, j } = setup({ all: history(5) })
    expect(await run(importer, j, ac.signal)).toBe('paused')
    expect(api.updateImport).not.toHaveBeenCalled()
  })

  it('never waits longer than the cap between pages', async () => {
    const { importer, sleeps, j } = setup({ all: history(3), pageDelayMs: 600_000 })
    await run(importer, j)
    expect(Math.max(...sleeps)).toBe(PAGE_DELAY_CAP_MS)
  })
})

// --- threads and replies phases ------------------------------------------------------------

const thread = (id: string, over: Record<string, any> = {}) => ({
  id, name: `thread ${id}`, ownerId: null, createdAt: new Date(DAY0 + 5000), archived: false, locked: false, ...over,
})
/** n messages for a thread, newest first, with ids from base+1..base+n. */
const threadMsgs = (base: number, n: number) => history(n, i => ({ id: SNOW(base + i) })).map((m: any, k: number) => ({ ...m, id: SNOW(base + n - k) }))

describe('HistoryImporter threads and replies phases', () => {
  it('finishes a voice channel import: its thread listing ends after the active list', async () => {
    const { ChannelType } = await import('discord.js')
    const { discordImportAccess } = await import('../src/runtime/importDiscord.js')
    const voice: any = {
      id: '1001', type: ChannelType.GuildVoice, guildId: 'g1', messages: {}, isTextBased: () => true, isThread: () => false,
      guild: { id: 'g1', channels: { fetchActiveThreads: async () => ({ threads: new Map() }) } },
    }
    const access = discordImportAccess(() => ({ channels: { cache: new Map([['1001', voice]]), fetch: async () => voice } }) as any, () => 'g1')
    const { importer, patches, posts, j } = setup({ all: history(3), listThreads: (c, cur) => access.listThreads(c, cur) })
    expect(await run(importer, j)).toBe('done')
    expect(posts.flat()).toHaveLength(3)
    expect(patches.at(-1)).toEqual({ state: 'done' })
    expect(patches.some(p => p.state === 'paused')).toBe(false)
  })

  const T1 = SNOW(500)
  const T2 = SNOW(600)

  it('imports a thread with a starter and a standalone one, posting their messages with thread_id', async () => {
    const { importer, api, posts, patches, j } = setup({
      all: history(2),
      threadPages: [[
        thread(T1, { ownerId: 'u9', archived: true }),
        thread(T2, { locked: true, name: '   ' }),
      ]],
      threadMessages: { [T1]: threadMsgs(700, 3), [T2]: threadMsgs(800, 2) },
      starters: new Set([T1]),
    })
    api.importThread.mockImplementation(async (_id: string, body: any) => `ht-${body.discord_thread_id}`)
    expect(await run(importer, j)).toBe('done')

    expect(api.importThread.mock.calls.map(c => c[1])).toEqual([
      { discord_thread_id: T1, name: `thread ${T1}`, created_at: new Date(DAY0 + 5000).toISOString(),
        starter_discord_message_id: T1, discord_user: { id: 'u9' }, archived: true, locked: false },
      { discord_thread_id: T2, name: 'Thread', created_at: new Date(DAY0 + 5000).toISOString(),
        starter_discord_message_id: null, discord_user: null, archived: false, locked: true },
    ])
    const threadPosts = posts.slice(1)
    expect(threadPosts.map(p => p.length)).toEqual([3, 2])
    expect(threadPosts[0].every(m => m.thread_id === `ht-${T1}`)).toBe(true)
    expect(threadPosts[1].every(m => m.thread_id === `ht-${T2}`)).toBe(true)
    expect(posts[0].every(m => !m.thread_id)).toBe(true)
    expect(patches.filter(p => 'threads_done' in p).map(p => p.threads_done)).toEqual([1, 2])
  })

  it('skips a thread whose own fetch says unknown channel and still finishes the job', async () => {
    const { importer, api, fetchPage, posts, patches, log, j } = setup({
      all: [], threadPages: [[thread(T1), thread(T2)]], threadMessages: { [T2]: threadMsgs(800, 2) },
    })
    const warn = vi.spyOn(log, 'warn')
    const real = fetchPage.getMockImplementation()!
    fetchPage.mockImplementation((c: string, b: string | undefined) => {
      if (c === T1) return Promise.reject(discordError(10003))
      return real(c, b)
    })
    expect(await run(importer, j)).toBe('done')
    expect(posts.map(p => p.length)).toEqual([2])
    expect(patches.filter(p => 'threads_done' in p).map(p => p.threads_done)).toEqual([1, 2])
    expect(patches.some(p => p.error === 'discord_access_lost')).toBe(false)
    expect(api.importThread).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('left out 1 thread(s) of 1001'))
  })

  it('skips a thread Harmony refuses as invalid and still finishes the job', async () => {
    const { importer, api, patches, j } = setup({ all: [], threadPages: [[thread(T1), thread(T2)]] })
    api.importThread.mockRejectedValueOnce(new BridgeApiError('bad thread', 400, 'invalid_thread'))
    expect(await run(importer, j)).toBe('done')
    expect(api.importThread).toHaveBeenCalledTimes(2)
    expect(patches.at(-1)).toEqual({ state: 'done' })
  })

  it('fails the job when the parent channel is lost while looking for a thread starter', async () => {
    const { importer, api, patches, j } = setup({ all: [], threadPages: [[thread(T1), thread(T2)]] })
    ;((importer as any).deps.hasStarterMessage as ReturnType<typeof vi.fn>).mockRejectedValue(discordError(50001))
    expect(await run(importer, j)).toBe('failed')
    expect(api.importThread).not.toHaveBeenCalled()
    expect(patches.at(-1)).toEqual({ state: 'failed', error: 'discord_access_lost' })
  })

  it('still fails the job when the channel listing loses access', async () => {
    const { importer, listThreads, patches, j } = setup({ all: [] })
    listThreads.mockRejectedValue(discordError(50001))
    expect(await run(importer, j)).toBe('failed')
    expect(patches).toContainEqual({ state: 'failed', error: 'discord_access_lost' })
  })

  it('sleeps pageDelayMs and re-checks server state after every thread, even empty ones', async () => {
    const { importer, api, sleeps, j } = setup({ all: [], threadPages: [[thread(T1), thread(T2)]] })
    const before = api.getImport.mock.calls.length
    await run(importer, j)
    expect(sleeps.filter(ms => ms === 7).length).toBeGreaterThanOrEqual(2)
    expect(api.getImport.mock.calls.length - before).toBeGreaterThanOrEqual(2)
  })

  it('stops after a thread when the server says the job was cancelled', async () => {
    const { importer, api, j } = setup({ all: [], threadPages: [[thread(T1), thread(T2)]] })
    api.getImport.mockResolvedValue(job({ state: 'cancelled' }))
    expect(await run(importer, j)).toBe('cancelled')
    expect(api.importThread).toHaveBeenCalledTimes(1)
  })

  it('does not touch reached_* or start while importing a thread', async () => {
    const { importer, patches, j } = setup({
      all: [], threadPages: [[thread(T1)]], threadMessages: { [T1]: threadMsgs(700, 3) },
    })
    await run(importer, j)
    expect(patches.filter(p => 'reached_discord_message_id' in p || 'start_discord_message_id' in p)).toEqual([])
  })

  it('sets threads_total when the first listing is complete', async () => {
    const { importer, patches, j } = setup({ all: [], threadPages: [[thread(T1), thread(T2)]] })
    await run(importer, j)
    expect(patches.find(p => 'threads_total' in p)).toEqual({ threads_total: 2 })
  })

  it('raises threads_total page by page when the listing spans several', async () => {
    const { importer, patches, j } = setup({ all: [], threadPages: [[thread(T1)], [thread(T2)]] })
    await run(importer, j)
    expect(patches.filter(p => 'threads_total' in p)).toEqual([{ threads_total: 1 }, { threads_total: 2 }])
  })

  it('sets threads_total for a text channel, whose listing always has a second list', async () => {
    const { importer, patches, j } = setup({ all: [], threadPages: [[], []] })
    await run(importer, j)
    expect(patches.filter(p => 'threads_total' in p)).toEqual([{ threads_total: 0 }])
  })

  it('checkpoints the ids of the threads it finished', async () => {
    const { importer, patches, j } = setup({ all: [], threadPages: [[thread(T1), thread(T2)]] })
    await run(importer, j)
    expect(patches.filter(p => 'thread_cursor' in p).map(p => p.thread_cursor)).toEqual([
      { at: null, done: [T1] },
      { at: null, done: [T1, T2] },
    ])
  })

  it('resumes from thread_cursor and skips completed threads', async () => {
    const T3 = SNOW(700)
    const { importer, api, listThreads, patches, j } = setup({
      all: [],
      jobOver: { phase: 'threads', state: 'running', threads_done: 1, thread_cursor: { at: { page: 0 }, done: [T1] } },
      threadPages: [[thread(T1), thread(T2)], [thread(T3)]],
    })
    expect(await run(importer, j)).toBe('done')
    expect(listThreads.mock.calls[0][1]).toEqual({ page: 0 })
    expect(api.importThread.mock.calls.map(c => (c[1] as any).discord_thread_id)).toEqual([T2, T3])
    expect(patches.filter(p => 'threads_done' in p).map(p => p.threads_done)).toEqual([2, 3])
  })

  it('imports an unfinished thread that moved up the list since the checkpoint', async () => {
    // T1 was done and first in the list. It was archived since: the list now starts with T2.
    const T3 = SNOW(700)
    const { importer, api, j } = setup({
      all: [],
      jobOver: { phase: 'threads', state: 'running', threads_done: 1, thread_cursor: { at: { page: 0 }, done: [T1] } },
      threadPages: [[thread(T2), thread(T3)]],
    })
    expect(await run(importer, j)).toBe('done')
    expect(api.importThread.mock.calls.map(c => (c[1] as any).discord_thread_id)).toEqual([T2, T3])
  })

  it('skips the threads phase when resumed in phase replies', async () => {
    const { importer, api, listThreads, fetchPage, patches, j } = setup({ all: history(3), jobOver: { phase: 'replies', state: 'running' } })
    expect(await run(importer, j)).toBe('done')
    expect(fetchPage).not.toHaveBeenCalled()
    expect(listThreads).not.toHaveBeenCalled()
    expect(api.linkImportReplies).toHaveBeenCalledTimes(1)
    expect(patches).toEqual([{ state: 'running' }, { state: 'done' }])
  })

  it('raises private_threads_skipped once, with the count summed over pages', async () => {
    const { importer, reportProblem, j } = setup({ all: [], threadPages: [[thread(T1)], [thread(T2)]], skippedPrivate: [2, 1] })
    await run(importer, j)
    expect(reportProblem).toHaveBeenCalledTimes(1)
    expect(reportProblem).toHaveBeenCalledWith({ code: 'private_threads_skipped', params: { discord_channel_id: '1001', count: '3' } })
  })

  it('raises no problem when no private threads were left out', async () => {
    const { importer, reportProblem, j } = setup({ all: [], threadPages: [[thread(T1)]], skippedPrivate: [0] })
    await run(importer, j)
    expect(reportProblem).not.toHaveBeenCalled()
  })

  it('never imports a private thread handed to it', async () => {
    const { importer, api, j } = setup({ all: [], threadPages: [[thread(T1, { type: 12 }), thread(T2)]] })
    await run(importer, j)
    expect(api.importThread).toHaveBeenCalledTimes(1)
    expect(api.importThread.mock.calls[0][1]).toMatchObject({ discord_thread_id: T2 })
  })

  it('calls linkImportReplies once, then patches done', async () => {
    const { importer, api, patches, j } = setup({ all: history(2) })
    api.linkImportReplies.mockImplementation(async () => { patches.push({ linkCalled: true }); return 4 })
    expect(await run(importer, j)).toBe('done')
    expect(api.linkImportReplies).toHaveBeenCalledTimes(1)
    expect(api.linkImportReplies.mock.calls[0][0]).toBe('job-1')
    expect(patches.slice(-3)).toEqual([{ phase: 'replies' }, { linkCalled: true }, { state: 'done' }])
  })

  it('ends with the server state on a 409 from importThread', async () => {
    const { importer, api, patches, j } = setup({ all: [], threadPages: [[thread(T1)]], getImport: async () => job({ state: 'failed' }) })
    api.importThread.mockRejectedValue(new BridgeApiError('stopped', 409, 'import_not_running'))
    expect(await run(importer, j)).toBe('failed')
    expect(api.linkImportReplies).not.toHaveBeenCalled()
    expect(stateOf(patches)).toEqual(['running'])
  })

  it('fails with discord_access_lost when listing threads loses access', async () => {
    const { importer, listThreads, patches, j } = setup({ all: [] })
    listThreads.mockRejectedValue(discordError(50001))
    expect(await run(importer, j)).toBe('failed')
    expect(patches.at(-1)).toEqual({ state: 'failed', error: 'discord_access_lost' })
  })
})

// --- translateForImport against live relay -------------------------------------------------

const ALL = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS | APPLICATION_FLAGS.GATEWAY_PRESENCE
const writer: PairWriter = { link: async () => {}, linkMany: async () => [], unlink: async () => false }

describe('BridgeRuntime.translateForImport', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bridge-import-'))
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  async function runtimeSetup() {
    const clients: FakeDiscordClient[] = []
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('/applications/@me')) return appResponse(ALL)()
      if (u.includes('/members')) return Response.json([])
      return new Response('not found', { status: 404 })
    })
    const runtime = new BridgeRuntime({
      mode: 'v2',
      directory: new V2Directory({
        bridge_id: 'b', server_id: 's', mode: 'self', discord_guild_id: 'g1',
        settings: { sync_member_list: true },
        pairs: [{ discord_channel_id: '1001', harmony_channel_id: 'h1', harmony_channel_name: 'general', direction: 'both' }],
        harmony_channels: [],
      }),
      writer,
      discordToken: 'dtok',
      harmony: { token: 'htok', gatewayUrl: 'ws://127.0.0.1:9/gateway', apiUrl: 'http://127.0.0.1:9', baseUrl: 'https://h.example' },
      permissionStorePath: join(dir, 'permission-sync.yml'),
      log: new Logger('debug', '', true),
      fetchImpl,
      media: { maxUploadBytes: 8 * 1024 * 1024, mediaOrigin: null },
      appEmojiDir: null,
      createDiscordClient: (options) => {
        const c = new FakeDiscordClient(options)
        c.addGuild('g1', [])
        clients.push(c)
        return c as any
      },
    })
    const h = runtime.harmony
    const sendMessage = vi.spyOn(h, 'sendMessage').mockImplementation(async () => ({ id: 'hm-1' }))
    vi.spyOn(h, 'getEmojis').mockResolvedValue([])
    vi.spyOn(h, 'registerBridgeData').mockReturnValue(true)
    await runtime.connectDiscord()
    fakeTextChannel(clients[0], 'g1', '1001')
    clients[0].ready()
    h.emit('ready', { bot: { id: 'hb', username: 'bridge' } })
    await vi.advanceTimersByTimeAsync(0)
    return { runtime, rt: runtime as any, sendMessage }
  }

  function dMsg(over: Record<string, any> = {}) {
    return {
      id: '9001', channelId: '1001', guildId: 'g1', partial: false,
      author: { id: 'du-1', bot: false, username: 'user-du-1', discriminator: '0', globalName: null, displayAvatarURL: () => 'https://cdn.example/a.png' },
      member: { displayName: 'Dave', displayAvatarURL: () => 'https://cdn.example/m.png' },
      content: 'hello **world**', type: MessageType.Default,
      createdAt: new Date('2026-02-03T04:05:06Z'), editedAt: new Date('2026-02-03T05:00:00Z'),
      attachments: new Collection(), stickers: new Collection(), embeds: [],
      mentions: { users: new Collection(), roles: new Collection(), channels: new Collection(), repliedUser: null },
      reference: { messageId: '8000' }, messageSnapshots: new Collection(),
      flags: { has: () => false }, guild: null,
      ...over,
    }
  }

  const member = fakeMember('g1', 'du-1') as any

  it('produces the same content and discord_user as live relay', async () => {
    const { runtime, rt, sendMessage } = await runtimeSetup()
    await rt.onDiscordMessage(dMsg({ reference: null, member }))
    const live = sendMessage.mock.calls[0]
    const imported = await rt.translateForImport(dMsg(), member)
    expect(imported).not.toBeNull()
    expect(imported!.content).toEqual(live[1])
    expect(imported!.discord_user).toEqual((live[2] as any).discord_user)
    expect(imported!.discord_message_id).toBe('9001')
    expect(imported!.created_at).toBe('2026-02-03T04:05:06.000Z')
    expect(imported!.edited_at).toBe('2026-02-03T05:00:00.000Z')
    expect(imported!.reply_to_discord_message_id).toBe('8000')
    await runtime.stop()
  })

  it('never looks a member up itself: the importer hands it the membership it resolved', async () => {
    const { runtime, rt } = await runtimeSetup()
    const fetch = vi.fn(async () => { throw discordError(10007) })
    const guild = { id: 'g1', members: { cache: new Map(), fetch } }
    await rt.translateForImport(dMsg({ member: null, guild }), member)
    expect(fetch).not.toHaveBeenCalled()
    await runtime.stop()
  })

  /** Live relay and import must agree on content and discord_user for the same message. */
  async function expectSameAsLive(over: Record<string, any>) {
    const { runtime, rt, sendMessage } = await runtimeSetup()
    await rt.onDiscordMessage(dMsg({ reference: null, member, ...over }))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const live = sendMessage.mock.calls[0]
    const imported = await rt.translateForImport(dMsg({ reference: null, ...over }), member)
    expect(imported).not.toBeNull()
    expect(imported!.content.length).toBeGreaterThan(0)
    expect(imported!.content).toEqual(live[1])
    expect(imported!.discord_user).toEqual((live[2] as any).discord_user)
    await runtime.stop()
    return imported!
  }

  it('imports an attachment-only message like live relay', async () => {
    const imported = await expectSameAsLive({
      content: '',
      attachments: new Collection([['a1', { id: 'a1', name: 'pic.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/pic.png', size: 10 }]]),
    })
    expect(imported.content).toEqual([expect.objectContaining({ type: 'file', fileName: 'pic.png' })])
  })

  it('imports a sticker-only message like live relay', async () => {
    const imported = await expectSameAsLive({
      content: '',
      stickers: new Collection([['s1', { id: 's1', name: 'wave', format: 1 }]]),
    })
    expect(imported.content).toEqual([expect.objectContaining({ type: 'file', fileType: 'image' })])
  })

  it('returns null for bots, webhooks, other message types and empty parts; null reply and edit by default', async () => {
    const { runtime, rt } = await runtimeSetup()
    expect(await rt.translateForImport(dMsg({ author: { id: 'b', bot: true } }), member)).toBeNull()
    expect(await rt.translateForImport(dMsg({ webhookId: 'wh-1' }), member)).toBeNull()
    expect(await rt.translateForImport(dMsg({ type: MessageType.ChannelPinnedMessage }), member)).toBeNull()
    expect(await rt.translateForImport(dMsg({ content: '' }), member)).toBeNull()
    const plain = await rt.translateForImport(dMsg({ reference: null, editedAt: null }), member)
    expect(plain).toMatchObject({ reply_to_discord_message_id: null, edited_at: null })
    await runtime.stop()
  })

  it('has no setting that imports bot or webhook authors as people', async () => {
    vi.stubEnv('BRIDGE_IMPORT_TEST_AUTHORS', 'wh-1,bot-2')
    try {
      const { runtime, rt } = await runtimeSetup()
      expect(await rt.translateForImport(dMsg({ webhookId: 'wh-1', author: { ...dMsg().author, id: 'wh-1', bot: true } }), member)).toBeNull()
      expect(await rt.translateForImport(dMsg({ author: { ...dMsg().author, id: 'bot-2', bot: true } }), member)).toBeNull()
      await runtime.stop()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not send a forward as a reply to the forwarded message', async () => {
    const { runtime, rt } = await runtimeSetup()
    const snapshot = { content: 'forwarded text', attachments: new Collection(), stickers: new Collection(), embeds: [], mentions: dMsg().mentions }
    const forward = dMsg({ content: '', reference: { type: 1, messageId: '7000', channelId: '1001' }, messageSnapshots: new Collection([['7000', snapshot]]) })
    const imported = await rt.translateForImport(forward, member)
    expect(imported!.reply_to_discord_message_id).toBeNull()
    expect(JSON.stringify(imported!.content)).toContain('forwarded text')
    await runtime.stop()
  })

  it('writes a plain @name as text, where live relay mentions the Harmony member of that name', async () => {
    const { runtime, rt, sendMessage } = await runtimeSetup()
    rt.translator.setHarmonyMemberLookup((username: string) => (username === 'alice'
      ? { id: 'hu-1', username: 'alice', domain: null, isLocal: true, displayName: 'Alice' } : null))
    await rt.onDiscordMessage(dMsg({ reference: null, member, content: 'thanks @alice' }))
    expect((sendMessage.mock.calls[0][1] as any[]).some(p => p.type === 'mention' && p.userId === 'hu-1')).toBe(true)

    const imported = await rt.translateForImport(dMsg({ content: 'thanks @alice' }), member)
    expect(imported!.content).toEqual([{ type: 'text', text: 'thanks @alice' }])
    await runtime.stop()
  })

  it('writes @everyone, @here and role pings as text', async () => {
    const { runtime, rt, sendMessage } = await runtimeSetup()
    rt.permissionSyncStore.getDefaultHarmonyRoleId = () => 'role-everyone'
    rt.permissionSyncStore.getHarmonyRoleId = (id: string) => (id === '555' ? 'role-mods' : undefined)
    const mentions = {
      users: new Collection(), channels: new Collection(), repliedUser: null, everyone: true,
      roles: new Collection([['555', { id: '555', name: 'mods', hexColor: '#ff0000' }]]),
    }
    const text = 'hey @everyone and @here and <@&555>'
    await rt.onDiscordMessage(dMsg({ reference: null, member, content: text, mentions }))
    const live = sendMessage.mock.calls[0][1] as any[]
    expect(live.filter(p => p.type === 'role_mention').map(p => p.roleId).sort()).toHaveLength(3)

    const imported = await rt.translateForImport(dMsg({ content: text, mentions }), member)
    expect(imported!.content.some((p: any) => p.type === 'role_mention' || p.type === 'mention')).toBe(false)
    expect(imported!.content.map((p: any) => p.text).join('')).toBe('hey @everyone and @here and @mods')
    await runtime.stop()
  })

  it('renders a retired sticker link as the image, and every sticker as an image on request', async () => {
    const { runtime, rt } = await runtimeSetup()
    const row = { id: 'hs-1', discord_sticker_id: 'st-1', name: 'Wave', description: 'a wave', url: 'https://db.test/stickers/st-1.png' }
    const sticker = dMsg({ content: '', stickers: new Collection([['st-1', { id: 'st-1', name: 'wave', format: 1 }]]) })
    const kinds = async (opts?: { nativeStickers: boolean }) =>
      (await rt.translateForImport(sticker, member, opts))!.content.map((p: any) => p.type)

    rt.stickerLinks.replace('s', [{ ...row, removed: false }])
    expect(await kinds()).toEqual(['sticker', 'file'])
    expect(await kinds({ nativeStickers: false })).toEqual(['file'])

    rt.stickerLinks.replace('s', [{ ...row, removed: true }])
    expect(await kinds()).toEqual(['file'])
    await runtime.stop()
  })

  it('forgets the live link of a sticker Harmony refused in an import batch', async () => {
    const { runtime, rt } = await runtimeSetup()
    rt.stickerLinks.replace('s', [{ id: 'hs-1', discord_sticker_id: 'st-1', name: 'Wave', description: 'a wave', url: 'u', removed: false }])
    rt.forgetStickerLink('hs-1')
    expect(rt.stickerLinks.harmonyFor('s', 'st-1')).toBeNull()
    await runtime.stop()
  })

  it('leaves the starter of a thread out when they left the guild or opted out', async () => {
    const { runtime, rt } = await runtimeSetup()
    const present = fakeMember('g1', 'owner-1')
    const guild = { id: 'g1', members: { fetch: vi.fn(async (id: string) => { if (id === 'owner-1') return present; throw discordError(10007) }) } }
    expect(await rt.threadStarterForImport({ id: 't1', ownerId: 'owner-1', guild })).toMatchObject({ id: 'owner-1' })
    expect(await rt.threadStarterForImport({ id: 't2', ownerId: 'gone-1', guild })).toBeNull()
    rt.optOuts.add('owner-1')
    expect(await rt.threadStarterForImport({ id: 't3', ownerId: 'owner-1', guild })).toBeNull()
    await runtime.stop()
  })
})
