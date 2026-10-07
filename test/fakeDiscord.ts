import { EventEmitter } from 'events'
import { vi } from 'vitest'
import { Collection, Events, PermissionFlagsBits, type ClientOptions } from 'discord.js'

/** discord.js Client stand-in: the members BridgeRuntime and SharedDiscordClient touch. */
export class FakeDiscordClient extends EventEmitter {
  rest = Object.assign(new EventEmitter(), { put: vi.fn(async (_route: string, _body: unknown) => []) })
  user: any = { id: 'bot-user', tag: 'bot#0001', username: 'bot', displayAvatarURL: () => null }
  application = { id: 'app-1' }
  guilds = {
    cache: new Map<string, any>(),
    fetch: vi.fn(async (id: string) => {
      const guild = this.guilds.cache.get(id)
      if (!guild) throw new Error(`Unknown guild ${id}`)
      return guild
    }),
  }
  channels = {
    cache: new Map<string, any>(),
    fetch: vi.fn(async (id: string) => this.channels.cache.get(id) ?? null),
  }
  login = vi.fn(async (_token: string) => 'token')
  destroy = vi.fn(async () => {})

  constructor(readonly options: ClientOptions) {
    super()
  }

  intents(): number[] {
    return this.options.intents as number[]
  }

  /** Adds a guild with text channels the bot can fully use. */
  addGuild(id: string, channelIds: string[] = []) {
    const me = { id: 'bot-user' }
    const channels = new Map<string, any>()
    for (const [i, channelId] of channelIds.entries()) {
      const channel = {
        id: channelId,
        name: `ch-${channelId}`,
        type: 0,
        guildId: id,
        parentId: null,
        rawPosition: i,
        isThread: () => false,
        permissionsFor: () => ({ has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel || flag === PermissionFlagsBits.SendMessages || flag === PermissionFlagsBits.ManageWebhooks }),
      }
      channels.set(channelId, channel)
      this.channels.cache.set(channelId, channel)
    }
    const guild = {
      id,
      name: `guild-${id}`,
      iconURL: () => null,
      members: { me, fetch: vi.fn(async () => new Collection()) },
      channels: { cache: channels },
      leave: vi.fn(async () => { this.guilds.cache.delete(id) }),
    }
    this.guilds.cache.set(id, guild)
    return guild
  }

  /** Emits ClientReady as discord.js does after login. */
  ready() {
    this.emit(Events.ClientReady, this)
  }
}

export function fakeMember(guildId: string, id: string, username = `user-${id}`) {
  return {
    id,
    guild: { id: guildId },
    displayName: username,
    joinedAt: null,
    presence: null,
    user: {
      id,
      username,
      bot: false,
      avatar: null,
      banner: null,
      hexAccentColor: null,
      createdAt: new Date(0),
      bannerURL: () => null,
      displayAvatarURL: () => `https://cdn.example/${id}.png`,
    },
    roles: { cache: new Collection<string, any>() },
  }
}

/** discord.js Presence-shaped object. */
export function fakePresence(
  guildId: string,
  userId: string,
  status: string,
  activities: Array<{ type: number; name?: string; state?: string | null; emoji?: { name: string } | null }> = [],
) {
  return { guild: { id: guildId }, userId, status, activities }
}

/** /applications/@me body with the given flags. */
export function appResponse(flags: number) {
  return () => Response.json({ id: 'app-1', name: 'Bot', flags, bot: { id: 'bot-user', username: 'bot', avatar: null } })
}
