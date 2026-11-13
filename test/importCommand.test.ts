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

function setup(opts: {
  admin?: boolean
  action?: string | null
  scope?: string | null
  paired?: boolean
  thread?: boolean
  /** No import routes: a hosted bridge or the instance bot. */
  api?: boolean
  /** `history_import.enabled` of the configuration. */
  enabled?: boolean
  confirm?: 'confirm' | 'cancel' | 'timeout'
  /** Discord channel ids the invoker cannot view. */
  hidden?: string[]
} = {}) {
  const api = {
    listImports: vi.fn(async () => [job()]),
    startImports: vi.fn(async (ids?: string[], _by?: { id: string; username?: string }) =>
      (ids ?? []).map(id => job({ discord_channel_id: id, state: 'queued' }))),
    cancelImport: vi.fn(async (_id: string) => [] as ImportJob[]),
  }
  const kick = vi.fn()
  // d1 and d2 bring Discord messages to Harmony; d3 is one-way to Discord.
  const pairs = [
    { discord: 'd1', harmony: 'h1', direction: 'both' },
    { discord: 'd2', harmony: 'h2', direction: 'to_harmony' },
    { discord: 'd3', harmony: 'h3', direction: 'to_discord' },
  ]
  const rt: any = {
    mode: 'v2',
    log: { error: vi.fn(), info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    dir: {
      getBridgeForDiscordGuild: () => ({ harmonyServerId: 's' }),
      getHarmonyChannel: (id: string) => (opts.paired === false ? null : pairs.find(p => p.discord === id)?.harmony ?? null),
      getAllMappings: () => (opts.paired === false ? [] : pairs),
      shouldBridgeFromDiscord: (id: string) => pairs.some(p => p.discord === id && p.direction !== 'to_discord'),
    },
    hooks: {
      kickImports: kick,
      ...(opts.api === false ? {} : { importApi: api }),
      importEnabled: () => opts.enabled !== false,
      harmonyChannels: () => [{ id: 'h1', name: 'general' }],
    },
  }
  const order: string[] = []
  for (const [name, fn] of Object.entries(api)) {
    const orig = fn as any
    ;(api as any)[name] = vi.fn(async (...args: any[]) => { order.push(name); return orig(...args) })
  }
  const member = { permissions: { has: (p: bigint) => opts.admin !== false && p === PermissionFlagsBits.Administrator } }
  const hidden = new Set(opts.hidden ?? [])
  const channelOf = (id: string) => ({
    id,
    permissionsFor: (who: unknown) => ({ has: (flag: bigint) => who === member && flag === PermissionFlagsBits.ViewChannel && !hidden.has(id) }),
  })
  const reply = vi.fn(async (_arg: any) => {})
  const message = {
    awaitMessageComponent: vi.fn(async () => {
      order.push('confirm')
      if (opts.confirm === 'timeout') throw new Error('time')
      return { customId: `${opts.confirm ?? 'confirm'}:i1`, user: { id: 'u1' }, update: vi.fn(async () => {}) }
    }),
  }
  const deferReply = vi.fn(async (_arg: any) => { order.push('defer'); interaction.deferred = true })
  const editReply = vi.fn(async (_arg: any) => message)
  const followUp = vi.fn(async (_arg: any) => {})
  const interaction: any = {
    id: 'i1',
    user: { id: 'u1', username: 'dana' },
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    commandName: 'bridge',
    guild: { id: 'g', channels: { cache: new Map(pairs.map(p => [p.discord, channelOf(p.discord)])), fetch: vi.fn(async () => null) } },
    guildId: 'g',
    member,
    channelId: opts.thread ? 'thread9' : 'd1',
    channel: opts.thread ? { isThread: () => true, parentId: 'd1' } : { isThread: () => false },
    options: {
      getSubcommand: () => 'import-history',
      getString: (name: string) => (name === 'action' ? opts.action ?? null : opts.scope ?? null),
    },
    reply, deferReply, editReply, followUp, deferred: false, replied: false,
  }
  return { rt, interaction, api, kick, reply, deferReply, editReply, followUp, order, message }
}
const text = (reply: { mock: { calls: any[][] } }) => reply.mock.calls[0][0].content as string
/** The last text the deferred reply was edited to. */
const edited = (t: { editReply: { mock: { calls: any[][] } } }) => t.editReply.mock.calls.at(-1)![0].content as string
/** The Confirm prompt: the first edit of a start. */
const prompt = (t: { editReply: { mock: { calls: any[][] } } }) => t.editReply.mock.calls[0][0].content as string

describe('/bridge import-history', () => {
  it('is registered for v2 only, and only where import is available', () => {
    const features = { soundSync: false, emojiSync: false, stickerSync: false, historyImport: true, privacy: false }
    const subs = (m: 'v1' | 'v2', f = features) => buildCommands(m, f).find(c => c.name === 'bridge')!.options!.map((o: any) => o.name)
    expect(subs('v2')).toContain('import-history')
    expect(subs('v1')).not.toContain('import-history')
    expect(subs('v2', { ...features, historyImport: false })).not.toContain('import-history')
  })

  it('refuses a member without Administrator', async () => {
    const t = setup({ admin: false })
    await handleInteraction(t.rt, t.interaction)
    expect(text(t.reply)).toMatch(/Administrator/)
    expect(t.api.startImports).not.toHaveBeenCalled()
  })

  it('start asks for confirmation before anything is queued', async () => {
    const t = setup({ confirm: 'cancel' })
    await handleInteraction(t.rt, t.interaction)
    expect(t.message.awaitMessageComponent).toHaveBeenCalledTimes(1)
    expect(t.api.startImports).not.toHaveBeenCalled()
    expect(t.kick).not.toHaveBeenCalled()
    const asked = prompt(t)
    expect(asked).toContain('Import the history of 1 channel into Harmony? <#d1>')
    expect(asked).toContain('Every message and file in them is copied to Harmony')
    expect(asked).toContain('Messages of people who left this server')
    expect(asked).toContain('There is no undo button')
    expect(t.editReply.mock.calls[0][0].components).toHaveLength(1)
  })

  it('start without an action asks too: nothing starts on the default alone', async () => {
    const t = setup({ action: null, confirm: 'timeout' })
    await handleInteraction(t.rt, t.interaction)
    expect(t.message.awaitMessageComponent).toHaveBeenCalledTimes(1)
    expect(t.api.startImports).not.toHaveBeenCalled()
  })

  it('start queues the paired channel after Confirm, names the invoker and kicks the scheduler', async () => {
    const t = setup()
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.startImports).toHaveBeenCalledWith(['d1'], { id: 'u1', username: 'dana' })
    expect(t.order.indexOf('confirm')).toBeLessThan(t.order.indexOf('startImports'))
    expect(t.kick).toHaveBeenCalled()
    expect(edited(t)).toContain('Importing history for 1 channel(s)')
    expect(t.deferReply.mock.calls[0][0].flags).toBeDefined()
    expect(t.rt.log.info).toHaveBeenCalledWith(expect.stringMatching(/import-history start by u1 in guild g: 1 job\(s\) for 1 channel\(s\)/))
  })

  it('start in a thread uses the parent channel', async () => {
    const t = setup({ thread: true })
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.startImports).toHaveBeenCalledWith(['d1'], expect.anything())
  })

  it('scope:all names every pair that brings Discord messages to Harmony', async () => {
    const t = setup({ scope: 'all' })
    await handleInteraction(t.rt, t.interaction)
    expect(prompt(t)).toContain('Import the history of 2 channels into Harmony? <#d1>, <#d2>')
    expect(t.api.startImports).toHaveBeenCalledWith(['d1', 'd2'], { id: 'u1', username: 'dana' })
    expect(edited(t)).toContain('2 channel(s)')
  })

  it('scope:all leaves out the channels the invoker cannot view and names them', async () => {
    const t = setup({ scope: 'all', hidden: ['d2'] })
    await handleInteraction(t.rt, t.interaction)
    expect(prompt(t)).toContain('Import the history of 1 channel into Harmony? <#d1>')
    expect(prompt(t)).toContain('Left out, you cannot view it: <#d2>')
    expect(t.api.startImports).toHaveBeenCalledWith(['d1'], expect.anything())
    expect(edited(t)).toContain('Left out, you cannot view it: <#d2>')
  })

  it('starts nothing for a channel the invoker cannot view', async () => {
    const t = setup({ thread: true, hidden: ['d1'] })
    await handleInteraction(t.rt, t.interaction)
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.api.startImports).not.toHaveBeenCalled()
    expect(edited(t)).toContain('you cannot view this channel')
  })

  it('starts the rest when Harmony names a pair it will not import', async () => {
    const t = setup({ scope: 'all' })
    t.api.startImports.mockRejectedValueOnce(new BridgeApiError('x', 400, 'pair_not_importable', { discord_channel_id: 'd2' }))
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.startImports.mock.calls.map(c => c[0])).toEqual([['d1', 'd2'], ['d1']])
    expect(edited(t)).toContain('Importing history for 1 channel(s)')
    expect(edited(t)).toContain('Not importable')
    expect(edited(t)).toContain('<#d2>')
  })

  it('status shows state, percent and message count', async () => {
    const t = setup({ action: 'status' })
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain('#general: running, 50%, 42 messages')
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
  })

  it('status shows how many messages were left out because of their author', async () => {
    const t = setup({ action: 'status' })
    t.api.listImports.mockResolvedValueOnce([job({ authors_skipped: 12 })])
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain('12 skipped (author left or opted out)')
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

  it('explains a pair that only goes to Discord', async () => {
    const t = setup()
    t.interaction.channelId = 'd3'
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain("This channel's pair doesn't bring Discord messages to Harmony")
    expect(t.api.startImports).not.toHaveBeenCalled()
  })

  it('defers before any API call and answers through editReply', async () => {
    const t = setup()
    await handleInteraction(t.rt, t.interaction)
    expect(t.order[0]).toBe('defer')
    expect(t.deferReply.mock.calls[0][0].flags).toBeDefined()
    expect(t.reply).not.toHaveBeenCalled()
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
    const t = setup({ scope: 'all', paired: false })
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toBe('Nothing to import: no channel here brings Discord messages to Harmony.')
    expect(t.api.startImports).not.toHaveBeenCalled()
  })

  it.each([
    ['pair_removed', 'pair removed'],
    ['channel_encrypted', 'channel is now encrypted'],
    ['discord_access_lost', 'the bot lost access to the Discord channel'],
    ['bridge_stalled', 'the import stopped making progress'],
    ['discord_approval_required', 'hidden from @everyone'],
    ['discord_channel_unsupported', 'cannot be imported'],
    ['import_disabled', 'history import was turned off'],
    ['harmony_403', 'Harmony refused the import (403)'],
  ])('status explains error %s', async (code, sentence) => {
    const t = setup({ action: 'status' })
    t.api.listImports.mockResolvedValueOnce([job({ state: 'failed', error: code })])
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain(sentence)
    expect(edited(t)).not.toContain(code)
  })

  it('status shows a server error text it does not know as it is', async () => {
    const t = setup({ action: 'status' })
    t.api.listImports.mockResolvedValueOnce([job({ state: 'failed', error: 'invalid_batch' })])
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain('(invalid_batch)')
  })

  it('status shows cancelling when a cancel is requested', async () => {
    const t = setup({ action: 'status' })
    t.api.listImports.mockResolvedValueOnce([job({ cancel_requested: true })])
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain('cancelling')
    expect(edited(t)).not.toContain('running')
  })

  it.each([
    ['a bridge without the import routes', { api: false }],
    ['a bridge whose configuration has import off', { enabled: false }],
  ])('calls no import route for %s', async (_name, over) => {
    for (const action of ['start', 'status', 'cancel']) {
      const t = setup({ ...over, action, scope: 'all' })
      await handleInteraction(t.rt, t.interaction)
      expect(text(t.reply)).toContain('History import is not available for this bridge')
      expect(t.deferReply).not.toHaveBeenCalled()
      expect(t.order).toEqual([])
    }
  })

  it.each([
    ['instance_off', 'turned off on this Harmony instance'],
    ['bridge_mode', 'Only a bridge you run yourself can import history'],
  ])('explains a 403 import_disabled with reason %s', async (reason, sentence) => {
    const t = setup({ action: 'status' })
    t.api.listImports.mockRejectedValueOnce(new BridgeApiError('off', 403, 'import_disabled', { reason }))
    await handleInteraction(t.rt, t.interaction)
    expect(edited(t)).toContain(sentence)
    expect(t.followUp).not.toHaveBeenCalled()
  })
})
