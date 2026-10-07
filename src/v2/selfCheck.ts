import { PermissionFlagsBits } from 'discord.js'
import type { DiscordChannelView, DiscordGuildView, Problem } from '../problems.js'

/** Structural subset of discord.js used here; tests pass plain objects. */
interface PermissionsLike {
  has(flag: bigint): boolean
}

interface ChannelLike {
  id: string
  name: string
  type: number
  parentId?: string | null
  rawPosition?: number
  position?: number
  isThread?: () => boolean
  permissionsFor?: (member: unknown) => PermissionsLike | null
}

interface GuildLike {
  id: string
  name: string
  iconURL?: (options?: { size?: number }) => string | null
  members: { me: unknown | null }
  channels: { cache: { values(): Iterable<ChannelLike> } }
}

export interface ClientLike {
  guilds: { cache: { values(): Iterable<GuildLike> } }
}

/** Discord channel types (API ChannelType): threads and DMs are never paired. */
const THREAD_OR_DM_TYPES = new Set([1, 3, 10, 11, 12])

/** `include` limits the snapshot to some guilds (instance bot: the linked one). */
export function collectGuildViews(client: ClientLike, include?: (guildId: string) => boolean): DiscordGuildView[] {
  const guilds: DiscordGuildView[] = []
  for (const guild of client.guilds.cache.values()) {
    if (include && !include(guild.id)) continue
    const me = guild.members.me
    const channels: DiscordChannelView[] = []
    for (const channel of guild.channels.cache.values()) {
      if (THREAD_OR_DM_TYPES.has(channel.type) || channel.isThread?.()) continue
      const perms = me && channel.permissionsFor ? channel.permissionsFor(me) : null
      const canView = !!perms?.has(PermissionFlagsBits.ViewChannel)
      channels.push({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        parent_id: channel.parentId ?? null,
        position: channel.rawPosition ?? channel.position ?? 0,
        can_view: canView,
        can_send: canView && !!perms?.has(PermissionFlagsBits.SendMessages),
        can_manage_webhooks: canView && !!perms?.has(PermissionFlagsBits.ManageWebhooks),
      })
    }
    channels.sort((a, b) => a.position - b.position)
    guilds.push({
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL?.({ size: 128 }) ?? null,
      channels,
    })
  }
  return guilds
}

/** POST /bridge/v2/status body. */
export interface StatusPayload {
  version: string
  discord: {
    connected: boolean
    application_id: string | null
    bot_user: { id: string; name: string; avatar: string | null } | null
    intents: { message_content: boolean; members: boolean; presence: boolean }
  }
  guilds: DiscordGuildView[]
  harmony: { connected: boolean }
  problems: Problem[]
}

export function buildStatusPayload(input: {
  version: string
  discordConnected: boolean
  applicationId: string | null
  botUser: StatusPayload['discord']['bot_user']
  intents: StatusPayload['discord']['intents']
  guilds: DiscordGuildView[] | null
  harmonyConnected: boolean
  problems: Problem[]
}): StatusPayload {
  return {
    version: input.version,
    discord: {
      connected: input.discordConnected,
      application_id: input.applicationId,
      bot_user: input.botUser,
      intents: input.intents,
    },
    guilds: input.guilds ?? [],
    harmony: { connected: input.harmonyConnected },
    problems: input.problems,
  }
}
