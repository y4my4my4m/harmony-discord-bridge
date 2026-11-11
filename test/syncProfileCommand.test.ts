import { describe, expect, it, vi } from 'vitest'
import { buildCommands, runBridgeSyncProfile } from '../src/runtime/commands.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'

const hState = (extra: Record<string, unknown> = {}) => ({
  name: 'Old',
  description: null,
  icon: null,
  banner: null,
  icon_discord_hash: null,
  icon_path: null,
  banner_discord_hash: null,
  banner_path: null,
  ...extra,
})

function setup(opts: {
  guild?: Record<string, unknown>
  harmony?: Record<string, unknown> | Error
  toggles?: Record<string, boolean>
  dryRun?: boolean
  confirm?: 'confirm' | 'cancel'
  patch?: Error
  fetchError?: Error
} = {}) {
  const replies: Array<Record<string, any>> = []
  const message = {
    awaitMessageComponent: vi.fn(async () => ({
      customId: `${opts.confirm ?? 'confirm'}:i1`,
      user: { id: 'u1' },
      update: vi.fn(async () => {}),
    })),
  }
  const guildData = { id: 'g1', name: 'New', description: null, icon: null, banner: null, features: [] as string[], ...opts.guild }
  const command: any = {
    id: 'i1',
    user: { id: 'u1' },
    options: {
      getBoolean: (n: string) => (n === 'dry_run' ? (opts.dryRun ?? false) : (opts.toggles?.[n] ?? null)),
    },
    guild: { ...guildData, fetch: vi.fn(async () => { if (opts.fetchError) throw opts.fetchError; return guildData }) },
    deferred: false,
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (r: any) => { replies.push(r); return message }),
  }
  const rt: any = {
    mode: 'v2',
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    dir: { getBridgeForDiscordGuild: () => ({ harmonyServerId: 's1' }) },
    harmony: {
      getServerProfileSyncState: vi.fn(async () => {
        if (opts.harmony instanceof Error) throw opts.harmony
        return hState(opts.harmony)
      }),
      syncServerProfile: vi.fn(async () => {
        if (opts.patch) throw opts.patch
        return { changed: true, name: 'New', description: null, icon: null, banner: null }
      }),
    },
  }
  return { command, rt, replies, message }
}

const last = (t: ReturnType<typeof setup>) => t.replies.at(-1)!.content as string

describe('runBridgeSyncProfile', () => {
  it('renames after Confirm and reports Updated: name', async () => {
    const t = setup()
    await runBridgeSyncProfile(t.rt, t.command)
    expect(t.rt.harmony.syncServerProfile).toHaveBeenCalledWith('s1', { name: 'New', invoker_discord_id: 'u1' })
    expect(last(t)).toContain('✅ Profile synced for **New**')
    expect(last(t)).toContain('• Updated: name')
    expect(t.message.awaitMessageComponent).toHaveBeenCalled()
  })

  it('Cancel sends nothing', async () => {
    const t = setup({ confirm: 'cancel' })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(t.rt.harmony.syncServerProfile).not.toHaveBeenCalled()
  })

  it('dry run lists changes and sends nothing', async () => {
    const t = setup({ dryRun: true })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(last(t)).toContain('🧪 **Dry run** for **New**')
    expect(last(t)).toContain('"Old" → "New"')
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.rt.harmony.syncServerProfile).not.toHaveBeenCalled()
  })

  it('already matching replies without a prompt', async () => {
    const t = setup({ harmony: { name: 'New' } })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(last(t)).toContain('✅ **New**: Harmony already matches Discord.')
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.rt.harmony.syncServerProfile).not.toHaveBeenCalled()
  })

  it('all fields off replies nothing to sync', async () => {
    const t = setup({ toggles: { name: false, icon: false, banner: false, description: false } })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(last(t)).toBe('Nothing to sync: every field is switched off.')
    expect(t.rt.harmony.getServerProfileSyncState).not.toHaveBeenCalled()
  })

  it('only unavailable fields selected sends nothing', async () => {
    const t = setup({ toggles: { name: false, icon: false } })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(last(t)).toContain('Nothing to sync for **New**.')
    expect(last(t)).toContain('Description skipped')
    expect(last(t)).toContain('Banner skipped')
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
    expect(t.rt.harmony.syncServerProfile).not.toHaveBeenCalled()
  })

  it('clearing the icon shows the warning in the prompt', async () => {
    const t = setup({ harmony: { name: 'New', icon: 'https://h/icon.png' }, toggles: { name: false } })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(t.replies[0].content).toContain("⚠️ Harmony's icon will be removed (Discord has none)")
    expect(t.rt.harmony.syncServerProfile).toHaveBeenCalledWith('s1', { icon_hash: null, invoker_discord_id: 'u1' })
    expect(last(t)).toContain('• Removed: icon')
  })

  it('guild.fetch failure replies Could not read the Discord server', async () => {
    const t = setup({ fetchError: new Error('boom') })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(last(t)).toContain('❌ Could not read the Discord server:')
    expect(last(t)).toContain('boom')
    expect(t.rt.harmony.syncServerProfile).not.toHaveBeenCalled()
  })

  it('changed false after Confirm replies already matched; nothing written', async () => {
    const t = setup()
    t.rt.harmony.syncServerProfile.mockResolvedValue({ changed: false, name: 'New', description: null, icon: null, banner: null })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(last(t)).toBe('✅ **New**: Harmony already matched Discord; nothing written.')
  })

  it('not bridged replies notBridgedText', async () => {
    const t = setup()
    t.rt.dir.getBridgeForDiscordGuild = () => null
    await runBridgeSyncProfile(t.rt, t.command)
    expect(last(t)).toMatch(/bridge/i)
    expect(t.rt.harmony.getServerProfileSyncState).not.toHaveBeenCalled()
    expect(t.message.awaitMessageComponent).not.toHaveBeenCalled()
  })

  it('404 on state says Harmony is too old', async () => {
    const t = setup({ harmony: new HarmonyHttpError('nf', 404) })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(last(t)).toBe('❌ Profile sync needs a newer Harmony (bridge profile sync endpoints).')
  })

  it('PROFILE_IMAGE size error names the 10 MB banner limit', async () => {
    const t = setup({
      guild: { banner: 'bh', features: ['BANNER'] },
      toggles: { name: false },
      patch: new HarmonyHttpError('x', 422, 'PROFILE_IMAGE', { code: 'PROFILE_IMAGE', field: 'banner', reason: 'size' }),
    })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(last(t)).toBe("❌ Could not copy the banner: it is over Harmony's 10 MB limit; nothing changed.")
  })

  it('PROFILE_IMAGE_DOWNLOAD error names the field', async () => {
    const t = setup({
      guild: { icon: 'ih' },
      toggles: { name: false },
      patch: new HarmonyHttpError('x', 502, 'PROFILE_IMAGE_DOWNLOAD', { field: 'icon', error: 'HTTP 404' }),
    })
    await runBridgeSyncProfile(t.rt, t.command)
    expect(last(t)).toBe('❌ Could not copy the icon from Discord: HTTP 404; nothing changed.')
  })
})

describe('buildCommands sync-profile', () => {
  const sub = (mode: 'v1' | 'v2'): any =>
    (buildCommands(mode).find(c => c.name === 'bridge')!.options ?? []).find(o => o.name === 'sync-profile')

  it('v1 has no sync-profile; v2 has it with five boolean options', () => {
    expect(sub('v1')).toBeUndefined()
    const s = sub('v2')
    expect(s.options.map((o: any) => o.name)).toEqual(['name', 'icon', 'banner', 'description', 'dry_run'])
    expect(s.options.every((o: any) => o.type === 5)).toBe(true)
  })
})
