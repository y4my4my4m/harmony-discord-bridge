import { describe, expect, it, vi } from 'vitest'
import { runBridgeSyncEmojis } from '../src/runtime/commands.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'

function dEmoji(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, animated: false, available: true, ...extra }
}
function hRow(id: string, name: string, discord: string | null = null, removed = false) {
  return { id, name, url: null, discord_emoji_id: discord, removed }
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
  const rt: any = {
    mode: 'v2',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    dir: { getBridgeForDiscordGuild: () => ({ harmonyServerId: 's1' }) },
    emojiLinks: { ensure: vi.fn(async () => {}), harmonyFor: () => null, set: vi.fn(), replace: vi.fn() },
    harmony: {
      getEmojiSyncState: vi.fn(async () => {
        if (opts.harmony instanceof Error) throw opts.harmony
        return { limit: opts.limit ?? 50, emojis: opts.harmony ?? [] }
      }),
      getServerEmojis: vi.fn(async () => []),
      removeServerEmoji: vi.fn(async (_s: string, id: string) => { calls.push(`remove:${id}`) }),
      importDiscordEmoji: vi.fn(async (_s: string, e: any, update?: boolean) => {
        calls.push(`${update ? 'update' : 'create'}:${e.name}`)
        return { status: update ? 'updated' : 'created' }
      }),
    },
  }
  return { command, rt, calls, replies, message }
}

const last = (t: ReturnType<typeof setup>) => t.replies.at(-1)!.content as string

describe('runBridgeSyncEmojis', () => {
  it('mirror removes, creates, renames and restores after Confirm', async () => {
    const t = setup({
      discord: [dEmoji('1', 'fresh'), dEmoji('2', 'newname'), dEmoji('3', 'back')],
      harmony: [hRow('h2', 'oldname', '2'), hRow('h3', 'back', '3', true), hRow('h4', 'extra')],
    })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.replies[0].content).toContain('This removes 1 Harmony emoji.')
    expect(t.calls).toEqual(['remove:h4', 'create:fresh', 'update:newname', 'update:back'])
    expect(t.rt.emojiLinks.replace).toHaveBeenCalledTimes(1)
    const text = last(t)
    expect(text).toContain('Emoji sync (mirror)')
    expect(text).toContain('• Added: 1')
    expect(text).toContain('• Renamed: 1')
    expect(text).toContain('• Restored: 1')
    expect(text).toContain('• Removed: 1')
  })

  it('mirror cancel makes no calls', async () => {
    const t = setup({ discord: [], harmony: [hRow('h1', 'extra')], confirm: 'cancel' })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.rt.emojiLinks.replace).not.toHaveBeenCalled()
  })

  it('mirror replace removes the holder, then creates', async () => {
    const t = setup({ discord: [dEmoji('1', 'horn')], harmony: [hRow('h1', 'horn')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual(['remove:h1', 'create:horn'])
    expect(last(t)).toContain('• Replaced (same name on Harmony): 1')
    expect(last(t)).toContain('• Removed: 0')
  })

  it('a failed holder removal blocks the create', async () => {
    const t = setup({ discord: [dEmoji('1', 'horn')], harmony: [hRow('h1', 'horn')] })
    t.rt.harmony.removeServerEmoji.mockRejectedValue(new HarmonyHttpError('server error', 500))
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.rt.harmony.importDiscordEmoji).not.toHaveBeenCalled()
    expect(last(t)).toContain('1 failure(s)')
  })

  it('merge lists a same-name unlinked emoji as a clash and changes nothing', async () => {
    const t = setup({ mode: 'merge', discord: [dEmoji('1', 'horn')], harmony: [hRow('h1', 'horn')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(last(t)).toContain('Name clash: 1 emoji')
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

  it('merge restores a removed linked emoji with update', async () => {
    const t = setup({ mode: 'merge', discord: [dEmoji('1', 'back')], harmony: [hRow('h1', 'back', '1', true)] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual(['update:back'])
    expect(t.rt.harmony.importDiscordEmoji.mock.calls[0][2]).toBe(true)
  })

  it('add only creates; a removed linked emoji counts as not updated', async () => {
    const t = setup({
      mode: 'add',
      discord: [dEmoji('1', 'fresh'), dEmoji('2', 'back')],
      harmony: [hRow('h2', 'back', '2', true)],
    })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual(['create:fresh'])
    expect(last(t)).toContain('Not updated (add mode): 1')
  })

  it('leaves an unavailable linked emoji alone', async () => {
    const t = setup({ discord: [dEmoji('1', 'x', { available: false })], harmony: [hRow('h1', 'other', '1')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(last(t)).toBe('✅ Emoji already match.')
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

  it('sync-emojis on a 404 says Harmony needs updating', async () => {
    const t = setup({ harmony: new HarmonyHttpError('nope', 404) })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(last(t)).toContain('needs a newer Harmony')
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

  it('lets a 403 propagate', async () => {
    const t = setup({ harmony: new HarmonyHttpError('forbidden', 403) })
    await expect(runBridgeSyncEmojis(t.rt, t.command)).rejects.toThrow('forbidden')
    expect(t.rt.harmony.importDiscordEmoji).not.toHaveBeenCalled()
  })

  it('writes nothing on a dry run', async () => {
    const t = setup({ dryRun: true, discord: [dEmoji('1', 'fresh')], harmony: [hRow('h1', 'extra')] })
    await runBridgeSyncEmojis(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    const text = last(t)
    expect(text).toContain('Dry run')
    expect(text).toContain(':fresh:')
    expect(text).toContain(':extra:')
  })
})
