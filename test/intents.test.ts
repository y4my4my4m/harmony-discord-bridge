import { describe, expect, it } from 'vitest'
import { GatewayIntentBits } from 'discord.js'
import {
  APPLICATION_FLAGS,
  classifyDiscordClose,
  classifyLoginError,
  discordPreflight,
  grantsFromApplicationFlags,
  sameIntents,
  selectIntents,
} from '../src/runtime/discordConnection.js'

const ALL = { message_content: true, members: true, presence: true }

describe('selectIntents', () => {
  it('always requests Guilds, GuildMessages and MessageContent', () => {
    const sel = selectIntents({ syncMemberList: false, syncPresence: false }, ALL)
    expect(sel.intents).toContain(GatewayIntentBits.Guilds)
    expect(sel.intents).toContain(GatewayIntentBits.GuildMessages)
    expect(sel.intents).toContain(GatewayIntentBits.MessageContent)
    expect(sel.intents).not.toContain(GatewayIntentBits.GuildMembers)
    expect(sel.intents).not.toContain(GatewayIntentBits.GuildPresences)
    expect(sel.requested).toEqual(['message_content'])
    expect(sel.missing).toEqual([])
  })

  it('adds GuildMembers only with sync_member_list', () => {
    const sel = selectIntents({ syncMemberList: true, syncPresence: false }, ALL)
    expect(sel.intents).toContain(GatewayIntentBits.GuildMembers)
    expect(sel.intents).not.toContain(GatewayIntentBits.GuildPresences)
  })

  it('adds GuildPresences only with sync_presence (on top of the member list)', () => {
    const sel = selectIntents({ syncMemberList: true, syncPresence: true }, ALL)
    expect(sel.intents).toContain(GatewayIntentBits.GuildPresences)
    expect(selectIntents({ syncMemberList: false, syncPresence: true }, ALL).intents)
      .not.toContain(GatewayIntentBits.GuildPresences)
  })

  it('leaves out intents the application lacks and reports them missing', () => {
    const sel = selectIntents(
      { syncMemberList: true, syncPresence: true },
      { message_content: true, members: false, presence: false },
    )
    expect(sel.missing).toEqual(['members', 'presence'])
    expect(sel.intents).not.toContain(GatewayIntentBits.GuildMembers)
    expect(sel.intents).not.toContain(GatewayIntentBits.GuildPresences)
    expect(sel.active).toEqual({ message_content: true, members: false, presence: false })
  })

  it('reports a missing Message Content intent but still connects', () => {
    const sel = selectIntents({ syncMemberList: false, syncPresence: false }, { message_content: false, members: false, presence: false })
    expect(sel.missing).toEqual(['message_content'])
    expect(sel.intents).not.toContain(GatewayIntentBits.MessageContent)
    expect(sel.intents).toContain(GatewayIntentBits.Guilds)
  })

  it('attempts everything requested when grants are unknown', () => {
    const sel = selectIntents({ syncMemberList: true, syncPresence: true }, null)
    expect(sel.missing).toEqual([])
    expect(sel.active).toEqual(ALL)
  })

  it('compares intent sets by bits', () => {
    expect(sameIntents([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], [GatewayIntentBits.GuildMembers, GatewayIntentBits.Guilds])).toBe(true)
    expect(sameIntents([GatewayIntentBits.Guilds], [GatewayIntentBits.GuildMembers])).toBe(false)
  })
})

describe('application flags', () => {
  it('reads full and limited intent toggles', () => {
    expect(grantsFromApplicationFlags(0)).toEqual({ message_content: false, members: false, presence: false })
    expect(grantsFromApplicationFlags(APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS))
      .toEqual({ message_content: true, members: true, presence: false })
    expect(grantsFromApplicationFlags(APPLICATION_FLAGS.GATEWAY_PRESENCE_LIMITED).presence).toBe(true)
  })
})

describe('failure classification', () => {
  it('maps unrecoverable gateway close codes', () => {
    expect(classifyDiscordClose(4004)).toBe('token_invalid')
    expect(classifyDiscordClose(4014)).toBe('intents_disallowed')
    expect(classifyDiscordClose(4013)).toBe('intents_invalid')
    expect(classifyDiscordClose(1006)).toBeNull()
  })

  it('maps discord.js login errors', () => {
    expect(classifyLoginError(Object.assign(new Error('An invalid token was provided.'), { code: 'TokenInvalid' }))).toBe('token_invalid')
    expect(classifyLoginError(new Error('Used disallowed intents'))).toBe('intents_disallowed')
    expect(classifyLoginError(new Error('getaddrinfo ENOTFOUND discord.com'))).toBe('unreachable')
  })
})

describe('discordPreflight', () => {
  it('reports an invalid token on 401', async () => {
    const fetchImpl = async () => new Response('{"message":"401: Unauthorized"}', { status: 401 })
    expect(await discordPreflight('bad', fetchImpl)).toEqual({ kind: 'token_invalid' })
  })

  it('reads application id, bot user and grants', async () => {
    let auth = ''
    const fetchImpl = async (_url: string | URL, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).Authorization
      return Response.json({
        id: '111',
        name: 'Bridge',
        flags: APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT,
        bot: { id: '111', username: 'bridge-bot', avatar: null },
      })
    }
    const result = await discordPreflight('tok', fetchImpl)
    expect(auth).toBe('Bot tok')
    expect(result).toMatchObject({
      kind: 'ok',
      applicationId: '111',
      grants: { message_content: true, members: false, presence: false },
      botUser: { id: '111', name: 'bridge-bot' },
    })
  })

  it('reports Discord unreachable on network failure', async () => {
    const fetchImpl = async () => { throw new TypeError('fetch failed') }
    const result = await discordPreflight('tok', fetchImpl)
    expect(result.kind).toBe('unreachable')
  }, 15_000)
})
