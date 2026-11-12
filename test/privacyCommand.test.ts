import { describe, expect, it, vi } from 'vitest'
import { MessageFlags } from 'discord.js'
import { buildCommands, handleInteraction, NO_FEATURES } from '../src/runtime/commands.js'
import { BridgeApiError, type OptOutState } from '../src/v2/BridgeApi.js'
import { OptOutList } from '../src/runtime/optOuts.js'

const IN: OptOutState = { opted_out: false, since: null, source: null }
const SELF: OptOutState = { opted_out: true, since: '2026-11-01T00:00:00Z', source: 'self' }
const MANAGER: OptOutState = { opted_out: true, since: '2026-11-02T00:00:00Z', source: 'manager' }
const ADMIN: OptOutState = { opted_out: true, since: null, source: 'admin' }

function setup(sub: string, opts: { bridged?: boolean; api?: boolean; confirm?: 'confirm' | 'cancel' | 'timeout'; optedOut?: string[] } = {}) {
  const api = {
    getOptOut: vi.fn(async (_id: string): Promise<OptOutState> => IN),
    putOptOut: vi.fn(async (_id: string, _username?: string): Promise<OptOutState> => SELF),
    deleteOptOut: vi.fn(async (_id: string): Promise<OptOutState> => IN),
    erase: vi.fn(async (_id: string) => ({ erased: 12, more: false })),
  }
  const optOuts = new OptOutList()
  for (const id of opts.optedOut ?? []) optOuts.add(id)
  const rt: any = {
    mode: 'v2',
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    dir: { getBridgeForDiscordGuild: () => (opts.bridged === false ? undefined : { harmonyServerId: 's' }) },
    hooks: opts.api === false ? {} : { privacyApi: api },
    optOuts,
  }
  const message = {
    awaitMessageComponent: vi.fn(async () => {
      if (opts.confirm === 'timeout') throw new Error('time')
      return { customId: `${opts.confirm ?? 'confirm'}:i1`, user: { id: 'u1' }, update: vi.fn(async () => {}) }
    }),
  }
  const interaction: any = {
    id: 'i1',
    user: { id: 'u1', username: 'dana' },
    // No Administrator, no roles: any member may run it.
    member: { permissions: { has: () => false } },
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    commandName: 'bridge-privacy',
    guild: { id: 'g' },
    guildId: 'g',
    options: { getSubcommand: () => sub },
    reply: vi.fn(async (_arg: any) => {}),
    deferReply: vi.fn(async (_arg: any) => {}),
    editReply: vi.fn(async (_arg: any) => message),
    followUp: vi.fn(async (_arg: any) => {}),
  }
  const last = () => interaction.editReply.mock.calls.at(-1)![0].content as string
  return { rt, api, interaction, optOuts, message, last }
}

describe('/bridge-privacy registration', () => {
  const privacy = (features = { ...NO_FEATURES, privacy: true }) => buildCommands('v2', features).find(c => c.name === 'bridge-privacy') as any

  it('is a top-level command for every member, with four subcommands and no options', () => {
    const command = privacy()
    expect(command).toBeTruthy()
    expect(command.default_member_permissions ?? null).toBeNull()
    expect(command.options.map((o: any) => o.name)).toEqual(['opt-out', 'opt-in', 'status', 'erase'])
    // No subcommand takes a user: a member can only act on their own account.
    for (const sub of command.options) expect(sub.options ?? []).toEqual([])
  })

  it('is registered only with the gateway capability, and never for a v1 bridge', () => {
    expect(privacy(NO_FEATURES)).toBeUndefined()
    expect(buildCommands('v1', { ...NO_FEATURES, privacy: true }).find(c => c.name === 'bridge-privacy')).toBeUndefined()
  })
})

describe('/bridge-privacy', () => {
  it('opt-out records the caller, answers only them, and stops their relay at once', async () => {
    const t = setup('opt-out')
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.putOptOut).toHaveBeenCalledWith('u1', 'dana')
    expect(t.interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral })
    expect(t.optOuts.has('u1')).toBe(true)
    expect(t.last()).toContain('You are opted out')
    expect(t.last()).toContain('`/bridge-privacy erase`')
    expect(t.rt.log.info).toHaveBeenCalledWith('/bridge-privacy opt-out by u1 in guild g')
  })

  it('opt-in lets the caller through again', async () => {
    const t = setup('opt-in', { optedOut: ['u1'] })
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.deleteOptOut).toHaveBeenCalledWith('u1')
    expect(t.optOuts.has('u1')).toBe(false)
    expect(t.last()).toContain('You are opted in')
  })

  it('opt-in does not claim success when a manager removed the caller', async () => {
    const t = setup('opt-in', { optedOut: ['u1'] })
    t.api.deleteOptOut.mockResolvedValue(MANAGER)
    await handleInteraction(t.rt, t.interaction)
    expect(t.last()).not.toContain('opted in')
    expect(t.last()).toContain('A server manager removed you from the Harmony bridge')
    expect(t.last()).toContain('Only a server manager can restore you: in Harmony, Server settings → Discord Bridge.')
    expect(t.optOuts.has('u1')).toBe(true)
  })

  it.each([
    ['in', IN, 'Your messages in this server go to Harmony'],
    ['out by themselves', SELF, 'You are opted out since <t:1793491200:D>'],
    ['removed by a manager', MANAGER, 'A server manager removed you from the Harmony bridge'],
    ['removed by an instance admin', ADMIN, 'A Harmony instance admin removed you from the Harmony bridge'],
  ])('status says where a caller who is %s stands', async (_name, state, sentence) => {
    const t = setup('status')
    t.api.getOptOut.mockResolvedValue(state)
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.getOptOut).toHaveBeenCalledWith('u1')
    expect(t.last()).toContain(sentence)
    expect(t.optOuts.has('u1')).toBe(state.opted_out)
    if (state.source === 'manager' || state.source === 'admin') expect(t.last()).toContain('Only a server manager can restore you')
  })

  it('erase asks first, saying what is deleted and that it cannot be undone', async () => {
    const t = setup('erase', { confirm: 'cancel' })
    await handleInteraction(t.rt, t.interaction)
    const prompt = t.interaction.editReply.mock.calls[0][0]
    expect(prompt.content).toContain('deletes your bridged and imported messages on Harmony for this server')
    expect(prompt.content).toContain('opts you out of the bridge')
    expect(prompt.content).toContain('cannot be undone')
    expect(prompt.components).toHaveLength(1)
    expect(t.api.erase).not.toHaveBeenCalled()
    expect(t.optOuts.has('u1')).toBe(false)
  })

  it('erase does nothing when the question goes unanswered', async () => {
    const t = setup('erase', { confirm: 'timeout' })
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.erase).not.toHaveBeenCalled()
  })

  it('erase deletes after Confirm, opts the caller out and reports the count', async () => {
    const t = setup('erase')
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.erase).toHaveBeenCalledWith('u1')
    expect(t.optOuts.has('u1')).toBe(true)
    expect(t.last()).toContain('Deleted 12 of your messages on Harmony.')
    expect(t.last()).toContain('You are opted out')
  })

  it('erase says when Harmony finishes in the background', async () => {
    const t = setup('erase')
    t.api.erase.mockResolvedValue({ erased: 500, more: true })
    await handleInteraction(t.rt, t.interaction)
    expect(t.last()).toContain('Deleted 500 of your messages on Harmony; the rest are being deleted in the background')
  })

  it('erase within a minute of the last one says how long to wait, and asks Harmony once', async () => {
    const t = setup('erase')
    t.api.erase.mockRejectedValue(new BridgeApiError('POST failed (429 erase_recent)', 429, 'erase_recent', { retry_after: 41 }, 41_000))
    await handleInteraction(t.rt, t.interaction)
    expect(t.api.erase).toHaveBeenCalledTimes(1)
    expect(t.last()).toContain('Try again in 41 seconds')
    expect(t.rt.log.error).not.toHaveBeenCalled()
  })

  it('reports a failure to the caller and leaves the list as it was', async () => {
    const t = setup('opt-out')
    t.api.putOptOut.mockRejectedValue(new BridgeApiError('PUT failed (503)', 503))
    await handleInteraction(t.rt, t.interaction)
    expect(t.last()).toContain('`/bridge-privacy opt-out` failed')
    expect(t.optOuts.has('u1')).toBe(false)
  })

  it.each([
    ['a server that is not bridged', { bridged: false }],
    ['a bridge without the privacy routes', { api: false }],
  ])('answers %s without calling Harmony', async (_name, over) => {
    const t = setup('opt-out', over)
    await handleInteraction(t.rt, t.interaction)
    expect(t.interaction.reply.mock.calls[0][0]).toMatchObject({ content: '❌ This server is not bridged to Harmony.', flags: MessageFlags.Ephemeral })
    expect(t.api.putOptOut).not.toHaveBeenCalled()
  })
})
