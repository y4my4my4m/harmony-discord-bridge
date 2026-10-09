import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionSync } from '../src/PermissionSync.js'
import { PermissionSyncStore } from '../src/PermissionSyncStore.js'
import { HarmonyHttpError } from '../src/HarmonyClient.js'
import { roleSyncSummary } from '../src/runtime/commands.js'
import { silentLogger } from '../src/log.js'

const SERVER = 'server-1'
const GUILD = 'guild-1'

function discordRole(id: string, name: string, position: number, bitfield = 0n) {
  return { id, name, position, color: 0x3498db, mentionable: false, hoist: false, managed: false, permissions: { bitfield } }
}

function guildWith(roles: ReturnType<typeof discordRole>[]) {
  const all = [discordRole(GUILD, '@everyone', 0), ...roles]
  return { id: GUILD, name: 'SSS', roles: { cache: new Map(all.map(r => [r.id, r])) } } as any
}

/** bot-gateway's role routes over an in-memory role list; `refuse` decides each write's 403. */
function fakeHarmony(refuse: (op: string, body: any) => HarmonyHttpError | null = () => null) {
  const roles: any[] = [
    { id: 'everyone', name: 'everyone', position: 0, is_default: true },
    { id: 'admin', name: 'Admin', position: 999, is_admin: true },
  ]
  const writes: Array<{ op: string; body: any }> = []
  let next = 1
  return {
    roles,
    writes,
    async getServerRoles() { return roles.map(r => ({ ...r })) },
    async createRole(_server: string, body: any) {
      writes.push({ op: 'create', body })
      const err = refuse('create', body)
      if (err) throw err
      const role = { id: `h${next++}`, ...body }
      roles.push(role)
      return role
    },
    async updateRole(_server: string, id: string, body: any) {
      writes.push({ op: 'update', body: { id, ...body } })
      const err = refuse('update', body)
      if (err) throw err
      if (!roles.some(r => r.id === id)) throw new HarmonyHttpError('Role not found', 404)
      return { id, ...body }
    },
  }
}

function sync(harmony: ReturnType<typeof fakeHarmony>, store = new PermissionSyncStore(join(mkdtempSync(join(tmpdir(), 'perm-')), 's.yml'))) {
  const mapper = {
    getBridgeForDiscordGuild: () => ({ harmonyServerId: SERVER }),
    isConfiguredDiscordGuild: () => true,
    runtimeSettings: () => ({ syncPermissions: true }),
  }
  return { ps: new PermissionSync(harmony as any, mapper as any, store, silentLogger), store }
}

describe('role sync', () => {
  it('reports roles Harmony refuses instead of claiming them created', async () => {
    const harmony = fakeHarmony(() => new HarmonyHttpError('Missing permission: manage_roles', 403))
    const { ps } = sync(harmony)
    const report = await ps.reconcileRoles(guildWith([discordRole('d1', 'CS2', 2), discordRole('d2', 'SSS', 3)]))

    expect(report).toMatchObject({ created: 0, updated: 0 })
    expect(report.failed.map(f => f.name)).toEqual(['CS2', 'SSS'])
    const reply = roleSyncSummary('SSS', report, 29).join('\n')
    expect(reply).toContain('0 created, 0 updated, 2 refused')
    expect(reply).toContain('lacks manage_roles')
  })

  it('creates a role without the permission bits the bot cannot grant', async () => {
    const harmony = fakeHarmony((op, body) =>
      op === 'create' && body.permissions !== '0'
        ? new HarmonyHttpError('Cannot grant permissions the bot does not hold', 403, null, { missing_permissions: body.permissions })
        : null)
    const { ps, store } = sync(harmony)
    const report = await ps.reconcileRoles(guildWith([discordRole('d1', 'Mods', 4, 1n << 1n)]))

    expect(report.created).toBe(1)
    expect(report.adjusted).toEqual([{ name: 'Mods', notes: ['permissions the bridge bot cannot grant were left off'] }])
    expect(harmony.writes.at(-1)!.body.permissions).toBe('0')
    expect(store.getHarmonyRoleId('d1')).toBe('h1')
  })

  it('places a role at the cap when its Discord position is above it', async () => {
    const harmony = fakeHarmony((op, body) =>
      op === 'create' && body.position > 3
        ? new HarmonyHttpError('Role position must be below the bot\'s highest manageable position', 403, null, { max_position: 3 })
        : null)
    const { ps } = sync(harmony)
    const report = await ps.reconcileRoles(guildWith([discordRole('d1', 'Three', 12)]))

    expect(report.created).toBe(1)
    expect(harmony.writes.at(-1)!.body.position).toBe(3)
    expect(report.adjusted[0].notes[0]).toContain('position 3')
  })

  it('recreates a role whose stored mapping points at a deleted Harmony role', async () => {
    const harmony = fakeHarmony()
    const { ps, store } = sync(harmony)
    store.setMapping('d1', 'deleted-role', 'Minecraft')
    const report = await ps.reconcileRoles(guildWith([discordRole('d1', 'Minecraft', 2)]))

    expect(report).toMatchObject({ created: 1, updated: 0, failed: [] })
    expect(store.getHarmonyRoleId('d1')).toBe('h1')
    expect(harmony.roles.some(r => r.name === 'Minecraft')).toBe(true)
  })

  it('links a same-named Harmony role and updates it', async () => {
    const harmony = fakeHarmony()
    harmony.roles.push({ id: 'friends', name: 'Friends', position: 5 })
    const { ps, store } = sync(harmony)
    const report = await ps.reconcileRoles(guildWith([discordRole('d1', 'Friends', 2)]))

    expect(report).toMatchObject({ created: 0, updated: 1 })
    expect(store.getHarmonyRoleId('d1')).toBe('friends')
  })
})
