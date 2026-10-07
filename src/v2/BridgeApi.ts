import { fetchWithRetry, type FetchLike, type RetryOptions } from '../http.js'
import type { StatusPayload } from './selfCheck.js'

export type PairDirectionV2 = 'both' | 'to_harmony' | 'to_discord'

/** GET /bridge/v2/config */
export interface BridgeV2Config {
  bridge_id: string
  server_id: string
  mode: 'self' | 'hosted'
  discord_guild_id: string | null
  settings: Record<string, unknown>
  pairs: Array<{
    harmony_channel_id: string
    harmony_channel_name?: string
    discord_channel_id: string
    direction: PairDirectionV2
  }>
  harmony_channels: Array<{
    id: string
    name: string
    type: number | string
    category?: string | null
    /** Read when present; the contract does not list it. */
    encrypted?: boolean
  }>
  /** Read when present; the contract does not list it. */
  base_url?: string
}

/** POST /bridge/v2/redeem */
export interface RedeemResponse {
  bridge_id: string
  server_id: string
  harmony_token: string
  api_url: string
  gateway_url: string
  base_url: string
}

/** GET /bridge/v2/hosted entry */
export interface HostedEntry {
  bridge_id: string
  harmony_token: string
  discord_token: string
}

export class BridgeApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'BridgeApiError'
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }
}

async function failure(res: Response, what: string): Promise<BridgeApiError> {
  const body = await res.json().catch(() => null) as { error?: string; message?: string } | null
  const detail = body?.error || body?.message
  return new BridgeApiError(`${what} failed (${res.status}${detail ? `: ${detail}` : ''})`, res.status)
}

const TIMEOUT_MS = 20_000

/** bot-gateway /bridge/v2 client. `apiBase` is the bot-gateway root (no /api/v1). */
export class BridgeApi {
  private readonly base: string

  constructor(
    apiBase: string,
    private readonly token: string,
    private readonly options: { fetchImpl?: FetchLike; retry?: RetryOptions } = {},
  ) {
    this.base = `${apiBase.replace(/\/+$/, '')}/bridge/v2`
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    return fetchWithRetry(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    }, { timeoutMs: TIMEOUT_MS, ...this.options.retry, fetchImpl: this.options.fetchImpl })
  }

  static async redeem(apiBase: string, code: string, fetchImpl?: FetchLike): Promise<RedeemResponse> {
    const res = await fetchWithRetry(`${apiBase.replace(/\/+$/, '')}/bridge/v2/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }, { fetchImpl, timeoutMs: TIMEOUT_MS })
    if (!res.ok) throw await failure(res, 'Setup code redeem')
    const body = await res.json() as Partial<RedeemResponse>
    if (!body.harmony_token || !body.bridge_id) {
      throw new BridgeApiError('Setup code redeem returned no credentials', 502)
    }
    return body as RedeemResponse
  }

  async getConfig(): Promise<BridgeV2Config> {
    const res = await this.call('/config')
    if (!res.ok) throw await failure(res, 'GET /bridge/v2/config')
    const body = await res.json() as Partial<BridgeV2Config>
    return {
      bridge_id: String(body.bridge_id ?? ''),
      server_id: String(body.server_id ?? ''),
      mode: body.mode === 'hosted' ? 'hosted' : 'self',
      discord_guild_id: body.discord_guild_id ? String(body.discord_guild_id) : null,
      settings: body.settings && typeof body.settings === 'object' ? body.settings : {},
      pairs: Array.isArray(body.pairs) ? body.pairs : [],
      harmony_channels: Array.isArray(body.harmony_channels) ? body.harmony_channels : [],
      ...(typeof body.base_url === 'string' && body.base_url ? { base_url: body.base_url } : {}),
    }
  }

  async postStatus(payload: StatusPayload): Promise<void> {
    const res = await this.call('/status', { method: 'POST', body: JSON.stringify(payload) })
    if (!res.ok) throw await failure(res, 'POST /bridge/v2/status')
    await res.body?.cancel().catch(() => {})
  }

  async createPair(body: {
    discord_channel_id: string
    discord_channel_name: string
    harmony_channel_id: string
    direction: PairDirectionV2
  }): Promise<void> {
    const res = await this.call('/pairs', { method: 'POST', body: JSON.stringify(body) })
    if (!res.ok) throw await failure(res, 'Link')
    await res.body?.cancel().catch(() => {})
  }

  /** False when the gateway has no such pair (404). */
  async deletePair(discordChannelId: string): Promise<boolean> {
    const res = await this.call(`/pairs/${encodeURIComponent(discordChannelId)}`, { method: 'DELETE' })
    if (res.status === 404) return false
    if (!res.ok) throw await failure(res, 'Unlink')
    await res.body?.cancel().catch(() => {})
    return true
  }

  /** Host runner list. Null when the gateway answers 404 (hosting disabled or secret unset). */
  static async hosted(apiBase: string, secret: string, fetchImpl?: FetchLike): Promise<HostedEntry[] | null> {
    const res = await fetchWithRetry(`${apiBase.replace(/\/+$/, '')}/bridge/v2/hosted`, {
      headers: { 'X-Bridge-Host-Secret': secret },
    }, { fetchImpl, timeoutMs: TIMEOUT_MS })
    if (res.status === 404) return null
    if (!res.ok) throw await failure(res, 'GET /bridge/v2/hosted')
    const body = await res.json() as unknown
    const list = Array.isArray(body) ? body : (body as { bridges?: unknown })?.bridges
    if (!Array.isArray(list)) throw new BridgeApiError('GET /bridge/v2/hosted returned no list', 502)
    return list
      .filter((e): e is HostedEntry =>
        !!e && typeof e.bridge_id === 'string' && typeof e.harmony_token === 'string' && typeof e.discord_token === 'string')
  }
}
