import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Events, GatewayIntentBits, type ClientOptions } from 'discord.js'
import { BridgeRuntime } from '../src/runtime/BridgeRuntime.js'
import { V2Directory } from '../src/v2/V2Directory.js'
import { APPLICATION_FLAGS } from '../src/runtime/discordConnection.js'
import { silentLogger } from '../src/log.js'
import type { PairWriter } from '../src/runtime/PairDirectory.js'

class FakeDiscordClient extends EventEmitter {
  rest = Object.assign(new EventEmitter(), { put: vi.fn(async () => []) })
  user: any = null
  application = { id: 'app-1' }
  guilds = { cache: new Map(), fetch: vi.fn(async (id: string) => { throw new Error(`Unknown guild ${id}`) }) }
  channels = { fetch: vi.fn() }
  login = vi.fn(async () => 'token')
  destroy = vi.fn(async () => {})
  constructor(readonly options: ClientOptions) { super() }
}

const writer: PairWriter = {
  link: async () => {},
  linkMany: async () => [],
  unlink: async () => false,
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-rt-'))
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function setup(
  appResponse: () => Response,
  settings: Record<string, unknown> = {},
  onCreate?: (client: FakeDiscordClient) => void,
) {
  const clients: FakeDiscordClient[] = []
  const appCalls = { n: 0 }
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = String(url)
    if (u.endsWith('/applications/@me')) {
      appCalls.n++
      return appResponse()
    }
    if (u.includes('/members')) return Response.json([])
    return new Response('not found', { status: 404 })
  })
  const runtime = new BridgeRuntime({
    mode: 'v2',
    directory: new V2Directory({
      bridge_id: 'b',
      server_id: 's',
      mode: 'self',
      discord_guild_id: 'g1',
      settings,
      pairs: [],
      harmony_channels: [],
    }),
    writer,
    discordToken: 'dtok',
    harmony: { token: 'htok', gatewayUrl: 'ws://127.0.0.1:9/gateway', apiUrl: 'http://127.0.0.1:9', baseUrl: 'https://h.example' },
    permissionStorePath: join(dir, 'permission-sync.yml'),
    log: silentLogger,
    fetchImpl,
    createDiscordClient: (options) => {
      const c = new FakeDiscordClient(options)
      clients.push(c)
      onCreate?.(c)
      return c as any
    },
  })
  return { runtime, clients, appCalls }
}

const codes = (rt: BridgeRuntime) => rt.connectionProblems().map(p => p.params?.intent ? `${p.code}:${p.params.intent}` : p.code)

describe('BridgeRuntime Discord connection', () => {
  it('reports an invalid token and retries with backoff instead of crashing', async () => {
    const { runtime, clients, appCalls } = setup(() => Response.json({ message: '401: Unauthorized' }, { status: 401 }))
    await runtime.connectDiscord()

    expect(runtime.getDiscordState()).toBe('token_invalid')
    expect(codes(runtime)).toContain('discord_token_invalid')
    expect(clients).toHaveLength(0)
    expect(appCalls.n).toBe(1)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(appCalls.n).toBe(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(appCalls.n).toBe(2)
    await runtime.stop()
  })

  it('connects without intents the application lacks and reports them', async () => {
    const { runtime, clients } = setup(
      () => Response.json({ id: 'app-1', flags: APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT }),
      { sync_member_list: true, sync_presence: true },
    )
    await runtime.connectDiscord()

    expect(clients).toHaveLength(1)
    const intents = clients[0].options.intents as GatewayIntentBits[]
    expect(intents).toContain(GatewayIntentBits.MessageContent)
    expect(intents).not.toContain(GatewayIntentBits.GuildMembers)
    expect(intents).not.toContain(GatewayIntentBits.GuildPresences)
    expect(clients[0].login).toHaveBeenCalledWith('dtok')
    expect(codes(runtime)).toEqual(['intent_missing:members', 'intent_missing:presence'])
    await runtime.stop()
  })

  it('handles a disallowed-intents close: tears down, reports, retries later', async () => {
    const { runtime, clients, appCalls } = setup(() => Response.json({ id: 'app-1', flags: APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT }))
    await runtime.connectDiscord()
    const client = clients[0]

    client.emit(Events.ShardDisconnect, { code: 4014 }, 0)
    await vi.advanceTimersByTimeAsync(0)

    expect(runtime.getDiscordState()).toBe('intents_disallowed')
    expect(codes(runtime)).toContain('intent_missing:message_content')
    expect(client.destroy).toHaveBeenCalled()
    expect(runtime.isDiscordConnected()).toBe(false)

    await vi.advanceTimersByTimeAsync(40_000)
    expect(appCalls.n).toBe(2)
    expect(clients).toHaveLength(2)
    await runtime.stop()
  })

  it('keeps the intent problem when the close lands during login', async () => {
    const { runtime, clients } = setup(
      () => Response.json({ id: 'app-1', flags: APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT }),
      {},
      (client) => {
        client.login.mockImplementationOnce(async () => {
          client.emit(Events.ShardDisconnect, { code: 4014 }, 0)
          throw new Error('Used disallowed intents')
        })
      },
    )
    await runtime.connectDiscord()
    await vi.advanceTimersByTimeAsync(0)
    expect(clients).toHaveLength(1)
    expect(runtime.getDiscordState()).toBe('intents_disallowed')
    expect(codes(runtime)).toContain('intent_missing:message_content')
    expect(codes(runtime)).not.toContain('discord_unreachable')
    await runtime.stop()
  })

  it('reports Discord unreachable when the preflight cannot connect', async () => {
    const { runtime } = setup(() => { throw new TypeError('fetch failed') })
    const pending = runtime.connectDiscord()
    await vi.advanceTimersByTimeAsync(5_000)
    await pending
    expect(runtime.getDiscordState()).toBe('unreachable')
    expect(codes(runtime)).toContain('discord_unreachable')
    await runtime.stop()
  })

  it('reconnects with a new intent set when settings change', async () => {
    const all = APPLICATION_FLAGS.GATEWAY_MESSAGE_CONTENT | APPLICATION_FLAGS.GATEWAY_GUILD_MEMBERS | APPLICATION_FLAGS.GATEWAY_PRESENCE
    const { runtime, clients } = setup(() => Response.json({ id: 'app-1', flags: all }), { sync_member_list: false })
    await runtime.connectDiscord()
    expect(clients[0].options.intents).not.toContain(GatewayIntentBits.GuildMembers)

    ;(runtime.dir as V2Directory).update({
      bridge_id: 'b', server_id: 's', mode: 'self', discord_guild_id: 'g1',
      settings: { sync_member_list: true }, pairs: [], harmony_channels: [],
    })
    await runtime.onDirectoryChanged({ settingsChanged: true, pairsChanged: false, addedHarmonyChannels: [] })

    expect(clients).toHaveLength(2)
    expect(clients[0].destroy).toHaveBeenCalled()
    expect(clients[1].options.intents).toContain(GatewayIntentBits.GuildMembers)
    await runtime.stop()
  })
})
