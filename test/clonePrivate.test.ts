import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChannelType, OverwriteType, PermissionFlagsBits } from 'discord.js'
import { PermissionSync } from '../src/PermissionSync.js'
import { PermissionSyncStore } from '../src/PermissionSyncStore.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'
import { handleInteraction } from '../src/runtime/commands.js'
import { silentLogger } from '../src/log.js'

const SERVER = 'server-1'
const GUILD = 'guild-1'
const VIEW = 1n << 1n // Harmony VIEW_CHANNEL
const BOT_BASE = ((1n << 30n) - 1n) & ~1n // every role bit but ADMINISTRATOR

type Op = { op: string; channel?: string; role?: string; allow?: bigint; deny?: bigint; pairs?: string[] }

/**
 * bot-gateway's channel, role and override routes in memory. An override write is refused when
 * it grants a bit outside the bot's channel mask: BOT_BASE less @everyone's deny, plus its allow
 * (botChannelMask). `refuse` adds 403s of its own.
 */
function fakeHarmony(refuse: (op: Op) => boolean = () => false) {
  const roles: any[] = [
    { id: 'everyone', name: 'everyone', position: 0, is_default: true },
    { id: 'admin', name: 'Admin', position: 999, is_admin: true },
  ]
  const overrides = new Map<string, Array<{ role_id: string; allow: bigint; deny: bigint }>>()
  const ops: Op[] = []
  let next = 1
  const rowsOf = (channel: string) => overrides.get(channel) ?? []
  const botMask = (channel: string) => {
    const everyone = rowsOf(channel).find(r => r.role_id === 'everyone')
    return (BOT_BASE & ~(everyone?.deny ?? 0n)) | (everyone?.allow ?? 0n)
  }
  return {
    ops,
    overrides: (channel: string) => rowsOf(channel),
    async getServerRoles() { return roles.map(r => ({ ...r })) },
    async createRole(_server: string, body: any) {
      const role = { id: `h${next++}`, ...body }
      roles.push(role)
      return role
    },
    async updateRole(_server: string, id: string, body: any) { return { id, ...body } },
    async getServerCategories() { return [] },
    async getServerChannels() { return [] },
    async createCategory(_server: string, name: string) { return { id: `cat-${name}` } },
    async updateCategory() { return {} },
    async createChannel(_server: string, opts: any) { return { id: `hc-${opts.name}` } },
    async updateChannel() { return {} },
    async getChannelPermissionOverrides(channel: string) {
      return rowsOf(channel).map(r => ({
        target_type: 'role',
        role_id: r.role_id,
        allow_permissions: r.allow.toString(),
        deny_permissions: r.deny.toString(),
      }))
    },
    async upsertChannelPermissionOverride(channel: string, body: any) {
      const op: Op = { op: 'override', channel, role: body.role_id, allow: BigInt(body.allow_permissions), deny: BigInt(body.deny_permissions) }
      ops.push(op)
      const rows = rowsOf(channel)
      const before = rows.find(r => r.role_id === body.role_id)
      const grants = (op.allow! & ~(before?.allow ?? 0n)) | ((before?.deny ?? 0n) & ~op.deny!)
      const missing = grants & ~botMask(channel)
      if (missing !== 0n || refuse(op)) {
        throw new HarmonyHttpError('Cannot grant permissions the bot does not hold in this channel', 403, null, { missing_permissions: missing.toString() })
      }
      overrides.set(channel, [...rows.filter(r => r !== before), { role_id: body.role_id, allow: op.allow!, deny: op.deny! }])
      return {}
    },
    async deleteChannelPermissionOverrideForRole(channel: string, role: string) {
      ops.push({ op: 'delete-override', channel, role })
      overrides.set(channel, rowsOf(channel).filter(r => r.role_id !== role))
    },
  }
}

function overwrite(id: string, allow = 0n, deny = 0n) {
  return { id, type: OverwriteType.Role, allow: { bitfield: allow }, deny: { bitfield: deny } }
}

/** A guild with a Mods role; each channel lists its overwrites in Discord cache order. */
function discordGuild(channels: Array<{ id: string; name: string; overwrites: ReturnType<typeof overwrite>[] }>) {
  const guild: any = { id: GUILD, name: 'SSS' }
  const roles = [
    { id: GUILD, name: '@everyone', position: 0 },
    { id: 'mods', name: 'Mods', position: 1 },
  ].map(r => ({ ...r, color: 0, mentionable: false, hoist: false, managed: false, permissions: { bitfield: 0n }, guild }))
  const cache = new Map<string, any>(channels.map((c, i) => [c.id, {
    id: c.id,
    name: c.name,
    type: ChannelType.GuildText,
    position: i,
    parentId: null,
    guild,
    guildId: GUILD,
    permissionOverwrites: { cache: new Map(c.overwrites.map(o => [o.id, o])) },
  }]))
  guild.roles = { cache: new Map(roles.map(r => [r.id, r])), fetch: async () => guild.roles.cache }
  guild.channels = { cache, fetch: async (id?: string) => id === undefined ? cache : cache.get(id) ?? null }
  return guild
}

async function runBridge(
  sub: string,
  guild: any,
  harmony: ReturnType<typeof fakeHarmony>,
  options: Record<string, boolean> = {},
  pairs: Array<{ discord: string; harmony: string; bidirectional: boolean }> = [],
) {
  const dir = {
    getBridgeForDiscordGuild: () => ({ harmonyServerId: SERVER }),
    isConfiguredDiscordGuild: () => true,
    runtimeSettings: () => ({ syncPermissions: false }),
    getAllMappings: () => [...pairs],
    getHarmonyChannel: (id: string) => pairs.find(p => p.discord === id)?.harmony ?? null,
  }
  const store = new PermissionSyncStore(join(mkdtempSync(join(tmpdir(), 'clone-')), 's.yml'))
  const rt: any = {
    mode: 'v2',
    dir,
    harmony,
    log: silentLogger,
    hooks: {},
    settings: () => ({ cloneRoles: false }),
    permissionSync: new PermissionSync(harmony as any, dir as any, store, silentLogger),
    writer: {
      async linkMany(_guild: string, added: Array<{ discord: string; harmony: string }>) {
        harmony.ops.push({ op: 'link', pairs: added.map(p => p.discord) })
        pairs.push(...added.map(p => ({ discord: p.discord, harmony: p.harmony, bidirectional: true })))
        return added
      },
    },
  }
  const replies: string[] = []
  const reply = async ({ content }: { content: string }) => { replies.push(content) }
  await handleInteraction(rt, {
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    commandName: 'bridge',
    guild,
    member: { permissions: PermissionFlagsBits.Administrator.toString() },
    options: {
      getSubcommand: () => sub,
      getBoolean: (name: string) => options[name] ?? null,
    },
    deferReply: async () => {},
    editReply: reply,
    reply,
    followUp: reply,
  } as any)
  return { reply: replies.join('\n'), linked: pairs.map(p => p.discord) }
}

const cloneServer = (guild: any, harmony: ReturnType<typeof fakeHarmony>, options: Record<string, boolean> = {}) =>
  runBridge('clone-server', guild, harmony, options)

const PRIVATE = overwrite(GUILD, 0n, PermissionFlagsBits.ViewChannel)

describe('/bridge clone-server on private channels', () => {
  it('hides a channel @everyone cannot view on Discord before pairing it', async () => {
    const harmony = fakeHarmony()
    const guild = discordGuild([
      { id: 'd-secret', name: 'secret', overwrites: [PRIVATE] },
      { id: 'd-lobby', name: 'lobby', overwrites: [] },
    ])
    const { reply, linked } = await cloneServer(guild, harmony)

    expect(harmony.overrides('hc-secret')).toEqual([{ role_id: 'everyone', allow: 0n, deny: VIEW }])
    expect(harmony.overrides('hc-lobby')).toEqual([])
    const hide = harmony.ops.findIndex(o => o.op === 'override' && o.channel === 'hc-secret')
    const link = harmony.ops.findIndex(o => o.op === 'link')
    expect(hide).toBeGreaterThanOrEqual(0)
    expect(hide).toBeLessThan(link)
    expect(linked).toEqual(['d-secret', 'd-lobby'])
    expect(reply).toContain('Private channels hidden from @everyone: 1')
  })

  it('writes role allows before the @everyone deny with clone_roles', async () => {
    const harmony = fakeHarmony()
    const guild = discordGuild([
      { id: 'd-secret', name: 'secret', overwrites: [PRIVATE, overwrite('mods', PermissionFlagsBits.ViewChannel)] },
    ])
    const { reply, linked } = await cloneServer(guild, harmony, { clone_roles: true })

    const writes = harmony.ops.filter(o => o.op === 'override' && o.channel === 'hc-secret')
    const modsRole = writes[0].role
    expect(writes.slice(0, 2)).toEqual([
      { op: 'override', channel: 'hc-secret', role: modsRole, allow: VIEW, deny: 0n },
      { op: 'override', channel: 'hc-secret', role: 'everyone', allow: 0n, deny: VIEW },
    ])
    expect(modsRole).not.toBe('everyone')
    expect(harmony.ops.findIndex(o => o.op === 'link')).toBeGreaterThan(harmony.ops.indexOf(writes[1]))
    expect(linked).toEqual(['d-secret'])
    expect(reply).not.toContain('failure')
  })

  it('syncs a role allow on a channel whose @everyone overwrite comes first in Discord order', async () => {
    const harmony = fakeHarmony()
    const guild = discordGuild([
      { id: 'd-secret', name: 'secret', overwrites: [PRIVATE, overwrite('mods', PermissionFlagsBits.ViewChannel)] },
    ])
    const store = new PermissionSyncStore(join(mkdtempSync(join(tmpdir(), 'clone-')), 's.yml'))
    store.setDefaultHarmonyRoleId('everyone')
    store.setMapping('mods', 'h-mods', 'Mods')
    const dir = { getBridgeForDiscordGuild: () => ({ harmonyServerId: SERVER }) }
    const ps = new PermissionSync(harmony as any, dir as any, store, silentLogger)
    await ps.syncChannelOverwrites(guild.channels.cache.get('d-secret'), 'hc-secret')

    expect(harmony.overrides('hc-secret')).toEqual([
      { role_id: 'h-mods', allow: VIEW, deny: 0n },
      { role_id: 'everyone', allow: 0n, deny: VIEW },
    ])
  })

  it('hides an already paired private channel on /bridge sync-perms with permission sync off', async () => {
    const harmony = fakeHarmony()
    const guild = discordGuild([
      { id: 'd-secret', name: 'secret', overwrites: [PRIVATE, overwrite('mods', PermissionFlagsBits.ViewChannel)] },
    ])
    await runBridge('sync-perms', guild, harmony, {}, [{ discord: 'd-secret', harmony: 'hc-secret', bidirectional: true }])

    const [mods, everyone] = harmony.overrides('hc-secret')
    expect(mods).toMatchObject({ allow: VIEW, deny: 0n })
    expect(everyone).toEqual({ role_id: 'everyone', allow: 0n, deny: VIEW })
  })

  it('leaves a private channel unpaired when hiding it fails', async () => {
    const harmony = fakeHarmony(op => op.role === 'everyone')
    const guild = discordGuild([
      { id: 'd-secret', name: 'secret', overwrites: [PRIVATE] },
      { id: 'd-lobby', name: 'lobby', overwrites: [] },
    ])
    const { reply, linked } = await cloneServer(guild, harmony)

    expect(linked).toEqual(['d-lobby'])
    expect(reply).toContain('`#secret`: left unbridged')
  })
})
