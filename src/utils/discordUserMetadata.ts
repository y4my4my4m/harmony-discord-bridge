import type { GuildMember, PartialGuildMember, User } from 'discord.js'

export interface DiscordMemberPresentation {
  displayName: string
  avatarUrl: string
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

  return {
    discord_user: {
      id: author.id,
      username: author.username,
      discriminator: author.discriminator,
      display_name: displayName,
      avatar_url: avatarUrl,
    },
    bridge_source: 'discord' as const,
  }
}
