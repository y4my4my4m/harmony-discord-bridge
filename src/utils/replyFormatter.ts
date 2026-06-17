export function buildDiscordJumpLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

export function isDiscordUserAlreadyMentioned(
  discordUserId: string,
  content: string,
  contentRaw?: unknown[],
  usernames?: string[],
  harmonyAuthorId?: string,
): boolean {
  if (content.includes(`<@${discordUserId}>`) || content.includes(`<@!${discordUserId}>`)) {
    return true
  }

  if (Array.isArray(contentRaw)) {
    for (const part of contentRaw) {
      const p = part as { type?: string; userId?: string; domain?: string }
      if (p.type !== 'mention') continue
      if (p.userId === discordUserId) return true
      if (p.domain === 'discord.com' && p.userId === discordUserId) return true
      if (harmonyAuthorId && p.userId === harmonyAuthorId) return true
    }
  }

  if (usernames) {
    for (const username of usernames) {
      if (!username) continue
      const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`@${escaped}(?:@|\\b|\\s|$|[^\\w])`, 'i')
      if (re.test(content)) return true
    }
  }

  return false
}

/** First line: jump link. Second line: optional @mention + reply body. */
export function formatHarmonyReplyForDiscord(
  jumpLink: string,
  mentionToken: string | null,
  contentText: string,
): string {
  const body = mentionToken ? `${mentionToken} ${contentText}`.trim() : contentText
  return `${jumpLink}\n${body}`
}
