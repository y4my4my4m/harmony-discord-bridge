/**
 * Ephemeral Discord emoji reactions — URL-only, no emojis table row.
 */

export interface DiscordReactionBridgePayload {
  /** Value for custom_emoji_content (non-UUID path in bot-gateway). */
  identifier: string
  metadata: Record<string, unknown>
}

export function buildDiscordCustomEmojiCdnUrl(
  discordEmojiId: string,
  isAnimated: boolean,
): string {
  const ext = isAnimated ? 'gif' : 'png'
  return `https://cdn.discordapp.com/emojis/${discordEmojiId}.${ext}`
}

/**
 * Build Harmony reaction identifier + metadata for a Discord custom emoji.
 * Uses discord:name:id in custom_emoji_content and CDN URL in metadata.
 */
export function buildDiscordReactionPayload(
  emojiName: string,
  discordEmojiId: string,
  isAnimated = false,
): DiscordReactionBridgePayload {
  const cleanName = emojiName.replace(/:/g, '') || 'unknown'
  const url = buildDiscordCustomEmojiCdnUrl(discordEmojiId, isAnimated)
  return {
    identifier: `discord:${cleanName}:${discordEmojiId}`,
    metadata: {
      remote_emoji_url: url,
      remote_emoji_name: cleanName,
      discord_emoji_id: discordEmojiId,
    },
  }
}

export function mergeReactionMetadata(
  discordUserMetadata: Record<string, unknown>,
  emojiMetadata: Record<string, unknown>,
): Record<string, unknown> {
  return { ...emojiMetadata, ...discordUserMetadata }
}
