import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  APP_EMOJI_MAX_BYTES,
  AppEmojiStore,
  appEmojiName,
  loadEmojiImage,
  supabaseRenderUrl,
  type AppEmojiApi,
  type AppEmojiIO,
} from '../src/runtime/appEmojis.js'
import { silentLogger } from '../src/log.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const GIF = Buffer.from('GIF89a......')

/** Discord's application emoji list for one application, shared by every "process" in a test. */
function discordApp() {
  const emojis = new Map<string, { id: string; name: string; animated: boolean }>()
  let next = 100
  const calls = { create: 0, delete: 0, list: 0 }
  const api: AppEmojiApi = {
    list: vi.fn(async () => { calls.list++; return Array.from(emojis.values()) }),
    create: vi.fn(async (name: string, image: string) => {
      calls.create++
      if (!/^[A-Za-z0-9_]{2,32}$/.test(name)) throw Object.assign(new Error('Invalid Form Body'), { code: 50035 })
      if ([...emojis.values()].some(e => e.name === name)) {
        throw Object.assign(new Error('Invalid Form Body: APPLICATION_EMOJI_NAME_ALREADY_TAKEN'), { code: 50035 })
      }
      if (emojis.size >= 2000) throw Object.assign(new Error('Maximum number of emojis reached'), { code: 30008 })
      const e = { id: String(next++), name, animated: image.startsWith('data:image/gif') }
      emojis.set(e.id, e)
      return e
    }),
    delete: vi.fn(async (id: string) => {
      calls.delete++
      if (!emojis.delete(id)) throw Object.assign(new Error('Unknown Emoji'), { code: 10014 })
    }),
  }
  return { api, emojis, calls }
}

function io(api: AppEmojiApi, images: Record<string, Buffer | null> = {}): AppEmojiIO {
  return {
    api,
    loadImage: vi.fn(async (url: string) => {
      const data = url in images ? images[url] : PNG
      if (!data) return null
      return `data:${data === GIF ? 'image/gif' : 'image/png'};base64,${data.toString('base64')}`
    }),
  }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'app-emoji-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('appEmojiName', () => {
  it('produces 2–32 characters of [A-Za-z0-9_], stable per image URL', () => {
    for (const name of ['party', 'a', '', 'ñoño-emoji!', 'x'.repeat(60), '__', '日本']) {
      const out = appEmojiName(name, `https://h.example/${name}.png`)
      expect(out).toMatch(/^[A-Za-z0-9_]{2,32}$/)
    }
    expect(appEmojiName('party', 'u1')).toBe(appEmojiName('party', 'u1'))
    expect(appEmojiName('party', 'u1')).not.toBe(appEmojiName('party', 'u2'))
    expect(appEmojiName('ñoño-emoji!', 'k')).toMatch(/^o_o_emoji_[0-9a-f]{6}$/)
    expect(appEmojiName('', 'k')).toMatch(/^emoji_[0-9a-f]{6}$/)
  })
})

describe('AppEmojiStore', () => {
  it('uploads once, maps the image URL to the emoji and persists the map', async () => {
    const { api, calls } = discordApp()
    const path = join(dir, 'app-1.json')
    const store = new AppEmojiStore({ path, log: silentLogger })
    const ioA = io(api, { 'https://h.example/party.gif': GIF })

    const first = await store.resolve({ url: 'https://h.example/party.gif', name: 'party' }, ioA)
    expect(first).toMatchObject({ animated: true, name: appEmojiName('party', 'https://h.example/party.gif') })
    expect(await store.resolve({ url: 'https://h.example/party.gif', name: 'party' }, ioA)).toEqual(first)
    expect(calls.create).toBe(1)

    const reloaded = new AppEmojiStore({ path, log: silentLogger })
    expect(reloaded.peek('https://h.example/party.gif')).toEqual(first)
    expect(JSON.parse(readFileSync(path, 'utf8')).emojis['https://h.example/party.gif'].id).toBe(first!.id)
  })

  it('shares one upload between concurrent requests and between bridges of one application', async () => {
    const { api, calls } = discordApp()
    const path = join(dir, 'shared.json')
    const a = AppEmojiStore.forPath(path, { log: silentLogger })
    const b = AppEmojiStore.forPath(path, { log: silentLogger })
    expect(a).toBe(b)
    const src = { url: 'https://h.example/x.png', name: 'x' }
    const [r1, r2, r3] = await Promise.all([a.resolve(src, io(api)), b.resolve(src, io(api)), a.resolve(src, io(api))])
    expect(r1).toEqual(r2)
    expect(r2).toEqual(r3)
    expect(calls.create).toBe(1)
  })

  it('adopts the emoji another process uploaded under the same name', async () => {
    const { api, calls, emojis } = discordApp()
    const one = new AppEmojiStore({ path: join(dir, 'p1.json'), log: silentLogger })
    const two = new AppEmojiStore({ path: join(dir, 'p2.json'), log: silentLogger })
    const src = { url: 'https://h.example/race.png', name: 'race' }
    const fromOne = await one.resolve(src, io(api))
    const fromTwo = await two.resolve(src, io(api))
    expect(fromTwo).toEqual(fromOne)
    expect(emojis.size).toBe(1)
    expect(calls.create).toBe(2)
    expect(calls.list).toBe(1)
  })

  it('evicts the least recently used upload to stay under the cap', async () => {
    let now = 1_000
    const { api, emojis } = discordApp()
    const store = new AppEmojiStore({ path: null, log: silentLogger, cap: 3, now: () => now })
    const ids: Record<string, string> = {}
    for (const n of ['a', 'b', 'c']) {
      now += 10
      ids[n] = (await store.resolve({ url: `https://h.example/${n}.png`, name: n }, io(api)))!.id
    }
    now += 10
    store.peek('https://h.example/a.png')
    now += 10
    await store.resolve({ url: 'https://h.example/d.png', name: 'd' }, io(api))
    expect(store.size).toBe(3)
    expect(emojis.has(ids.b)).toBe(false)
    expect(emojis.has(ids.a)).toBe(true)
    expect(store.peek('https://h.example/b.png')).toBeNull()
  })

  it('frees room when Discord reports the application full', async () => {
    const { api, emojis } = discordApp()
    let now = 0
    const store = new AppEmojiStore({ path: null, log: silentLogger, now: () => ++now })
    for (let i = 0; i < 5; i++) await store.resolve({ url: `https://h.example/${i}.png`, name: `e${i}` }, io(api))
    for (let i = 0; emojis.size < 2000; i++) emojis.set(`x${i}`, { id: `x${i}`, name: `other_${i}`, animated: false })

    const added = await store.resolve({ url: 'https://h.example/new.png', name: 'new' }, io(api))
    expect(added).not.toBeNull()
    expect(store.size).toBe(1)
    expect(emojis.size).toBe(1996)
  })

  it('skips an unusable image, remembers the failure and forgets an emoji deleted elsewhere', async () => {
    const { api, calls } = discordApp()
    const store = new AppEmojiStore({ path: null, log: silentLogger })
    const broken = io(api, { 'https://h.example/huge.png': null })
    expect(await store.resolve({ url: 'https://h.example/huge.png', name: 'huge' }, broken)).toBeNull()
    expect(await store.resolve({ url: 'https://h.example/huge.png', name: 'huge' }, broken)).toBeNull()
    expect(broken.loadImage).toHaveBeenCalledTimes(1)
    expect(calls.create).toBe(0)

    const ok = await store.resolve({ url: 'https://h.example/ok.png', name: 'ok' }, io(api))
    store.invalidate('https://h.example/ok.png')
    expect(store.peek('https://h.example/ok.png')).toBeNull()
    expect(ok).not.toBeNull()
  })
})

describe('loadEmojiImage', () => {
  it('uses the original when it fits, else the Supabase render at a smaller size', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(APP_EMOJI_MAX_BYTES)])
    const original = 'https://h.example/storage/v1/object/public/emojis/s/big.png'
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u === original) return new Response(big)
      if (u === supabaseRenderUrl(original, 128)) return new Response(PNG)
      return new Response('nope', { status: 404 })
    })
    expect(await loadEmojiImage(original, fetchImpl)).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(fetchImpl.mock.calls.map(c => String(c[0]))).toEqual([original, supabaseRenderUrl(original, 128)])

    const notImage = vi.fn(async () => new Response('<html>'))
    expect(await loadEmojiImage('https://h.example/x.png', notImage)).toBeNull()
    const remoteBig = vi.fn(async () => new Response(big))
    expect(await loadEmojiImage('https://remote.example/x.png', remoteBig)).toBeNull()
  })
})
