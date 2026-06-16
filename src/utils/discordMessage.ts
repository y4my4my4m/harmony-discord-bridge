/** Discord message content limit (chars). */
export const DISCORD_MESSAGE_MAX_LENGTH = 2000

/**
 * Join lines with newlines, appending "...and N more" when needed so the result
 * fits within Discord's message length limit.
 */
export function joinLinesWithinDiscordLimit(
  lines: string[],
  limit: number = DISCORD_MESSAGE_MAX_LENGTH,
): string {
  if (lines.length === 0) return ''

  let shown: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const tentative = [...shown, lines[i]]
    const omitted = lines.length - tentative.length
    const suffix = omitted > 0 ? `\n_...and ${omitted} more_` : ''
    const candidate = tentative.join('\n') + suffix

    if (candidate.length > limit) {
      if (shown.length > 0) break
      return lines[0].slice(0, limit - 1) + '…'
    }
    shown = tentative
  }

  const omitted = lines.length - shown.length
  let result = shown.join('\n')
  if (omitted > 0) result += `\n_...and ${omitted} more_`
  return result.length > limit ? result.slice(0, limit - 1) + '…' : result
}

export function truncateDiscordContent(
  content: string,
  limit: number = DISCORD_MESSAGE_MAX_LENGTH,
): string {
  if (content.length <= limit) return content
  return content.slice(0, limit - 1) + '…'
}
