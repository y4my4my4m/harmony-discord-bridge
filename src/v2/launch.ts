import { mkdirSync } from 'fs'
import { join } from 'path'
import { BridgeApi } from './BridgeApi.js'
import { CredentialsError, obtainCredentials, type StoredCredentials } from './credentials.js'
import { EndpointError, endpointsFor, probeEndpoints, type HarmonyEndpoints } from './endpoints.js'
import { HostRunner } from './HostRunner.js'
import { V2Bridge } from './V2Bridge.js'
import { Backoff, sleep, type FetchLike } from '../http.js'
import { Logger, errorText } from '../log.js'
import type { HealthReport, Launched } from '../health.js'

/** Config errors the user must fix; printed without a stack, exit status 1. */
export class FatalConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FatalConfigError'
  }
}

export const SELF_AUTH_HINT =
  'Harmony rejected this bridge\'s credentials (the bridge was deleted or a newer setup code was redeemed). In Harmony open Server Settings → Discord Bridge, generate a new setup code and set it as HARMONY_SETUP_CODE.'

export const HOSTED_DISCORD_TOKEN_HINT =
  'Discord rejected the bot token stored in Harmony. Reset it in the Discord Developer Portal (Bot → Reset Token) and paste it again in Harmony → Server Settings → Discord Bridge.'

export const HOSTED_AUTH_HINT =
  'Harmony rejected this hosted bridge\'s token; the host runner restarts it when Harmony issues a new one.'

/** Retries `fn` with backoff while `isTransient` accepts its error; other errors propagate. */
async function untilReachable<T>(
  log: Logger,
  what: string,
  fn: () => Promise<T>,
  isTransient: (err: unknown) => boolean,
  shouldStop: () => boolean,
): Promise<T> {
  const backoff = new Backoff(5_000, 5 * 60_000)
  let logged = false
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (!isTransient(err) || shouldStop()) throw err
      const delay = backoff.next()
      if (!logged) log.error(`${what}: ${errorText(err)}. Retrying with backoff.`)
      else log.debug(`${what}: ${errorText(err)}. Next attempt in ${Math.round(delay / 1000)} s.`)
      logged = true
      await sleep(delay)
      if (shouldStop()) throw err
    }
  }
}

function ensureDataDir(dataDir: string) {
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch (err) {
    throw new FatalConfigError(
      `DATA_DIR ${dataDir} cannot be created (${errorText(err)}). With Docker, mount a volume: -v harmony-bridge:/data`,
    )
  }
}

/**
 * Self-hosted v2: redeem HARMONY_SETUP_CODE once (or reuse saved
 * credentials), then run one V2Bridge.
 */
export async function runSelf(opts: {
  harmonyUrl: string
  setupCode: string | null
  discordToken: string
  dataDir: string
  log: Logger
  version: string
  ignoredLegacyConfig: string | null
  fetchImpl?: FetchLike
}): Promise<Launched> {
  const { log } = opts
  let stopped = false
  if (opts.ignoredLegacyConfig) {
    log.info(`HARMONY_URL is set; ignoring legacy ${opts.ignoredLegacyConfig}.`)
  }
  ensureDataDir(opts.dataDir)

  const probed = await untilReachable(
    log,
    'Cannot reach Harmony',
    () => probeEndpoints(opts.harmonyUrl, opts.fetchImpl),
    err => err instanceof EndpointError && err.unreachable,
    () => stopped,
  ).catch(err => {
    if (err instanceof EndpointError) throw new FatalConfigError(err.message)
    throw err
  })

  let creds: StoredCredentials
  try {
    const result = await untilReachable(
      log,
      'Cannot redeem the setup code',
      () => obtainCredentials({
        harmonyUrl: opts.harmonyUrl,
        setupCode: opts.setupCode,
        dataDir: opts.dataDir,
        apiBase: probed.apiBase,
        fetchImpl: opts.fetchImpl,
        warn: line => log.warn(line),
      }),
      err => err instanceof CredentialsError && err.kind === 'unreachable',
      () => stopped,
    )
    creds = result.creds
    if (result.source === 'redeemed') {
      log.info(`Setup code redeemed; credentials saved to ${join(opts.dataDir, 'credentials.json')}. HARMONY_SETUP_CODE is no longer needed.`)
    } else {
      log.info(`Using saved credentials for bridge ${creds.bridge_id}`)
    }
  } catch (err) {
    if (err instanceof CredentialsError) throw new FatalConfigError(err.message)
    throw err
  }

  // A bot-gateway URL given directly (co-located) wins; otherwise the URLs Harmony returned.
  const endpoints: HarmonyEndpoints = probed.direct
    ? probed
    : endpointsFor(creds.api_url || probed.apiBase, false)
  const gatewayUrl = probed.direct ? probed.gatewayUrl : (creds.gateway_url || endpoints.gatewayUrl)

  const bridge = new V2Bridge({
    harmonyToken: creds.harmony_token,
    apiBase: endpoints.apiBase,
    gatewayUrl,
    baseUrl: creds.base_url || null,
    discordToken: opts.discordToken,
    dataDir: opts.dataDir,
    log,
    version: opts.version,
    authHint: SELF_AUTH_HINT,
    fetchImpl: opts.fetchImpl,
  })
  await bridge.start()

  return {
    async stop() {
      stopped = true
      await bridge.stop()
    },
    health(): HealthReport {
      const h = bridge.health()
      return { ok: h.ok, body: { mode: 'self', ...h.body } }
    },
  }
}

/** Host mode: every hosted bridge of the instance, reconciled every 60 s. */
export async function runHost(opts: {
  harmonyUrl: string
  hostSecret: string
  publicUrl: string | null
  dataDir: string
  log: Logger
  version: string
  fetchImpl?: FetchLike
}): Promise<Launched> {
  const { log } = opts
  let stopped = false
  ensureDataDir(opts.dataDir)

  const endpoints = await untilReachable(
    log,
    'Cannot reach Harmony',
    () => probeEndpoints(opts.harmonyUrl, opts.fetchImpl),
    err => err instanceof EndpointError && err.unreachable,
    () => stopped,
  ).catch(err => {
    if (err instanceof EndpointError) throw new FatalConfigError(err.message)
    throw err
  })
  const publicUrl = opts.publicUrl ?? (endpoints.direct ? null : opts.harmonyUrl)

  const runner = new HostRunner({
    log,
    fetchHosted: () => BridgeApi.hosted(endpoints.apiBase, opts.hostSecret, opts.fetchImpl),
    createInstance: (entry) => new V2Bridge({
      label: `[${entry.bridge_id.slice(0, 8)}]`,
      harmonyToken: entry.harmony_token,
      apiBase: endpoints.apiBase,
      gatewayUrl: endpoints.gatewayUrl,
      baseUrl: publicUrl,
      discordToken: entry.discord_token,
      dataDir: join(opts.dataDir, 'hosted', entry.bridge_id.replace(/[^A-Za-z0-9_-]/g, '_')),
      log,
      version: opts.version,
      authHint: HOSTED_AUTH_HINT,
      discordTokenHint: HOSTED_DISCORD_TOKEN_HINT,
      fetchImpl: opts.fetchImpl,
    }),
  })
  log.info(`Host mode: bot-gateway ${endpoints.apiBase}`)
  await runner.start()

  return {
    async stop() {
      stopped = true
      await runner.stop()
    },
    health: () => runner.health(),
  }
}
