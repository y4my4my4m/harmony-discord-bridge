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
})
