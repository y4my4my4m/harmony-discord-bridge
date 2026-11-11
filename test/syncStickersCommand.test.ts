import { describe, expect, it, vi } from 'vitest'
import { runBridgeSyncStickers } from '../src/runtime/commands.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'

function dSticker(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, description: `${name} desc`, format: 1, available: true, ...extra }
}
function hRow(id: string, name: string, discord: string | null = null, removed = false, description?: string) {
  return { id, name, description: description ?? `${name} desc`, url: 'u', discord_sticker_id: discord, removed }
}

function setup(opts: {
  mode?: string | null
  dryRun?: boolean
  discord?: unknown[]
  limit?: number
  harmony?: unknown[] | Error
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
  const fetchStickers = vi.fn(async () => new Map((opts.discord ?? []).map((e: any) => [e.id, e])))
  const command: any = {
    id: 'i1',
    user: { id: 'u1' },
    options: {
      getString: () => opts.mode ?? null,
      getBoolean: () => opts.dryRun ?? false,
    },
    guild: { id: 'g1', name: 'G', stickers: { fetch: fetchStickers } },
    deferred: false,
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (r: any) => { replies.push(r); return message }),
  }
  const rt: any = {
    mode: 'v2',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    dir: { getBridgeForDiscordGuild: () => ({ harmonyServerId: 's1' }) },
    stickerLinks: { replace: vi.fn() },
    harmony: {
      getStickerSyncState: vi.fn(async () => {
        if (opts.harmony instanceof Error) throw opts.harmony
        return { limit: opts.limit ?? 15, stickers: opts.harmony ?? [] }
      }),
      removeServerSticker: vi.fn(async (_s: string, id: string) => { calls.push(`remove:${id}`) }),
      importDiscordSticker: vi.fn(async (_s: string, d: any, update?: boolean) => {
        calls.push(`${update ? 'update' : 'create'}:${d.name}`)
        return { status: update ? 'updated' : 'created' }
      }),
    },
  }
  return { command, rt, calls, replies, message, fetchStickers }
}

const last = (t: ReturnType<typeof setup>) => t.replies.at(-1)!.content as string

describe('runBridgeSyncStickers', () => {
  it('mirror removes, creates, updates and restores after Confirm', async () => {
    const t = setup({
      discord: [dSticker('1', 'fresh'), dSticker('2', 'newname'), dSticker('3', 'back'), dSticker('4', 'same', { description: 'new text' })],
      harmony: [hRow('h2', 'oldname', '2'), hRow('h3', 'back', '3', true), hRow('h4', 'same', '4', false, 'old text'), hRow('h5', 'extra')],
    })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.replies[0].content).toContain('This removes 1 Harmony sticker. Removed stickers leave the sticker list.')
    expect(t.calls).toEqual(['remove:h5', 'create:fresh', 'update:newname', 'update:same', 'update:back'])
    expect(t.rt.stickerLinks.replace).toHaveBeenCalledTimes(1)
    const text = last(t)
    expect(text).toContain('Sticker sync (mirror)')
    expect(text).toContain('• Added: 1')
    expect(text).toContain('• Updated: 2')
    expect(text).toContain('• Restored: 1')
    expect(text).toContain('• Removed: 1')
  })

  it('mirror cancel makes no calls', async () => {
    const t = setup({ discord: [], harmony: [hRow('h1', 'extra')], confirm: 'cancel' })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.rt.stickerLinks.replace).not.toHaveBeenCalled()
  })

  it('mirror replace removes the holder, then creates', async () => {
    const t = setup({ discord: [dSticker('1', 'horn')], harmony: [hRow('h1', 'horn')] })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual(['remove:h1', 'create:horn'])
    expect(last(t)).toContain('• Replaced (same name on Harmony): 1')
    expect(last(t)).toContain('• Removed: 0')
  })

  it('a failed holder removal blocks the create', async () => {
    const t = setup({ discord: [dSticker('1', 'horn')], harmony: [hRow('h1', 'horn')] })
    t.rt.harmony.removeServerSticker.mockRejectedValue(new HarmonyHttpError('server error', 500))
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.rt.harmony.importDiscordSticker).not.toHaveBeenCalled()
    expect(last(t)).toContain('1 failure(s)')
  })

  it('merge lists a same-name unlinked sticker as a clash and changes nothing', async () => {
    const t = setup({ mode: 'merge', discord: [dSticker('1', 'horn')], harmony: [hRow('h1', 'horn')] })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(last(t)).toContain('Name clash: 1 sticker')
  })

  it('merge does not update into a clashing name', async () => {
    const t = setup({
      mode: 'merge',
      discord: [dSticker('1', 'taken')],
      harmony: [hRow('h1', 'old', '1'), hRow('h2', 'taken')],
    })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.rt.harmony.importDiscordSticker).not.toHaveBeenCalled()
    expect(last(t)).toContain('Name clash')
  })

  it('add only creates; an outdated linked sticker counts as not updated', async () => {
    const t = setup({
      mode: 'add',
      discord: [dSticker('1', 'fresh'), dSticker('2', 'new')],
      harmony: [hRow('h2', 'old', '2')],
    })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual(['create:fresh'])
    expect(last(t)).toContain('Not updated (add mode): 1')
  })

  it('leaves an unavailable linked sticker alone', async () => {
    const t = setup({ discord: [dSticker('1', 'x', { available: false })], harmony: [hRow('h1', 'other', '1')] })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(last(t)).toBe('✅ Stickers already match.')
  })

  it('lists Lottie and too-short names as skipped and keeps their Harmony stickers', async () => {
    const t = setup({
      discord: [dSticker('1', 'anim', { format: 3 }), dSticker('2', 'x'), dSticker('3', 'ok')],
      harmony: [hRow('h1', 'anim', '1'), hRow('h2', 'x', '2')],
    })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual(['create:ok'])
    const text = last(t)
    expect(text).toContain(`Skipped 1: Lottie stickers can't be copied ("anim")`)
    expect(text).toContain('Skipped 1: name too short ("x")')
  })

  it('a 422 STICKER_FILE is a skip, not a failure', async () => {
    const t = setup({ mode: 'add', discord: [dSticker('1', 'x2')] })
    t.rt.harmony.importDiscordSticker.mockRejectedValue(
      new HarmonyHttpError('bad file', 422, 'STICKER_FILE', { reason: 'duration' }),
    )
    await runBridgeSyncStickers(t.rt, t.command)
    const text = last(t)
    expect(text).toContain(`Skipped 1: can't be copied ("x2": animation over 5 s)`)
    expect(text.startsWith('✅')).toBe(true)
    expect(text).not.toContain('failure')
  })

  it('a mirror replace whose create is file-refused is a failure naming the removal', async () => {
    const t = setup({ discord: [dSticker('1', 'horn')], harmony: [hRow('h1', 'horn')] })
    t.rt.harmony.importDiscordSticker.mockRejectedValue(
      new HarmonyHttpError('bad file', 422, 'STICKER_FILE', { reason: 'duration' }),
    )
    await runBridgeSyncStickers(t.rt, t.command)
    const text = last(t)
    expect(t.rt.harmony.removeServerSticker).toHaveBeenCalledWith('s1', 'h1')
    expect(text.startsWith('⚠️')).toBe(true)
    expect(text).toContain('1 failure(s)')
    expect(text).toContain('"horn": the Harmony sticker was removed but the Discord one could not be copied (animation over 5 s)')
    expect(text).not.toContain("can't be copied (")
  })

  it('a mirror replace whose create gets a 409 is a failure naming the removal', async () => {
    const t = setup({ discord: [dSticker('1', 'horn')], harmony: [hRow('h1', 'horn')] })
    t.rt.harmony.importDiscordSticker.mockRejectedValue(new HarmonyHttpError('conflict here', 409))
    await runBridgeSyncStickers(t.rt, t.command)
    const text = last(t)
    expect(text.startsWith('⚠️')).toBe(true)
    expect(text).toContain('"horn": the Harmony sticker was removed but the Discord one could not be copied (')
    expect(text).toContain('conflict here')
  })

  it('creates what fits under the limit and lists the rest', async () => {
    const t = setup({
      mode: 'add',
      limit: 2,
      discord: [dSticker('1', 'aa'), dSticker('2', 'bb'), dSticker('3', 'cc')],
      harmony: [hRow('h0', 'existing', '9')],
    })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual(['create:aa'])
    const text = last(t)
    expect(text).toContain('2 skipped')
    expect(text).toContain('max stickers per server')
  })

  it('a limit lowered below the active count creates nothing and removes nothing', async () => {
    const t = setup({
      limit: 1,
      discord: [dSticker('1', 'aa'), dSticker('2', 'bb'), dSticker('3', 'cc')],
      harmony: [hRow('h8', 'aa', '1'), hRow('h9', 'bb', '2')],
    })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(last(t)).toContain('Skipped 1 sticker: limit reached (1 per server)')
  })

  it('a retired sticker with the same name is not a clash', async () => {
    const t = setup({ mode: 'merge', discord: [dSticker('1', 'party')], harmony: [hRow('h1', 'party', null, true)] })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual(['create:party'])
    expect(last(t)).not.toContain('Name clash')
  })

  it('limit 0 says stickers are off and does nothing', async () => {
    const t = setup({ limit: 0, dryRun: true, discord: [dSticker('1', 'aa')] })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(last(t)).toBe('❌ Server stickers are turned off on this Harmony instance (max stickers per server is 0).')
    expect(t.fetchStickers).not.toHaveBeenCalled()
    expect(t.rt.harmony.importDiscordSticker).not.toHaveBeenCalled()
  })

  it('reports a taken name and keeps going', async () => {
    const t = setup({ mode: 'add', discord: [dSticker('1', 'aa'), dSticker('2', 'bb')] })
    t.rt.harmony.importDiscordSticker.mockImplementation(async (_s: string, d: any) => {
      if (d.name === 'aa') throw new HarmonyHttpError('taken', 409, 'STICKER_NAME_TAKEN')
      t.calls.push(`create:${d.name}`)
      return { status: 'created' }
    })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual(['create:bb'])
    expect(last(t)).toContain('name already used by another Harmony sticker')
  })

  it('reports a full sticker list', async () => {
    const t = setup({ mode: 'add', discord: [dSticker('1', 'aa')] })
    t.rt.harmony.importDiscordSticker.mockRejectedValue(new HarmonyHttpError('full', 409, 'STICKER_LIMIT'))
    await runBridgeSyncStickers(t.rt, t.command)
    expect(last(t)).toContain('the Harmony sticker list is full (15 per server)')
  })

  it('on a 404 says Harmony needs updating', async () => {
    const t = setup({ harmony: new HarmonyHttpError('nope', 404) })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(last(t)).toBe('❌ Sticker sync needs a newer Harmony (bridge sticker sync endpoints).')
    expect(t.rt.harmony.importDiscordSticker).not.toHaveBeenCalled()
  })

  it('lets a 403 propagate', async () => {
    const t = setup({ harmony: new HarmonyHttpError('forbidden', 403) })
    await expect(runBridgeSyncStickers(t.rt, t.command)).rejects.toThrow('forbidden')
  })

  it('writes nothing on a dry run and lists the plan and the skips', async () => {
    const t = setup({
      dryRun: true,
      discord: [dSticker('1', 'fresh'), dSticker('2', 'anim', { format: 3 })],
      harmony: [hRow('h1', 'extra')],
    })
    await runBridgeSyncStickers(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    const text = last(t)
    expect(text).toContain('Dry run')
    expect(text).toContain('"fresh"')
    expect(text).toContain('"extra"')
    expect(text).toContain('Skipped 1: Lottie')
  })
})
