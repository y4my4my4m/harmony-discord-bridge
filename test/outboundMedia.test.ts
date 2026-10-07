import { describe, expect, it, vi } from 'vitest'
import {
  OutboundMedia,
  guildUploadLimit,
  isAnimatedImage,
  mediaOptionsFromEnv,
  nameForImage,
} from '../src/runtime/outboundMedia.js'
import { collectHarmonyFiles } from '../src/MessageTranslator.js'
import { fetchCapped, isPublicHttpsUrl } from '../src/utils/fetchCapped.js'
import { silentLogger } from '../src/log.js'

const MIB = 1024 * 1024
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const WEBP = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')

/** PNG head: signature, IHDR, then acTL (animated) or IDAT (static). */
function pngHead(animated: boolean): Buffer {
  const chunk = (type: string, len: number) => Buffer.concat([
    Buffer.from([0, 0, 0, len]), Buffer.from(type, 'latin1'), Buffer.alloc(len), Buffer.alloc(4),
  ])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', 13),
    chunk(animated ? 'acTL' : 'IDAT', 8),
  ])
}

const opts = (maxMb = 8, mediaOrigin: string | null = null) => ({ maxUploadBytes: maxMb * MIB, mediaOrigin })
const files = (...parts: any[]) => collectHarmonyFiles({ content_raw: parts })

describe('media options', () => {
  it('reads MAX_UPLOAD_MB and HARMONY_MEDIA_ORIGIN, falling back on bad values', () => {
    expect(mediaOptionsFromEnv({}, silentLogger)).toEqual({ maxUploadBytes: 8 * MIB, mediaOrigin: null })
    expect(mediaOptionsFromEnv({ MAX_UPLOAD_MB: '2.5', HARMONY_MEDIA_ORIGIN: 'http://127.0.0.1:8000/' }, silentLogger))
      .toEqual({ maxUploadBytes: 2.5 * MIB, mediaOrigin: 'http://127.0.0.1:8000' })
    expect(mediaOptionsFromEnv({ MAX_UPLOAD_MB: 'lots', HARMONY_MEDIA_ORIGIN: 'ftp://x' }, silentLogger))
      .toEqual({ maxUploadBytes: 8 * MIB, mediaOrigin: null })
    expect(mediaOptionsFromEnv({ MAX_UPLOAD_MB: '0' }, silentLogger).maxUploadBytes).toBe(0)
  })

  it('maps boost tiers to Discord upload limits', () => {
    expect(guildUploadLimit(0)).toBe(25 * MIB)
    expect(guildUploadLimit(1)).toBe(25 * MIB)
    expect(guildUploadLimit(2)).toBe(50 * MIB)
    expect(guildUploadLimit(3)).toBe(100 * MIB)
    expect(guildUploadLimit(undefined)).toBe(25 * MIB)
  })
})

describe('OutboundMedia', () => {
  it('fetches only from Harmony or public Supabase storage', () => {
    const m = new OutboundMedia('https://h.example', opts())
    expect(m.isFetchable('https://h.example/storage/v1/object/sign/message_media/a.png?token=t')).toBe(true)
    expect(m.isFetchable('https://abc.supabase.co/storage/v1/object/public/user_media/a.png')).toBe(true)
    expect(m.isFetchable('https://evil.example/a.png')).toBe(false)
    expect(m.isFetchable('http://supabase-kong:8000/storage/v1/object/public/a.png')).toBe(false)
    expect(m.isFetchable('https://169.254.169.254/storage/v1/x')).toBe(false)
    expect(isPublicHttpsUrl('https://localhost/storage/v1/x')).toBe(false)
  })

  it('routes Harmony media through HARMONY_MEDIA_ORIGIN with path and query intact', () => {
    const m = new OutboundMedia('https://h.example', opts(8, 'http://127.0.0.1:8000'))
    expect(m.route('https://h.example/storage/v1/object/sign/message_media/c/1/a.png?token=x.y'))
      .toBe('http://127.0.0.1:8000/storage/v1/object/sign/message_media/c/1/a.png?token=x.y')
    expect(m.route('https://other.example/a.png')).toBe('https://other.example/a.png')
    expect(new OutboundMedia('https://h.example', opts()).route('https://h.example/a')).toBe('https://h.example/a')
  })

  it('fetches static public images through the 1600 px render and keeps animated ones original', async () => {
    const pub = 'https://h.example/storage/v1/object/public/user_media/u/photo.png'
    const anim = 'https://h.example/storage/v1/object/public/user_media/u/anim.png'
    const signed = 'https://h.example/storage/v1/object/sign/message_media/c/1/u/pic.jpg?token=t'
    const render = 'https://h.example/storage/v1/render/image/public/user_media/u/photo.png?width=1600&height=1600&resize=contain&quality=82'
    const fetched: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      fetched.push(`${(init?.headers as Record<string, string> | undefined)?.Range ? 'probe ' : ''}${u}`)
      if (u === pub) return new Response(pngHead(false))
      if (u === anim) return new Response(pngHead(true))
      if (u === render) return new Response(WEBP)
      if (u === signed) return new Response(JPEG)
      return new Response('nope', { status: 404 })
    })
    const m = new OutboundMedia('https://h.example', opts(8, 'https://h.example'), fetchImpl)
    const out = await m.prepare(files(
      { type: 'file', url: pub, fileName: 'photo.png', fileType: 'image' },
      { type: 'file', url: anim, fileName: 'anim.png', fileType: 'image' },
      { type: 'file', url: signed, path: 'c/1/u/pic.jpg', fileName: 'pic.jpg', fileType: 'image' },
    ), 8 * MIB)

    expect(out.map(f => [f.key, f.name])).toEqual([
      [pub, 'photo.webp'],
      [anim, 'anim.png'],
      ['c/1/u/pic.jpg', 'pic.jpg'],
    ])
    expect(fetched).toEqual([`probe ${pub}`, render, `probe ${anim}`, anim, signed])
  })

  it('skips files beyond the budget, unfetchable ones and failures; the rest fit', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('big.mp4')) return new Response(Buffer.alloc(3 * MIB))
      if (u.endsWith('mid.mp3')) return new Response(Buffer.alloc(MIB))
      if (u.endsWith('gone.pdf')) return new Response('gone', { status: 404 })
      return new Response(Buffer.alloc(10))
    })
    const m = new OutboundMedia('https://h.example', opts(2), fetchImpl)
    const base = 'https://h.example/storage/v1/object/sign/message_media/c/1/u/'
    const out = await m.prepare(files(
      { type: 'file', url: `${base}big.mp4`, fileName: 'big.mp4', fileType: 'video' },
      { type: 'file', url: `${base}declared.zip`, fileName: 'declared.zip', fileSize: 5 * MIB },
      { type: 'file', url: `${base}gone.pdf`, fileName: 'gone.pdf' },
      { type: 'file', url: 'https://elsewhere.example/x.txt', fileName: 'x.txt' },
      { type: 'file', url: `${base}mid.mp3`, fileName: 'mid.mp3', fileType: 'audio' },
      { type: 'file', url: `${base}small.txt`, fileName: 'small.txt' },
    ), 2 * MIB)
    expect(out.map(f => f.name)).toEqual(['mid.mp3', 'small.txt'])
    expect(fetchImpl.mock.calls.map(c => String(c[0]).split('/').pop())).not.toContain('declared.zip')
  })
})

describe('image helpers', () => {
  it('detects animation from the first bytes', () => {
    expect(isAnimatedImage(pngHead(true))).toBe(true)
    expect(isAnimatedImage(pngHead(false))).toBe(false)
    const animWebp = Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x02\x00\x00\x00', 'latin1')
    expect(isAnimatedImage(animWebp)).toBe(true)
    expect(isAnimatedImage(WEBP)).toBe(false)
  })

  it('gives the file name the extension of its bytes', () => {
    expect(nameForImage('photo.png', WEBP)).toBe('photo.webp')
    expect(nameForImage('photo.jpeg', JPEG)).toBe('photo.jpeg')
    expect(nameForImage('noext', JPEG)).toBe('noext.jpg')
    expect(nameForImage('doc.pdf', Buffer.from('%PDF'))).toBe('doc.pdf')
  })

  it('caps downloads by declared and streamed size', async () => {
    const declared = vi.fn(async () => new Response('x', { headers: { 'content-length': '999999' } }))
    expect(await fetchCapped('https://h.example/a', { maxBytes: 10, timeoutMs: 1000, fetchImpl: declared })).toEqual({ ok: false, reason: 'too_large' })
    const streamed = vi.fn(async () => new Response(Buffer.alloc(11)))
    expect(await fetchCapped('https://h.example/a', { maxBytes: 10, timeoutMs: 1000, fetchImpl: streamed })).toEqual({ ok: false, reason: 'too_large' })
    const fits = vi.fn(async () => new Response(Buffer.alloc(10)))
    expect(await fetchCapped('https://h.example/a', { maxBytes: 10, timeoutMs: 1000, fetchImpl: fits })).toMatchObject({ ok: true })
  })
})

describe('gateway render_url', () => {
  const signed = 'https://h.example/storage/v1/object/sign/message_media/c/1/u/photo.jpg?token=orig'
  const render = 'https://h.example/storage/v1/render/image/sign/message_media/c/1/u/photo.jpg?token=render'
  const part = (renderUrl: string) => files({ type: 'file', url: signed, path: 'c/1/u/photo.jpg', render_url: renderUrl, fileName: 'photo.jpg', fileType: 'image', fileSize: 5 * MIB })

  it('prefers render_url, through HARMONY_MEDIA_ORIGIN', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url) === 'http://127.0.0.1:8000/storage/v1/render/image/sign/message_media/c/1/u/photo.jpg?token=render'
        ? new Response(WEBP)
        : new Response('nope', { status: 404 }))
    const m = new OutboundMedia('https://h.example', opts(8, 'http://127.0.0.1:8000'), fetchImpl)
    const out = await m.prepare(part(render), 8 * MIB)
    expect(out).toEqual([{ key: 'c/1/u/photo.jpg', name: 'photo.webp', data: WEBP }])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('falls back to url when the render fails', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url) === signed ? new Response(JPEG) : new Response('gone', { status: 500 }))
    const m = new OutboundMedia('https://h.example', opts(8), fetchImpl)
    const out = await m.prepare(files({ type: 'file', url: signed, path: 'c/1/u/photo.jpg', render_url: render, fileName: 'photo.jpg', fileType: 'image' }), 8 * MIB)
    expect(out.map(f => f.name)).toEqual(['photo.jpg'])
    expect(fetchImpl.mock.calls.map(c => String(c[0]))).toEqual([render, signed])
  })

  it('ignores a render_url outside the allowed origins', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url) === signed ? new Response(JPEG) : new Response('nope', { status: 404 }))
    const m = new OutboundMedia('https://h.example', opts(8), fetchImpl)
    await m.prepare(files({ type: 'file', url: signed, path: 'c/1/u/photo.jpg', render_url: 'http://10.0.0.5/render.jpg', fileName: 'photo.jpg', fileType: 'image' }), 8 * MIB)
    expect(fetchImpl.mock.calls.map(c => String(c[0]))).toEqual([signed])
  })

  it('uses the render even when the original exceeds the budget', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url) === render ? new Response(JPEG) : new Response(Buffer.alloc(5 * MIB)))
    const m = new OutboundMedia('https://h.example', opts(1), fetchImpl)
    const out = await m.prepare(part(render), 1 * MIB)
    expect(out.map(f => f.data)).toEqual([JPEG])
  })
})
