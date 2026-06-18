const HARMONY_SERVER_EVENT_TYPES = new Set([
  'member_join',
  'member_leave',
  'member_kick',
  'member_ban',
])

function systemMessageText(msg: { content_raw?: unknown[]; content?: string }): string {
  if (Array.isArray(msg.content_raw)) {
    return msg.content_raw
      .filter((p): p is { type?: string; text?: string } => !!p && typeof p === 'object' && (p as { type?: string }).type === 'text')
      .map(p => p.text ?? '')
      .join(' ')
      .trim()
  }
  return (msg.content ?? '').trim()
}

/** Skip Harmony system/server event messages when bridging to Discord. */
export function shouldBridgeHarmonyMessageToDiscord(msg: {
  is_system?: boolean
  metadata?: { type?: string }
  content?: string
  content_raw?: unknown[]
}): boolean {
  if (msg.is_system) return false

  const eventType = msg.metadata?.type
  if (typeof eventType === 'string' && HARMONY_SERVER_EVENT_TYPES.has(eventType)) {
    return false
  }

  const text = systemMessageText(msg)
  if (/^has (joined|left) the server$/i.test(text)) return false
  if (/^was (kicked|banned) from the server$/i.test(text)) return false

  return true
}
