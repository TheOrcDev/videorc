import type {
  CohostAvatarState,
  CohostBubbleStyle,
  CohostPersona,
  OverlayRect
} from '@/lib/backend'
import { GOLEM_DEFAULT_PACK } from '@/lib/golem-default-pack'

// The Golem on stream (plan 164 Phase C, D17): the avatar's state image with
// a comic bubble above it, rasterized per output canvas like the highlight
// card (`lib/comment-highlight.ts`) and pushed to the backend's `golem_overlay`
// slot through `golem.overlay.set`. The avatar fills the placed rect's width
// (a square box), the bubble sits above it with a tail pointing at the
// avatar's top and wraps to at most four lines at the rect's width. The
// stream is not themed: the bubble is always the light variant, primary ink
// on porcelain with a hairline ring.
//
// Pure layout lives here (unit-tested with a fake measurer and snapshotted
// paint logs); the OffscreenCanvas painter is a thin shell. This module rides
// the lazy Golem chunks only (it imports the default pack); the target plan
// the Studio needs eagerly lives in `golem-overlay-targets.ts`.

export const GOLEM_BUBBLE_MAX_LINES = 4
/** 18 px of text on a 1920x1080 canvas, scaled by the canvas's LONG edge so a
 * 1080x1920 portrait leg (watched on a phone) gets the same type as its
 * landscape twin instead of a width-based size (the highlight card's rule). */
const GOLEM_FONT_FRACTION = 18 / 1920
const GOLEM_FONT_MIN_PX = 14
/** The bubble's porcelain and ink (videorc-design light column; D17). */
export const GOLEM_BUBBLE_FILL = '#FAFAFB'
export const GOLEM_BUBBLE_INK = '#0D0D0F'
export const GOLEM_BUBBLE_RING = 'rgba(0, 0, 0, 0.25)'
const GOLEM_BUBBLE_SHADOW = 'rgba(0, 0, 0, 0.35)'

export type GolemFontWeight = 500 | 700
export type GolemTextMeasurer = (text: string, fontPx: number, weight: GolemFontWeight) => number

export interface GolemOverlayMetrics {
  fontPx: number
  lineHeightPx: number
  paddingPx: number
  radiusPx: number
  ringPx: number
  tailPx: number
  /** Space between the tail's tip and the avatar's top. */
  gapPx: number
  /** The avatar box: a square the width of the placed rect. */
  avatarPx: number
  /** Shadow room around the bitmap. */
  padPx: number
  maxTextWidthPx: number
  weight: GolemFontWeight
}

export function golemBubbleFontWeight(style: CohostBubbleStyle): GolemFontWeight {
  return style === 'shout' ? 700 : 500
}

export function golemOverlayMetrics(
  canvasWidth: number,
  canvasHeight: number,
  rectWidthPx: number,
  style: CohostBubbleStyle
): GolemOverlayMetrics {
  const longEdge = Math.max(canvasWidth, canvasHeight, 1)
  const fontPx = Math.max(GOLEM_FONT_MIN_PX, Math.round(longEdge * GOLEM_FONT_FRACTION))
  const paddingPx = Math.round(fontPx * 0.7)
  const avatarPx = Math.max(1, Math.floor(Math.min(rectWidthPx, canvasWidth)))
  return {
    fontPx,
    lineHeightPx: Math.round(fontPx * 1.25),
    paddingPx,
    radiusPx: Math.round(fontPx * (style === 'thought' ? 1.4 : 0.7)),
    ringPx: Math.max(1, Math.round(fontPx / 10)),
    tailPx: Math.round(fontPx * 0.9),
    gapPx: Math.round(fontPx * 0.2),
    avatarPx,
    padPx: Math.round(fontPx * 0.6),
    maxTextWidthPx: avatarPx - paddingPx * 2,
    weight: golemBubbleFontWeight(style)
  }
}

/** Greedy word wrap capped at GOLEM_BUBBLE_MAX_LINES; a word wider than the
 * bubble breaks by character; overflow keeps the HEAD with a trailing
 * ellipsis. A shout is set in capitals. */
export function wrapGolemBubbleText(
  text: string,
  metrics: GolemOverlayMetrics,
  measure: GolemTextMeasurer,
  style: CohostBubbleStyle
): string[] {
  const source = style === 'shout' ? text.toUpperCase() : text
  const words = source.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0 || metrics.maxTextWidthPx < metrics.fontPx) return []
  const fits = (candidate: string): boolean =>
    measure(candidate, metrics.fontPx, metrics.weight) <= metrics.maxTextWidthPx
  const lines: string[] = []
  let current = ''
  let overflow = false
  const push = (line: string): void => {
    if (lines.length < GOLEM_BUBBLE_MAX_LINES) lines.push(line)
    else overflow = true
  }
  for (const word of words) {
    if (overflow) break
    const candidate = current ? `${current} ${word}` : word
    if (fits(candidate)) {
      current = candidate
      continue
    }
    if (current) push(current)
    if (fits(word)) {
      current = word
      continue
    }
    // A single word wider than the bubble: break it by character.
    let piece = ''
    for (const char of Array.from(word)) {
      if (fits(piece + char)) {
        piece += char
      } else {
        if (piece) push(piece)
        piece = char
      }
    }
    current = piece
  }
  if (current) push(current)
  if (overflow) {
    const last = lines[GOLEM_BUBBLE_MAX_LINES - 1] ?? ''
    let chars = Array.from(last)
    while (chars.length > 1 && !fits(`${chars.join('')}…`)) chars = chars.slice(0, -1)
    lines[GOLEM_BUBBLE_MAX_LINES - 1] = `${chars.join('').trimEnd()}…`
  }
  return lines.slice(0, GOLEM_BUBBLE_MAX_LINES)
}

export interface GolemPoint {
  x: number
  y: number
}

export interface GolemBox {
  x: number
  y: number
  w: number
  h: number
}

export interface GolemOverlayLayout {
  metrics: GolemOverlayMetrics
  style: CohostBubbleStyle
  lines: string[]
  /** The bubble's box in bitmap pixels; null without text. */
  bubble: GolemBox | null
  /** Speech: a triangle. Shout: a long spike. Thought: nothing here (see `thoughtDots`). */
  tail: GolemPoint[]
  /** Thought bubbles trail two circles toward the avatar. */
  thoughtDots: Array<{ cx: number; cy: number; r: number }>
  /** The avatar box (square, the rect's width). */
  avatar: GolemBox
  /** Bitmap size. */
  width: number
  height: number
}

/** Lay out the bubble over the avatar for one canvas. `rectWidthPx` is the
 * placed rect's width on that canvas (the avatar's width). */
export function layoutGolemOverlay(params: {
  text: string | null
  style: CohostBubbleStyle
  canvasWidth: number
  canvasHeight: number
  rectWidthPx: number
  measure: GolemTextMeasurer
}): GolemOverlayLayout {
  const metrics = golemOverlayMetrics(
    params.canvasWidth,
    params.canvasHeight,
    params.rectWidthPx,
    params.style
  )
  const lines = params.text
    ? wrapGolemBubbleText(params.text, metrics, params.measure, params.style)
    : []
  const { padPx, avatarPx } = metrics
  const width = avatarPx + padPx * 2
  if (lines.length === 0) {
    return {
      metrics,
      style: params.style,
      lines: [],
      bubble: null,
      tail: [],
      thoughtDots: [],
      avatar: { x: padPx, y: padPx, w: avatarPx, h: avatarPx },
      width,
      height: avatarPx + padPx * 2
    }
  }
  const widest = lines.reduce(
    (max, line) => Math.max(max, params.measure(line, metrics.fontPx, metrics.weight)),
    0
  )
  const contentWidth = Math.min(Math.max(widest, metrics.fontPx * 3), metrics.maxTextWidthPx)
  const bubbleW = Math.ceil(contentWidth + metrics.paddingPx * 2)
  const bubbleH = Math.ceil(lines.length * metrics.lineHeightPx + metrics.paddingPx * 2)
  const bubble: GolemBox = {
    x: padPx + Math.round((avatarPx - bubbleW) / 2),
    y: padPx,
    w: bubbleW,
    h: bubbleH
  }
  const tailTop = bubble.y + bubble.h
  const avatarY = tailTop + metrics.tailPx + metrics.gapPx
  const avatar: GolemBox = { x: padPx, y: avatarY, w: avatarPx, h: avatarPx }
  const avatarCenterX = avatar.x + avatar.w / 2
  const tail: GolemPoint[] = []
  const thoughtDots: GolemOverlayLayout['thoughtDots'] = []
  const tipY = tailTop + metrics.tailPx
  if (params.style === 'speech') {
    // The tail's base sits on the bubble's bottom edge, its tip points at
    // the avatar's top.
    tail.push(
      { x: avatarCenterX - metrics.tailPx * 0.75, y: tailTop - metrics.ringPx },
      { x: avatarCenterX + metrics.tailPx * 0.35, y: tailTop - metrics.ringPx },
      { x: avatarCenterX, y: tipY }
    )
  } else if (params.style === 'shout') {
    tail.push(
      { x: avatarCenterX - metrics.tailPx * 0.55, y: tailTop - metrics.ringPx },
      { x: avatarCenterX + metrics.tailPx * 0.25, y: tailTop - metrics.ringPx },
      { x: avatarCenterX - metrics.tailPx * 0.1, y: tipY }
    )
  } else {
    const big = metrics.tailPx * 0.34
    const small = metrics.tailPx * 0.2
    thoughtDots.push(
      { cx: avatarCenterX - metrics.fontPx * 0.5, cy: tailTop + big + metrics.ringPx, r: big },
      { cx: avatarCenterX - metrics.fontPx * 1.1, cy: tipY - small, r: small }
    )
  }
  return {
    metrics,
    style: params.style,
    lines,
    bubble,
    tail,
    thoughtDots,
    avatar,
    width,
    height: avatarY + avatarPx + padPx
  }
}

/** The jagged outline of a shout bubble: spikes around its box. */
export function shoutBubblePoints(bubble: GolemBox, spikePx: number): GolemPoint[] {
  const inset = spikePx
  const inner: GolemBox = {
    x: bubble.x + inset,
    y: bubble.y + inset,
    w: bubble.w - inset * 2,
    h: bubble.h - inset * 2
  }
  const step = spikePx * 2.2
  const points: GolemPoint[] = []
  const edge = (from: GolemPoint, to: GolemPoint, outward: GolemPoint, first: boolean): void => {
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    const count = Math.max(1, Math.round(length / step))
    for (let index = 0; index < count; index += 1) {
      const t0 = index / count
      const t1 = (index + 0.5) / count
      if (index > 0 || first) {
        points.push({ x: from.x + (to.x - from.x) * t0, y: from.y + (to.y - from.y) * t0 })
      }
      points.push({
        x: from.x + (to.x - from.x) * t1 + outward.x * spikePx,
        y: from.y + (to.y - from.y) * t1 + outward.y * spikePx
      })
    }
  }
  const topLeft = { x: inner.x, y: inner.y }
  const topRight = { x: inner.x + inner.w, y: inner.y }
  const bottomRight = { x: inner.x + inner.w, y: inner.y + inner.h }
  const bottomLeft = { x: inner.x, y: inner.y + inner.h }
  edge(topLeft, topRight, { x: 0, y: -1 }, true)
  edge(topRight, bottomRight, { x: 1, y: 0 }, true)
  edge(bottomRight, bottomLeft, { x: 0, y: 1 }, true)
  edge(bottomLeft, topLeft, { x: -1, y: 0 }, true)
  return points.map((point) => ({ x: round1(point.x), y: round1(point.y) }))
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

// --- Painting ---------------------------------------------------------------

/** A decoded avatar image with its pixel size (an `ImageBitmap` for the
 * persona's own files, an `HTMLImageElement` for the bundled SVG pack). */
export interface GolemImage {
  source: CanvasImageSource
  width: number
  height: number
}

function golemCanvasFont(fontPx: number, weight: GolemFontWeight): string {
  return `${weight} ${fontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
}

function tracePath(context: OffscreenCanvasRenderingContext2D, points: GolemPoint[]): void {
  context.beginPath()
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y)
    else context.lineTo(point.x, point.y)
  })
  context.closePath()
}

/** Paint the laid-out overlay: the bubble (fill, ring, tail), the lines of
 * text and the avatar "contained" in its square, bottom-aligned. */
export function paintGolemOverlay(
  context: OffscreenCanvasRenderingContext2D,
  layout: GolemOverlayLayout,
  image: GolemImage | null
): void {
  const { metrics, bubble } = layout
  if (bubble) {
    const shape = (): void => {
      if (layout.style === 'shout') {
        tracePath(context, shoutBubblePoints(bubble, Math.round(metrics.fontPx * 0.45)))
      } else {
        context.beginPath()
        context.roundRect(bubble.x, bubble.y, bubble.w, bubble.h, metrics.radiusPx)
      }
    }
    // Shadow on the body only; the tail and dots are flat so the join stays clean.
    context.save()
    context.shadowColor = GOLEM_BUBBLE_SHADOW
    context.shadowBlur = metrics.fontPx * 0.5
    context.shadowOffsetY = metrics.fontPx * 0.1
    shape()
    context.fillStyle = GOLEM_BUBBLE_FILL
    context.fill()
    context.restore()
    if (layout.tail.length > 0) {
      tracePath(context, layout.tail)
      context.fillStyle = GOLEM_BUBBLE_FILL
      context.fill()
      context.strokeStyle = GOLEM_BUBBLE_RING
      context.lineWidth = metrics.ringPx
      context.lineJoin = 'round'
      context.stroke()
    }
    // The ring, then the body again so the tail's inner edge disappears.
    shape()
    context.strokeStyle = GOLEM_BUBBLE_RING
    context.lineWidth = metrics.ringPx
    context.lineJoin = 'round'
    context.stroke()
    shape()
    context.fillStyle = GOLEM_BUBBLE_FILL
    context.fill()
    for (const dot of layout.thoughtDots) {
      context.beginPath()
      context.arc(dot.cx, dot.cy, dot.r, 0, Math.PI * 2)
      context.fillStyle = GOLEM_BUBBLE_FILL
      context.fill()
      context.strokeStyle = GOLEM_BUBBLE_RING
      context.lineWidth = metrics.ringPx
      context.stroke()
    }
    context.font = golemCanvasFont(metrics.fontPx, metrics.weight)
    context.fillStyle = GOLEM_BUBBLE_INK
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    const centerX = bubble.x + bubble.w / 2
    layout.lines.forEach((line, index) => {
      const y = bubble.y + metrics.paddingPx + metrics.lineHeightPx * (index + 0.5)
      context.fillText(line, centerX, y, metrics.maxTextWidthPx)
    })
  }
  if (image && image.width > 0 && image.height > 0) {
    const box = layout.avatar
    const scale = Math.min(box.w / image.width, box.h / image.height)
    const drawW = Math.round(image.width * scale)
    const drawH = Math.round(image.height * scale)
    context.drawImage(
      image.source,
      box.x + Math.round((box.w - drawW) / 2),
      box.y + box.h - drawH,
      drawW,
      drawH
    )
  }
}

function golemCanvasMeasurer(): GolemTextMeasurer | null {
  const probe = new OffscreenCanvas(1, 1)
  const context = probe.getContext('2d')
  if (!context) return null
  return (text, fontPx, weight) => {
    context.font = golemCanvasFont(fontPx, weight)
    return context.measureText(text).width
  }
}

async function canvasToBase64Png(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const buffer = await blob.arrayBuffer()
  let binary = ''
  const view = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/**
 * Render the Golem for one output canvas to a PNG (base64, no data: prefix):
 * the avatar in a square the width of `rect` on that canvas, the bubble
 * above it when `bubble` is set. Null when the host has no 2D canvas.
 */
export async function renderGolemOverlayPng(params: {
  image: GolemImage | null
  bubble: string | null
  style: CohostBubbleStyle
  canvas: { width: number; height: number }
  rect: OverlayRect
}): Promise<string | null> {
  const measure = golemCanvasMeasurer()
  if (!measure) return null
  const layout = layoutGolemOverlay({
    text: params.bubble,
    style: params.style,
    canvasWidth: params.canvas.width,
    canvasHeight: params.canvas.height,
    rectWidthPx: Math.floor(params.rect.w * params.canvas.width),
    measure
  })
  const canvas = new OffscreenCanvas(Math.max(1, layout.width), Math.max(1, layout.height))
  const context = canvas.getContext('2d')
  if (!context) return null
  paintGolemOverlay(context, layout, params.image)
  return canvasToBase64Png(canvas)
}

// --- Images -----------------------------------------------------------------

export interface GolemImageDeps {
  /** The bytes of a persona's own file (`<personaId>/<state>.<ext>`) through
   * main (the renderer cannot fetch the managed scheme, plan 095 S3). */
  readImage: (relativePath: string) => Promise<Uint8Array | null>
  /** Decode bytes (PNG, WebP, JPEG) to a drawable image. */
  decode: (bytes: Uint8Array) => Promise<GolemImage>
  /** Load a same-origin URL (the bundled default pack's SVG). */
  loadUrl: (url: string) => Promise<GolemImage>
  warn?: (line: string) => void
}

const defaultGolemImageDeps: GolemImageDeps = {
  readImage: (relativePath) =>
    window.videorc?.readGolemImage?.(relativePath) ?? Promise.resolve(null),
  decode: async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]))
    return { source: bitmap, width: bitmap.width, height: bitmap.height }
  },
  loadUrl: async (url) => {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return { source: image, width: image.naturalWidth, height: image.naturalHeight }
  },
  warn: (line) => console.warn(line)
}

/** The image path a persona uses for a state: its own file for that state,
 * else its own idle (D16), else null (the bundled pack takes over). */
export function golemOwnImagePath(
  persona: Pick<CohostPersona, 'images'>,
  state: CohostAvatarState
): string | null {
  return persona.images[state] ?? persona.images.idle ?? null
}

/**
 * The drawable image for a persona's state: its own file when it has one and
 * it decodes, else the bundled default pack's image for that state (D19).
 * A failed own file is logged once with its reason and never blocks the
 * overlay.
 */
export async function loadGolemStateImage(
  persona: Pick<CohostPersona, 'images'>,
  state: CohostAvatarState,
  deps: Partial<GolemImageDeps> = {}
): Promise<GolemImage> {
  const resolved = { ...defaultGolemImageDeps, ...deps }
  const own = golemOwnImagePath(persona, state)
  if (own) {
    try {
      const bytes = await resolved.readImage(own)
      if (bytes) return await resolved.decode(bytes)
      resolved.warn?.(`Golem overlay: ${own} has no file; using the default ${state} image.`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      resolved.warn?.(
        `Golem overlay: ${own} could not be decoded (${reason}); using the default ${state} image.`
      )
    }
  }
  return resolved.loadUrl(GOLEM_DEFAULT_PACK[state])
}
