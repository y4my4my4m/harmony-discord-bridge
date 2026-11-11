import { fetchWithRetry, type FetchLike, type RetryOptions } from '../http.js'
import type { StatusPayload } from './selfCheck.js'

export type PairDirectionV2 = 'both' | 'to_harmony' | 'to_discord'

/** GET /bridge/v2/config */
export interface BridgeV2Config {
  bridge_id: string
  server_id: string
  mode: 'self' | 'hosted' | 'instance'
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

/** GET /bridge/v2/hosted/instance bridge entry */
export interface InstanceBridgeEntry {
  bridge_id: string
  harmony_token: string
  discord_guild_id: string | null
}

/** GET /bridge/v2/hosted/instance */
export interface InstanceHosted {
  application_id: string | null
  discord_token: string
  /** GuildPresences allowed on the shared client. */
  presence: boolean
  bridges: InstanceBridgeEntry[]
}

export type ImportState = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
export type ImportPhase = 'messages' | 'threads' | 'replies'

/** A history import job (GET /bridge/v2/imports). */
export interface ImportJob {
  id: string
  harmony_channel_id: string
  discord_channel_id: string
  state: ImportState
  phase: ImportPhase
  cancel_requested: boolean
  start_discord_message_id: string | null
  start_at: string | null
  reached_discord_message_id: string | null
  reached_at: string | null
  channel_created_at: string | null
  threads_total: number | null
  threads_done: number
  thread_cursor: Record<string, unknown> | null
  imported_count: number
  skipped_count: number
  pins_skipped: number
  error: string | null
  requested_via: 'harmony' | 'discord'
  created_at: string
  updated_at: string
  finished_at: string | null
}

/** One message of a POST /imports/:id/messages batch (1..100). */
export interface ImportMessage {
  discord_message_id: string
  created_at: string
  edited_at?: string | null
  /** Harmony parts from the translator, pre-pipeline. */
  content: unknown[]
  /** buildDiscordUserMetadata(...).discord_user */
  discord_user: Record<string, unknown>
  reply_to_discord_message_id?: string | null
  /** Harmony thread uuid. */
  thread_id?: string | null
  pinned?: boolean
}

/** POST /imports/:id/threads body. */
export interface ImportThreadBody {
  discord_thread_id: string
  name: string
  created_at: string
  starter_discord_message_id?: string | null
  discord_user?: Record<string, unknown> | null
  archived: boolean
  locked: boolean
}

export class BridgeApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'BridgeApiError'
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }
}

async function failure(res: Response, what: string): Promise<BridgeApiError> {
  const body = await res.json().catch(() => null) as { error?: string; message?: string; code?: string } | null
  const detail = body?.error || body?.message
  const code = typeof body?.code === 'string' ? body.code : undefined
  return new BridgeApiError(
    `${what} failed (${res.status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''})`,
    res.status,
    code,
  )
}

const TIMEOUT_MS = 20_000
/** The server mirrors attachments while handling a batch, which is slow. */
const IMPORT_BATCH_TIMEOUT_MS = 120_000

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

  private async call(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
    return fetchWithRetry(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    }, { timeoutMs, ...this.options.retry, fetchImpl: this.options.fetchImpl })
  }

  private async importsJson<T>(what: string, path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const res = await this.call(path, init, timeoutMs)
    if (!res.ok) throw await failure(res, what)
    return await res.json() as T
  }

  /** This bridge's import jobs, all states. */
  async listImports(): Promise<ImportJob[]> {
    const body = await this.importsJson<{ imports?: ImportJob[] }>('GET /bridge/v2/imports', '/imports')
    return body.imports ?? []
  }

  /** Queue imports; omitted ids means every importable pair. 400 pair_not_importable on a bad pair. */
  async startImports(discordChannelIds?: string[]): Promise<ImportJob[]> {
    const body = await this.importsJson<{ imports?: ImportJob[] }>('POST /bridge/v2/imports', '/imports', {
      method: 'POST',
      body: JSON.stringify(discordChannelIds ? { discord_channel_ids: discordChannelIds } : {}),
    })
    return body.imports ?? []
  }

  /** 409 invalid_transition for a disallowed state change. */
  async updateImport(id: string, patch: Partial<ImportJob>): Promise<ImportJob> {
    const body = await this.importsJson<{ import: ImportJob }>('PATCH /bridge/v2/imports/:id', `/imports/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    return body.import
  }

  /**
   * Insert a batch (1..100). `skipped` lists ids already present AND ids dropped for empty content, so it is
   * not a count of earlier imports. 409 import_not_running means stop the job. Safe to resend: the server dedupes.
   */
  async postImportMessages(id: string, messages: ImportMessage[]): Promise<{
    inserted: { discord_message_id: string; id: string }[]
    skipped: string[]
  }> {
    const body = await this.importsJson<{ inserted?: { discord_message_id: string; id: string }[]; skipped?: string[] }>(
      'POST /bridge/v2/imports/:id/messages',
      `/imports/${encodeURIComponent(id)}/messages`,
      { method: 'POST', body: JSON.stringify({ messages }) },
      IMPORT_BATCH_TIMEOUT_MS,
    )
    return { inserted: body.inserted ?? [], skipped: body.skipped ?? [] }
  }

  /** Create (or find, idempotent per discord_thread_id) the Harmony thread; returns its uuid. */
  async importThread(id: string, body: ImportThreadBody): Promise<string> {
    const res = await this.importsJson<{ thread_id: string }>(
      'POST /bridge/v2/imports/:id/threads',
      `/imports/${encodeURIComponent(id)}/threads`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    return res.thread_id
  }

  /** Number of replies linked. */
  async linkImportReplies(id: string): Promise<number> {
    const res = await this.importsJson<{ linked: number }>(
      'POST /bridge/v2/imports/:id/replies/link',
      `/imports/${encodeURIComponent(id)}/replies/link`,
      { method: 'POST' },
    )
    return res.linked
  }

  async cancelImport(id: string): Promise<ImportJob[]> {
    const body = await this.importsJson<{ imports?: ImportJob[] }>(
      'POST /bridge/v2/imports/:id/cancel',
      `/imports/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
    )
    return body.imports ?? []
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
      mode: body.mode === 'hosted' || body.mode === 'instance' ? body.mode : 'self',
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

  /** Instance bot and its bridges. Null when the gateway answers 404 (instance bot disabled or unconfigured). */
  static async hostedInstance(apiBase: string, secret: string, fetchImpl?: FetchLike): Promise<InstanceHosted | null> {
    const res = await fetchWithRetry(`${apiBase.replace(/\/+$/, '')}/bridge/v2/hosted/instance`, {
      headers: { 'X-Bridge-Host-Secret': secret },
    }, { fetchImpl, timeoutMs: TIMEOUT_MS })
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {})
      return null
    }
    if (!res.ok) throw await failure(res, 'GET /bridge/v2/hosted/instance')
    const body = await res.json() as Partial<InstanceHosted> | null
    if (!body || typeof body.discord_token !== 'string' || !body.discord_token) return null
    const bridges = Array.isArray(body.bridges) ? body.bridges : []
    return {
      application_id: typeof body.application_id === 'string' ? body.application_id : null,
      discord_token: body.discord_token,
      presence: body.presence === true,
      bridges: bridges
        .filter((e): e is InstanceBridgeEntry =>
          !!e && typeof e.bridge_id === 'string' && typeof e.harmony_token === 'string')
        .map(e => ({
          bridge_id: e.bridge_id,
          harmony_token: e.harmony_token,
          discord_guild_id: typeof e.discord_guild_id === 'string' && e.discord_guild_id ? e.discord_guild_id : null,
        })),
    }
  }
}
