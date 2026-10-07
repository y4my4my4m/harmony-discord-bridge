import { GatewayIntentBits } from 'discord.js'
import { fetchWithRetry, type FetchLike } from '../http.js'
import type { PrivilegedIntent } from '../problems.js'

const DISCORD_API = 'https://discord.com/api/v10'

/**
 * Application flags (Discord API, Application Object → Application Flags).
 * The *_LIMITED bits mean the toggle is on for an unverified app under 100 guilds.
 */
export const APPLICATION_FLAGS = {
  GATEWAY_PRESENCE: 1 << 12,
  GATEWAY_PRESENCE_LIMITED: 1 << 13,
  GATEWAY_GUILD_MEMBERS: 1 << 14,
  GATEWAY_GUILD_MEMBERS_LIMITED: 1 << 15,
  GATEWAY_MESSAGE_CONTENT: 1 << 18,
  GATEWAY_MESSAGE_CONTENT_LIMITED: 1 << 19,
} as const

/** Gateway close codes (Discord API, Opcodes and Status Codes). */
export const DISCORD_CLOSE = {
  AUTHENTICATION_FAILED: 4004,
  INVALID_INTENTS: 4013,
  DISALLOWED_INTENTS: 4014,
} as const

export type IntentGrants = Record<PrivilegedIntent, boolean>

export function grantsFromApplicationFlags(flags: number): IntentGrants {
  const has = (full: number, limited: number) => (flags & full) !== 0 || (flags & limited) !== 0
  return {
    message_content: has(APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT, APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED),
    members: has(APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS, APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS_LIMITED),
    presence: has(APPLICATION_FLAGS.GATEWAY_PRESENCE, APPLICATION_FLAGS.GATEWAY_PRESENCE_LIMITED),
  }
}

export interface IntentSelection {
  /** Bits passed to the discord.js client. */
  intents: GatewayIntentBits[]
  /** Privileged intents the settings ask for. */
  requested: PrivilegedIntent[]
  /** Requested privileged intents included in `intents`. */
  active: IntentGrants
  /** Requested privileged intents the application does not have. */
  missing: PrivilegedIntent[]
}

/**
 * Guilds + GuildMessages + MessageContent always; GuildMembers only with
 * sync_member_list, GuildPresences only with sync_presence. Presence data
 * arrives on member objects, so presence also needs the members intent.
 * GuildMessageReactions is unprivileged and always on.
 *
 * `grants` null means unknown: everything requested is attempted.
 * A requested intent the application lacks is left out and reported missing,
 * so the connection still comes up.
 */
export function selectIntents(
  settings: { syncMemberList: boolean; syncPresence: boolean },
  grants: IntentGrants | null,
): IntentSelection {
  const requested: PrivilegedIntent[] = ['message_content']
  if (settings.syncMemberList) requested.push('members')
  if (settings.syncPresence && settings.syncMemberList) requested.push('presence')

  const active: IntentGrants = { message_content: false, members: false, presence: false }
  const missing: PrivilegedIntent[] = []
  for (const intent of requested) {
    if (!grants || grants[intent]) active[intent] = true
    else missing.push(intent)
  }

  const intents: GatewayIntentBits[] = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ]
  if (active.message_content) intents.push(GatewayIntentBits.MessageContent)
  if (active.members) intents.push(GatewayIntentBits.GuildMembers)
  if (active.presence) intents.push(GatewayIntentBits.GuildPresences)

  return { intents, requested, active, missing }
}

export function sameIntents(a: GatewayIntentBits[], b: GatewayIntentBits[]): boolean {
  const sum = (xs: GatewayIntentBits[]) => xs.reduce((acc, x) => acc | x, 0)
  return sum(a) === sum(b)
}

export type PreflightResult =
  | {
      kind: 'ok'
      applicationId: string
      applicationName: string
      flags: number
      grants: IntentGrants
      botUser: { id: string; name: string; avatar: string | null } | null
    }
  | { kind: 'token_invalid' }
  | { kind: 'unreachable'; error: string }

/** GET /applications/@me with the bot token: validity, application id, intent toggles. */
export async function discordPreflight(token: string, fetchImpl?: FetchLike): Promise<PreflightResult> {
  if (!token.trim()) return { kind: 'token_invalid' }
  let res: Response
  try {
    res = await fetchWithRetry(`${DISCORD_API}/applications/@me`, {
      headers: { Authorization: `Bot ${token}` },
    }, { fetchImpl, attempts: 3, timeoutMs: 15_000 })
  } catch (err) {
    return { kind: 'unreachable', error: err instanceof Error ? err.message : String(err) }
  }
  if (res.status === 401 || res.status === 403) return { kind: 'token_invalid' }
  if (!res.ok) return { kind: 'unreachable', error: `HTTP ${res.status}` }

  const app = await res.json() as {
    id?: string
    name?: string
    flags?: number
    bot?: { id?: string; username?: string; avatar?: string | null }
  }
  const flags = Number(app.flags ?? 0)
  return {
    kind: 'ok',
    applicationId: String(app.id ?? ''),
    applicationName: String(app.name ?? ''),
    flags,
    grants: grantsFromApplicationFlags(flags),
    botUser: app.bot?.id
      ? { id: String(app.bot.id), name: String(app.bot.username ?? ''), avatar: app.bot.avatar ?? null }
      : null,
  }
}

export type DiscordFailure = 'token_invalid' | 'intents_disallowed' | 'intents_invalid'

/** Close codes discord.js does not recover from on its own. */
export function classifyDiscordClose(code: number): DiscordFailure | null {
  if (code === DISCORD_CLOSE.AUTHENTICATION_FAILED) return 'token_invalid'
  if (code === DISCORD_CLOSE.DISALLOWED_INTENTS) return 'intents_disallowed'
  if (code === DISCORD_CLOSE.INVALID_INTENTS) return 'intents_invalid'
  return null
}

/** discord.js login rejections. */
export function classifyLoginError(err: unknown): DiscordFailure | 'unreachable' {
  const code = (err as { code?: unknown })?.code
  const message = err instanceof Error ? err.message : String(err)
  if (code === 'TokenInvalid' || /invalid token/i.test(message)) return 'token_invalid'
  if (code === 'DisallowedIntents' || /disallowed intents/i.test(message)) return 'intents_disallowed'
  return 'unreachable'
}
