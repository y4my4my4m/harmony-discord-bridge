import type { GuildMember, PartialGuildMember, User } from 'discord.js'

export interface DiscordMemberPresentation {
  displayName: string
  avatarUrl: string
  /** ISO time the member joined the guild. */
  joinedAt?: string | null
}

/** Prefer guild nickname / server display name over Discord global name. */
export function resolveDiscordMemberPresentation(
  author: User,
  member?: GuildMember | PartialGuildMember | null,
  cached?: DiscordMemberPresentation | null,
): DiscordMemberPresentation {
  const displayName =
    (member && 'displayName' in member && member.displayName) ||
    cached?.displayName ||
    author.globalName ||
    author.username

  let avatarUrl = cached?.avatarUrl
  if (member && typeof (member as GuildMember).displayAvatarURL === 'function') {
    avatarUrl = (member as GuildMember).displayAvatarURL({ size: 256 })
  }
  if (!avatarUrl) {
    avatarUrl = author.displayAvatarURL({ size: 256 })
  }

  return { displayName, avatarUrl }
}

export function buildDiscordUserMetadata(
  author: User,
  member?: GuildMember | PartialGuildMember | null,
  cached?: DiscordMemberPresentation | null,
) {
  const { displayName, avatarUrl } = resolveDiscordMemberPresentation(author, member, cached)
  const joinedAt = memberJoinedAt(member) ?? cached?.joinedAt ?? null

  return {
    discord_user: {
      id: String(author.id),
      username: author.username,
      discriminator: author.discriminator,
      display_name: displayName,
      avatar_url: avatarUrl,
      // ISO 8601; absent when unknown.
      ...(joinedAt ? { joined_at: joinedAt } : {}),
    },
    bridge_source: 'discord' as const,
  }
}

/** ISO joinedAt of a guild member (discord.js GuildMember or a raw API member). */
export function memberJoinedAt(member: unknown): string | null {
  const m = member as { joinedAt?: Date | null; joined_at?: string | null } | null | undefined
  if (m?.joinedAt instanceof Date && !Number.isNaN(m.joinedAt.getTime())) return m.joinedAt.toISOString()
  if (typeof m?.joined_at === 'string' && m.joined_at) return m.joined_at
  return null
}
