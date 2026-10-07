/** Problem codes reported in POST /bridge/v2/status `problems[]` (bridge-v2 contract). */
export type ProblemCode =
  | 'discord_token_invalid'
  | 'intent_missing'
  | 'bot_not_in_guild'
  | 'no_guild'
  | 'guild_not_selected'
  | 'channel_not_visible'
  | 'cannot_send'
  | 'cannot_manage_webhooks'
  | 'harmony_auth_failed'
  | 'harmony_channel_missing'
  | 'harmony_channel_encrypted'
  | 'rate_limited'
  | 'discord_unreachable'
  | 'harmony_unreachable'

export type PrivilegedIntent = 'message_content' | 'members' | 'presence'

export interface Problem {
  code: ProblemCode
  params?: Record<string, string>
}

export function problemKey(p: Problem): string {
  const params = p.params
    ? Object.keys(p.params).sort().map(k => `${k}=${p.params![k]}`).join(',')
    : ''
  return `${p.code}${params ? `:${params}` : ''}`
}

export function dedupeProblems(problems: Problem[]): Problem[] {
  const seen = new Set<string>()
  const out: Problem[] = []
  for (const p of problems) {
    const key = problemKey(p)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

/** Developer Portal toggle names, Bot → Privileged Gateway Intents. */
export const INTENT_PORTAL_NAME: Record<PrivilegedIntent, string> = {
  message_content: 'Message Content Intent',
  members: 'Server Members Intent',
  presence: 'Presence Intent',
}

/** One-line operator hint for refused privileged intents. */
export function intentPortalHint(missing: PrivilegedIntent[]): string {
  const names = missing.map(i => `"${INTENT_PORTAL_NAME[i]}"`).join(' and ')
  return `Discord refused privileged intents: turn on ${names} at https://discord.com/developers/applications → your app → Bot → Privileged Gateway Intents (retrying automatically).`
}

/** Plain-language summary and fix, for `/bridge status` and logs. */
export function describeProblem(p: Problem): { summary: string; fix: string } {
  const ch = p.params?.discord_channel_id ? `<#${p.params.discord_channel_id}>` : 'a bridged channel'
  switch (p.code) {
    case 'discord_token_invalid':
      return {
        summary: 'Discord rejected the bot token.',
        fix: 'Reset the token in the Discord Developer Portal (Bot → Reset Token) and update DISCORD_TOKEN (or paste it again in Harmony for hosted bridges).',
      }
    case 'intent_missing': {
      const intent = (p.params?.intent ?? 'message_content') as PrivilegedIntent
      return {
        summary: `The "${INTENT_PORTAL_NAME[intent] ?? intent}" is switched off for this bot.`,
        fix: 'Discord Developer Portal → your app → Bot → Privileged Gateway Intents → switch it on. The bridge picks it up within a few minutes.',
      }
    }
    case 'bot_not_in_guild':
      return {
        summary: 'The bot is not a member of the Discord server chosen in Harmony.',
        fix: 'Invite the bot to that server again, or pick another server in Harmony → Server Settings → Discord Bridge.',
      }
    case 'no_guild':
      return {
        summary: 'The bot has not been added to any Discord server yet.',
        fix: 'Use the invite link from Harmony → Server Settings → Discord Bridge to add the bot to your Discord server.',
      }
    case 'guild_not_selected':
      return {
        summary: 'The bot is in several Discord servers and none is chosen.',
        fix: 'Pick the Discord server in Harmony → Server Settings → Discord Bridge.',
      }
    case 'channel_not_visible':
      return {
        summary: `The bot cannot see ${ch}.`,
        fix: 'Give the bot (or its role) the View Channel permission on that channel.',
      }
    case 'cannot_send':
      return {
        summary: `The bot cannot post in ${ch}.`,
        fix: 'Give the bot the Send Messages permission on that channel.',
      }
    case 'cannot_manage_webhooks':
      return {
        summary: `The bot cannot manage webhooks in ${ch}, so Harmony messages show the bot's name instead of the author's.`,
        fix: 'Give the bot the Manage Webhooks permission on that channel.',
      }
    case 'harmony_auth_failed':
      return {
        summary: 'Harmony rejected the bridge credentials.',
        fix: 'Generate a new setup code in Harmony → Server Settings → Discord Bridge and set it as HARMONY_SETUP_CODE.',
      }
    case 'harmony_channel_missing':
      return {
        summary: 'A bridged Harmony channel no longer exists.',
        fix: 'Remove the pair (/bridge unlink in the Discord channel, or in Harmony) and link another channel.',
      }
    case 'harmony_channel_encrypted':
      return {
        summary: 'A bridged Harmony channel is end-to-end encrypted; the bridge cannot read it.',
        fix: 'Bridge a channel without end-to-end encryption.',
      }
    case 'rate_limited':
      return {
        summary: 'Discord or Harmony is rate limiting the bridge; some messages were dropped.',
        fix: 'Usually temporary. If it persists, reduce traffic in the bridged channels.',
      }
    case 'discord_unreachable':
      return {
        summary: 'The bridge cannot reach Discord.',
        fix: 'Check the internet connection of the machine running the bridge.',
      }
    case 'harmony_unreachable':
      return {
        summary: 'The bridge cannot reach Harmony.',
        fix: 'Check HARMONY_URL and the internet connection of the machine running the bridge.',
      }
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DiscordChannelView {
  id: string
  name: string
  type: number
  parent_id: string | null
  position: number
  can_view: boolean
  can_send: boolean
  can_manage_webhooks: boolean
}

export interface DiscordGuildView {
  id: string
  name: string
  icon: string | null
  channels: DiscordChannelView[]
}

export interface PairView {
  harmony_channel_id: string
  discord_channel_id: string
  direction: 'both' | 'to_harmony' | 'to_discord'
}

export interface HarmonyChannelView {
  id: string
  encrypted?: boolean
}

export interface DetectInput {
  /** Connection-level problems already known (tokens, intents, reachability). */
  connection: Problem[]
  /** Guilds the bot is in; null while Discord is not connected. */
  guilds: DiscordGuildView[] | null
  /** Bridge configuration; null before the first successful /config. */
  config: {
    discord_guild_id: string | null
    pairs: PairView[]
    harmony_channels: HarmonyChannelView[] | null
  } | null
}

export function detectProblems(input: DetectInput): Problem[] {
  const problems: Problem[] = [...input.connection]
  const { guilds, config } = input

  if (guilds && config) {
    const selected = config.discord_guild_id
    if (guilds.length === 0) {
      problems.push({ code: 'no_guild' })
    } else if (!selected) {
      if (guilds.length > 1) problems.push({ code: 'guild_not_selected' })
    } else {
      const guild = guilds.find(g => g.id === selected)
      if (!guild) {
        problems.push({ code: 'bot_not_in_guild', params: { guild_id: selected } })
      } else {
        for (const pair of config.pairs) {
          const params = { discord_channel_id: pair.discord_channel_id }
          const channel = guild.channels.find(c => c.id === pair.discord_channel_id)
          if (!channel || !channel.can_view) {
            problems.push({ code: 'channel_not_visible', params })
            continue
          }
          if (pair.direction === 'to_harmony') continue
          if (!channel.can_send) problems.push({ code: 'cannot_send', params })
          if (!channel.can_manage_webhooks) problems.push({ code: 'cannot_manage_webhooks', params })
        }
      }
    }
  }

  if (config?.harmony_channels) {
    const byId = new Map(config.harmony_channels.map(c => [c.id, c]))
    for (const pair of config.pairs) {
      const params = { harmony_channel_id: pair.harmony_channel_id }
      const channel = byId.get(pair.harmony_channel_id)
      if (!channel) problems.push({ code: 'harmony_channel_missing', params })
      else if (channel.encrypted) problems.push({ code: 'harmony_channel_encrypted', params })
    }
  }

  return dedupeProblems(problems)
}
