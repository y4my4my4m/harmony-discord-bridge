import { describe, expect, it } from 'vitest'
import { PermissionFlagsBits } from 'discord.js'
import { collectGuildViews, buildStatusPayload } from '../src/v2/selfCheck.js'
import {
  describeProblem,
  detectProblems,
  problemKey,
  type DetectInput,
  type PairView,
  type ProblemCode,
} from '../src/problems.js'

/** Minimal discord.js-shaped guild for collectGuildViews. */
function fakeGuild(id: string, channels: Array<{ id: string; name: string; type?: number; perms: bigint[]; parentId?: string }>) {
  const me = { id: 'bot' }
  return {
    id,
    name: `guild-${id}`,
    iconURL: () => `https://cdn.discordapp.com/icons/${id}/x.png`,
    members: { me },
    channels: {
      cache: new Map(channels.map((c, i) => [c.id, {
        id: c.id,
        name: c.name,
        type: c.type ?? 0,
        parentId: c.parentId ?? null,
        rawPosition: i,
        isThread: () => false,
        permissionsFor: (member: unknown) => member === me
          ? { has: (flag: bigint) => c.perms.includes(flag) }
          : null,
      }])),
    },
  }
}

function fakeClient(guilds: ReturnType<typeof fakeGuild>[]) {
  return { guilds: { cache: new Map(guilds.map(g => [g.id, g])) } }
}

const { ViewChannel, SendMessages, ManageWebhooks } = PermissionFlagsBits

describe('collectGuildViews', () => {
  it('reads per-channel permissions of the bot', () => {
    const client = fakeClient([fakeGuild('g1', [
      { id: 'c-ok', name: 'general', perms: [ViewChannel, SendMessages, ManageWebhooks] },
      { id: 'c-ro', name: 'announcements', perms: [ViewChannel] },
      { id: 'c-hidden', name: 'staff', perms: [] },
      { id: 'thread', name: 'thread', type: 11, perms: [ViewChannel] },
    ])])
    const [guild] = collectGuildViews(client)
    expect(guild.id).toBe('g1')
    expect(guild.icon).toContain('g1')
    expect(guild.channels.map(c => c.id)).toEqual(['c-ok', 'c-ro', 'c-hidden'])
    expect(guild.channels[0]).toMatchObject({ can_view: true, can_send: true, can_manage_webhooks: true })
    expect(guild.channels[1]).toMatchObject({ can_view: true, can_send: false, can_manage_webhooks: false })
    expect(guild.channels[2]).toMatchObject({ can_view: false, can_send: false, can_manage_webhooks: false })
  })
})

const codes = (input: DetectInput) => detectProblems(input).map(problemKey)

describe('detectProblems', () => {
  const baseConfig = {
    discord_guild_id: 'g1',
    pairs: [] as PairView[],
    harmony_channels: [] as { id: string; encrypted?: boolean }[],
  }

  it('reports no_guild when the bot is in no guild', () => {
    expect(codes({ connection: [], guilds: [], config: { ...baseConfig, discord_guild_id: null } })).toEqual(['no_guild'])
  })

  it('reports guild_not_selected with several guilds and none chosen', () => {
    const guilds = collectGuildViews(fakeClient([fakeGuild('g1', []), fakeGuild('g2', [])]))
    expect(codes({ connection: [], guilds, config: { ...baseConfig, discord_guild_id: null } })).toEqual(['guild_not_selected'])
    // One guild: the gateway selects it on the next status.
    expect(codes({ connection: [], guilds: guilds.slice(0, 1), config: { ...baseConfig, discord_guild_id: null } })).toEqual([])
  })

  it('reports bot_not_in_guild for a chosen guild the bot left', () => {
    const guilds = collectGuildViews(fakeClient([fakeGuild('g2', [])]))
    expect(codes({ connection: [], guilds, config: baseConfig })).toEqual(['bot_not_in_guild:guild_id=g1'])
  })

  it('checks each pair against channel permissions', () => {
    const guilds = collectGuildViews(fakeClient([fakeGuild('g1', [
      { id: 'ok', name: 'ok', perms: [ViewChannel, SendMessages, ManageWebhooks] },
      { id: 'nosend', name: 'nosend', perms: [ViewChannel, ManageWebhooks] },
      { id: 'nohook', name: 'nohook', perms: [ViewChannel, SendMessages] },
      { id: 'hidden', name: 'hidden', perms: [] },
      { id: 'inbound', name: 'inbound', perms: [ViewChannel] },
    ])]))
    const pair = (discord: string, direction: 'both' | 'to_harmony' | 'to_discord' = 'both') =>
      ({ discord_channel_id: discord, harmony_channel_id: `h-${discord}`, direction })
    const config = {
      discord_guild_id: 'g1',
      pairs: [pair('ok'), pair('nosend'), pair('nohook'), pair('hidden'), pair('gone'), pair('inbound', 'to_harmony')],
      harmony_channels: ['ok', 'nosend', 'nohook', 'hidden', 'gone', 'inbound'].map(d => ({ id: `h-${d}` })),
    }
    expect(codes({ connection: [], guilds, config })).toEqual([
      'cannot_send:discord_channel_id=nosend',
      'cannot_manage_webhooks:discord_channel_id=nohook',
      'channel_not_visible:discord_channel_id=hidden',
      'channel_not_visible:discord_channel_id=gone',
    ])
  })

  it('reports missing and encrypted Harmony channels', () => {
    const config = {
      discord_guild_id: 'g1',
      pairs: [
        { discord_channel_id: 'a', harmony_channel_id: 'h-missing', direction: 'both' as const },
        { discord_channel_id: 'b', harmony_channel_id: 'h-e2ee', direction: 'both' as const },
      ],
      harmony_channels: [{ id: 'h-e2ee', encrypted: true }],
    }
    expect(codes({ connection: [], guilds: null, config })).toEqual([
      'harmony_channel_missing:harmony_channel_id=h-missing',
      'harmony_channel_encrypted:harmony_channel_id=h-e2ee',
    ])
  })

  it('keeps connection problems and skips guild checks while Discord is down', () => {
    const result = codes({
      connection: [
        { code: 'intent_missing', params: { intent: 'members' } },
        { code: 'intent_missing', params: { intent: 'members' } },
        { code: 'harmony_auth_failed' },
      ],
      guilds: null,
      config: baseConfig,
    })
    expect(result).toEqual(['intent_missing:intent=members', 'harmony_auth_failed'])
  })
})

describe('describeProblem', () => {
  it('has plain-language text for every code', () => {
    const all: ProblemCode[] = [
      'discord_token_invalid', 'intent_missing', 'bot_not_in_guild', 'no_guild', 'guild_not_selected',
      'channel_not_visible', 'cannot_send', 'cannot_manage_webhooks', 'harmony_auth_failed',
      'harmony_channel_missing', 'harmony_channel_encrypted', 'rate_limited', 'discord_unreachable',
      'harmony_unreachable',
    ]
    for (const code of all) {
      const { summary, fix } = describeProblem({ code, params: { intent: 'presence', discord_channel_id: '1' } })
      expect(summary.length).toBeGreaterThan(10)
      expect(fix.length).toBeGreaterThan(10)
    }
    expect(describeProblem({ code: 'intent_missing', params: { intent: 'members' } }).summary).toContain('Server Members Intent')
  })
})

describe('buildStatusPayload', () => {
  it('matches the POST /bridge/v2/status shape', () => {
    const payload = buildStatusPayload({
      version: '2.0.0',
      discordConnected: true,
      applicationId: '111',
      botUser: { id: '111', name: 'bot', avatar: null },
      intents: { message_content: true, members: false, presence: false },
      guilds: null,
      harmonyConnected: false,
      problems: [{ code: 'no_guild' }],
    })
    expect(payload).toEqual({
      version: '2.0.0',
      discord: {
        connected: true,
        application_id: '111',
        bot_user: { id: '111', name: 'bot', avatar: null },
        intents: { message_content: true, members: false, presence: false },
      },
      guilds: [],
      harmony: { connected: false },
      problems: [{ code: 'no_guild' }],
    })
  })
})
