import { dirname, join } from 'path'
import { ChannelMapper } from '../ChannelMapper.js'
import { BridgeRuntime } from '../runtime/BridgeRuntime.js'
import type { NewPair, PairWriter } from '../runtime/PairDirectory.js'
import { Logger } from '../log.js'
import type { HealthReport, Launched } from '../health.js'

/** PairWriter over bridge-config.yml. */
class YamlPairWriter implements PairWriter {
  constructor(private readonly mapper: ChannelMapper) {}

  async link(guildId: string, pair: NewPair): Promise<void> {
    this.mapper.addMapping(pair.discord, pair.harmony, pair.direction !== 'to_harmony', pair.name, guildId)
  }

  async linkMany(guildId: string, pairs: NewPair[]): Promise<NewPair[]> {
    const added = this.mapper.addMappingsBatch(
      pairs.map(p => ({ discord: p.discord, harmony: p.harmony, bidirectional: p.direction !== 'to_harmony', name: p.name })),
      guildId,
    )
    const addedKeys = new Set(added.map(a => a.discord))
    return pairs.filter(p => addedKeys.has(p.discord))
  }

  async unlink(discordChannelId: string): Promise<boolean> {
    return this.mapper.removeMapping(discordChannelId)
  }
}

/**
 * Legacy bridge-config.yml bridge: tokens, guilds and channel mappings from
 * YAML, hot-reloaded on edit. Permission-sync state lives in `data/` next to
 * the `config/` directory.
 */
export async function runV1(configPath: string, log: Logger): Promise<Launched> {
  log.info(`Using legacy ${configPath} (v1). New setups need no YAML: see "Setting up" in the README (Harmony → Server Settings → Discord Bridge).`)

  const mapper = new ChannelMapper(configPath)
  await mapper.resolveHarmonyPairing()
  const config = mapper.getConfig()

  if (!config.harmony?.baseUrl) {
    throw new Error('Configuration error: harmony.baseUrl is required in bridge-config.yml')
  }

  const permissionStorePath = join(dirname(dirname(configPath)), 'data', 'permission-sync.yml')

  let runtime: BridgeRuntime | null = null
  runtime = new BridgeRuntime({
    mode: 'v1',
    directory: mapper,
    writer: new YamlPairWriter(mapper),
    discordToken: config.discord.token,
    harmony: {
      token: config.harmony.token,
      gatewayUrl: config.harmony.gatewayUrl,
      apiUrl: config.harmony.apiUrl,
      baseUrl: config.harmony.baseUrl,
    },
    permissionStorePath,
    log,
    hooks: {
      afterPairsWritten: async () => { await runtime?.onDirectoryChanged({}) },
      harmonyAuthHint: 'Harmony rejected harmony.token from bridge-config.yml. Check the bot token in Harmony → Admin → Bot Management.',
    },
  })

  // Out-of-process edits of bridge-config.yml; the mapper suppresses its own writes.
  mapper.on('configReloaded', () => {
    void runtime?.onDirectoryChanged({})
  })
  mapper.startWatching()

  await runtime.start()

  return {
    async stop() {
      mapper.stopWatching()
      await runtime?.stop()
    },
    health(): HealthReport {
      const discord = runtime?.isDiscordConnected() ?? false
      const harmony = runtime?.isHarmonyConnected() ?? false
      return {
        ok: discord && harmony,
        body: {
          mode: 'v1',
          discord: { connected: discord, state: runtime?.getDiscordState() },
          harmony: { connected: harmony },
          problems: runtime?.connectionProblems().map(p => p.code) ?? [],
        },
      }
    },
  }
}
