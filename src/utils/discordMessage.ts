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

/** `<@id>`, `<@!id>`, `<@&id>`, `<#id>`, `<:name:id>`, `<a:name:id>`, `<t:…>`: never split inside. */
const DISCORD_TOKEN_RE = /<(?:@[!&]?\d+|#\d+|a?:\w+:\d+|t:\d+(?::[a-zA-Z])?)>/g

/** Fence opener (```lang) left open at the end of `text`, or null. */
function openCodeFence(text: string): string | null {
  let open: string | null = null
  const re = /```([^\s`]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    open = open === null ? '```' + m[1] : null
  }
  return open
}

function findCut(text: string, budget: number): number {
  const window = text.slice(0, budget)
  const floor = Math.floor(budget / 2)
  const newline = window.lastIndexOf('\n')
  let cut = newline >= floor ? newline : -1
  if (cut < 0) {
    const space = window.lastIndexOf(' ')
    cut = space >= floor ? space : budget
  }
  // Move the cut before any mention/emoji token it would land inside.
  DISCORD_TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = DISCORD_TOKEN_RE.exec(text)) !== null) {
    if (m.index >= cut) break
    if (m.index < cut && m.index + m[0].length > cut && m.index > 0) {
      cut = m.index
      break
    }
  }
  // Keep UTF-16 surrogate pairs together.
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return Math.max(1, cut)
}

/**
 * Split content into messages of at most `limit` characters. Prefers line
 * breaks, then spaces; never cuts inside a mention or custom emoji; closes an
 * open code fence at the cut and reopens it in the next chunk.
 */
export function splitDiscordContent(
  content: string,
  limit: number = DISCORD_MESSAGE_MAX_LENGTH,
): string[] {
  if (content.length <= limit) return [content]

  const FENCE_CLOSE = '\n```'
  const chunks: string[] = []
  let rest = content
  let reopen: string | null = null

  while (rest.length > 0) {
    const prefix = reopen ? `${reopen}\n` : ''
    if (prefix.length + rest.length <= limit) {
      chunks.push(prefix + rest)
      break
    }
    const budget = Math.max(1, limit - prefix.length - FENCE_CLOSE.length)
    const cut = findCut(rest, budget)
    let chunk = prefix + rest.slice(0, cut)
    rest = rest.slice(cut)
    if (rest.startsWith('\n') || rest.startsWith(' ')) rest = rest.slice(1)

    reopen = openCodeFence(chunk)
    if (reopen) chunk = chunk.replace(/\n+$/, '') + FENCE_CLOSE
    if (chunk.trim()) chunks.push(chunk)
  }
  return chunks
}
