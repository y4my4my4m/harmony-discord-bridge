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
