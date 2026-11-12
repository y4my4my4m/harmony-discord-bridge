import { describe, expect, it, vi } from 'vitest'
import { runBridgeSyncEmojis } from '../src/runtime/commands.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'

function dEmoji(id: string, name: string | null, extra: Record<string, unknown> = {}) {
  return { id, name, animated: false, available: true, ...extra }
}
/**
 * A row of GET /servers/:id/emojis/discord. `discord` null: a member's upload. `removed`:
 * 'bridge' is a removal the bridge may undo, 'person' one it may not.
 */
function hRow(id: string, name: string, discord: string | null = null, removed: false | 'bridge' | 'person' = false, extra: Record<string, unknown> = {}) {
  return {
    id, name, url: null, discord_emoji_id: discord, removed: removed !== false,
    imported: discord !== null, restorable: removed === 'bridge', ...extra,
  }
}

function setup(opts: {
  mode?: string | null
  dryRun?: boolean
  discord?: unknown[]
  limit?: number
  harmony?: unknown[] | Error
  /** Rows answered to the read after Confirm; default: the same rows. */
  harmonyAfterConfirm?: unknown[]
  confirm?: 'confirm' | 'cancel'
}) {
  const calls: string[] = []
  const replies: Array<Record<string, any>> = []
  const message = {
    awaitMessageComponent: vi.fn(async () => ({
      customId: `${opts.confirm ?? 'confirm'}:i1`,
      user: { id: 'u1' },
      update: vi.fn(async () => {}),
    })),
  }
  const command: any = {
    id: 'i1',
    user: { id: 'u1' },
    options: {
      getString: () => opts.mode ?? null,
      getBoolean: () => opts.dryRun ?? false,
    },
    guild: {
      id: 'g1',
      name: 'G',
      emojis: { fetch: vi.fn(async () => new Map((opts.discord ?? []).map((e: any) => [e.id, e]))) },
    },
    deferred: false,
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (r: any) => { replies.push(r); return message }),
  }
  let reads = 0
  const rt: any = {
    mode: 'v2',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    dir: { getBridgeForDiscordGuild: () => ({ harmonyServerId: 's1' }) },
    emojiLinks: { ensure: vi.fn(async () => {}), harmonyFor: () => null, set: vi.fn(), replace: vi.fn() },
    harmony: {
      getEmojiSyncState: vi.fn(async () => {
        if (opts.harmony instanceof Error) throw opts.harmony
        reads++
        return { limit: opts.limit ?? 50, emojis: reads > 1 && opts.harmonyAfterConfirm ? opts.harmonyAfterConfirm : opts.harmony ?? [] }
      }),
      getServerEmojis: vi.fn(async () => []),
      removeServerEmoji: vi.fn(async (_s: string, id: string) => { calls.push(`remove:${id}`) }),
      importDiscordEmoji: vi.fn(async (_s: string, e: any, update?: boolean): Promise<any> => {
        calls.push(`${update ? 'update' : 'create'}:${e.name}`)
        return { status: update ? 'updated' : 'created' }
      }),
    },
  }
  return { command, rt, calls, replies, message }
}

const last = (t: ReturnType<typeof setup>) => t.replies.at(-1)!.content as string

describe('runBridgeSyncEmojis', () => {
  it('runs merge without a mode: removes nothing and asks nothing', async () => {
    const t = setup({ discord: [dEmoji('1', 'fresh')], harmony: [hRow('h9', 'stale', '9'), hRow('h4', 'mine')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.calls).toEqual(['create:fresh'])
    expect(last(t)).toContain('Emoji sync (merge)')
  })

  it('mirror removes imported emoji deleted on Discord, creates, renames and restores after Confirm', async () => {
    const t = setup({
      mode: 'mirror',
      discord: [dEmoji('1', 'fresh'), dEmoji('2', 'newname'), dEmoji('3', 'back')],
      harmony: [hRow('h2', 'oldname', '2'), hRow('h3', 'back', '3', 'bridge'), hRow('h9', 'stale', '9'), hRow('h4', 'mine')],
    })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.replies[0].content.split('\n')[0]).toContain('⚠️ This removes 1 Harmony emoji the bridge imported.')
    expect(t.calls).toEqual(['remove:h9', 'create:fresh', 'update:newname', 'update:back'])
    expect(t.rt.emojiLinks.replace).toHaveBeenCalledTimes(1)
    const text = last(t)
    expect(text).toContain('Emoji sync (mirror)')
    expect(text).toContain('• Added: 1')
    expect(text).toContain('• Renamed: 1')
    expect(text).toContain('• Restored: 1')
    expect(text).toContain('• Removed: 1')
    expect(text).toContain('• Kept (not imported by the bridge): 1')
  })

  it('mirror never removes an emoji a member uploaded, also one the gateway linked by name', async () => {
    const t = setup({
      mode: 'mirror',
      discord: [],
      harmony: [hRow('h1', 'mine'), hRow('h2', 'adopted', '7', false, { imported: false })],
    })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.rt.harmony.removeServerEmoji).not.toHaveBeenCalled()
    expect(last(t)).toContain('Kept: 2 emoji not copied from Discord')
  })

  it('mirror cancel makes no calls', async () => {
    const t = setup({ mode: 'mirror', discord: [], harmony: [hRow('h1', 'stale', '9')], confirm: 'cancel' })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.replies[0].content.split('\n')[0]).toContain('This Discord server has no emoji. This removes all 1 Harmony emoji the bridge imported.')
    expect(t.calls).toEqual([])
    expect(t.rt.emojiLinks.replace).not.toHaveBeenCalled()
  })

  it('mirror reports a member emoji holding a Discord name as a clash and replaces nothing', async () => {
    const t = setup({ mode: 'mirror', discord: [dEmoji('1', 'horn')], harmony: [hRow('h1', 'horn')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(last(t)).toContain('Name clash: 1 emoji')
  })

  it('mirror replace removes an imported holder whose Discord emoji is gone, then creates', async () => {
    const t = setup({ mode: 'mirror', discord: [dEmoji('1', 'horn')], harmony: [hRow('h1', 'horn', '9')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual(['remove:h1', 'create:horn'])
    expect(last(t)).toContain('• Replaced (same name, copied from a deleted Discord one): 1')
    expect(last(t)).toContain('• Removed: 0')
  })

  it('a failed holder removal blocks the create', async () => {
    const t = setup({ mode: 'mirror', discord: [dEmoji('1', 'horn')], harmony: [hRow('h1', 'horn', '9')] })
    t.rt.harmony.removeServerEmoji.mockRejectedValue(new HarmonyHttpError('server error', 500))
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.rt.harmony.importDiscordEmoji).not.toHaveBeenCalled()
    expect(last(t)).toContain('1 failure(s)')
  })

  it('a replace whose copy fails names the removed emoji and who can restore it', async () => {
    const t = setup({ mode: 'mirror', discord: [dEmoji('1', 'horn')], harmony: [hRow('h1', 'horn', '9')] })
    t.rt.harmony.importDiscordEmoji.mockRejectedValue(new HarmonyHttpError('image download failed', 502))
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(last(t)).toContain(':horn: the old Harmony emoji was removed but the Discord one could not be copied (image download failed); an instance administrator can restore the old one')
  })

  it('counts an emoji the gateway keeps as a member upload as kept, not as a failure', async () => {
    const t = setup({ mode: 'mirror', discord: [dEmoji('1', 'horn')], harmony: [hRow('h1', 'horn', '9'), hRow('h2', 'stale', '8')] })
    t.rt.harmony.removeServerEmoji.mockRejectedValue(new HarmonyHttpError('EMOJI_NOT_LINKED: a member uploaded it', 403, 'EMOJI_NOT_LINKED'))
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.rt.harmony.importDiscordEmoji).not.toHaveBeenCalled()
    expect(last(t)).toContain('✅ Emoji sync (mirror)')
    expect(last(t)).toContain('• Kept (not imported by the bridge): 2')
    expect(last(t)).not.toContain('failure')
  })

  it('applies nothing when the emoji to remove changed during the confirmation', async () => {
    const t = setup({
      mode: 'mirror',
      discord: [],
      harmony: [hRow('h1', 'stale', '9')],
      harmonyAfterConfirm: [hRow('h1', 'stale', '9'), hRow('h2', 'other', '8')],
    })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(last(t)).toContain('changed while this waited')
  })

  it('puts the removal warning first in a prompt too long for Discord', async () => {
    const stale = Array.from({ length: 12 }, (_, i) => hRow(`h${i}`, `stale_emoji_with_a_long_name_${i}`, `9${i}`))
    const fresh = Array.from({ length: 60 }, (_, i) => dEmoji(`1${String(i).padStart(3, '0')}`, `new_emoji_with_a_long_name_${i}`))
    const renamed = Array.from({ length: 30 }, (_, i) => hRow(`r${i}`, `before_${i}`, `2${String(i).padStart(3, '0')}`))
    const renames = Array.from({ length: 30 }, (_, i) => dEmoji(`2${String(i).padStart(3, '0')}`, `renamed_emoji_long_name_${i}`))
    const t = setup({ mode: 'mirror', limit: 500, discord: [...fresh, ...renames], harmony: [...stale, ...renamed], confirm: 'cancel' })
    await runBridgeSyncEmojis(t.rt, t.command)
    const prompt = t.replies[0].content as string
    expect(prompt.length).toBeLessThanOrEqual(2000)
    expect(prompt).toContain('more_')
    expect(prompt.split('\n')[0]).toContain('⚠️ This removes 12 Harmony emoji the bridge imported.')
    for (let i = 0; i < 12; i++) expect(prompt).toContain(`:stale_emoji_with_a_long_name_${i}:`)
  })

  it('merge lists a same-name unlinked emoji as a clash and changes nothing', async () => {
    const t = setup({ mode: 'merge', discord: [dEmoji('1', 'horn')], harmony: [hRow('h1', 'horn')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(last(t)).toContain('Name clash: 1 emoji')
    expect(last(t)).not.toContain('mirror')
  })

  it('merge does not rename into a clashing name', async () => {
    const t = setup({
      mode: 'merge',
      discord: [dEmoji('1', 'taken')],
      harmony: [hRow('h1', 'old', '1'), hRow('h2', 'taken')],
    })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.rt.harmony.importDiscordEmoji).not.toHaveBeenCalled()
    expect(last(t)).toContain('Name clash')
  })

  it('merge restores an emoji the bridge removed, with update', async () => {
    const t = setup({ mode: 'merge', discord: [dEmoji('1', 'back')], harmony: [hRow('h1', 'back', '1', 'bridge')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual(['update:back'])
    expect(t.rt.harmony.importDiscordEmoji.mock.calls[0][2]).toBe(true)
  })

  it('never restores an emoji a person removed, in any mode', async () => {
    for (const mode of ['mirror', 'merge', 'add']) {
      const t = setup({ mode, discord: [dEmoji('1', 'banned')], harmony: [hRow('h1', 'banned', '1', 'person')] })
      await runBridgeSyncEmojis(t.rt, t.command)
      expect(t.calls).toEqual([])
      expect(last(t)).toContain('Left removed: 1 emoji (a person removed it on Harmony)')
      expect(last(t)).not.toContain('Would restore')
      expect(last(t)).not.toContain('Not updated')
    }
  })

  it('does not restore a removed emoji when the gateway does not say who removed it', async () => {
    const t = setup({ mode: 'merge', discord: [dEmoji('1', 'back')], harmony: [{ id: 'h1', name: 'back', url: null, discord_emoji_id: '1', removed: true }] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
  })

  it('an emoji a person removed does not take a slot from a new one', async () => {
    const t = setup({
      mode: 'merge',
      limit: 1,
      discord: [dEmoji('1', 'banned'), dEmoji('2', 'fresh')],
      harmony: [hRow('h1', 'banned', '1', 'person')],
    })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual(['create:fresh'])
    expect(last(t)).not.toContain('limit reached')
  })

  it('reports a restore the gateway refuses as left removed, not as a failure', async () => {
    const t = setup({ mode: 'merge', discord: [dEmoji('1', 'back')], harmony: [hRow('h1', 'back', '1', 'bridge')] })
    t.rt.harmony.importDiscordEmoji.mockRejectedValue(new HarmonyHttpError('EMOJI_REMOVED: a person removed it', 403, 'EMOJI_REMOVED'))
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(last(t)).toContain('✅ Emoji sync (merge)')
    expect(last(t)).toContain('• Left removed (a person removed them on Harmony): 1')
    expect(last(t)).not.toContain('failure')
  })

  it('plans one emoji per name when Discord has two of a name, the older one', async () => {
    const t = setup({ mode: 'merge', limit: 1, discord: [dEmoji('20', 'Dup'), dEmoji('10', 'dup')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual(['create:dup'])
    expect(last(t)).toContain('1 skipped: another emoji on Discord has the same name')
    expect(last(t)).toContain(':Dup:')
    expect(last(t)).not.toContain('limit reached')
  })

  it('add only creates; an emoji the bridge removed counts as not updated', async () => {
    const t = setup({
      mode: 'add',
      discord: [dEmoji('1', 'fresh'), dEmoji('2', 'back')],
      harmony: [hRow('h2', 'back', '2', 'bridge')],
    })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual(['create:fresh'])
    expect(last(t)).toContain('Not updated (add mode): 1')
  })

  it('leaves an unavailable linked emoji alone', async () => {
    const t = setup({ mode: 'mirror', discord: [dEmoji('1', 'x', { available: false })], harmony: [hRow('h1', 'other', '1')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(last(t)).toBe('✅ Emoji already match.')
  })

  it('leaves the row of a Discord emoji without a usable name alone', async () => {
    const t = setup({ mode: 'mirror', discord: [dEmoji('1', null)], harmony: [hRow('h1', 'named', '1')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
  })

  it('creates what fits under the limit and lists the rest', async () => {
    const t = setup({
      mode: 'add',
      limit: 2,
      discord: [dEmoji('1', 'a'), dEmoji('2', 'b'), dEmoji('3', 'c')],
      harmony: [hRow('h0', 'existing', '9')],
    })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual(['create:a'])
    const text = last(t)
    expect(text).toContain('2 skipped')
    expect(text).toContain('max custom emojis per server')
  })

  it('counts by the status Harmony answers: existing and linked are not added', async () => {
    const t = setup({ mode: 'add', discord: [dEmoji('1', 'a'), dEmoji('2', 'b'), dEmoji('3', 'c')] })
    const answers: Record<string, string> = { a: 'existing', b: 'linked', c: 'created' }
    t.rt.harmony.importDiscordEmoji.mockImplementation(async (_s: string, e: any) => ({ status: answers[e.name] }))
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(last(t)).toContain('• Added: 1')
    expect(last(t)).toContain('• Linked to a Harmony emoji with the same name: 1')
    expect(last(t)).toContain('• Already there: 1')
  })

  it('reports a taken name and keeps going', async () => {
    const t = setup({ mode: 'add', discord: [dEmoji('1', 'a'), dEmoji('2', 'b')] })
    t.rt.harmony.importDiscordEmoji.mockImplementation(async (_s: string, e: any) => {
      if (e.name === 'a') throw new HarmonyHttpError('taken', 409, 'EMOJI_NAME_TAKEN')
      t.calls.push(`create:${e.name}`)
      return { status: 'created' }
    })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual(['create:b'])
    expect(last(t)).toContain('name already used by another Harmony emoji')
  })

  it('reports a full emoji list', async () => {
    const t = setup({ mode: 'add', discord: [dEmoji('1', 'a')] })
    t.rt.harmony.importDiscordEmoji.mockRejectedValue(new HarmonyHttpError('full', 409, 'EMOJI_LIMIT'))
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(last(t)).toContain('the Harmony emoji list is full (50 per server)')
  })

  it('sync-emojis on a 404 says which Harmony it needs', async () => {
    const t = setup({ harmony: new HarmonyHttpError('nope', 404) })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(last(t)).toContain('needs Harmony 1.9.7 or later')
    expect(t.rt.harmony.importDiscordEmoji).not.toHaveBeenCalled()
  })

  it('import-emojis on a 404 runs the legacy import', async () => {
    const t = setup({ harmony: new HarmonyHttpError('nope', 404), discord: [dEmoji('1', 'a')] })
    await runBridgeSyncEmojis(t.rt, t.command, { mode: 'add' })
    expect(t.command.deferReply).toHaveBeenCalledTimes(1)
    expect(t.rt.harmony.importDiscordEmoji).toHaveBeenCalledTimes(1)
    expect(t.rt.harmony.importDiscordEmoji.mock.calls[0][2]).toBeUndefined()
    expect(last(t)).toContain('Emoji import')
  })

  it('plans nothing on a list too large to answer whole', async () => {
    const t = setup({ mode: 'mirror', harmony: new HarmonyHttpError('more than 10000 emoji rows', 500, 'LIST_TOO_LARGE'), discord: [dEmoji('1', 'a')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(last(t)).toContain('too many emoji rows')
  })

  it('lets a 403 propagate', async () => {
    const t = setup({ harmony: new HarmonyHttpError('forbidden', 403) })
    await expect(runBridgeSyncEmojis(t.rt, t.command)).rejects.toThrow('forbidden')
    expect(t.rt.harmony.importDiscordEmoji).not.toHaveBeenCalled()
  })

  it('refuses a second run, sync-emojis or import-emojis, while one is in flight', async () => {
    const t = setup({ mode: 'merge', discord: [dEmoji('1', 'a')] })
    let release!: () => void
    t.rt.harmony.importDiscordEmoji.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const running = runBridgeSyncEmojis(t.rt, t.command)
    await vi.waitFor(() => expect(t.rt.harmony.importDiscordEmoji).toHaveBeenCalled())

    const second = setup({ discord: [dEmoji('1', 'a')] })
    await runBridgeSyncEmojis(second.rt, second.command, { mode: 'add' })
    expect(last(second)).toContain('already running')
    expect(second.rt.harmony.importDiscordEmoji).not.toHaveBeenCalled()

    release()
    await running
  })

  it('logs who ran the sync, where, and what it did', async () => {
    const t = setup({ mode: 'merge', discord: [dEmoji('1', 'a')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.rt.log.info).toHaveBeenCalledWith(expect.stringMatching(/sync-emojis \(merge\) by u1 in guild g1: added 1, /))
  })

  it('writes nothing on a dry run', async () => {
    const t = setup({ mode: 'mirror', dryRun: true, discord: [dEmoji('1', 'fresh')], harmony: [hRow('h1', 'stale', '9')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    const text = last(t)
    expect(text).toContain('Dry run')
    expect(text).toContain(':fresh:')
    expect(text).toContain(':stale:')
  })
})
