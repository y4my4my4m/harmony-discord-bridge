import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BridgeRuntime, type RuntimeHooks } from '../src/runtime/BridgeRuntime.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { APPLICATION_FLAGS } from '../src/runtime/discordConnection.js'
import { silentLogger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'
import { FakeDiscordClient, appResponse } from './fakeDiscord.js'

const ALL = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS | APPLICATION_FLAGS.GATEWAY_PRESENCE
const writer: PairWriter = { link: async () => {}, linkMany: async () => [], unlink: async () => false }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-commands-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** A runtime whose Discord client is ready. `me`: the body GET /users/@me answers, or null for a 503. */
async function setup(opts: { me?: Record<string, unknown> | null; hooks?: RuntimeHooks } = {}) {
  const clients: FakeDiscordClient[] = []
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.endsWith('/applications/@me')) return appResponse(ALL)()
    if (u.endsWith('/users/@me')) return opts.me ? Response.json(opts.me) : new Response('down', { status: 503 })
    if (u.includes('/members')) return Response.json([])
    return new Response('not found', { status: 404 })
  })
  const runtime = new BridgeRuntime({
    mode: 'v2',
    directory: new V2Directory({
      bridge_id: 'b', server_id: 's', mode: 'self', discord_guild_id: 'g1',
      settings: { sync_member_list: false }, pairs: [], harmony_channels: [],
    }),
    writer,
    discordToken: 'dtok',
    harmony: { token: 'htok', gatewayUrl: 'ws://127.0.0.1:9/gateway', apiUrl: 'http://127.0.0.1:9', baseUrl: 'https://h.example' },
    permissionStorePath: join(dir, 'permission-sync.yml'),
    log: silentLogger,
    fetchImpl,
    media: { maxUploadBytes: 8 * 1024 * 1024, mediaOrigin: null },
    appEmojiDir: null,
    hooks: opts.hooks,
    createDiscordClient: (options) => {
      const c = new FakeDiscordClient(options)
      c.addGuild('g1', [])
      clients.push(c)
      return c as any
    },
  })
  vi.spyOn(runtime.harmony, 'registerBridgeData').mockReturnValue(true)
  await runtime.connectDiscord()
  clients[0].ready()
  await vi.advanceTimersByTimeAsync(0)
  const put = clients[0].rest.put
  /** /bridge subcommand names of each registration, in order. */
  const registrations = () => put.mock.calls.map(([, body]) =>
    ((body as any).body as any[]).find(c => c.name === 'bridge').options.map((o: any) => o.name) as string[])
  /** READY as the gateway sends it. */
  const harmonyReady = async (capabilities?: string[]) => {
    ;(runtime.harmony as any).handlePayload({ op: 0, t: 'READY', d: { bot: { id: 'hb', username: 'bridge' }, session_id: 's', ...(capabilities ? { capabilities } : {}) } })
    await vi.advanceTimersByTimeAsync(0)
  }
  return { runtime, registrations, harmonyReady }
}

describe('slash command registration by gateway capability', () => {
  it('registers the sync subcommands the gateway lists in GET /users/@me', async () => {
    const { runtime, registrations } = await setup({ me: { id: 'hb', capabilities: ['bridge_emoji_sync', 'bridge_sound_sync'] } })
    expect(registrations().at(-1)).toEqual(expect.arrayContaining(['sync-emojis', 'sync-sounds', 'import-emojis']))
    expect(registrations().at(-1)).not.toContain('sync-stickers')
    expect(registrations().at(-1)).not.toContain('import-history')
    await runtime.stop()
  })

  it('hides every 1.9.7 subcommand from a gateway that lists no capabilities', async () => {
    const { runtime, registrations, harmonyReady } = await setup({ me: { id: 'hb' } })
    expect(registrations()[0]).toEqual(['status', 'link', 'unlink', 'clone-server', 'sync-order', 'sync-perms', 'import-emojis'])
    await harmonyReady()
    expect(registrations()).toHaveLength(1)
    await runtime.stop()
  })

  it('registers the base set at once while Harmony cannot be asked, and again when READY brings capabilities', async () => {
    const { runtime, registrations, harmonyReady } = await setup({ me: null })
    expect(registrations()).toHaveLength(1)
    expect(registrations()[0]).not.toContain('sync-stickers')
    await harmonyReady(['bridge_sticker_sync'])
    expect(registrations()).toHaveLength(2)
    expect(registrations()[1]).toContain('sync-stickers')
    await harmonyReady(['bridge_sticker_sync'])
    expect(registrations()).toHaveLength(2)
    await runtime.stop()
  })

  it('offers import-history only with the capability, the import routes and the instance switch on', async () => {
    let enabled = false
    const importApi = { listImports: vi.fn(), startImports: vi.fn(), cancelImport: vi.fn() } as any
    const { runtime, registrations, harmonyReady } = await setup({ me: null, hooks: { importApi, importEnabled: () => enabled } })
    await harmonyReady(['bridge_history_import'])
    expect(registrations().at(-1)).not.toContain('import-history')
    enabled = true
    await runtime.onDirectoryChanged({ pairsChanged: false })
    expect(registrations().at(-1)).toContain('import-history')
    enabled = false
    await runtime.onDirectoryChanged({ pairsChanged: false })
    expect(registrations().at(-1)).not.toContain('import-history')
    await runtime.stop()
  })

  it('never offers import-history to a bridge without the import routes', async () => {
    const { runtime, registrations, harmonyReady } = await setup({ me: null, hooks: { importEnabled: () => true } })
    await harmonyReady(['bridge_history_import'])
    expect(registrations().at(-1)).not.toContain('import-history')
    await runtime.stop()
  })

  it('reads sticker links only from a gateway with the sticker routes', async () => {
    const { runtime, harmonyReady } = await setup({ me: { id: 'hb' } })
    const ensure = vi.spyOn(runtime.stickerLinks, 'ensure').mockResolvedValue()
    vi.spyOn(runtime.emojiLinks, 'ensure').mockResolvedValue()
    await (runtime as any).emojiServerFor('g1')
    expect(ensure).not.toHaveBeenCalled()
    await harmonyReady(['bridge_sticker_sync'])
    await (runtime as any).emojiServerFor('g1')
    expect(ensure).toHaveBeenCalledWith('s')
    await runtime.stop()
  })
})
