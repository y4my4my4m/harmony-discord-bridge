import { EventEmitter } from 'events'
import { vi } from 'vitest'
import { Collection, Events, PermissionFlagsBits, type ClientOptions } from 'discord.js'

/** discord.js Client stand-in: the members BridgeRuntime and SharedDiscordClient touch. */
export class FakeDiscordClient extends EventEmitter {
  rest = Object.assign(new EventEmitter(), {
    put: vi.fn(async (_route: string, _body: unknown) => []),
    get: vi.fn(async (_route: string): Promise<unknown> => ({ items: [] })),
    post: vi.fn(async (_route: string, _opts?: unknown): Promise<unknown> => ({})),
    delete: vi.fn(async (_route: string): Promise<unknown> => undefined),
  })
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
    avatar: null,
    displayAvatarURL: () => `https://cdn.example/${id}.png`,
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

/** Discord REST error as discord.js throws it. */
export function discordError(code: number, message = `Discord error ${code}`, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

export function fakeWebhook(id = 'wh-1') {
  let n = 0
  return {
    id,
    name: 'Harmony Bridge',
    token: 'wt',
    send: vi.fn(async (_payload: any): Promise<any> => ({ id: `${id}-msg-${++n}` })),
    editMessage: vi.fn(async (_id: string, _payload: any) => ({})),
    deleteMessage: vi.fn(async (_id: string) => {}),
  }
}

/**
 * Guild text channel with the members BridgeRuntime posts through: webhooks,
 * bot sends, message fetch/edit/delete. `perms` are the bot's permissions.
 */
export function fakeTextChannel(
  client: FakeDiscordClient,
  guildId: string,
  channelId: string,
  opts: { perms?: bigint[]; premiumTier?: number; webhook?: ReturnType<typeof fakeWebhook> | null } = {},
) {
  const perms = opts.perms ?? [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ManageWebhooks,
    PermissionFlagsBits.AttachFiles,
  ]
  let n = 0
  const webhooks: any[] = opts.webhook === null ? [] : [opts.webhook ?? fakeWebhook()]
  const created: any[] = []
  const reactions: string[] = []
  const channel: any = {
    id: channelId,
    name: `ch-${channelId}`,
    type: 0,
    guildId,
    parentId: null,
    rawPosition: 0,
    client,
    guild: { id: guildId, premiumTier: opts.premiumTier ?? 0, emojis: { cache: new Collection<string, any>() } },
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: (flag: bigint) => perms.includes(flag) }),
    webhooks,
    created,
    reactions,
    fetchWebhooks: vi.fn(async () => new Collection(webhooks.map(w => [w.id, w]))),
    createWebhook: vi.fn(async () => {
      const w = fakeWebhook(`wh-new-${created.length + 1}`)
      created.push(w)
      webhooks.length = 0
      webhooks.push(w)
      return w
    }),
    send: vi.fn(async (_payload: any): Promise<any> => ({ id: `bot-msg-${++n}` })),
    messages: {
      fetch: vi.fn(async (id: string) => ({
        id,
        webhookId: null,
        author: { id: 'someone', bot: false, username: 'someone' },
        react: vi.fn(async (emoji: string) => { reactions.push(emoji) }),
        reactions: { cache: new Collection() },
      })),
      edit: vi.fn(async () => ({})),
      delete: vi.fn(async (_id: string) => {}),
    },
  }
  client.channels.cache.set(channelId, channel)
  return channel
}
