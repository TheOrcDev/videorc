import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LiveChatMessage } from '@/lib/backend'
import { renderCommentHighlightCards, type HighlightBitmap } from './caption-overlay'

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
