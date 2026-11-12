import type { HarmonyStickerSyncRow } from '../HarmonyClient.js'
import { SERVER_EMOJI_LINKS_TTL_MS } from './serverEmojiLinks.js'

export interface LinkedSticker {
  id: string
  name: string
  description: string
  url: string
  removed: boolean
}

interface ServerLinks {
  byDiscord: Map<string, LinkedSticker>
  loadedAt: number
}

/**
 * Harmony server stickers synced from Discord, per Harmony server: Discord sticker id → Harmony
 * sticker. Retired rows are kept (`removed: true`) so an edited message reproduces the same native
 * sticker part.
 */
export class ServerStickerLinks {
  private readonly servers = new Map<string, ServerLinks>()
  private readonly loading = new Map<string, Promise<void>>()

  constructor(
    private readonly fetchRows: (serverId: string) => Promise<HarmonyStickerSyncRow[]>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Loads the server's links when absent or older than the TTL. A failed read keeps the old links. */
  async ensure(serverId: string): Promise<void> {
    const current = this.servers.get(serverId)
    if (current && this.now() - current.loadedAt < SERVER_EMOJI_LINKS_TTL_MS) return
    const pending = this.loading.get(serverId)
    if (pending) return pending
    const load = this.fetchRows(serverId)
      .then(rows => { this.replace(serverId, rows) })
      .catch(() => {
        // Harmony without the sticker routes answers 404; retry after the TTL.
        if (!current) this.replace(serverId, [])
        else current.loadedAt = this.now()
      })
      .finally(() => { this.loading.delete(serverId) })
    this.loading.set(serverId, load)
    return load
  }

  replace(serverId: string, rows: HarmonyStickerSyncRow[]): void {
    const links: ServerLinks = { byDiscord: new Map(), loadedAt: this.now() }
    for (const row of rows) {
      if (!row?.id || !row.discord_sticker_id) continue
      links.byDiscord.set(row.discord_sticker_id, {
        id: row.id, name: row.name, description: row.description, url: row.url, removed: row.removed,
      })
    }
    this.servers.set(serverId, links)
  }

  harmonyFor(serverId: string, discordStickerId: string): LinkedSticker | null {
    return this.servers.get(serverId)?.byDiscord.get(discordStickerId) ?? null
  }

  /**
   * Forgets the live link to a Harmony sticker that Harmony refused. A retired link stays: an
   * edit of a message that holds the sticker reproduces its part from it.
   */
  dropLive(serverId: string, harmonyStickerId: string): void {
    const links = this.servers.get(serverId)?.byDiscord
    if (!links) return
    for (const [discordId, link] of links) {
      if (link.id === harmonyStickerId && !link.removed) links.delete(discordId)
    }
  }
}
