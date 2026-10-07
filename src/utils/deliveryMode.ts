/**
 * How a Harmony message reached Discord: true = webhook post, false = bot
 * post, null = unknown (Discord copy gone or unreadable).
 * Order: in-memory record, `discord_via_webhook` metadata written at send
 * time, then the Discord message itself (webhookId / author).
 */
export async function resolveDeliveryMode(input: {
  cached: boolean | undefined
  metadata: Record<string, unknown> | null | undefined
  botUserId: string | null | undefined
  fetchDiscordMessage: () => Promise<{ webhookId?: string | null; author?: { id: string } | null } | null>
}): Promise<boolean | null> {
  if (input.cached !== undefined) return input.cached
  const recorded = input.metadata?.discord_via_webhook
  if (typeof recorded === 'boolean') return recorded
  const fetched = await input.fetchDiscordMessage().catch(() => null)
  if (!fetched) return null
  if (fetched.webhookId) return true
  if (input.botUserId && fetched.author?.id === input.botUserId) return false
  return null
}
