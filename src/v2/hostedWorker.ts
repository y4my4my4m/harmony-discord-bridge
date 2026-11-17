import { parentPort, workerData } from 'worker_threads'
import { V2Bridge } from './V2Bridge.js'
import { ImportSlots } from '../runtime/importScheduler.js'
import { DEFAULT_IMPORT_SETTINGS } from '../env.js'
import { HOSTED_AUTH_HINT, HOSTED_DISCORD_TOKEN_HINT } from './hints.js'
import { Logger, errorText } from '../log.js'
import type { FromWorker, HostedWorkerData, ToWorker } from './hostedWorkerProtocol.js'

/**
 * Worker thread entry: one own-bot hosted bridge, the V2Bridge that runHost
 * builds inline, under the heap limit WorkerHostedInstance sets. process.exit
 * here ends this thread only.
 */
if (!parentPort) throw new Error('hostedWorker.js runs only as a worker thread')
const port = parentPort
const data = workerData as HostedWorkerData
const log = new Logger(data.logLevel)
const send = (msg: FromWorker) => port.postMessage(msg)

// Same policy as the main thread (index.ts): a failed handler is logged, the bridge keeps running.
process.on('unhandledRejection', (reason) => {
  log.error(`[${data.entry.bridge_id.slice(0, 8)}] Unhandled rejection:`, reason instanceof Error ? (reason.stack ?? reason.message) : String(reason))
})

const bridge = new V2Bridge({
  label: `[${data.entry.bridge_id.slice(0, 8)}]`,
  harmonyToken: data.entry.harmony_token,
  apiBase: data.apiBase,
  gatewayUrl: data.gatewayUrl,
  baseUrl: data.baseUrl,
  discordToken: data.entry.discord_token,
  dataDir: data.dataDir,
  appEmojiDir: data.appEmojiDir,
  log,
  version: data.version,
  authHint: HOSTED_AUTH_HINT,
  discordTokenHint: HOSTED_DISCORD_TOKEN_HINT,
  import: { slots: new ImportSlots(1), settings: data.import ?? DEFAULT_IMPORT_SETTINGS },
})

const pushHealth = () => send({ type: 'health', report: bridge.health() })
const healthTimer = setInterval(pushHealth, data.healthIntervalMs)

let stopping = false
port.on('message', (msg: ToWorker) => {
  if (msg?.type !== 'stop' || stopping) return
  stopping = true
  clearInterval(healthTimer)
  bridge.stop()
    .catch(err => log.error(`[${data.entry.bridge_id.slice(0, 8)}] Stop failed: ${errorText(err)}`))
    .finally(() => process.exit(0))
})

bridge.start().then(
  () => { send({ type: 'started' }); pushHealth() },
  (err) => { send({ type: 'start-failed', error: errorText(err) }); pushHealth() },
)
