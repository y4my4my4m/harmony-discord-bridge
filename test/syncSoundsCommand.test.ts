import { describe, expect, it, vi } from 'vitest'
import { runBridgeSyncSounds } from '../src/runtime/commands.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'

function discordSound(soundId: string, name: string, extra: Record<string, unknown> = {}) {
  return { soundId, name, volume: 1, available: true, emoji: null, ...extra }
}
function harmonyRow(id: string, name: string, discord: string | null = null) {
  return { id, name, emoji: null, emoji_id: null, volume: 1, discord_sound_id: discord }
}

function setup(opts: {
  mode?: string | null
  dryRun?: boolean
  discord?: unknown[]
  fetchError?: Error
  harmony?: unknown[] | Error
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
  const rt: any = {
    mode: 'v2',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    dir: { getBridgeForDiscordGuild: () => ({ harmonyServerId: 's1' }) },
    emojiLinks: { ensure: vi.fn(async () => {}), harmonyFor: () => null },
    harmony: {
      getServerSounds: vi.fn(async () => {
        if (opts.harmony instanceof Error) throw opts.harmony
        return opts.harmony ?? []
      }),
      deleteServerSound: vi.fn(async (_s: string, id: string) => { calls.push(`delete:${id}`) }),
      importDiscordSound: vi.fn(async (_s: string, sound: any, update: boolean) => {
        calls.push(`${update ? 'update' : 'create'}:${sound.name}`)
      }),
    },
  }
  return { command, rt, calls, replies, message }
}

describe('runBridgeSyncSounds', () => {
  it('writes nothing on a dry run', async () => {
    const t = setup({ dryRun: true, discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'extra')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.replies.at(-1)!.content).toContain('Would add')
  })

  it('asks for confirmation in mirror mode and writes nothing on cancel', async () => {
    const t = setup({ discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'extra')], confirm: 'cancel' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.message.awaitMessageComponent).toHaveBeenCalled()
    expect(t.replies[0].content).toContain('This deletes 1 Harmony sound(s). Confirm?')
    expect(t.calls).toEqual([])
  })

  it('writes nothing when the confirmation times out', async () => {
    const t = setup({ discord: [], harmony: [harmonyRow('h1', 'extra')], confirm: 'timeout' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
  })

  it('deletes before creating after confirm', async () => {
    const t = setup({ discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'extra')], confirm: 'confirm' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual(['delete:h1', 'create:horn'])
    expect(t.replies.at(-1)!.components).toEqual([])
  })

  it('does not ask in merge mode with nothing to delete', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'extra')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.calls).toEqual(['create:horn'])
  })

  it('treats a 404 on delete as already deleted', async () => {
    const t = setup({ discord: [], harmony: [harmonyRow('h1', 'extra')], confirm: 'confirm' })
    t.rt.harmony.deleteServerSound.mockRejectedValue(new HarmonyHttpError('gone', 404))
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.replies.at(-1)!.content).not.toContain('failure')
  })

  it('explains an old Harmony on 404', async () => {
    const t = setup({ harmony: new HarmonyHttpError('nope', 404) })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.replies.at(-1)!.content).toContain('needs a newer Harmony')
    expect(t.calls).toEqual([])
  })

  it('writes nothing when the Discord fetch fails', async () => {
    const t = setup({ fetchError: new Error('boom'), harmony: [harmonyRow('h1', 'extra')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.replies.at(-1)!.content).toContain('boom')
  })

  it('leaves unavailable sounds alone', async () => {
    const t = setup({
      discord: [discordSound('d1', 'horn', { available: false })],
      harmony: [harmonyRow('h1', 'horn', 'd1')],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.replies.at(-1)!.content).toContain('already matches')
  })

  it('merge reports a same-name Harmony sound and changes nothing', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'horn')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.rt.harmony.deleteServerSound).not.toHaveBeenCalled()
    const content = t.replies.at(-1)!.content
    expect(content).toContain('Name clash: 1 sound')
    expect(content).not.toContain('Confirm')
  })

  it('merge reports a sound linked to a deleted Discord sound that holds the new name', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d2', 'horn')], harmony: [harmonyRow('h1', 'horn', 'd1')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    expect(t.replies.at(-1)!.content).toContain('Name clash: 1 sound')
  })

  it('mirror replace deletes the Harmony row then creates without update', async () => {
    const t = setup({ discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'horn')], confirm: 'confirm' })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual(['delete:h1', 'create:horn'])
    expect(t.rt.harmony.importDiscordSound).toHaveBeenCalledWith('s1', expect.objectContaining({ name: 'horn' }), false)
    const content = t.replies.at(-1)!.content
    expect(content).toContain('Added: 0')
    expect(content).toContain('Replaced (same name on Harmony): 1')
    expect(content).toContain('Deleted: 0')
  })

  it('add mode reports clashes and outdated sounds instead of saying the soundboard matches', async () => {
    const t = setup({
      mode: 'add',
      discord: [discordSound('d1', 'renamed'), discordSound('d2', 'horn')],
      harmony: [harmonyRow('h1', 'old', 'd1'), harmonyRow('h2', 'horn')],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual([])
    const content = t.replies.at(-1)!.content
    expect(content).toContain('⚠️ Nothing to apply (add)')
    expect(content).toContain('Name clash: 1 sound')
    expect(content).toContain('  • horn')
    expect(content).toContain('Not updated (add mode): 1; use merge or mirror to update')
    expect(content).not.toContain('already matches')
  })

  it('add mode summary lists clashes and counts outdated sounds next to what it added', async () => {
    const t = setup({
      mode: 'add',
      discord: [discordSound('d1', 'renamed'), discordSound('d2', 'horn'), discordSound('d3', 'new')],
      harmony: [harmonyRow('h1', 'old', 'd1'), harmonyRow('h2', 'horn')],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual(['create:new'])
    const content = t.replies.at(-1)!.content
    expect(content).toContain('Added: 1')
    expect(content).toContain('⚠️ 1 name clash(es), left as they are:\n  • horn')
    expect(content).toContain('run `mode:mirror` to replace it')
    expect(content).toContain('Not updated (add mode): 1; use merge or mirror to update')
  })

  it('updates a linked sound renamed on Discord and counts it', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'newname')], harmony: [harmonyRow('h1', 'oldname', 'd1')] })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.rt.harmony.importDiscordSound).toHaveBeenCalledTimes(1)
    expect(t.rt.harmony.importDiscordSound).toHaveBeenCalledWith('s1', expect.objectContaining({ name: 'newname' }), true)
    expect(t.replies.at(-1)!.content).toContain('Updated: 1')
  })

  it('reports a full soundboard and a warning header when a create fails', async () => {
    const t = setup({ mode: 'merge', discord: [discordSound('d1', 'horn')], harmony: [] })
    t.rt.harmony.importDiscordSound.mockRejectedValue(new HarmonyHttpError('limit', 409, 'SOUND_LIMIT'))
    await runBridgeSyncSounds(t.rt, t.command)
    const content = t.replies.at(-1)!.content
    expect(content).toContain('horn: the Harmony soundboard is full (48 sounds per server)')
    expect(content).not.toContain('SOUND_LIMIT')
    expect(content).toContain('⚠️ Soundboard sync finished with 1 failure(s)')
    expect(content).not.toContain('✅')
  })

  it('does not create the Discord sound when deleting the replaced Harmony sound fails', async () => {
    const t = setup({ discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'horn')], confirm: 'confirm' })
    t.rt.harmony.deleteServerSound.mockRejectedValue(new HarmonyHttpError('server error', 500))
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.rt.harmony.importDiscordSound).not.toHaveBeenCalled()
    const content = t.replies.at(-1)!.content
    expect(content).toContain('horn: not replaced, deleting the Harmony sound failed')
    expect(content).toContain('1 failure(s)')
    expect(content).toContain('⚠️ Soundboard sync finished with 1 failure(s)')
  })

  it('creates after a 404 delete of a replaced sound', async () => {
    const t = setup({ discord: [discordSound('d1', 'horn')], harmony: [harmonyRow('h1', 'horn')], confirm: 'confirm' })
    t.rt.harmony.deleteServerSound.mockRejectedValue(new HarmonyHttpError('gone', 404))
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.calls).toEqual(['create:horn'])
  })

  it('hints at /bridge import-emojis when an applied sound had an unimported custom emoji', async () => {
    const t = setup({
      mode: 'merge',
      discord: [discordSound('d1', 'horn', { emoji: { id: 'e1', name: 'party' } })],
      harmony: [],
    })
    await runBridgeSyncSounds(t.rt, t.command)
    expect(t.replies.at(-1)!.content).toContain('/bridge import-emojis')
  })
})
