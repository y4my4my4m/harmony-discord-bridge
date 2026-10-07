import * as dotenv from 'dotenv'
import type { Server } from 'http'
import { planLaunch } from './env.js'
import { Logger, errorText, parseLogLevel } from './log.js'
import { findLegacyConfigPath, packageVersion, resolveDataDir } from './paths.js'
import { startHealthServer, type Launched } from './health.js'
import { FatalConfigError, runHost, runSelf } from './v2/launch.js'
import { runV1 } from './v1/runV1.js'

dotenv.config({ quiet: true })

const log = new Logger(parseLogLevel(process.env.LOG_LEVEL))
const version = packageVersion()

let launched: Launched | null = null
let healthServer: Server | null = null
let shuttingDown = false

function fatal(message: string): never {
  console.error(message)
  process.exit(1)
}

async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`${signal}: shutting down`)
  const timer = setTimeout(() => process.exit(0), 10_000)
  timer.unref()
  try {
    await launched?.stop()
  } catch (err) {
    log.error('Shutdown error:', errorText(err))
  }
  healthServer?.close()
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown('SIGTERM') })
process.on('SIGINT', () => { void shutdown('SIGINT') })

// One failing handler (or one hosted bridge) must not take the process down.
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
})

async function main() {
  const plan = planLaunch(process.env, findLegacyConfigPath())
  if (plan.kind === 'error') fatal(plan.message)

  log.info(`Harmony Discord bridge ${version} (${plan.kind === 'self' ? 'self-hosted' : plan.kind === 'host' ? 'host mode' : 'legacy v1 config'})`)

  // Up before launch: startup can wait on an unreachable Harmony.
  if (plan.healthPort !== null) {
    healthServer = await startHealthServer({
      port: plan.healthPort,
      log,
      version,
      report: () => launched?.health() ?? { ok: false, body: { state: 'starting' } },
    })
  }

  try {
    if (plan.kind === 'v1') {
      launched = await runV1(plan.configPath, log)
    } else if (plan.kind === 'self') {
      launched = await runSelf({
        harmonyUrl: plan.harmonyUrl,
        setupCode: plan.setupCode,
        discordToken: plan.discordToken,
        dataDir: resolveDataDir(),
        log,
        version,
        ignoredLegacyConfig: plan.ignoredLegacyConfig,
      })
    } else {
      launched = await runHost({
        harmonyUrl: plan.harmonyUrl,
        hostSecret: plan.hostSecret,
        publicUrl: plan.publicUrl,
        dataDir: resolveDataDir(),
        log,
        version,
      })
    }
  } catch (err) {
    if (err instanceof FatalConfigError) fatal(err.message)
    throw err
  }
  if (shuttingDown) await launched.stop()
}

main().catch(err => {
  console.error('Bridge failed to start:', err instanceof Error ? (err.stack ?? err.message) : err)
  process.exit(1)
})
