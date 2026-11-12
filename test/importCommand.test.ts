import { describe, expect, it, vi } from 'vitest'
import { PermissionFlagsBits } from 'discord.js'
import { handleInteraction, buildCommands } from '../src/runtime/commands.js'
import { importPercent } from '../src/runtime/importProgress.js'
import { BridgeApiError, type ImportJob } from '../src/v2/BridgeApi.js'

const job = (over: Partial<ImportJob> = {}): ImportJob => ({
  id: 'j1', harmony_channel_id: 'h1', discord_channel_id: 'd1', state: 'running', phase: 'messages',
  cancel_requested: false, start_discord_message_id: null, start_at: '2026-01-11T00:00:00Z',
  reached_discord_message_id: null, reached_at: '2026-01-06T00:00:00Z', channel_created_at: '2026-01-01T00:00:00Z',
  threads_total: null, threads_done: 0, thread_cursor: null, imported_count: 42, skipped_count: 0, pins_skipped: 0,
  error: null, requested_via: 'discord', created_at: '2026-01-11T00:00:00Z', updated_at: '2026-01-11T00:00:00Z',
  finished_at: null, ...over,
})

describe('importPercent', () => {
  it('is the share of the channel age walked back', () => {
    expect(importPercent(job())).toBe(50)
  })
  it('is 100 when done, null when a timestamp is missing, clamped to 0..100', () => {
    expect(importPercent(job({ state: 'done', reached_at: null }))).toBe(100)
    expect(importPercent(job({ reached_at: null }))).toBeNull()
    expect(importPercent(job({ channel_created_at: null }))).toBeNull()
    expect(importPercent(job({ reached_at: '2025-01-01T00:00:00Z' }))).toBe(100)
    expect(importPercent(job({ reached_at: '2026-02-01T00:00:00Z' }))).toBe(0)
  })
})

function setup(opts: { admin?: boolean; action?: string | null; scope?: string | null; paired?: boolean; thread?: boolean; api?: boolean } = {}) {
  const api = {
    listImports: vi.fn(async () => [job()]),
    startImports: vi.fn(async (ids?: string[]) => (ids ?? ['d1', 'd2']).map(id => job({ discord_channel_id: id, state: 'queued' }))),
    cancelImport: vi.fn(async () => [] as ImportJob[]),
  }
  const kick = vi.fn()
  const rt: any = {
    mode: 'v2',
    log: { error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    dir: {
      getBridgeForDiscordGuild: () => ({ harmonyServerId: 's' }),
      getHarmonyChannel: (id: string) => (opts.paired === false ? null : id === 'd1' ? 'h1' : null),
    },
    hooks: { kickImports: kick, ...(opts.api === false ? {} : { importApi: api }), harmonyChannels: () => [{ id: 'h1', name: 'general' }] },
  }
  const reply = vi.fn(async (_arg: any) => {})
  const order: string[] = []
  for (const [name, fn] of Object.entries(api)) {
    const orig = fn as any
    ;(api as any)[name] = vi.fn(async (...args: any[]) => { order.push(name); return orig(...args) })
  }
  const deferReply = vi.fn(async (_arg: any) => { order.push('defer'); interaction.deferred = true })
  const editReply = vi.fn(async (_arg: any) => {})
  const followUp = vi.fn(async (_arg: any) => {})
  const interaction: any = {
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    commandName: 'bridge',
    guild: { id: 'g' },
    guildId: 'g',
    member: { permissions: { has: (p: bigint) => opts.admin !== false && p === PermissionFlagsBits.Administrator } },
    channelId: opts.thread ? 'thread9' : 'd1',
    channel: opts.thread ? { isThread: () => true, parentId: 'd1' } : { isThread: () => false },
    options: {
      getSubcommand: () => 'import-history',
      getString: (name: string) => (name === 'action' ? opts.action ?? null : opts.scope ?? null),
    },
    reply, deferReply, editReply, followUp, deferred: false, replied: false,
  }
  return { rt, interaction, api, kick, reply, deferReply, editReply, followUp, order }
}
const text = (reply: { mock: { calls: any[][] } }) => reply.mock.calls[0][0].content as string
const edited = (t: { editReply: { mock: { calls: any[][] } } }) => t.editReply.mock.calls[0][0].content as string

describe('/bridge import-history', () => {
  it('is registered for v2 only, and only where import is available', () => {
    const features = { soundSync: false, emojiSync: false, stickerSync: false, historyImport: true, privacy: false }
    const subs = (m: 'v1' | 'v2', f = features) => buildCommands(m, f).find(c => c.name === 'bridge')!.options!.map((o: any) => o.name)
    expect(subs('v2')).toContain('import-history')
    expect(subs('v1')).not.toContain('import-history')
    expect(subs('v2', { ...features, historyImport: false })).not.toContain('import-history')
  })

  it('refuses non-admins', async () => {
    const t = setup({ admin: false })
    await handleInteraction(t.rt, t.interaction)
    expect(text(t.reply)).toMatch(/Administrator/)
    expect(t.api.startImports).not.toHaveBeenCalled()
  })

  it('start queues the paired channel and kicks the scheduler', async () => {
    const t = setup()
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.startImports).toHaveBeenCalledWith(['d1'])
    expect(t.kick).toHaveBeenCalled()
    expect(edited(t)).toContain('Importing history for 1 channel(s)')
    expect(t.deferReply.mock.calls[0][0].flags).toBeDefined()
  })

  it('start in a thread uses the parent channel', async () => {
    const t = setup({ thread: true })
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.startImports).toHaveBeenCalledWith(['d1'])
  })

  it('scope:all starts every importable pair', async () => {
    const t = setup({ scope: 'all' })
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.startImports).toHaveBeenCalledWith(undefined)
    expect(edited(t)).toContain('2 channel(s)')
  })

  it('status shows state, percent and message count', async () => {
    const t = setup({ action: 'status' })
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain('#general: running, 50%, 42 messages')
  })

  it('status of a finished run counts what that run added, and says up to date when nothing was new', async () => {
    const t = setup({ action: 'status' })
    t.api.listImports.mockResolvedValueOnce([job({ state: 'done', imported_count: 7 })])
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain('#general: done, 100%, 7 new messages')

    const u = setup({ action: 'status' })
    u.api.listImports.mockResolvedValueOnce([job({ state: 'done', imported_count: 0 })])
    await handleInteraction(u.rt, u.interaction)
    expect(edited(u)).toContain('#general: done, 100%, up to date')
  })

  it('cancel cancels each active job in scope', async () => {
    const t = setup({ action: 'cancel' })
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.cancelImport).toHaveBeenCalledWith('j1')
    expect(edited(t)).toContain('Cancelling')
  })

  it('replies not bridged in an unpaired channel', async () => {
    const t = setup({ paired: false })
    await handleInteraction(t.rt, t.interaction)
    expect(text(t.reply)).toContain("This channel isn't bridged")
    expect(t.api.startImports).not.toHaveBeenCalled()
  })

  it('explains pair_not_importable', async () => {
    const t = setup()
    t.api.startImports.mockRejectedValueOnce(new BridgeApiError('x', 400, 'pair_not_importable'))
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain("This channel's pair doesn't bring Discord messages to Harmony")
  })

  it('defers before any API call and answers through editReply', async () => {
    const t = setup()
    await handleInteraction(t.rt, t.interaction)
    expect(t.order[0]).toBe('defer')
    expect(t.deferReply.mock.calls[0][0].flags).toBeDefined()
    expect(t.reply).not.toHaveBeenCalled()
    expect(t.editReply).toHaveBeenCalledTimes(1)
  })

  it('defers before listing on status and cancel too', async () => {
    for (const action of ['status', 'cancel']) {
      const t = setup({ action })
      await handleInteraction(t.rt, t.interaction)
      expect(t.order[0]).toBe('defer')
      expect(t.reply).not.toHaveBeenCalled()
    }
  })

  it('reports an API failure with followUp once deferred', async () => {
    const t = setup()
    t.api.startImports.mockRejectedValueOnce(new Error('boom'))
    await handleInteraction(t.rt, t.interaction)
    expect(t.followUp.mock.calls[0][0].content).toContain('boom')
    expect(t.reply).not.toHaveBeenCalled()
  })

  it('says nothing to import when no channel qualifies', async () => {
    const t = setup({ scope: 'all' })
    t.api.startImports.mockResolvedValueOnce([])
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toBe('Nothing to import: no channel here brings Discord messages to Harmony.')
  })

  it.each([
    ['pair_removed', 'pair removed'],
    ['channel_encrypted', 'channel is now encrypted'],
    ['discord_access_lost', 'the bot lost access to the Discord channel'],
    ['bridge_stalled', 'the import stopped making progress'],
    ['harmony_403', 'Harmony refused the import (403)'],
  ])('status explains error %s', async (code, sentence) => {
    const t = setup({ action: 'status' })
    t.api.listImports.mockResolvedValueOnce([job({ state: 'failed', error: code })])
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain(sentence)
    expect(edited(t)).not.toContain(code)
  })

  it('status shows cancelling when a cancel is requested', async () => {
    const t = setup({ action: 'status' })
    t.api.listImports.mockResolvedValueOnce([job({ cancel_requested: true })])
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain('cancelling')
    expect(edited(t)).not.toContain('running')
  })

  it('says importing needs the current bridge setup without the import api', async () => {
    const t = setup({ api: false })
    await handleInteraction(t.rt, t.interaction)
    expect(text(t.reply)).toMatch(/current bridge setup/)
  })
})
