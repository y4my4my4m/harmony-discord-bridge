import { describe, expect, it, vi } from 'vitest'
import { runBridgeSyncSounds } from '../src/runtime/commands.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'

function discordSound(soundId: string, name: string, extra: Record<string, unknown> = {}) {
  return { soundId, name, volume: 1, available: true, emoji: null, ...extra }
}
/** `discord` set: copied from that Discord sound. Null: a member's upload. */
function harmonyRow(id: string, name: string, discord: string | null = null, extra: Record<string, unknown> = {}) {
  return { id, name, emoji: null, emoji_id: null, volume: 1, discord_sound_id: discord, ...extra }
}

function setup(opts: {
  mode?: string | null
  dryRun?: boolean
  discord?: unknown[]
  fetchError?: Error
  harmony?: unknown[] | Error
  /** Harmony rows answered to the read after Confirm; default: the same rows. */
  harmonyAfterConfirm?: unknown[]
  emojis?: unknown[] | Error
  confirm?: 'confirm' | 'cancel' | 'timeout'
}) {
  const calls: string[] = []
  const replies: Array<Record<string, any>> = []
  const message = {
    awaitMessageComponent: vi.fn(async () => {
      if (opts.confirm === 'timeout') throw new Error('time')
      return { customId: `${opts.confirm ?? 'confirm'}:i1`, user: { id: 'u1' }, update: vi.fn(async () => {}) }
    }),
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
      soundboardSounds: {
        fetch: vi.fn(async () => {
          if (opts.fetchError) throw opts.fetchError
          return new Map((opts.discord ?? []).map((s: any) => [s.soundId, s]))
        }),
      },
    },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (r: any) => { replies.push(r); return message }),
  }
  const links = new Map<string, { id: string }>()
  let reads = 0
  const rt: any = {
    mode: 'v2',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    dir: { getBridgeForDiscordGuild: () => ({ harmonyServerId: 's1' }) },
    emojiLinks: {
      replace: vi.fn((_s: string, rows: any[]) => {
        links.clear()
        for (const r of rows) if (r.discord_emoji_id) links.set(r.discord_emoji_id, r)
      }),
      harmonyFor: (_s: string, id: string) => links.get(id) ?? null,
    },
    harmony: {
      getServerSounds: vi.fn(async () => {
        if (opts.harmony instanceof Error) throw opts.harmony
        reads++
        return reads > 1 && opts.harmonyAfterConfirm ? opts.harmonyAfterConfirm : opts.harmony ?? []
      }),
      getServerEmojis: vi.fn(async () => {
        if (opts.emojis instanceof Error) throw opts.emojis
        return opts.emojis ?? []
      }),
      deleteServerSound: vi.fn(async (_s: string, id: string) => { calls.push(`delete:${id}`) }),
      importDiscordSound: vi.fn(async (_s: string, sound: any, update: boolean): Promise<any> => {
        calls.push(`${update ? 'update' : 'create'}:${sound.name}`)
        return undefined
      }),
    },
  }
  const last = () => replies.at(-1)!.content as string
  return { command, rt, calls, replies, message, last }
}

describe('runBridgeSyncSounds', () => {
  it('writes nothing on a dry run', async () => {
    const t = setup({ dryRun: true, discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'extra')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.last()).toContain('Would add')
  })

  it('runs merge without a mode: adds, deletes nothing, asks nothing', async () => {
    const t = setup({ discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'old', 'gone')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.calls).toEqual(['create:horn'])
    expect(t.last()).toContain('Soundboard sync (merge)')
  })

  it('mirror keeps a sound a member uploaded and says so', async () => {
    const t = setup({ mode: 'mirror', discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'extra')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.rt.harmony.deleteServerSound).not.toHaveBeenCalled()
    expect(t.calls).toEqual(['create:horn'])
    expect(t.last()).toContain('Kept (not copied from Discord): 1')
  })

  it('mirror reports a member upload holding a Discord name as a clash and replaces nothing', async () => {
    const t = setup({ mode: 'mirror', discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'horn')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.last()).toContain('Name clash: 1 sound')
    expect(t.last()).not.toContain('mirror` to replace')
  })

  it('mirror asks before deleting a sound copied from a deleted Discord sound, and writes nothing on cancel', async () => {
    const t = setup({ mode: 'mirror', discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'old', 'gone')], confirm: 'cancel' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.message.awaitMessageComponent).toHaveBeenCalled()
    expect(t.replies[0].content.split('\n')[0]).toBe('⚠️ This deletes 1 Harmony sound(s) copied from Discord. Confirm?')
    expect(t.calls).toEqual([])
  })

  it('writes nothing when the confirmation times out', async () => {
    const t = setup({ mode: 'mirror', discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'old', 'gone')], confirm: 'timeout' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
  })

  it('deletes before creating after confirm', async () => {
    const t = setup({ mode: 'mirror', discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'old', 'gone')], confirm: 'confirm' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual(['delete:h1', 'create:horn'])
    expect(t.replies.at(-1)!.components).toEqual([])
  })

  it('warns that the Discord soundboard is empty before deleting every copied sound', async () => {
    const t = setup({ mode: 'mirror', discord: [], harmony: [harmonyRow('h1', 'a', 'x1'), harmonyRow('h2', 'b', 'x2'), harmonyRow('h3', 'mine')], confirm: 'cancel' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.replies[0].content.split('\n')[0]).toBe('⚠️ The Discord soundboard is empty. This deletes all 2 Harmony sound(s) copied from Discord. Confirm?')
    expect(t.calls).toEqual([])
  })

  it('puts the warning and every deletion first, so a long prompt cannot lose them', async () => {
    const stale = Array.from({ length: 30 }, (_, i) => harmonyRow(`h${i}`, `stale-sound-with-a-long-name-${i}`, `x${i}`))
    const fresh = Array.from({ length: 40 }, (_, i) => discordSound(`d${i}`, `new-sound-with-a-long-name-${i}`))
    const t = setup({ mode: 'mirror', discord: fresh, harmony: stale, confirm: 'cancel' })
    await runBridgeSyncSounds(t.rt, t.command)
    const prompt = t.replies[0].content as string
    expect(prompt.length).toBeLessThanOrEqual(2000)
    expect(prompt.split('\n')[0]).toContain('This deletes 30 Harmony sound(s)')
    for (let i = 0; i < 30; i++) expect(prompt).toContain(`stale-sound-with-a-long-name-${i}\n`)
  })

  it('applies nothing when the sounds to delete changed during the confirmation', async () => {
    const t = setup({
      mode: 'mirror',
      discord: [discordSound('d1', 'horn')],
      harmony: [harmonyRow('h1', 'old', 'gone')],
      harmonyAfterConfirm: [harmonyRow('h1', 'old', 'gone'), harmonyRow('h2', 'other', 'gone2')],
      confirm: 'confirm',
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.last()).toContain('changed while this waited')
  })

  it('counts a sound the gateway keeps as a member upload as kept, not as a failure', async () => {
    const t = setup({ mode: 'mirror', discord: [], harmony: [harmonyRow('h1', 'old', 'gone')], confirm: 'confirm' })
    t.rt.harmony.deleteServerSound.mockRejectedValue(new HarmonyHttpError('SOUND_NOT_LINKED: a member uploaded it', 403, 'SOUND_NOT_LINKED'))
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.last()).toContain('✅ Soundboard sync (mirror)')
    expect(t.last()).toContain('Kept (not copied from Discord): 1')
    expect(t.last()).toContain('Deleted: 0')
    expect(t.last()).not.toContain('failure')
  })

  it('treats a 404 on delete as already deleted', async () => {
    const t = setup({ mode: 'mirror', discord: [], harmony: [harmonyRow('h1', 'old', 'gone')], confirm: 'confirm' })
    t.rt.harmony.deleteServerSound.mockRejectedValue(new HarmonyHttpError('gone', 404))
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.last()).not.toContain('failure')
    expect(t.last()).toContain('Deleted: 1')
  })

  it('reports any other delete error as a failure', async () => {
    const t = setup({ mode: 'mirror', discord: [], harmony: [harmonyRow('h1', 'old', 'gone')], confirm: 'confirm' })
    t.rt.harmony.deleteServerSound.mockRejectedValue(new HarmonyHttpError('Bot is not the Discord bridge of this server', 403))
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.last()).toContain('⚠️ Soundboard sync finished with 1 failure(s)')
    expect(t.last()).toContain('old: Bot is not the Discord bridge of this server')
    expect(t.last()).not.toContain('(null)')
  })

  it('explains an old Harmony on 404', async () => {
    const t = setup({ harmony: new HarmonyHttpError('nope', 404) })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.last()).toContain('needs Harmony 1.9.7 or later')
    expect(t.calls).toEqual([])
  })

  it('writes nothing when the Discord fetch fails', async () => {
    const t = setup({ fetchError: new Error('boom'), harmony: [harmonyRow('h1', 'extra')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.last()).toContain('boom')
  })

  it('writes nothing when Harmony emoji cannot be read', async () => {
    const t = setup({
      discord: [discordSound('d1', 'horn', { emoji: { id: 'e1', name: 'party' } })],
      harmony: [harmonyRow('h1', 'horn', 'd1', { emoji_id: 'he1' })],
      emojis: new Error('emoji read failed'),
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.last()).toContain('emoji read failed')
    expect(t.last()).toContain('Nothing changed')
  })

  it('leaves the emoji of a linked sound alone when its Discord emoji is not on Harmony', async () => {
    const t = setup({
      discord: [discordSound('d1', 'horn', { emoji: { id: 'e1', name: 'party' } })],
      harmony: [harmonyRow('h1', 'horn', 'd1', { emoji_id: 'he1' })],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.last()).toContain('already matches')
  })

  it('keeps the Harmony emoji when it renames a sound whose Discord emoji is not on Harmony', async () => {
    const t = setup({
      discord: [discordSound('d1', 'airhorn', { emoji: { id: 'e1', name: 'party' } })],
      harmony: [harmonyRow('h1', 'horn', 'd1', { emoji_id: 'he1' })],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.rt.harmony.importDiscordSound).toHaveBeenCalledWith('s1', expect.objectContaining({ name: 'airhorn', emoji: null, emojiId: 'he1' }), true)
  })

  it('maps a custom emoji that is on Harmony', async () => {
    const t = setup({
      discord: [discordSound('d1', 'horn', { emoji: { id: 'e1', name: 'party' } })],
      harmony: [],
      emojis: [{ id: 'he1', name: 'party', url: null, discord_emoji_id: 'e1' }],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.rt.harmony.importDiscordSound).toHaveBeenCalledWith('s1', expect.objectContaining({ emojiId: 'he1' }), false)
    expect(t.last()).not.toContain('/bridge import-emojis')
  })

  it('leaves unavailable sounds alone', async () => {
    const t = setup({
      mode: 'mirror',
      discord: [discordSound('d1', 'horn', { available: false })],
      harmony: [harmonyRow('h1', 'horn', 'd1')],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.last()).toContain('already matches')
  })

  it('merge reports a same-name Harmony sound and changes nothing', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'horn')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.rt.harmony.deleteServerSound).not.toHaveBeenCalled()
    expect(t.last()).toContain('Name clash: 1 sound')
    expect(t.last()).not.toContain('Confirm')
  })

  it('merge reports a sound linked to a deleted Discord sound that holds the new name', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d2', 'horn')], harmony: [harmonyRow('h1', 'horn', 'd1')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.last()).toContain('Name clash: 1 sound')
  })

  it('mirror replace copies the Discord sound first, then deletes the old copy', async () => {
    const t = setup({ mode: 'mirror', discord: [discordSound('d2', 'horn')], harmony: [harmonyRow('h1', 'horn', 'd1')], confirm: 'confirm' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual(['create:horn', 'delete:h1'])
    expect(t.rt.harmony.importDiscordSound).toHaveBeenCalledWith('s1', expect.objectContaining({ name: 'horn' }), false)
    expect(t.last()).toContain('Added: 0')
    expect(t.last()).toContain('Replaced (same name, copied from a deleted Discord one): 1')
    expect(t.last()).toContain('Deleted: 0')
  })

  it('mirror replace keeps the old copy when the new one cannot be made', async () => {
    const t = setup({ mode: 'mirror', discord: [discordSound('d2', 'horn')], harmony: [harmonyRow('h1', 'horn', 'd1')], confirm: 'confirm' })
    t.rt.harmony.importDiscordSound.mockRejectedValue(new HarmonyHttpError('clip download failed', 502))
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.rt.harmony.deleteServerSound).not.toHaveBeenCalled()
    expect(t.last()).toContain('horn: clip download failed')
  })

  it('mirror replace deletes first when the soundboard is at its cap', async () => {
    const filler = Array.from({ length: 47 }, (_, i) => harmonyRow(`f${i}`, `f${i}`, `fd${i}`))
    const t = setup({
      mode: 'mirror',
      discord: [discordSound('d2', 'horn'), ...filler.map(f => discordSound(f.discord_sound_id!, f.name))],
      harmony: [harmonyRow('h1', 'horn', 'd1'), ...filler],
      confirm: 'confirm',
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual(['delete:h1', 'create:horn'])
  })

  it('at the cap, does not copy the Discord sound when deleting the old copy fails', async () => {
    const filler = Array.from({ length: 47 }, (_, i) => harmonyRow(`f${i}`, `f${i}`, `fd${i}`))
    const t = setup({
      mode: 'mirror',
      discord: [discordSound('d2', 'horn'), ...filler.map(f => discordSound(f.discord_sound_id!, f.name))],
      harmony: [harmonyRow('h1', 'horn', 'd1'), ...filler],
      confirm: 'confirm',
    })
    t.rt.harmony.deleteServerSound.mockRejectedValue(new HarmonyHttpError('server error', 500))
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.rt.harmony.importDiscordSound).not.toHaveBeenCalled()
    expect(t.last()).toContain('horn: deleting the old Harmony sound failed')
    expect(t.last()).toContain('⚠️ Soundboard sync finished with 1 failure(s)')
  })

  it('add mode reports clashes and outdated sounds instead of saying the soundboard matches', async () => {
    const t = setup({
      mode: 'add',
      discord: [discordSound('d1', 'renamed'), discordSound('d2', 'horn')],
      harmony: [harmonyRow('h1', 'old', 'd1'), harmonyRow('h2', 'horn')],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.last()).toContain('⚠️ Nothing to apply (add)')
    expect(t.last()).toContain('Name clash: 1 sound')
    expect(t.last()).toContain('  • horn')
    expect(t.last()).toContain('Not updated (add mode): 1; use merge or mirror to update')
    expect(t.last()).not.toContain('already matches')
  })

  it('add mode summary lists clashes and counts outdated sounds next to what it added', async () => {
    const t = setup({
      mode: 'add',
      discord: [discordSound('d1', 'renamed'), discordSound('d2', 'horn'), discordSound('d3', 'new')],
      harmony: [harmonyRow('h1', 'old', 'd1'), harmonyRow('h2', 'horn')],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual(['create:new'])
    expect(t.last()).toContain('Added: 1')
    expect(t.last()).toContain('⚠️ 1 name clash(es), left as they are:\n  • horn')
    expect(t.last()).toContain("To use Discord's: delete or rename the Harmony one")
    expect(t.last()).toContain('Not updated (add mode): 1; use merge or mirror to update')
  })

  it('updates a linked sound renamed on Discord and counts it', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'newname')], harmony: [harmonyRow('h1', 'oldname', 'd1')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.rt.harmony.importDiscordSound).toHaveBeenCalledTimes(1)
    expect(t.rt.harmony.importDiscordSound).toHaveBeenCalledWith('s1', expect.objectContaining({ name: 'newname' }), true)
    expect(t.last()).toContain('Updated: 1')
  })

  it('counts a sound Harmony already holds as already there, not as added', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'horn')], harmony: [] })
    t.rt.harmony.importDiscordSound.mockResolvedValue({ status: 'existing' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.last()).toContain('Added: 0')
    expect(t.last()).toContain('Already there: 1')
  })

  it('stops sending sounds once the soundboard is full and lists the rest as skipped', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'one'), discordSound('d2', 'two'), discordSound('d3', 'three')], harmony: [] })
    t.rt.harmony.importDiscordSound.mockRejectedValue(new HarmonyHttpError('limit', 409, 'SOUND_LIMIT'))
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.rt.harmony.importDiscordSound).toHaveBeenCalledTimes(1)
    expect(t.last()).toContain('⚠️ 3 skipped: the Harmony soundboard is full (48 sounds per server)')
    expect(t.last()).toContain('  • three')
    expect(t.last()).not.toContain('SOUND_LIMIT')
  })

  it('logs who ran the sync, where, and what it did', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'horn')], harmony: [] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.rt.log.info).toHaveBeenCalledWith(expect.stringMatching(/sync-sounds \(merge\) by u1 in guild g1: added 1, /))
  })

  it('refuses a second run while one is in flight for the server', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'horn')], harmony: [] })
    let release!: () => void
    t.rt.harmony.importDiscordSound.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const running = runBridgeSyncSounds(t.rt, t.command)
    await vi.waitFor(() => expect(t.rt.harmony.importDiscordSound).toHaveBeenCalled())

    const second = setup({ mode: 'merge', discord: [discordSound('d1', 'horn')], harmony: [] })
    await runBridgeSyncSounds(second.rt, second.command)
    expect(second.last()).toContain('already running')
    expect(second.rt.harmony.getServerSounds).not.toHaveBeenCalled()

    release()
    await running
    const third = setup({ mode: 'merge', discord: [], harmony: [] })
    await runBridgeSyncSounds(third.rt, third.command)
    expect(third.last()).toContain('already matches')
  })

  it('hints at /bridge import-emojis when an applied sound had an unimported custom emoji', async () => {
    const t = setup({
      mode: 'merge',
      discord: [discordSound('d1', 'horn', { emoji: { id: 'e1', name: 'party' } })],
      harmony: [],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.last()).toContain('/bridge import-emojis')
  })
})
