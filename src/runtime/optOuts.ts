/**
 * Discord users of the bridged server who are opted out of the bridge: by themselves, or
 * removed by a server manager or instance admin. Nothing of theirs is sent to Harmony.
 * `onChange` runs whenever the set of users changes, by any path.
 */
export class OptOutList {
  private ids = new Set<string>()
  private loadedVersion: string | null = null

  constructor(private readonly onChange: () => void = () => {}) {}

  /** The `privacy_version` the list was read at; null before the first read. */
  version(): string | null {
    return this.loadedVersion
  }

  has(discordUserId: string): boolean {
    return this.ids.has(discordUserId)
  }

  /** Records one user ahead of the next read, e.g. after a 403 BRIDGE_AUTHOR_OPTED_OUT. */
  add(discordUserId: string): void {
    if (this.ids.has(discordUserId)) return
    this.ids.add(discordUserId)
    this.onChange()
  }

  remove(discordUserId: string): void {
    if (this.ids.delete(discordUserId)) this.onChange()
  }

  replace(version: string | null, discordUserIds: Iterable<string>): void {
    const next = new Set(discordUserIds)
    const changed = next.size !== this.ids.size || [...next].some(id => !this.ids.has(id))
    this.ids = next
    this.loadedVersion = version
    if (changed) this.onChange()
  }

  size(): number {
    return this.ids.size
  }
}
