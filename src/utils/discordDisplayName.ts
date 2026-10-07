/**
 * Harmony display names may include custom-emoji shortcodes (`:fire:`).
 * Discord won't render those — strip them before puppeting or bot fallback.
 */
export function stripEmojiShortcodes(text: string): string {
  return text
    .replace(/:[a-zA-Z0-9_]+:/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function formatHarmonyDisplayNameForDiscord(
  displayName: string | undefined,
  username: string | undefined,
): string {
  const raw = displayName || username || 'Harmony User'
  const stripped = stripEmojiShortcodes(raw)
  return stripped || username || 'Harmony User'
}

/** Harmony gateway message author; `nickname` is the per-server nickname (user_servers.nickname). */
export interface HarmonyAuthorNames {
  nickname?: string | null
  display_name?: string | null
  username?: string | null
}

/** Puppet name: server nickname, else display name, else username; emoji shortcodes stripped. */
export function harmonyAuthorName(author: HarmonyAuthorNames | null | undefined): string {
  for (const candidate of [author?.nickname, author?.display_name]) {
    if (!candidate) continue
    const stripped = stripEmojiShortcodes(candidate)
    if (stripped) return stripped
  }
  return formatHarmonyDisplayNameForDiscord(undefined, author?.username || undefined)
}

export const WEBHOOK_NAME_FALLBACK = 'Harmony user'
const WEBHOOK_NAME_MAX = 80
const WEBHOOK_FORBIDDEN = /clyde|discord/gi

/**
 * Webhook `username` override. Discord rejects names containing "clyde" or
 * "discord" (any case, also inside words) and names outside 1–80 characters.
 * Removal repeats until stable: "discdiscordord" leaves no "discord".
 */
export function sanitizeWebhookUsername(name: string | null | undefined): string {
  let out = (name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  for (let prev = ''; prev !== out;) {
    prev = out
    out = out.replace(WEBHOOK_FORBIDDEN, '')
  }
  out = out.replace(/\s+/g, ' ').trim()
  const chars = Array.from(out)
  if (chars.length > WEBHOOK_NAME_MAX) out = chars.slice(0, WEBHOOK_NAME_MAX).join('').trimEnd()
  return out || WEBHOOK_NAME_FALLBACK
}

/** Bold author prefix of a bot post; Markdown in the name is escaped. */
export function botPostPrefix(name: string): string {
  return `**${name.replace(/([\\*_~`|])/g, '\\$1')}**: `
}

/** `@username` for local users, `@username@domain` for federated remote users. */
export function formatHarmonyUserHandle(
  username: string,
  domain: string | null | undefined,
  isLocal: boolean,
): string {
  if (isLocal) return `@${username}`
  if (domain) return `@${username}@${domain}`
  return `@${username}`
}

/** Discord slash-command autocomplete label: stripped name + handle (max 100 chars). */
export function formatHarmonyUserAutocompleteLabel(
  displayName: string,
  username: string,
  domain: string | null | undefined,
  isLocal: boolean,
): string {
  const name = formatHarmonyDisplayNameForDiscord(displayName, username)
  const handle = formatHarmonyUserHandle(username, domain, isLocal)
  const label = `${name} (${handle})`
  return label.length > 100 ? `${label.slice(0, 97)}...` : label
}
