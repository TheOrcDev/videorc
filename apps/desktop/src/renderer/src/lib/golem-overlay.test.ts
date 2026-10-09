import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostBubbleStyle } from '@/lib/backend'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'
import {
  GOLEM_BUBBLE_MAX_LINES,
  type GolemImage,
  golemOverlayMetrics,
  layoutGolemBubble,
  layoutGolemOverlay,
  loadGolemStateImage,
  paintGolemOverlay,
  renderGolemBubblePng,
  renderGolemOverlayPng,
  shoutBubblePoints,
  wrapGolemBubbleText
} from './golem-overlay'
import { golemOverlayKey, golemOverlayTargetPlan } from './golem-overlay-targets'

// The overlay is painted on an OffscreenCanvas, which the node test
// environment lacks. A recording 2D context stands in: it measures text at
// 0.55 em per character and logs every call and style set, so the snapshots
// below pin the exact paint of each bubble style on both canvases.

type Call = string

const calls: Call[] = []

const measure = (text: string, fontPx: number): number => text.length * fontPx * 0.55

function fmt(value: unknown): string {
  if (typeof value === 'number') return String(Math.round(value * 10) / 10)
  if (typeof value === 'string') return JSON.stringify(value)
  if (value && typeof value === 'object' && 'kind' in (value as object)) {
    return `<${(value as { kind: string }).kind}>`
  }
  return String(value)
}

function fakeContext(): OffscreenCanvasRenderingContext2D {
  let font = ''
  const target: Record<string, unknown> = {
    measureText: (text: string) => {
      const fontPx = Number(/(\d+)px/.exec(font)?.[1] ?? 16)
      return { width: measure(text, fontPx) }
    }
  }
  return new Proxy(target, {
    get(object, property: string) {
      if (property in object) return object[property]
      return (...args: unknown[]) => {
        calls.push(`${property}(${args.map(fmt).join(', ')})`)
      }
    },
    set(object, property: string, value) {
      // The measurer sets the font before every measurement; log a change only.
      const changed = object[property] !== value
      if (property === 'font') font = String(value)
      object[property] = value
      if (
        changed &&
        ['font', 'fillStyle', 'strokeStyle', 'lineWidth', 'textAlign'].includes(property)
      ) {
        calls.push(`${property} = ${fmt(value)}`)
      }
      return true
    }
  }) as unknown as OffscreenCanvasRenderingContext2D
}

class FakeOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number
  ) {
    calls.push(`canvas ${width}x${height}`)
  }

  getContext(): OffscreenCanvasRenderingContext2D {
    return fakeContext()
  }

  async convertToBlob(): Promise<Blob> {
    return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])])
  }
}

const avatar: GolemImage = {
  source: { kind: 'avatar' } as unknown as ImageBitmap,
  width: 512,
  height: 640
}

const STYLES: readonly CohostBubbleStyle[] = ['speech', 'thought', 'shout']
const CANVASES = [
  { width: 1920, height: 1080 },
  { width: 1080, height: 1920 }
] as const

describe('golemOverlayMetrics', () => {
  it('scales the type with the long edge and boxes the avatar at the rect width', () => {
    const landscape = golemOverlayMetrics(1920, 1080, 346, 'speech')
    expect(landscape.fontPx).toBe(18)
    expect(landscape.avatarPx).toBe(346)
    expect(landscape.maxTextWidthPx).toBe(346 - landscape.paddingPx * 2)
    // A portrait leg is watched on a phone: its 1920 long edge sets the
    // size, the same as its landscape twin.
    expect(golemOverlayMetrics(1080, 1920, 346, 'speech').fontPx).toBe(18)
    expect(golemOverlayMetrics(3840, 2160, 691, 'speech').fontPx).toBe(36)
    // Never under 14 px, never wider than the canvas.
    expect(golemOverlayMetrics(320, 180, 500, 'speech').fontPx).toBe(14)
    expect(golemOverlayMetrics(320, 180, 500, 'speech').avatarPx).toBe(320)
    expect(golemOverlayMetrics(1920, 1080, 346, 'shout').weight).toBe(700)
    expect(golemOverlayMetrics(1920, 1080, 346, 'thought').radiusPx).toBeGreaterThan(
      landscape.radiusPx
    )
  })
})

describe('wrapGolemBubbleText', () => {
  const metrics = golemOverlayMetrics(1920, 1080, 346, 'speech')

  it('wraps to at most four lines and keeps the head with an ellipsis', () => {
    const lines = wrapGolemBubbleText('word '.repeat(60).trim(), metrics, measure, 'speech')
    expect(lines).toHaveLength(GOLEM_BUBBLE_MAX_LINES)
    expect(lines[0]!.startsWith('word')).toBe(true)
    expect(lines.at(-1)).toMatch(/…$/)
    for (const line of lines) {
      expect(measure(line, metrics.fontPx)).toBeLessThanOrEqual(metrics.maxTextWidthPx)
    }
  })

  it('returns short text on one line, empties as no lines and shouts in capitals', () => {
    expect(wrapGolemBubbleText('gg', metrics, measure, 'speech')).toEqual(['gg'])
    expect(wrapGolemBubbleText('   ', metrics, measure, 'speech')).toEqual([])
    expect(wrapGolemBubbleText('welcome to the horde', metrics, measure, 'shout')).toEqual([
      'WELCOME TO THE HORDE'
    ])
  })

  it('breaks a word wider than the bubble by character', () => {
    const lines = wrapGolemBubbleText('a'.repeat(80), metrics, measure, 'speech')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(measure(line, metrics.fontPx)).toBeLessThanOrEqual(metrics.maxTextWidthPx)
    }
    expect(lines.join('')).toBe('a'.repeat(80))
  })

  it('draws no bubble when the rect is too narrow for a word', () => {
    const narrow = golemOverlayMetrics(1920, 1080, 40, 'speech')
    expect(wrapGolemBubbleText('hello', narrow, measure, 'speech')).toEqual([])
  })
})

describe('layoutGolemOverlay', () => {
  it('stacks the bubble, its tail and the avatar, and centres the bubble over the box', () => {
    const layout = layoutGolemOverlay({
      text: 'Welcome to the horde',
      style: 'speech',
      canvasWidth: 1920,
      canvasHeight: 1080,
      rectWidthPx: 346,
      measure
    })
    const { metrics } = layout
    expect(layout.bubble).not.toBeNull()
    expect(layout.bubble!.w).toBeLessThanOrEqual(metrics.avatarPx)
    expect(
      Math.abs(layout.bubble!.x + layout.bubble!.w / 2 - (layout.avatar.x + metrics.avatarPx / 2))
    ).toBeLessThanOrEqual(1)
    expect(layout.avatar.y).toBe(
      layout.bubble!.y + layout.bubble!.h + metrics.tailPx + metrics.gapPx
    )
    expect(layout.width).toBe(metrics.avatarPx + metrics.padPx * 2)
    expect(layout.height).toBe(layout.avatar.y + metrics.avatarPx + metrics.padPx)
    // The tail's tip points at the avatar's top centre.
    expect(layout.tail).toHaveLength(3)
    expect(layout.tail[2]!.x).toBe(layout.avatar.x + metrics.avatarPx / 2)
    expect(layout.tail[2]!.y).toBe(layout.avatar.y - metrics.gapPx)
    expect(layout.thoughtDots).toEqual([])
  })

  it('is the avatar alone without text, and trails dots for a thought', () => {
    const idle = layoutGolemOverlay({
      text: null,
      style: 'speech',
      canvasWidth: 1920,
      canvasHeight: 1080,
      rectWidthPx: 346,
      measure
    })
    expect(idle.bubble).toBeNull()
    expect(idle.lines).toEqual([])
    expect(idle.height).toBe(idle.metrics.avatarPx + idle.metrics.padPx * 2)
    const thought = layoutGolemOverlay({
      text: 'hmm',
      style: 'thought',
      canvasWidth: 1920,
      canvasHeight: 1080,
      rectWidthPx: 346,
      measure
    })
    expect(thought.tail).toEqual([])
    expect(thought.thoughtDots).toHaveLength(2)
    expect(thought.thoughtDots[0]!.r).toBeGreaterThan(thought.thoughtDots[1]!.r)
  })

  it('outlines a shout with spikes around its box', () => {
    const points = shoutBubblePoints({ x: 10, y: 10, w: 200, h: 60 }, 8)
    expect(points.length).toBeGreaterThan(12)
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(10)
    expect(Math.max(...xs)).toBeLessThanOrEqual(210)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10)
    expect(Math.max(...ys)).toBeLessThanOrEqual(70)
  })
})

describe('renderGolemOverlayPng snapshots (D17)', () => {
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  })
  afterEach(() => vi.unstubAllGlobals())

  for (const style of STYLES) {
    for (const canvas of CANVASES) {
      it(`paints a ${style} bubble at ${canvas.width}x${canvas.height}`, async () => {
        const rect =
          DEFAULT_OVERLAY_LAYOUT.golem[canvas.height > canvas.width ? 'vertical' : 'horizontal']
        const png = await renderGolemOverlayPng({
          image: avatar,
          bubble: 'Welcome to the horde, Ana! Grab a seat by the fire.',
          style,
          canvas,
          rect
        })
        expect(png).toBeTruthy()
        expect(calls.filter((call) => call.startsWith('drawImage('))).toHaveLength(1)
        const texts = calls.filter((call) => call.startsWith('fillText('))
        expect(texts.length).toBeGreaterThan(0)
        expect(texts.length).toBeLessThanOrEqual(GOLEM_BUBBLE_MAX_LINES)
        expect(calls.join('\n')).toMatchSnapshot()
      })
    }
  }

  it('paints the avatar alone between bubbles', () => {
    const layout = layoutGolemOverlay({
      text: null,
      style: 'speech',
      canvasWidth: 1920,
      canvasHeight: 1080,
      rectWidthPx: 346,
      measure
    })
    paintGolemOverlay(fakeContext(), layout, avatar)
    expect(calls).toEqual(['drawImage(<avatar>, 46, 11, 277, 346)'])
    calls.length = 0
    paintGolemOverlay(fakeContext(), layout, null)
    expect(calls).toEqual([])
  })
})

describe('the bubble alone for the stream (plan 168 D16)', () => {
  beforeEach(() => {
    calls.length = 0
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  })
  afterEach(() => vi.unstubAllGlobals())

  for (const style of STYLES) {
    it(`cuts the ${style} layout at the tail's tip plus its gap, centred`, () => {
      const params = {
        text: 'Welcome to the horde',
        style,
        canvasWidth: 1920,
        canvasHeight: 1080,
        rectWidthPx: 346,
        measure
      }
      const full = layoutGolemOverlay(params)
      const bubble = layoutGolemBubble(params)!
      expect(bubble.height).toBe(full.avatar.y)
      expect(bubble.width).toBe(full.width)
      // The bitmap's bottom-centre is where the tail points (the backend
      // puts it on the pet's head).
      expect(full.avatar.x + full.metrics.avatarPx / 2).toBe(bubble.width / 2)
      if (style === 'speech') {
        expect(bubble.tail[2]!.y + bubble.metrics.gapPx).toBe(bubble.height)
      }
      for (const dot of bubble.thoughtDots) {
        expect(dot.cy + dot.r).toBeLessThanOrEqual(bubble.height)
      }
    })
  }

  it('is nothing without text', () => {
    expect(
      layoutGolemBubble({
        text: null,
        style: 'speech',
        canvasWidth: 1920,
        canvasHeight: 1080,
        rectWidthPx: 346,
        measure
      })
    ).toBeNull()
  })

  it('paints the bubble and never the avatar', async () => {
    const png = await renderGolemBubblePng({
      bubble: 'Welcome to the horde, Ana!',
      style: 'speech',
      canvas: { width: 1920, height: 1080 },
      rect: DEFAULT_OVERLAY_LAYOUT.golem.horizontal
    })
    expect(png).toBeTruthy()
    expect(calls.some((call) => call.startsWith('drawImage('))).toBe(false)
    expect(calls.filter((call) => call.startsWith('fillText(')).length).toBeGreaterThan(0)
    // The first canvas is the text measurer's 1x1 probe; the last is the bitmap.
    const canvas = calls.filter((call) => call.startsWith('canvas ')).at(-1)
    const layout = layoutGolemBubble({
      text: 'Welcome to the horde, Ana!',
      style: 'speech',
      canvasWidth: 1920,
      canvasHeight: 1080,
      rectWidthPx: Math.floor(DEFAULT_OVERLAY_LAYOUT.golem.horizontal.w * 1920),
      measure
    })!
    expect(canvas).toBe(`canvas ${layout.width}x${layout.height}`)
  })
})

describe('golemOverlayTargetPlan', () => {
  // The shipped default is opt-in (both switches off); these plans need it on.
  const layout = { ...DEFAULT_OVERLAY_LAYOUT.golem, showOnStream: true, showInRecording: true }
  const recording = { width: 1920, height: 1080 }
  const stream = { width: 1280, height: 720 }

  it('rasters the capture canvas, plus the stream leg while streaming', () => {
    expect(
      golemOverlayTargetPlan({
        streamEnabled: false,
        recordingVideo: recording,
        streamVideo: stream,
        layout
      })
    ).toEqual([
      { target: 'primary', canvasWidth: 1920, canvasHeight: 1080, rect: layout.horizontal }
    ])
    expect(
      golemOverlayTargetPlan({
        streamEnabled: true,
        recordingVideo: recording,
        streamVideo: stream,
        layout
      })
    ).toEqual([
      { target: 'primary', canvasWidth: 1920, canvasHeight: 1080, rect: layout.horizontal },
      { target: 'auxiliary', canvasWidth: 1280, canvasHeight: 720, rect: layout.horizontal }
    ])
  })

  it('gives the vertical leg its portrait rect and nothing when both switches are off', () => {
    expect(
      golemOverlayTargetPlan({
        streamEnabled: true,
        recordingVideo: recording,
        streamVideo: stream,
        verticalLeg: { width: 1080, height: 1920 },
        layout
      })[1]
    ).toEqual({ target: 'auxiliary', canvasWidth: 1080, canvasHeight: 1920, rect: layout.vertical })
    expect(
      golemOverlayTargetPlan({
        streamEnabled: true,
        recordingVideo: recording,
        streamVideo: stream,
        layout: { ...layout, showOnStream: false, showInRecording: false }
      })
    ).toEqual([])
  })

  it('keys every input that changes pixels', () => {
    const targets = golemOverlayTargetPlan({
      streamEnabled: false,
      recordingVideo: recording,
      streamVideo: stream,
      layout
    })
    const base = { bubble: null, style: 'speech' as const, targets }
    expect(golemOverlayKey(base)).toBe(golemOverlayKey({ ...base }))
    expect(golemOverlayKey(base)).not.toBe(golemOverlayKey({ ...base, bubble: 'hi' }))
    expect(golemOverlayKey(base)).not.toBe(golemOverlayKey({ ...base, style: 'shout' }))
    expect(golemOverlayKey(base)).not.toBe(golemOverlayKey({ ...base, targets: [] }))
  })
})

describe('loadGolemStateImage', () => {
  const own: GolemImage = { source: { kind: 'own' } as unknown as ImageBitmap, width: 1, height: 1 }
  const bundled: GolemImage = {
    source: { kind: 'svg' } as unknown as HTMLImageElement,
    width: 2,
    height: 2
  }

  it('decodes the persona file for the state, falling back to its idle, then the pack', async () => {
    const readImage = vi.fn(async () => new Uint8Array([1]))
    const decode = vi.fn(async () => own)
    const loadUrl = vi.fn(async () => bundled)
    const persona = { images: { idle: 'p1/idle.png', laugh: 'p1/laugh.webp' } }
    expect(await loadGolemStateImage(persona, 'laugh', { readImage, decode, loadUrl })).toBe(own)
    expect(readImage).toHaveBeenLastCalledWith('p1/laugh.webp')
    expect(await loadGolemStateImage(persona, 'talk', { readImage, decode, loadUrl })).toBe(own)
    expect(readImage).toHaveBeenLastCalledWith('p1/idle.png')
    expect(loadUrl).not.toHaveBeenCalled()
    expect(await loadGolemStateImage({ images: {} }, 'think', { readImage, decode, loadUrl })).toBe(
      bundled
    )
    expect(loadUrl).toHaveBeenCalledTimes(1)
  })

  it('uses the default pack and warns once when the own file is missing or corrupt', async () => {
    const warn = vi.fn()
    const loadUrl = vi.fn(async () => bundled)
    expect(
      await loadGolemStateImage({ images: { idle: 'p1/idle.png' } }, 'idle', {
        readImage: async () => null,
        decode: async () => own,
        loadUrl,
        warn
      })
    ).toBe(bundled)
    expect(warn.mock.calls[0]?.[0]).toMatch(/has no file/)
    expect(
      await loadGolemStateImage({ images: { idle: 'p1/idle.png' } }, 'idle', {
        readImage: async () => new Uint8Array([1]),
        decode: async () => {
          throw new Error('bad png')
        },
        loadUrl,
        warn
      })
    ).toBe(bundled)
    expect(warn.mock.calls[1]?.[0]).toMatch(/bad png/)
    expect(loadUrl).toHaveBeenCalledTimes(2)
  })
})
