import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveChatMessage } from '@/lib/backend'
import { renderCommentHighlightCards, type HighlightBitmap } from './caption-overlay'
import { X_LOGO_WHITE_URL, X_VERIFIED_URL } from './x-mark'

// The card is painted on an OffscreenCanvas, which the node test environment
// lacks. A recording 2D context stands in: it measures text like the layout
// tests (0.55 em per character) and records every drawImage and fillText.

type Call = { method: string; args: unknown[] }

const calls: Call[] = []

function fakeContext(): OffscreenCanvasRenderingContext2D {
  const gradient = { addColorStop: (): void => {} }
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: text.length * 24 * 0.55 }),
    createLinearGradient: () => gradient
  }
  return new Proxy(target, {
    get(object, property: string) {
      if (property in object) return object[property]
      return (...args: unknown[]) => {
        calls.push({ method: property, args })
      }
    },
    set(object, property: string, value) {
      object[property] = value
      return true
    }
  }) as unknown as OffscreenCanvasRenderingContext2D
}

class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number
  ) {}

  getContext(): OffscreenCanvasRenderingContext2D {
    return fakeContext()
  }

  async convertToBlob(): Promise<Blob> {
    return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])])
  }
}

const bitmap = { width: 300, height: 300 } as unknown as HighlightBitmap

const message = {
  id: 'm1',
  providerMessageId: 'm1',
  platform: 'twitch',
  sessionId: 's1',
  authorName: 'Orc Dev',
  authorBadges: [],
  authorRoles: [],
  publishedAt: '2026-10-02T12:00:00Z',
  receivedAt: '2026-10-02T12:00:00Z',
  messageText: 'hello there',
  fragments: [],
  eventType: 'message',
  isDeleted: false
} as unknown as LiveChatMessage

const avatarUrl = 'videorc-asset://avatar/0123456789abcdef0123456789abcdef.png'

describe('renderCommentHighlightCards images (plan 095, S3)', () => {
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('decodes the avatar once from main bytes and draws it on both cards', async () => {
    const readImage = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const decode = vi.fn(async () => bitmap)
    const warn = vi.fn()
    const cards = await renderCommentHighlightCards(
      message,
      avatarUrl,
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { readImage, decode, warn }
    )
    expect(cards?.pngBase64).toBeTruthy()
    expect(cards?.verticalPngBase64).toBeTruthy()
    expect(readImage).toHaveBeenCalledTimes(1)
    expect(readImage).toHaveBeenCalledWith(avatarUrl)
    expect(decode).toHaveBeenCalledTimes(1)
    const drawn = calls.filter((call) => call.method === 'drawImage')
    expect(drawn).toHaveLength(2)
    expect(drawn.every((call) => call.args[0] === bitmap)).toBe(true)
    // No monogram letters were painted.
    const texts = calls.filter((call) => call.method === 'fillText').map((call) => call.args[0])
    expect(texts).not.toContain('OD')
    expect(warn).not.toHaveBeenCalled()
  })

  it('paints the monogram and warns once, with the reason, when main has no bytes', async () => {
    const warn = vi.fn()
    const cards = await renderCommentHighlightCards(
      message,
      avatarUrl,
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { readImage: async () => null, decode: async () => bitmap, warn }
    )
    expect(cards?.pngBase64).toBeTruthy()
    expect(calls.filter((call) => call.method === 'drawImage')).toHaveLength(0)
    const texts = calls.filter((call) => call.method === 'fillText').map((call) => call.args[0])
    expect(texts.filter((text) => text === 'OD')).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/twitch avatar for Orc Dev fell back to the monogram/)
    expect(warn.mock.calls[0]?.[0]).toMatch(/no cached file/)
  })

  it('names a decode failure and a deadline as the reason', async () => {
    const warn = vi.fn()
    await renderCommentHighlightCards(
      message,
      avatarUrl,
      { width: 1920, height: 1080 },
      undefined,
      {
        readImage: async () => new Uint8Array([1]),
        decode: async () => {
          throw new Error('not an image')
        },
        warn
      }
    )
    expect(warn.mock.calls[0]?.[0]).toMatch(/not an image/)

    warn.mockClear()
    await renderCommentHighlightCards(
      message,
      avatarUrl,
      { width: 1920, height: 1080 },
      undefined,
      {
        readImage: () => new Promise(() => {}),
        decode: async () => bitmap,
        warn,
        deadlineMs: 5
      }
    )
    expect(warn.mock.calls[0]?.[0]).toMatch(/not decoded within 5 ms/)
  })

  it('draws cached emotes in their boxes and shares them between both cards (S4)', async () => {
    const emoteBitmap = { width: 224, height: 112 } as unknown as HighlightBitmap
    const overlayBitmap = { width: 112, height: 112 } as unknown as HighlightBitmap
    const cacheImage = vi.fn(async (remoteUrl: string) =>
      remoteUrl.includes('/3.0')
        ? 'videorc-asset://avatar/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.img'
        : 'videorc-asset://avatar/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.webp'
    )
    const readImage = vi.fn(async (localUrl: string) =>
      localUrl.endsWith('.img') ? new Uint8Array([1]) : new Uint8Array([1, 2])
    )
    const decode = vi.fn(async (bytes: Uint8Array) =>
      bytes.length === 1 ? emoteBitmap : overlayBitmap
    )
    const warn = vi.fn()
    const withEmotes = {
      ...message,
      messageText: 'gg Kappa RainTime',
      fragments: [
        { type: 'text', text: 'gg ' },
        {
          type: 'emote',
          text: 'Kappa',
          imageUrl: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0'
        },
        { type: 'text', text: ' ' },
        {
          type: 'emote',
          text: 'RainTime',
          imageUrl: 'https://cdn.7tv.app/emote/RainTime/2x.webp',
          zeroWidth: true
        }
      ]
    } as unknown as LiveChatMessage
    const cards = await renderCommentHighlightCards(
      withEmotes,
      null,
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { readImage, cacheImage, decode, warn }
    )
    expect(cards?.verticalPngBase64).toBeTruthy()
    // The card asks Twitch for the sharp 3.0 emote; 7TV stays as sent.
    expect(cacheImage.mock.calls.map((call) => call[0]).sort()).toEqual([
      'https://cdn.7tv.app/emote/RainTime/2x.webp',
      'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0'
    ])
    // Decoded once per image, drawn on both cards (base + overlay each).
    expect(decode).toHaveBeenCalledTimes(2)
    const drawn = calls.filter((call) => call.method === 'drawImage')
    expect(drawn).toHaveLength(4)
    const base = drawn.filter((call) => call.args[0] === emoteBitmap)
    const overlay = drawn.filter((call) => call.args[0] === overlayBitmap)
    expect(base).toHaveLength(2)
    expect(overlay).toHaveLength(2)
    // The overlay shares the base emote's box (same x, y, w, h).
    expect(overlay[0]!.args.slice(1)).toEqual(base[0]!.args.slice(1))
    // A 2:1 emote gets a 2:1 box, 1.2 text sizes high (40 px text at 1080p).
    expect(base[0]!.args.slice(3)).toEqual([96, 48])
    const texts = calls.filter((call) => call.method === 'fillText').map((call) => call.args[0])
    expect(texts).toContain('gg')
    expect(texts.some((text) => String(text).includes('Kappa'))).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('shows a failed emote as its name and warns once for all failures (S4)', async () => {
    const warn = vi.fn()
    const withEmotes = {
      ...message,
      messageText: 'gg Kappa',
      fragments: [
        { type: 'text', text: 'gg ' },
        {
          type: 'emote',
          text: 'Kappa',
          imageUrl: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0'
        },
        { type: 'text', text: ' ' },
        { type: 'emote', text: 'PogU', imageUrl: 'https://cdn.7tv.app/emote/PogU/2x.webp' }
      ]
    } as unknown as LiveChatMessage
    await renderCommentHighlightCards(withEmotes, null, { width: 1920, height: 1080 }, undefined, {
      readImage: async () => null,
      cacheImage: async (url) => (url.includes('7tv') ? null : 'videorc-asset://avatar/x.img'),
      decode: async () => bitmap,
      warn
    })
    expect(calls.filter((call) => call.method === 'drawImage')).toHaveLength(0)
    const texts = calls.filter((call) => call.method === 'fillText').map((call) => call.args[0])
    // Consecutive words paint as one run, so the names land in the message run.
    expect(texts).toContain('gg Kappa PogU')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/2 emote\(s\) show as text/)
    expect(warn.mock.calls[0]?.[0]).toMatch(/Kappa: main has no cached file/)
    expect(warn.mock.calls[0]?.[0]).toMatch(/PogU: main did not cache it/)
  })

  it('keeps an activity card as text even when its fragments carry emotes (S4)', async () => {
    const cacheImage = vi.fn(async () => 'videorc-asset://avatar/x.img')
    const activity = {
      ...message,
      messageText: 'Kappa',
      eventType: 'raid',
      details: { kind: 'raid', viewerCount: 12 },
      fragments: [
        { type: 'emote', text: 'Kappa', imageUrl: 'https://cdn.7tv.app/emote/Kappa/2x.webp' }
      ]
    } as unknown as LiveChatMessage
    await renderCommentHighlightCards(activity, null, { width: 1920, height: 1080 }, undefined, {
      readImage: async () => null,
      cacheImage,
      decode: async () => bitmap,
      warn: vi.fn()
    })
    expect(cacheImage).not.toHaveBeenCalled()
    expect(calls.filter((call) => call.method === 'drawImage')).toHaveLength(0)
  })

  it('never reads bytes for a message without an avatar', async () => {
    const readImage = vi.fn(async () => new Uint8Array([1]))
    await renderCommentHighlightCards(message, null, { width: 1920, height: 1080 }, undefined, {
      readImage,
      decode: async () => bitmap,
      warn: vi.fn()
    })
    expect(readImage).not.toHaveBeenCalled()
  })
})

// Plan 165 (Google's YouTube API ToS report, III.F.2a): a YouTube card shows
// YouTube's own icon on the identity row, at least 20 output pixels tall, and
// never a redrawn badge.
describe('renderCommentHighlightCards YouTube icon (plan 165)', () => {
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  })
  afterEach(() => vi.unstubAllGlobals())

  const youtube = { ...message, platform: 'youtube' } as LiveChatMessage
  // The decoded official file: the artboard, mark cropped from inside it.
  const icon = { width: 602.187, height: 515.868 } as unknown as HighlightBitmap

  it('draws the official icon at 20 px or more on every leg, right of the name', async () => {
    const loadYoutubeMark = vi.fn(async () => icon)
    await renderCommentHighlightCards(
      youtube,
      null,
      { width: 1280, height: 720 },
      { width: 1080, height: 1920 },
      { loadYoutubeMark, warn: vi.fn() }
    )
    expect(loadYoutubeMark).toHaveBeenCalledTimes(1)
    const marks = calls.filter((call) => call.method === 'drawImage' && call.args[0] === icon)
    expect(marks).toHaveLength(2)
    for (const { args } of marks) {
      // Source crop is the mark's bounds inside the file.
      expect(args.slice(1, 5).map((value) => Math.round(Number(value)))).toEqual([
        103, 119, 396, 277
      ])
      const [width, height] = [Number(args[7]), Number(args[8])]
      expect(height).toBeGreaterThanOrEqual(20)
      expect(width / height).toBeCloseTo(396 / 277.402343, 1)
    }
    const nameCalls = calls.filter((call) => call.method === 'fillText')
    const names = nameCalls.map((call) => String(call.args[0]))
    expect(names).toContain('Orc Dev')
    // The icon closes the identity row on the right, after the name.
    const nameX = Number(nameCalls.find((call) => call.args[0] === 'Orc Dev')?.args[1])
    for (const { args } of marks) expect(Number(args[5])).toBeGreaterThan(nameX)
    expect(names.some((name) => name.includes('YouTube ·'))).toBe(false)
  })

  it('names YouTube in words when the icon cannot load, and never redraws it', async () => {
    await renderCommentHighlightCards(youtube, null, { width: 1280, height: 720 }, undefined, {
      loadYoutubeMark: async () => null,
      warn: vi.fn()
    })
    expect(calls.filter((call) => call.method === 'drawImage')).toHaveLength(0)
    const names = calls.filter((call) => call.method === 'fillText').map((call) => call.args[0])
    expect(names).toContain('YouTube · Orc Dev')
  })
})

// Plan 167: an X card shows the mark from X's partner kit on the identity
// row (never the old stroked "×" over the avatar), and a verified author gets
// X's own check right after the name.
describe('renderCommentHighlightCards X mark and verified check (plan 167)', () => {
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  })
  afterEach(() => vi.unstubAllGlobals())

  const xMessage = { ...message, platform: 'x' } as LiveChatMessage
  const mark = { width: 300, height: 300, name: 'x-mark' } as unknown as HighlightBitmap
  const check = { width: 300, height: 300, name: 'check' } as unknown as HighlightBitmap

  it('draws X’s mark at 20 px or more on every leg, right of the name, and no avatar badge', async () => {
    const loadBrandMark = vi.fn(async (url: string) => (url === X_LOGO_WHITE_URL ? mark : check))
    await renderCommentHighlightCards(
      xMessage,
      null,
      { width: 1280, height: 720 },
      { width: 1080, height: 1920 },
      { loadBrandMark, warn: vi.fn() }
    )
    expect(loadBrandMark).toHaveBeenCalledTimes(1)
    expect(loadBrandMark).toHaveBeenCalledWith(X_LOGO_WHITE_URL)
    const marks = calls.filter((call) => call.method === 'drawImage' && call.args[0] === mark)
    expect(marks).toHaveLength(2)
    const nameCalls = calls.filter((call) => call.method === 'fillText')
    const nameX = Number(nameCalls.find((call) => call.args[0] === 'Orc Dev')?.args[1])
    for (const { args } of marks) {
      // The whole kit file (its 24 px grid), square, never cropped.
      expect(args).toHaveLength(5)
      const [x, , width, height] = args.slice(1).map(Number)
      expect(height).toBeGreaterThanOrEqual(20)
      expect(width).toBe(height)
      expect(x).toBeGreaterThan(nameX)
    }
    expect(nameCalls.some((call) => String(call.args[0]).includes('X ·'))).toBe(false)
    // No hand-drawn badge: nothing is stroked or filled as an arc.
    expect(calls.filter((call) => call.method === 'stroke')).toHaveLength(2)
    expect(calls.filter((call) => call.method === 'arc')).toHaveLength(2)
  })

  it('names X in words when the mark cannot load, and never redraws it', async () => {
    await renderCommentHighlightCards(xMessage, null, { width: 1280, height: 720 }, undefined, {
      loadBrandMark: async () => null,
      warn: vi.fn()
    })
    expect(calls.filter((call) => call.method === 'drawImage')).toHaveLength(0)
    const names = calls.filter((call) => call.method === 'fillText').map((call) => call.args[0])
    expect(names).toContain('X · Orc Dev')
  })

  it('draws X’s own check right after the name for each verified type', async () => {
    for (const verified of ['blue', 'business', 'government'] as const) {
      calls.length = 0
      const loaded: string[] = []
      await renderCommentHighlightCards(
        { ...xMessage, authorVerified: verified },
        null,
        { width: 1280, height: 720 },
        { width: 1080, height: 1920 },
        {
          loadBrandMark: async (url) => {
            loaded.push(url)
            return url === X_LOGO_WHITE_URL ? mark : check
          },
          warn: vi.fn()
        }
      )
      expect(loaded, verified).toEqual([X_LOGO_WHITE_URL, X_VERIFIED_URL[verified]])
      const checks = calls.filter((call) => call.method === 'drawImage' && call.args[0] === check)
      expect(checks, verified).toHaveLength(2)
      const nameCall = calls.find((call) => call.method === 'fillText' && call.args[0] === 'Orc Dev')
      const marks = calls.filter((call) => call.method === 'drawImage' && call.args[0] === mark)
      for (const [index, { args }] of checks.entries()) {
        const [x, , width, height] = args.slice(1).map(Number)
        expect(width).toBe(height)
        expect(height).toBeGreaterThanOrEqual(16)
        expect(x).toBeGreaterThan(Number(nameCall?.args[1]))
        // The check sits between the name and the X mark.
        expect(x + width).toBeLessThan(Number(marks[index].args[1]))
      }
    }
  })

  it('shows no check for an unverified author or when the file cannot load', async () => {
    const loadBrandMark = vi.fn(async (url: string) => (url === X_LOGO_WHITE_URL ? mark : null))
    await renderCommentHighlightCards(
      { ...xMessage, authorVerified: 'blue' },
      null,
      { width: 1280, height: 720 },
      undefined,
      { loadBrandMark, warn: vi.fn() }
    )
    expect(calls.filter((call) => call.method === 'drawImage')).toHaveLength(1)
    calls.length = 0
    await renderCommentHighlightCards(xMessage, null, { width: 1280, height: 720 }, undefined, {
      loadBrandMark,
      warn: vi.fn()
    })
    expect(calls.filter((call) => call.method === 'drawImage')).toHaveLength(1)
  })
})
