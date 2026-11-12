import { fetchWithRetry, parseRetryAfter, type FetchLike, type RetryOptions } from '../http.js'
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
  /**
   * Whether this bridge may import history now (Harmony 1.9.7). `bridge_mode`: hosted or the
   * instance bot, which never import. `instance_off`: the instance setting. Absent from an
   * older gateway, read as disabled.
   */
  history_import?: { enabled: boolean; reason: 'instance_off' | 'bridge_mode' | null }
  /** Changes whenever the server's opt-out list changes. Absent or null: the gateway has no privacy routes. */
  privacy_version?: string | null
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
  /** Messages the bridge left out because of their author (left the guild, opted out). */
  authors_skipped?: number
  automod_skipped?: number
  /** The Discord member who ran the command. */
  requested_by_remote?: { id: string; username?: string } | null
  created_at: string
  updated_at: string
  finished_at: string | null
}

/** Why the gateway did not store a message of a batch. Final: the message is never resent as it was. */
export type ImportRejectReason = 'invalid' | 'future_date' | 'opted_out' | 'automod' | 'too_long' | 'check_violation'

export interface ImportBatchResult {
  inserted: { discord_message_id: string; id: string }[]
  /** Ids already present, ids dropped for empty content, and every rejected id. Not a count of earlier imports. */
  skipped: string[]
  rejected: { discord_message_id: string; reason: ImportRejectReason | string }[]
}

/** One call that is never retried inside the client; with `signal`, aborted with an import job. */
export interface ImportCallOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * A Discord user's standing with the bridge of this server. `source` says who opted them out:
 * `self` (they did), or a server `manager` or instance `admin` who removed them. Opting in
 * lifts only `self`.
 */
export interface OptOutState {
  opted_out: boolean
  since: string | null
  source: 'self' | 'manager' | 'admin' | null
}

function optOutState(raw: unknown): OptOutState {
  const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const source = body.source === 'self' || body.source === 'manager' || body.source === 'admin' ? body.source : null
  return { opted_out: body.opted_out === true, since: typeof body.since === 'string' ? body.since : null, source }
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
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The gateway's error body, e.g. `discord_message_id`, `reason`. */
    readonly details: Record<string, unknown> = {},
    /** Retry-After of a 429, from the header or the body's `retry_after`. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'BridgeApiError'
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403
  }
}

async function failure(res: Response, what: string): Promise<BridgeApiError> {
  const body = await res.json().catch(() => null) as { error?: string; message?: string; code?: string; retry_after?: unknown } | null
  const detail = body?.error || body?.message
  const code = typeof body?.code === 'string' ? body.code : undefined
  let retryAfterMs: number | null = null
  if (res.status === 429) {
    const seconds = Number(body?.retry_after)
    retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
      ?? (Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null)
  }
  return new BridgeApiError(
    `${what} failed (${res.status}${code ? ` ${code}` : ''}${detail ? `: ${detail}` : ''})`,
    res.status,
    code,
    body && typeof body === 'object' ? body as Record<string, unknown> : {},
    retryAfterMs,
  )
}

const TIMEOUT_MS = 20_000
/** A batch of 100 runs the content pipeline once per message. */
const IMPORT_BATCH_TIMEOUT_MS = 120_000
/** Linking replies scans every imported reply of the channel. */
const IMPORT_LINK_TIMEOUT_MS = 120_000

function historyImportOf(raw: unknown): NonNullable<BridgeV2Config['history_import']> {
  const value = raw && typeof raw === 'object' ? raw as { enabled?: unknown; reason?: unknown } : {}
  const reason = value.reason === 'instance_off' || value.reason === 'bridge_mode' ? value.reason : null
  return { enabled: value.enabled === true, reason }
}

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

  /**
   * `job`: a call that makes one attempt and is aborted with `job.signal`. The caller owns the
   * waits and retries: the importer, which can abort them, or a command that reports the wait.
   */
  private async call(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS, job?: ImportCallOptions): Promise<Response> {
    return fetchWithRetry(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    }, {
      timeoutMs: job?.timeoutMs ?? timeoutMs,
      ...this.options.retry,
      fetchImpl: this.options.fetchImpl,
      ...(job ? { attempts: 1, signal: job.signal } : {}),
    })
  }

  private async json<T>(what: string, path: string, init: RequestInit = {}, timeoutMs?: number, job?: ImportCallOptions): Promise<T> {
    const res = await this.call(path, init, timeoutMs, job)
    if (!res.ok) throw await failure(res, what)
    return await res.json() as T
  }

  /** This bridge's import jobs, all states. 403 import_disabled while import is off for this bridge. */
  async listImports(job?: ImportCallOptions): Promise<ImportJob[]> {
    const body = await this.json<{ imports?: ImportJob[] }>('GET /bridge/v2/imports', '/imports', {}, undefined, job)
    return body.imports ?? []
  }

  /** One job. 404 import_not_found for a job that is not this bridge's. */
  async getImport(id: string, job?: ImportCallOptions): Promise<ImportJob> {
    const body = await this.json<{ import: ImportJob }>('GET /bridge/v2/imports/:id', `/imports/${encodeURIComponent(id)}`, {}, undefined, job)
    return body.import
  }

  /**
   * Queue imports; omitted ids means every importable pair. 400 pair_not_importable (with
   * `discord_channel_id`) on a bad pair. `requestedBy` is the Discord member who ran the command.
   */
  async startImports(discordChannelIds?: string[], requestedBy?: { id: string; username?: string }): Promise<ImportJob[]> {
    const body = await this.json<{ imports?: ImportJob[] }>('POST /bridge/v2/imports', '/imports', {
      method: 'POST',
      body: JSON.stringify({
        ...(discordChannelIds ? { discord_channel_ids: discordChannelIds } : {}),
        ...(requestedBy ? { requested_by: requestedBy } : {}),
      }),
    })
    return body.imports ?? []
  }

  /**
   * 409 invalid_transition for a disallowed state change; 429 import_busy when `state: 'running'`
   * meets the instance's cap on running imports (the job keeps its state).
   */
  async updateImport(id: string, patch: Partial<ImportJob>, job?: ImportCallOptions): Promise<ImportJob> {
    const body = await this.json<{ import: ImportJob }>('PATCH /bridge/v2/imports/:id', `/imports/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }, undefined, job)
    return body.import
  }

  /**
   * Insert a batch (1..100). 409 import_not_running: the job is not running. 429
   * import_rate_limited: nothing was stored, the same batch is sent again after the wait.
   * Safe to resend: the server dedupes.
   */
  async postImportMessages(id: string, messages: ImportMessage[], job?: ImportCallOptions): Promise<ImportBatchResult> {
    const body = await this.json<Partial<ImportBatchResult>>(
      'POST /bridge/v2/imports/:id/messages',
      `/imports/${encodeURIComponent(id)}/messages`,
      { method: 'POST', body: JSON.stringify({ messages }) },
      IMPORT_BATCH_TIMEOUT_MS,
      job && { ...job, timeoutMs: job.timeoutMs ?? IMPORT_BATCH_TIMEOUT_MS },
    )
    return {
      inserted: Array.isArray(body.inserted) ? body.inserted : [],
      skipped: Array.isArray(body.skipped) ? body.skipped : [],
      rejected: Array.isArray(body.rejected) ? body.rejected : [],
    }
  }

  /** Create (or find, idempotent per discord_thread_id) the Harmony thread; returns its uuid. */
  async importThread(id: string, body: ImportThreadBody, job?: ImportCallOptions): Promise<string> {
    const res = await this.json<{ thread_id: string }>(
      'POST /bridge/v2/imports/:id/threads',
      `/imports/${encodeURIComponent(id)}/threads`,
      { method: 'POST', body: JSON.stringify(body) },
      undefined,
      job,
    )
    return res.thread_id
  }

  /** Number of replies linked. */
  async linkImportReplies(id: string, job?: ImportCallOptions): Promise<number> {
    const res = await this.json<{ linked: number }>(
      'POST /bridge/v2/imports/:id/replies/link',
      `/imports/${encodeURIComponent(id)}/replies/link`,
      { method: 'POST' },
      IMPORT_LINK_TIMEOUT_MS,
      job && { ...job, timeoutMs: job.timeoutMs ?? IMPORT_LINK_TIMEOUT_MS },
    )
    return res.linked
  }

  async cancelImport(id: string): Promise<ImportJob[]> {
    const body = await this.json<{ imports?: ImportJob[] }>(
      'POST /bridge/v2/imports/:id/cancel',
      `/imports/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
    )
    return body.imports ?? []
  }

  // Privacy: the bridge's server, platform discord. Ids are Discord user ids.

  /** Every opted-out Discord user of this server, with the list's version. */
  async getOptOuts(job?: ImportCallOptions): Promise<{ version: string | null; remoteUserIds: string[] }> {
    const body = await this.json<{ version?: unknown; remote_user_ids?: unknown }>('GET /bridge/v2/privacy/optouts', '/privacy/optouts', {}, undefined, job)
    if (!Array.isArray(body.remote_user_ids)) throw new BridgeApiError('GET /bridge/v2/privacy/optouts returned no list', 502)
    return {
      version: typeof body.version === 'string' ? body.version : null,
      remoteUserIds: body.remote_user_ids.filter((id): id is string => typeof id === 'string'),
    }
  }

  /** 400 invalid_remote_user for an id that is not a Discord id. */
  async getOptOut(discordUserId: string): Promise<OptOutState> {
    return optOutState(await this.json<unknown>('GET /bridge/v2/privacy/optouts/:id', `/privacy/optouts/${encodeURIComponent(discordUserId)}`))
  }

  async putOptOut(discordUserId: string, username?: string): Promise<OptOutState> {
    return optOutState(await this.json<unknown>('PUT /bridge/v2/privacy/optouts/:id', `/privacy/optouts/${encodeURIComponent(discordUserId)}`, {
      method: 'PUT',
      body: JSON.stringify(username ? { username } : {}),
    }))
  }

  /**
   * Lifts the user's own opt-out. The answer is their standing afterwards: still `opted_out`
   * with `source` manager or admin when a moderator removed them.
   */
  async deleteOptOut(discordUserId: string): Promise<OptOutState> {
    return optOutState(await this.json<unknown>('DELETE /bridge/v2/privacy/optouts/:id', `/privacy/optouts/${encodeURIComponent(discordUserId)}`, {
      method: 'DELETE',
    }))
  }

  /**
   * Opts the user out and deletes their relayed and imported messages in this server.
   * `more`: the gateway finishes the deletion in the background. 429 erase_recent within 60 s
   * of an accepted erase of the same user; one attempt, the wait is the caller's to report.
   */
  async erase(discordUserId: string): Promise<{ erased: number; more: boolean }> {
    const body = await this.json<{ erased?: unknown; more?: unknown }>('POST /bridge/v2/privacy/erase', '/privacy/erase', {
      method: 'POST',
      body: JSON.stringify({ remote_user_id: discordUserId }),
    }, undefined, {})
    return { erased: typeof body.erased === 'number' ? body.erased : 0, more: body.more === true }
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
      history_import: historyImportOf(body.history_import),
      privacy_version: typeof body.privacy_version === 'string' ? body.privacy_version : null,
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
