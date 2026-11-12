import { describe, expect, it } from 'vitest'
import { buildCommands } from '../src/runtime/commands.js'

const bridgeSubcommands = (mode: 'v1' | 'v2') =>
  (buildCommands(mode).find(c => c.name === 'bridge')!.options ?? []).map(o => o.name)

describe('buildCommands', () => {
  it('offers /bridge import-emojis only to v2 bridges, which Harmony knows by discord_bridges row', () => {
    expect(bridgeSubcommands('v2')).toContain('import-emojis')
    expect(bridgeSubcommands('v1')).not.toContain('import-emojis')
    expect(bridgeSubcommands('v1')).toContain('sync-perms')
  })

  it('offers /bridge sync-sounds only to v2 with mode choices and dry_run', () => {
    expect(bridgeSubcommands('v1')).not.toContain('sync-sounds')
    const sub: any = (buildCommands('v2').find(c => c.name === 'bridge')!.options ?? []).find(o => o.name === 'sync-sounds')
    expect(sub).toBeTruthy()
    const mode = sub.options.find((o: any) => o.name === 'mode')
    expect(mode.choices.map((c: any) => c.value)).toEqual(['merge', 'mirror', 'add'])
    expect(sub.options.map((o: any) => o.name)).toContain('dry_run')
    expect(mode.description).toContain('default: merge')
  })

  it('offers /bridge sync-emojis only to v2 with mode choices and dry_run', () => {
    expect(bridgeSubcommands('v1')).not.toContain('sync-emojis')
    const sub: any = (buildCommands('v2').find(c => c.name === 'bridge')!.options ?? []).find(o => o.name === 'sync-emojis')
    expect(sub).toBeTruthy()
    const mode = sub.options.find((o: any) => o.name === 'mode')
    expect(mode.choices.map((c: any) => c.value)).toEqual(['merge', 'mirror', 'add'])
    expect(sub.options.map((o: any) => o.name)).toContain('dry_run')
  })

  it('offers /bridge sync-stickers only to v2 with mode choices and dry_run', () => {
    expect(bridgeSubcommands('v1')).not.toContain('sync-stickers')
    const sub: any = (buildCommands('v2').find(c => c.name === 'bridge')!.options ?? []).find(o => o.name === 'sync-stickers')
    expect(sub).toBeTruthy()
    const mode = sub.options.find((o: any) => o.name === 'mode')
    expect(mode.choices.map((c: any) => c.value)).toEqual(['merge', 'mirror', 'add'])
    expect(sub.options.map((o: any) => o.name)).toContain('dry_run')
  })
})
