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
