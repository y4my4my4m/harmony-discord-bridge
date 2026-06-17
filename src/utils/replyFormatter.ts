export function buildDiscordJumpLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`
}

const DISCORD_JUMP_LINK_RE =
  /^https:\/\/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\s*(?:\r?\n|$)/

export interface ParsedDiscordJumpLink {
  guildId: string
  channelId: string
  messageId: string
  /** Length of the matched prefix in the original string (from index 0). */
  consumedLength: number
}

/** Parse a leading Discord message jump link (Harmony→Discord reply format). */
export function parseDiscordJumpLink(text: string): ParsedDiscordJumpLink | null {
  const trimmed = text.trimStart()
  const leadingWhitespace = text.length - trimmed.length
  const match = trimmed.match(DISCORD_JUMP_LINK_RE)
  if (!match) return null
  return {
    guildId: match[1],
    channelId: match[2],
    messageId: match[3],
    consumedLength: leadingWhitespace + match[0].length,
  }
}

/** Remove a leading jump-link line from bridged reply content. */
export function stripDiscordJumpLinkLine(text: string): string {
  const parsed = parseDiscordJumpLink(text)
  if (!parsed) return text
  return text.slice(parsed.consumedLength).trimStart()
}

/** Remove a leading `<@id>` Discord mention (Discord auto-adds these on replies). */
export function stripDiscordUserMentionPrefix(text: string, discordUserId: string): string {
  return text.replace(new RegExp(`^\\s*<@!?${discordUserId}>\\s*`), '')
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
