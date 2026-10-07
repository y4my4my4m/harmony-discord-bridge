import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BridgeApi, BridgeApiError, type RedeemResponse } from './BridgeApi.js'
import type { FetchLike } from '../http.js'

export interface StoredCredentials {
  version: 1
  bridge_id: string
  server_id: string
  harmony_token: string
  api_url: string
  gateway_url: string
  base_url: string
  /** HARMONY_URL at redeem time. */
  harmony_url: string
  /** sha256 of the redeemed setup code; a different code triggers a new redeem. */
  setup_code_sha256: string
  redeemed_at: string
}

export const CREDENTIALS_FILE = 'credentials.json'

export function credentialsPath(dataDir: string): string {
  return join(dataDir, CREDENTIALS_FILE)
}

/** Setup codes compare case-insensitively without surrounding whitespace. */
export function hashSetupCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex')
}

export class CredentialsError extends Error {
  constructor(message: string, readonly kind: 'no_code' | 'code_rejected' | 'unreachable' | 'storage') {
    super(message)
    this.name = 'CredentialsError'
  }
}

export function loadCredentials(dataDir: string): StoredCredentials | null {
  const path = credentialsPath(dataDir)
  if (!existsSync(path)) return null
  let parsed: Partial<StoredCredentials>
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new CredentialsError(
      `${path} is unreadable (${err instanceof Error ? err.message : String(err)}). Delete it and set a new HARMONY_SETUP_CODE.`,
      'storage',
    )
  }
  if (!parsed.harmony_token || !parsed.api_url || !parsed.gateway_url) return null
  return parsed as StoredCredentials
}

/** Writes credentials.json with mode 0600 via a temp file and rename. */
export function saveCredentials(dataDir: string, creds: StoredCredentials): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    const path = credentialsPath(dataDir)
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, path)
  } catch (err) {
    throw new CredentialsError(
      `Cannot write ${credentialsPath(dataDir)} (${err instanceof Error ? err.message : String(err)}). DATA_DIR must be a writable directory; with Docker mount a volume at /data.`,
      'storage',
    )
  }
}

export function credentialsFromRedeem(
  res: RedeemResponse,
  harmonyUrl: string,
  code: string,
  now = new Date(),
): StoredCredentials {
  return {
    version: 1,
    bridge_id: res.bridge_id,
    server_id: res.server_id,
    harmony_token: res.harmony_token,
    api_url: res.api_url,
    gateway_url: res.gateway_url,
    base_url: res.base_url,
    harmony_url: harmonyUrl,
    setup_code_sha256: hashSetupCode(code),
    redeemed_at: now.toISOString(),
  }
}

export interface ObtainOptions {
  harmonyUrl: string
  setupCode: string | null
  dataDir: string
  /** bot-gateway root for the redeem call. */
  apiBase: string
  fetchImpl?: FetchLike
  warn?: (line: string) => void
}

/**
 * Saved credentials, or a redeem of HARMONY_SETUP_CODE:
 * - no saved credentials: redeem the code (required);
 * - saved credentials from the same code: reuse, no network;
 * - a different code: redeem and replace; when the new code is refused,
 *   keep the saved credentials.
 */
export async function obtainCredentials(
  opts: ObtainOptions,
): Promise<{ creds: StoredCredentials; source: 'saved' | 'redeemed' }> {
  const saved = loadCredentials(opts.dataDir)
  const code = opts.setupCode?.trim() || null

  if (!code) {
    if (saved) return { creds: saved, source: 'saved' }
    throw new CredentialsError(
      'No setup code and no saved credentials. Set HARMONY_SETUP_CODE to the code from Harmony → Server Settings → Discord Bridge.',
      'no_code',
    )
  }

  if (saved && saved.setup_code_sha256 === hashSetupCode(code)) {
    return { creds: saved, source: 'saved' }
  }

  let redeemed: RedeemResponse
  try {
    redeemed = await BridgeApi.redeem(opts.apiBase, code, opts.fetchImpl)
  } catch (err) {
    if (err instanceof BridgeApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      if (saved) {
        opts.warn?.(`HARMONY_SETUP_CODE was refused (${err.status}); keeping the saved credentials. Remove HARMONY_SETUP_CODE to silence this.`)
        return { creds: saved, source: 'saved' }
      }
      throw new CredentialsError(
        `Harmony refused the setup code (${err.message}). Setup codes work once and expire after 30 minutes: generate a new one in Harmony → Server Settings → Discord Bridge.`,
        'code_rejected',
      )
    }
    throw new CredentialsError(
      `Cannot redeem the setup code: ${err instanceof Error ? err.message : String(err)}`,
      'unreachable',
    )
  }

  const creds = credentialsFromRedeem(redeemed, opts.harmonyUrl, code)
  saveCredentials(opts.dataDir, creds)
  return { creds, source: 'redeemed' }
}
