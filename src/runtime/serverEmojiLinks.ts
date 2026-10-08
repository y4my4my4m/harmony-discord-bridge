import type { HarmonyServerEmoji } from '../HarmonyClient.js'

/** Links are read again after this long; an import updates them at once. */
export const SERVER_EMOJI_LINKS_TTL_MS = 5 * 60 * 1000

interface ServerLinks {
  byDiscord: Map<string, HarmonyServerEmoji>
  byHarmony: Map<string, HarmonyServerEmoji>
  loadedAt: number
}

/**
 * Harmony server emoji imported from Discord, per Harmony server: Discord emoji id ↔ Harmony
 * emoji row. A linked emoji is one emoji on both sides; reactions and message emoji map through it.
 */
export class ServerEmojiLinks {
  private readonly servers = new Map<string, ServerLinks>()
  private readonly loading = new Map<string, Promise<void>>()

  constructor(
    private readonly fetchRows: (serverId: string) => Promise<HarmonyServerEmoji[]>,
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
        // Harmony before 1.6.25 has no such route; retry after the TTL.
        if (!current) this.replace(serverId, [])
        else current.loadedAt = this.now()
      })
      .finally(() => { this.loading.delete(serverId) })
    this.loading.set(serverId, load)
    return load
  }

  replace(serverId: string, rows: HarmonyServerEmoji[]): void {
    const links: ServerLinks = { byDiscord: new Map(), byHarmony: new Map(), loadedAt: this.now() }
    for (const row of rows) this.addTo(links, row)
    this.servers.set(serverId, links)
  }

  /** Records one row, e.g. from an import, without waiting for the next load. */
  set(serverId: string, row: HarmonyServerEmoji): void {
    let links = this.servers.get(serverId)
    if (!links) {
      links = { byDiscord: new Map(), byHarmony: new Map(), loadedAt: 0 }
      this.servers.set(serverId, links)
    }
    this.addTo(links, row)
  }

  harmonyFor(serverId: string, discordEmojiId: string): HarmonyServerEmoji | null {
    return this.servers.get(serverId)?.byDiscord.get(discordEmojiId) ?? null
  }

  discordFor(serverId: string, harmonyEmojiId: string): string | null {
    return this.servers.get(serverId)?.byHarmony.get(harmonyEmojiId)?.discord_emoji_id ?? null
  }

  private addTo(links: ServerLinks, row: HarmonyServerEmoji): void {
    if (!row?.id || !row.discord_emoji_id) return
    links.byDiscord.set(row.discord_emoji_id, row)
    links.byHarmony.set(row.id, row)
  }
}
