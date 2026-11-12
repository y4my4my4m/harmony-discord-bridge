import { describe, expect, it } from 'vitest'
import { buildCommands, NO_FEATURES, type CommandFeatures } from '../src/runtime/commands.js'

const ALL: CommandFeatures = { soundSync: true, emojiSync: true, stickerSync: true, historyImport: true, privacy: true }
const bridgeSubcommands = (mode: 'v1' | 'v2', features: CommandFeatures = ALL) =>
  (buildCommands(mode, features).find(c => c.name === 'bridge')!.options ?? []).map(o => o.name)
const subcommand = (name: string): any =>
  (buildCommands('v2', ALL).find(c => c.name === 'bridge')!.options ?? []).find(o => o.name === name)

describe('buildCommands', () => {
  it('offers /bridge import-emojis only to v2 bridges, which Harmony knows by discord_bridges row', () => {
    expect(bridgeSubcommands('v2')).toContain('import-emojis')
    expect(bridgeSubcommands('v2', NO_FEATURES)).toContain('import-emojis')
    expect(bridgeSubcommands('v1')).not.toContain('import-emojis')
    expect(bridgeSubcommands('v1')).toContain('sync-perms')
  })

  it.each(['sync-sounds', 'sync-emojis', 'sync-stickers'])('offers /bridge %s only to v2 with mode choices and dry_run', (name) => {
    expect(bridgeSubcommands('v1')).not.toContain(name)
    const sub = subcommand(name)
    expect(sub).toBeTruthy()
    const mode = sub.options.find((o: any) => o.name === 'mode')
    expect(mode.choices.map((c: any) => c.value)).toEqual(['merge', 'mirror', 'add'])
    expect(mode.description).toContain('default: merge')
    expect(sub.options.map((o: any) => o.name)).toContain('dry_run')
  })

  it.each([
    ['sync-sounds', 'soundSync'],
    ['sync-emojis', 'emojiSync'],
    ['sync-stickers', 'stickerSync'],
    ['import-history', 'historyImport'],
  ] as const)('offers /bridge %s only with its gateway feature', (name, feature) => {
    expect(bridgeSubcommands('v2', { ...NO_FEATURES, [feature]: true })).toContain(name)
    expect(bridgeSubcommands('v2', { ...ALL, [feature]: false })).not.toContain(name)
  })

  it('offers an older gateway the commands it always had', () => {
    expect(bridgeSubcommands('v2', NO_FEATURES)).toEqual(['status', 'link', 'unlink', 'clone-server', 'sync-order', 'sync-perms', 'import-emojis'])
    expect(buildCommands('v2').map(c => c.name)).toEqual(['mention', 'm', 'bridge'])
  })
})
