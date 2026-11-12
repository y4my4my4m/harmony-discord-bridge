/**
 * Discord users of the bridged server who are opted out of the bridge: by themselves, or
 * removed by a server manager or instance admin. Nothing of theirs is sent to Harmony.
 */
export class OptOutList {
  private ids = new Set<string>()
  private loadedVersion: string | null = null

  /** The `privacy_version` the list was read at; null before the first read. */
  version(): string | null {
    return this.loadedVersion
  }

  has(discordUserId: string): boolean {
    return this.ids.has(discordUserId)
  }

  /** Records one user ahead of the next read, e.g. after a 403 BRIDGE_AUTHOR_OPTED_OUT. */
  add(discordUserId: string): void {
    this.ids.add(discordUserId)
  }

  remove(discordUserId: string): void {
    this.ids.delete(discordUserId)
  }

  replace(version: string | null, discordUserIds: Iterable<string>): void {
    this.ids = new Set(discordUserIds)
    this.loadedVersion = version
  }

  size(): number {
    return this.ids.size
  }
}
