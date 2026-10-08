import { WebSocket } from 'ws'
import { EventEmitter } from 'events'
import { Backoff, fetchWithRetry, type FetchLike, type RetryOptions } from './http.js'
import { Logger, errorText } from './log.js'
import type { PresenceDelta } from './runtime/presenceDeltas.js'

interface HarmonyMessage {
  id: string
  channel_id: string
  author: {
    id: string
    username: string
    avatar?: string
  }
  content: string
  timestamp: string
}

/** bot-gateway closes IDENTIFY with 4001 (missing token) or 4004 (rejected token). */
export const HARMONY_AUTH_CLOSE_CODES = new Set([4001, 4004])
/** bot-gateway closes a connection that sent more than 120 frames (op 1 excluded) in 60 s. */
export const HARMONY_RATE_LIMITED_CLOSE = 4008
const GATEWAY_FRAME_WINDOW_MS = 60_000

export class HarmonyHttpError extends Error {
  /** `code` of the gateway's error body, e.g. AUTOMOD_BLOCKED. */
  readonly code: string | null

  constructor(message: string, readonly status: number, code: string | null = null) {
    super(message)
    this.name = 'HarmonyHttpError'
    this.code = code
  }
}

/** A relay Harmony's AutoMod refused (403 `{code: "AUTOMOD_BLOCKED"}`); final, not retried. */
export function isAutomodBlocked(err: unknown): boolean {
  return err instanceof HarmonyHttpError && err.status === 403 && err.code === 'AUTOMOD_BLOCKED'
}

export interface HarmonyClientOptions {
  log?: Logger
  fetchImpl?: FetchLike
  retry?: RetryOptions
  /** Reconnect delays after an ordinary disconnect. */
  reconnectBaseMs?: number
  reconnectMaxMs?: number
  /** Reconnect delays after the gateway rejected the token. */
  authRetryBaseMs?: number
  authRetryMaxMs?: number
}

/**
 * Events: ready(data), connectionState(boolean), authFailed({code, reason}),
 * unreachable(error), rateLimited(info), gatewayRateLimited({code, reason}),
 * bridgeConfigUpdate(data), and the message/reaction events listed in handleEvent.
 */
export interface HarmonyServerEmoji {
  id: string
  name: string
  url: string | null
  discord_emoji_id: string | null
}

export class HarmonyClient extends EventEmitter {
  private ws: WebSocket | null = null
  private botToken: string
  private gatewayUrl: string
  private apiUrl: string
  private heartbeatInterval: NodeJS.Timeout | null = null
  /** Resets the reconnect backoff once a connection outlives a frame window after a 4008 close. */
  private stableTimer: NodeJS.Timeout | null = null
  private sessionId: string | null = null
  /** Cleared by disconnect(); the close handler reconnects only while set. */
  private reconnectEnabled: boolean = true
  private reconnectTimer: NodeJS.Timeout | null = null
  private readonly log: Logger
  private readonly fetchImpl: FetchLike
  private readonly retry: RetryOptions
  private readonly reconnectBackoff: Backoff
  private readonly authBackoff: Backoff
  private ready = false
  private authRejected = false
  lastClose: { code: number; reason: string } | null = null

  constructor(
    botToken: string,
    gatewayUrl: string = 'ws://localhost:3002/gateway',
    apiUrl: string = 'http://localhost:3002',
    options: HarmonyClientOptions = {},
  ) {
    super()
    this.botToken = botToken
    this.gatewayUrl = gatewayUrl
    this.apiUrl = apiUrl.replace(/\/+$/, '')
    this.log = options.log ?? new Logger()
    this.fetchImpl = options.fetchImpl ?? fetch
    this.retry = options.retry ?? {}
    this.reconnectBackoff = new Backoff(options.reconnectBaseMs ?? 2_000, options.reconnectMaxMs ?? 60_000)
    this.authBackoff = new Backoff(options.authRetryBaseMs ?? 60_000, options.authRetryMaxMs ?? 15 * 60_000)
  }

  /** READY received and the socket is open. */
  isConnected(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN
  }

  /** The gateway or REST rejected the token since the last READY. */
  isAuthRejected(): boolean {
    return this.authRejected
  }

  async connect() {
    this.log.info(`Connecting to Harmony gateway ${this.gatewayUrl}`)

    this.reconnectEnabled = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const ws = new WebSocket(this.gatewayUrl)
    this.ws = ws

    ws.on('open', () => {
      this.log.debug('Harmony gateway socket open')
      this.identify()
    })

    ws.on('message', (data) => {
      let payload: any
      try {
        payload = JSON.parse(data.toString())
      } catch {
        this.log.warn('Harmony gateway sent a non-JSON frame; ignored')
        return
      }
      this.handlePayload(payload)
    })

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      if (this.ws !== ws) return
      const reason = reasonBuf?.toString() || ''
      this.lastClose = { code, reason }
      const wasReady = this.ready
      this.cleanup()
      if (wasReady) this.emit('connectionState', false)

      if (!this.reconnectEnabled) {
        this.log.info('Disconnected from Harmony gateway')
        return
      }

      let delay: number
      if (HARMONY_AUTH_CLOSE_CODES.has(code)) {
        this.authRejected = true
        delay = this.authBackoff.next()
        this.emit('authFailed', { code, reason })
        this.log.warn(
          `Harmony rejected the bridge token (close ${code}${reason ? ` "${reason}"` : ''}); retrying in ${Math.round(delay / 1000)} s`,
        )
      } else if (code === HARMONY_RATE_LIMITED_CLOSE) {
        delay = this.reconnectBackoff.next()
        this.emit('gatewayRateLimited', { code, reason })
        this.log.warn(`Harmony gateway closed the connection for sending too many frames (4008); reconnecting in ${Math.round(delay / 1000)} s`)
      } else {
        delay = this.reconnectBackoff.next()
        this.log.warn(
          `Harmony gateway closed (code ${code}${reason ? ` "${reason}"` : ''}); reconnecting in ${Math.round(delay / 1000)} s`,
        )
      }

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (this.reconnectEnabled) {
          this.connect().catch(err => this.log.error('Harmony reconnect failed:', errorText(err)))
        }
      }, delay)
    })

    ws.on('error', (error) => {
      this.log.warn(`Harmony gateway connection error: ${errorText(error)}`)
      this.emit('unreachable', error)
    })
  }

  private identify() {
    if (!this.ws) return

    this.ws.send(JSON.stringify({
      op: 2, // IDENTIFY
      d: {
        token: this.botToken
      }
    }))
  }

  private handlePayload(payload: any) {
    if (payload.t === 'READY' || payload.type === 'READY') {
      this.sessionId = payload.d.session_id
      this.ready = true
      this.authRejected = false
      if (this.lastClose?.code === HARMONY_RATE_LIMITED_CLOSE) {
        // A 4008 loop keeps growing the delay until one connection survives a full frame window.
        if (this.stableTimer) clearTimeout(this.stableTimer)
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null
          this.reconnectBackoff.reset()
        }, GATEWAY_FRAME_WINDOW_MS)
      } else {
        this.reconnectBackoff.reset()
      }
      this.authBackoff.reset()
      this.log.info(`Harmony bot ready: ${payload.d.bot?.username}`)
      this.emit('ready', payload.d)
      this.emit('connectionState', true)

      const interval = payload.d.heartbeat_interval || 30000
      this.startHeartbeat(interval)
      return
    }

    switch (payload.op) {
      case 0: // DISPATCH
        this.handleEvent(payload.t, payload.d)
        break

      case 10: // HELLO
        if (payload.d?.heartbeat_interval) {
          this.startHeartbeat(payload.d.heartbeat_interval)
        }
        break

      case 11: // HEARTBEAT_ACK
        break
    }
  }

  private handleEvent(eventType: string, data: any) {
    switch (eventType) {
      case 'MESSAGE_CREATE':
        this.emit('messageCreate', data as HarmonyMessage)
        break

      case 'MESSAGE_UPDATE':
        this.log.debug('Harmony MESSAGE_UPDATE:', data?.id)
        this.emit('messageUpdate', data)
        break

      case 'MESSAGE_DELETE':
        this.log.debug('Harmony MESSAGE_DELETE:', data?.id)
        this.emit('messageDelete', data)
        break

      case 'REFRESH_ATTACHMENTS':
        this.emit('refreshAttachments', data)
        break

      case 'MESSAGE_REACTION_ADD':
        this.emit('reactionAdd', data)
        break

      case 'MESSAGE_REACTION_REMOVE':
        this.emit('reactionRemove', data)
        break

      case 'MEMBER_JOIN':
        this.emit('memberJoin', data)
        break

      case 'MEMBER_LEAVE':
        this.emit('memberLeave', data)
        break

      case 'BRIDGE_CONFIG_UPDATE':
        this.emit('bridgeConfigUpdate', data)
        break

      default:
        this.log.debug(`Unhandled Harmony event: ${eventType}`)
    }
  }

  private startHeartbeat(interval: number) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }

    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1 })) // HEARTBEAT
      }
    }, interval)
  }

  private cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer)
      this.stableTimer = null
    }
    this.sessionId = null
    this.ready = false
  }

  // ---------------------------------------------------------------------------
  // REST. Every call goes through fetchWithRetry: 429 honors Retry-After,
  // idempotent calls retry 5xx and network errors with backoff.
  // ---------------------------------------------------------------------------

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.botToken}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    }
    const res = await fetchWithRetry(`${this.apiUrl}/api/v1${path}`, { ...init, headers }, {
      ...this.retry,
      fetchImpl: this.retry.fetchImpl ?? this.fetchImpl,
      onRateLimited: (info) => {
        this.log.debug(`Harmony 429 on ${init.method ?? 'GET'} ${path}; waiting ${info.waitMs} ms`)
        this.emit('rateLimited', info)
        this.retry.onRateLimited?.(info)
      },
    })
    if (res.status === 401) {
      this.authRejected = true
      this.emit('authFailed', { code: 401, reason: 'REST 401' })
    }
    return res
  }

  /** Throws HarmonyHttpError with the gateway's `error` text when the response is not ok. */
  private async expectOk(res: Response, fallback: string): Promise<Response> {
    if (res.ok) return res
    const errorData = await res.json().catch(() => ({})) as any
    const code = typeof errorData?.code === 'string' ? errorData.code : null
    throw new HarmonyHttpError(errorData?.error || `${fallback} (${res.status})`, res.status, code)
  }

  private async getJson<T>(path: string, fallback: string): Promise<T> {
    const res = await this.expectOk(await this.request(path), fallback)
    return res.json() as Promise<T>
  }

  private async sendJson<T>(method: string, path: string, body: unknown, fallback: string): Promise<T> {
    const res = await this.expectOk(
      await this.request(path, { method, body: JSON.stringify(body) }),
      fallback,
    )
    return res.json() as Promise<T>
  }

  async sendMessage(
    channelId: string,
    content: string | any[],
    metadata?: any,
    replyTo?: string | null,
  ): Promise<any> {
    return this.sendJson('POST', `/channels/${channelId}/messages`, {
      content,
      metadata,
      reply_to: replyTo || undefined,
    }, 'Failed to send message')
  }

  async getMessage(messageId: string): Promise<any | null> {
    const response = await this.request(`/messages/${messageId}`)
    if (!response.ok) return null
    return response.json()
  }

  async lookupMessageByDiscordId(channelId: string, discordMessageId: string): Promise<any | null> {
    const response = await this.request(
      `/channels/${channelId}/messages/lookup?discord_message_id=${encodeURIComponent(discordMessageId)}`,
    )
    if (!response.ok) return null
    return response.json()
  }

  async mergeMessageMetadata(messageId: string, metadata: Record<string, unknown>): Promise<void> {
    const response = await this.request(`/messages/${messageId}/metadata`, {
      method: 'PATCH',
      body: JSON.stringify({ metadata }),
    })
    await this.expectOk(response, 'Failed to merge metadata')
  }

  async silentUpdateMessageContent(messageId: string, content: any[]): Promise<void> {
    const response = await this.request(`/messages/${messageId}/content-silent`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    })
    await this.expectOk(response, 'Silent update failed')
  }

  async fetchInvitePreview(code: string): Promise<{
    code: string
    invite_url: string
    server_name: string
    server_description?: string | null
    server_icon_url?: string | null
    member_count?: number | null
  } | null> {
    const response = await this.request(`/invites/${encodeURIComponent(code)}/preview`)
    if (!response.ok) return null
    return (await response.json()) as {
      code: string
      invite_url: string
      server_name: string
      server_description?: string | null
      server_icon_url?: string | null
      member_count?: number | null
    }
  }

  // ---------------------------------------------------------------------------
  // Server structure. Writes need manage_channels on the Harmony server; the
  // gateway enforces it.
  // ---------------------------------------------------------------------------

  async getServerInfo(serverId: string): Promise<any> {
    return this.getJson(`/servers/${serverId}`, 'Failed to fetch server info')
  }

  async getServerMembers(serverId: string, limit = 1000): Promise<any[]> {
    return this.getJson<any[]>(`/servers/${serverId}/members?limit=${limit}`, 'Failed to fetch server members')
  }

  async getServerChannels(serverId: string): Promise<any[]> {
    return this.getJson<any[]>(`/servers/${serverId}/channels`, 'Failed to fetch server channels')
  }

  async getServerCategories(serverId: string): Promise<any[]> {
    return this.getJson<any[]>(`/servers/${serverId}/categories`, 'Failed to fetch server categories')
  }

  async createCategory(serverId: string, name: string, order: number = 0): Promise<any> {
    return this.sendJson('POST', `/servers/${serverId}/categories`, { name, order }, 'Failed to create category')
  }

  async createChannel(
    serverId: string,
    opts: {
      name: string
      type?: 0 | 1
      categoryId?: string | null
      description?: string | null
      order?: number
    },
  ): Promise<any> {
    return this.sendJson('POST', `/servers/${serverId}/channels`, {
      name: opts.name,
      type: opts.type ?? 0,
      category_id: opts.categoryId ?? null,
      description: opts.description ?? null,
      order: opts.order ?? 0,
    }, 'Failed to create channel')
  }

  async updateCategory(
    serverId: string,
    categoryId: string,
    opts: { order?: number; name?: string },
  ): Promise<any> {
    return this.sendJson('PATCH', `/servers/${serverId}/categories/${categoryId}`, opts, 'Failed to update category')
  }

  async updateChannel(
    channelId: string,
    opts: { order?: number; categoryId?: string | null },
  ): Promise<any> {
    const body: Record<string, unknown> = {}
    if (typeof opts.order === 'number') body.order = opts.order
    if (opts.categoryId !== undefined) body.category_id = opts.categoryId
    return this.sendJson('PATCH', `/channels/${channelId}`, body, 'Failed to update channel')
  }

  async getServerRoles(serverId: string): Promise<any[]> {
    return this.getJson<any[]>(`/servers/${serverId}/roles`, 'Failed to fetch server roles')
  }

  /**
   * `permissions` is a bigint bitmask in string form (JS numbers cannot hold
   * 30+ bits). The gateway strips the ADMINISTRATOR bit.
   */
  async createRole(
    serverId: string,
    opts: {
      name: string
      color?: string | null
      position?: number
      permissions?: string
      mentionable?: boolean
      hoist?: boolean
    },
  ): Promise<any> {
    return this.sendJson('POST', `/servers/${serverId}/roles`, {
      name: opts.name,
      color: opts.color ?? null,
      position: opts.position ?? 0,
      permissions: opts.permissions ?? '0',
      mentionable: opts.mentionable ?? true,
      hoist: opts.hoist ?? false,
    }, 'Failed to create role')
  }

  async updateRole(
    serverId: string,
    roleId: string,
    opts: {
      name?: string
      color?: string | null
      position?: number
      permissions?: string
      mentionable?: boolean
      hoist?: boolean
    },
  ): Promise<any> {
    return this.sendJson('PATCH', `/servers/${serverId}/roles/${roleId}`, opts, 'Failed to update role')
  }

  async deleteRole(serverId: string, roleId: string): Promise<void> {
    const response = await this.request(`/servers/${serverId}/roles/${roleId}`, { method: 'DELETE' })
    if (response.status !== 204) await this.expectOk(response, 'Failed to delete role')
  }

  async getChannelPermissionOverrides(channelId: string): Promise<any[]> {
    return this.getJson<any[]>(`/channels/${channelId}/permission-overrides`, 'Failed to fetch channel overrides')
  }

  async upsertChannelPermissionOverride(
    channelId: string,
    body: {
      target_type: 'role' | 'user'
      role_id?: string
      user_id?: string
      allow_permissions: string
      deny_permissions: string
    },
  ): Promise<any> {
    const response = await this.request(`/channels/${channelId}/permission-overrides`, {
      method: 'PUT',
      body: JSON.stringify(body),
    })
    if (response.status === 204) return null
    await this.expectOk(response, 'Failed to upsert channel override')
    return response.json()
  }

  async deleteChannelPermissionOverrideForRole(channelId: string, roleId: string): Promise<void> {
    const response = await this.request(
      `/channels/${channelId}/permission-overrides/role/${roleId}`,
      { method: 'DELETE' },
    )
    if (response.status !== 204) await this.expectOk(response, 'Failed to delete channel override')
  }

  async editMessage(messageId: string, content: string | any[]): Promise<any> {
    return this.sendJson('PATCH', `/messages/${messageId}`, { content }, 'Failed to edit message')
  }

  async deleteMessage(messageId: string): Promise<any> {
    const response = await this.request(`/messages/${messageId}`, { method: 'DELETE' })
    await this.expectOk(response, 'Failed to delete message')
    if (response.status === 204) {
      return { success: true }
    }
    return response.json()
  }

  async addReaction(channelId: string, messageId: string, emoji: string, metadata?: any): Promise<any> {
    const response = await this.request(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
      method: 'PUT',
      body: JSON.stringify({ metadata: metadata || null }),
    })
    await this.expectOk(response, 'Failed to add reaction')
    if (response.status === 204) {
      return { success: true }
    }
    return response.json()
  }

  async removeReaction(
    channelId: string,
    messageId: string,
    emoji: string,
    discordUserId?: string,
  ): Promise<any> {
    const response = await this.request(`/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
      method: 'DELETE',
      body: JSON.stringify(discordUserId ? { discord_user_id: discordUserId } : {}),
    })
    await this.expectOk(response, 'Failed to remove reaction')
    if (response.status === 204) {
      return { success: true }
    }
    return response.json()
  }

  /**
   * Emoji rows for `id` ({id, name, url, ...}). bot-gateway filters by `url`
   * only; without an `id` filter it answers every row, all of which the caller
   * may cache.
   */
  /** Harmony 1.6.16+ answers `?id=` with one emoji object; older versions with every row. */
  async getEmojis(id: string): Promise<Array<{ id: string; name: string | null; url: string | null }>> {
    const body = await this.getJson<unknown>(`/emojis?id=${encodeURIComponent(id)}`, 'Failed to fetch emojis')
    const rows = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : []
    return rows as Array<{ id: string; name: string | null; url: string | null }>
  }

  /** Server emoji with their Discord links (Harmony 1.6.25+). */
  async getServerEmojis(serverId: string): Promise<HarmonyServerEmoji[]> {
    return this.getJson<HarmonyServerEmoji[]>(`/servers/${serverId}/emojis`, 'Failed to fetch server emojis')
  }

  /**
   * Imports a Discord emoji as a server emoji (Harmony 1.6.25+). Status `existing` for one
   * imported before, `linked` for a same-name server emoji that now carries the Discord id.
   */
  async importDiscordEmoji(
    serverId: string,
    emoji: { discordEmojiId: string; name: string; animated: boolean },
  ): Promise<HarmonyServerEmoji & { status: 'created' | 'existing' | 'linked' }> {
    return this.sendJson('POST', `/servers/${serverId}/emojis/discord`, {
      discord_emoji_id: emoji.discordEmojiId,
      name: emoji.name,
      animated: emoji.animated,
    }, 'Failed to import emoji')
  }

  async getGuildMembers(guildId: string): Promise<any[]> {
    return this.getJson<any[]>(`/guilds/${guildId}/members`, 'Failed to fetch guild members')
  }

  /** Recent messages of a channel; [] on failure. Restores message id mappings at startup. */
  async loadRecentMessages(channelId: string, limit: number = 100): Promise<any[]> {
    const response = await this.request(`/channels/${channelId}/messages?limit=${limit}`)
    if (!response.ok) {
      this.log.warn(`Failed to fetch recent messages for ${channelId} (${response.status})`)
      return []
    }
    return response.json() as Promise<any[]>
  }

  /**
   * REGISTER_BRIDGE_DATA (op 6): channel mappings and Discord members for the
   * frontend's bridged-user autosuggest. False when the socket is not open.
   */
  registerBridgeData(
    channels: Array<{
      harmonyChannelId: string
      discordChannelId: string
      members?: Array<{
        id: string
        username: string
        displayName: string
        avatarUrl: string
        bannerUrl?: string | null
        accentColor?: string | null
        harmonyRoleIds?: string[]
        roles?: Array<{
          id: string
          name: string
          color: string | null
          position: number
        }>
        joinedAt?: string | null
        createdAt?: string | null
        presenceStatus?: 'online' | 'away' | 'busy' | 'offline'
        customStatus?: { text: string; emoji: string | null } | null
        source: 'discord'
      }>
    }>,
    sharedMembers?: Array<{
      id: string
      username: string
      displayName: string
      avatarUrl: string
      bannerUrl?: string | null
      accentColor?: string | null
      harmonyRoleIds?: string[]
      roles?: Array<{
        id: string
        name: string
        color: string | null
        position: number
      }>
      joinedAt?: string | null
      createdAt?: string | null
      presenceStatus?: 'online' | 'away' | 'busy' | 'offline'
      customStatus?: { text: string; emoji: string | null } | null
      source: 'discord'
    }>,
  ): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn(`Cannot register bridge data: Harmony socket not open (state ${this.ws?.readyState})`)
      return false
    }

    const guildMembers = sharedMembers ?? channels.find(ch => ch.members?.length)?.members ?? []
    this.log.debug(`REGISTER_BRIDGE_DATA: ${channels.length} channel(s), ${guildMembers.length} member(s)`)

    this.ws.send(JSON.stringify({
      op: 6, // REGISTER_BRIDGE_DATA
      d: {
        channels,
        members: guildMembers,
      },
    }))
    return true
  }

  /**
   * BRIDGE_PRESENCE_UPDATE (op 7): `{updates: [{id, presenceStatus, customStatus}]}`,
   * `id` a Discord user id already registered with op 6. False before READY.
   */
  sendPresenceUpdates(updates: PresenceDelta[]): boolean {
    if (!this.isConnected()) return false
    this.ws!.send(JSON.stringify({
      op: 7, // BRIDGE_PRESENCE_UPDATE
      d: {
        updates: updates.map(u => ({ id: u.id, presenceStatus: u.presenceStatus, customStatus: u.customStatus })),
      },
    }))
    this.log.debug(`BRIDGE_PRESENCE_UPDATE: ${updates.length} member(s)`)
    return true
  }

  disconnect() {
    this.reconnectEnabled = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const wasReady = this.ready
    this.cleanup()
    if (this.ws) {
      const ws = this.ws
      this.ws = null
      ws.close()
    }
    if (wasReady) this.emit('connectionState', false)
  }
}
