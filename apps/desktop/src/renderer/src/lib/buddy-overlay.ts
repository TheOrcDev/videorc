import type {
  CohostAvatarState,
  CohostBubbleStyle,
  CohostPersona,
  OverlayRect
} from '@/lib/backend'
import { BUDDY_DEFAULT_PACK } from '@/lib/buddy-default-pack'

// The Golem's comic bubble (plan 164 Phase C, D17), rasterized per output
// canvas like the highlight card (`lib/comment-highlight.ts`). On stream the
// backend draws the pet itself (plan 168 S-B1) and this module pushes the
// bubble alone to the `buddy_overlay` slot through `buddy.overlay.set`
// (`renderBuddyBubblePng`): its tail tip sits on the bitmap's bottom-centre,
// which the backend puts on the pet's head (D16). The settings sample still
// draws plan 164's composite, the avatar under its bubble
// (`renderBuddyOverlayPng`). The avatar box is the placed rect's width (a
// square), the bubble wraps to at most four lines at that width. The stream
// is not themed: the bubble is always the light variant, primary ink on
// porcelain with a hairline ring.
//
// Pure layout lives here (unit-tested with a fake measurer and snapshotted
// paint logs); the OffscreenCanvas painter is a thin shell. This module rides
// the lazy Golem chunks only (it imports the default pack); the target plan
// the Studio needs eagerly lives in `buddy-overlay-targets.ts`.

export const BUDDY_BUBBLE_MAX_LINES = 4
/** 18 px of text on a 1920x1080 canvas, scaled by the canvas's LONG edge so a
 * 1080x1920 portrait leg (watched on a phone) gets the same type as its
 * landscape twin instead of a width-based size (the highlight card's rule). */
const BUDDY_FONT_FRACTION = 18 / 1920
const BUDDY_FONT_MIN_PX = 14
/** The bubble's porcelain and ink (videorc-design light column; D17). */
export const BUDDY_BUBBLE_FILL = '#FAFAFB'
export const BUDDY_BUBBLE_INK = '#0D0D0F'
export const BUDDY_BUBBLE_RING = 'rgba(0, 0, 0, 0.25)'
const BUDDY_BUBBLE_SHADOW = 'rgba(0, 0, 0, 0.35)'

export type BuddyFontWeight = 500 | 700
export type BuddyTextMeasurer = (text: string, fontPx: number, weight: BuddyFontWeight) => number

export interface BuddyOverlayMetrics {
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
  weight: BuddyFontWeight
}

export function buddyBubbleFontWeight(style: CohostBubbleStyle): BuddyFontWeight {
  return style === 'shout' ? 700 : 500
}

export function buddyOverlayMetrics(
  canvasWidth: number,
  canvasHeight: number,
  rectWidthPx: number,
  style: CohostBubbleStyle
): BuddyOverlayMetrics {
  const longEdge = Math.max(canvasWidth, canvasHeight, 1)
  const fontPx = Math.max(BUDDY_FONT_MIN_PX, Math.round(longEdge * BUDDY_FONT_FRACTION))
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
    weight: buddyBubbleFontWeight(style)
  }
}

/** Greedy word wrap capped at BUDDY_BUBBLE_MAX_LINES; a word wider than the
 * bubble breaks by character; overflow keeps the HEAD with a trailing
 * ellipsis. A shout is set in capitals. */
export function wrapBuddyBubbleText(
  text: string,
  metrics: BuddyOverlayMetrics,
  measure: BuddyTextMeasurer,
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
    if (lines.length < BUDDY_BUBBLE_MAX_LINES) lines.push(line)
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
    const last = lines[BUDDY_BUBBLE_MAX_LINES - 1] ?? ''
    let chars = Array.from(last)
    while (chars.length > 1 && !fits(`${chars.join('')}…`)) chars = chars.slice(0, -1)
    lines[BUDDY_BUBBLE_MAX_LINES - 1] = `${chars.join('').trimEnd()}…`
  }
  return lines.slice(0, BUDDY_BUBBLE_MAX_LINES)
}

export interface BuddyPoint {
  x: number
  y: number
}

export interface BuddyBox {
  x: number
  y: number
  w: number
  h: number
}

export interface BuddyOverlayLayout {
  metrics: BuddyOverlayMetrics
  style: CohostBubbleStyle
  lines: string[]
  /** The bubble's box in bitmap pixels; null without text. */
  bubble: BuddyBox | null
  /** Speech: a triangle. Shout: a long spike. Thought: nothing here (see `thoughtDots`). */
  tail: BuddyPoint[]
  /** Thought bubbles trail two circles toward the avatar. */
  thoughtDots: Array<{ cx: number; cy: number; r: number }>
  /** The avatar box (square, the rect's width). */
  avatar: BuddyBox
  /** Bitmap size. */
  width: number
  height: number
}

/** Lay out the bubble over the avatar for one canvas. `rectWidthPx` is the
 * placed rect's width on that canvas (the avatar's width). */
export function layoutBuddyOverlay(params: {
  text: string | null
  style: CohostBubbleStyle
  canvasWidth: number
  canvasHeight: number
  rectWidthPx: number
  measure: BuddyTextMeasurer
}): BuddyOverlayLayout {
  const metrics = buddyOverlayMetrics(
    params.canvasWidth,
    params.canvasHeight,
    params.rectWidthPx,
    params.style
  )
  const lines = params.text
    ? wrapBuddyBubbleText(params.text, metrics, params.measure, params.style)
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
  const bubble: BuddyBox = {
    x: padPx + Math.round((avatarPx - bubbleW) / 2),
    y: padPx,
    w: bubbleW,
    h: bubbleH
  }
  const tailTop = bubble.y + bubble.h
  const avatarY = tailTop + metrics.tailPx + metrics.gapPx
  const avatar: BuddyBox = { x: padPx, y: avatarY, w: avatarPx, h: avatarPx }
  const avatarCenterX = avatar.x + avatar.w / 2
  const tail: BuddyPoint[] = []
  const thoughtDots: BuddyOverlayLayout['thoughtDots'] = []
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

/**
 * The bubble alone for the stream (plan 168 D16): plan 164's layout without
 * the avatar, cut at the tail's tip plus its gap, so the bitmap's
 * bottom-centre is where the tail points. The backend places that point on
 * the pet's head. Null without text.
 */
export function layoutBuddyBubble(
  params: Parameters<typeof layoutBuddyOverlay>[0]
): BuddyOverlayLayout | null {
  const layout = layoutBuddyOverlay(params)
  if (!layout.bubble) return null
  return { ...layout, height: layout.avatar.y }
}

/** The jagged outline of a shout bubble: spikes around its box. */
export function shoutBubblePoints(bubble: BuddyBox, spikePx: number): BuddyPoint[] {
  const inset = spikePx
  const inner: BuddyBox = {
    x: bubble.x + inset,
    y: bubble.y + inset,
    w: bubble.w - inset * 2,
    h: bubble.h - inset * 2
  }
  const step = spikePx * 2.2
  const points: BuddyPoint[] = []
  const edge = (from: BuddyPoint, to: BuddyPoint, outward: BuddyPoint, first: boolean): void => {
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
export interface BuddyImage {
  source: CanvasImageSource
  width: number
  height: number
}

function buddyCanvasFont(fontPx: number, weight: BuddyFontWeight): string {
  return `${weight} ${fontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
}

function tracePath(context: OffscreenCanvasRenderingContext2D, points: BuddyPoint[]): void {
  context.beginPath()
  points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y)
    else context.lineTo(point.x, point.y)
  })
  context.closePath()
}

/** Paint the laid-out overlay: the bubble (fill, ring, tail), the lines of
 * text and the avatar "contained" in its square, bottom-aligned. */
export function paintBuddyOverlay(
  context: OffscreenCanvasRenderingContext2D,
  layout: BuddyOverlayLayout,
  image: BuddyImage | null
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
    context.shadowColor = BUDDY_BUBBLE_SHADOW
    context.shadowBlur = metrics.fontPx * 0.5
    context.shadowOffsetY = metrics.fontPx * 0.1
    shape()
    context.fillStyle = BUDDY_BUBBLE_FILL
    context.fill()
    context.restore()
    if (layout.tail.length > 0) {
      tracePath(context, layout.tail)
      context.fillStyle = BUDDY_BUBBLE_FILL
      context.fill()
      context.strokeStyle = BUDDY_BUBBLE_RING
      context.lineWidth = metrics.ringPx
      context.lineJoin = 'round'
      context.stroke()
    }
    // The ring, then the body again so the tail's inner edge disappears.
    shape()
    context.strokeStyle = BUDDY_BUBBLE_RING
    context.lineWidth = metrics.ringPx
    context.lineJoin = 'round'
    context.stroke()
    shape()
    context.fillStyle = BUDDY_BUBBLE_FILL
    context.fill()
    for (const dot of layout.thoughtDots) {
      context.beginPath()
      context.arc(dot.cx, dot.cy, dot.r, 0, Math.PI * 2)
      context.fillStyle = BUDDY_BUBBLE_FILL
      context.fill()
      context.strokeStyle = BUDDY_BUBBLE_RING
      context.lineWidth = metrics.ringPx
      context.stroke()
    }
    context.font = buddyCanvasFont(metrics.fontPx, metrics.weight)
    context.fillStyle = BUDDY_BUBBLE_INK
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

function buddyCanvasMeasurer(): BuddyTextMeasurer | null {
  const probe = new OffscreenCanvas(1, 1)
  const context = probe.getContext('2d')
  if (!context) return null
  return (text, fontPx, weight) => {
    context.font = buddyCanvasFont(fontPx, weight)
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
export async function renderBuddyOverlayPng(params: {
  image: BuddyImage | null
  bubble: string | null
  style: CohostBubbleStyle
  canvas: { width: number; height: number }
  rect: OverlayRect
}): Promise<string | null> {
  const measure = buddyCanvasMeasurer()
  if (!measure) return null
  const layout = layoutBuddyOverlay({
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
  paintBuddyOverlay(context, layout, params.image)
  return canvasToBase64Png(canvas)
}

/**
 * Render the bubble for one output canvas to a PNG (base64, no data: prefix),
 * wrapped to the width of `rect` on that canvas, its tail tip on the bitmap's
 * bottom-centre (plan 168 D16). Null without text or a 2D canvas.
 */
export async function renderBuddyBubblePng(params: {
  bubble: string
  style: CohostBubbleStyle
  canvas: { width: number; height: number }
  rect: OverlayRect
}): Promise<string | null> {
  const measure = buddyCanvasMeasurer()
  if (!measure) return null
  const layout = layoutBuddyBubble({
    text: params.bubble,
    style: params.style,
    canvasWidth: params.canvas.width,
    canvasHeight: params.canvas.height,
    rectWidthPx: Math.floor(params.rect.w * params.canvas.width),
    measure
  })
  if (!layout) return null
  const canvas = new OffscreenCanvas(Math.max(1, layout.width), Math.max(1, layout.height))
  const context = canvas.getContext('2d')
  if (!context) return null
  paintBuddyOverlay(context, layout, null)
  return canvasToBase64Png(canvas)
}

// --- Images -----------------------------------------------------------------

export interface BuddyImageDeps {
  /** The bytes of a persona's own file (`<personaId>/<state>.<ext>`) through
   * main (the renderer cannot fetch the managed scheme, plan 095 S3). */
  readImage: (relativePath: string) => Promise<Uint8Array | null>
  /** Decode bytes (PNG, WebP, JPEG) to a drawable image. */
  decode: (bytes: Uint8Array) => Promise<BuddyImage>
  /** Load a same-origin URL (the bundled default pack's SVG). */
  loadUrl: (url: string) => Promise<BuddyImage>
  warn?: (line: string) => void
}

const defaultBuddyImageDeps: BuddyImageDeps = {
  readImage: (relativePath) =>
    window.videorc?.readBuddyImage?.(relativePath) ?? Promise.resolve(null),
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
export function buddyOwnImagePath(
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
export async function loadBuddyStateImage(
  persona: Pick<CohostPersona, 'images'>,
  state: CohostAvatarState,
  deps: Partial<BuddyImageDeps> = {}
): Promise<BuddyImage> {
  const resolved = { ...defaultBuddyImageDeps, ...deps }
  const own = buddyOwnImagePath(persona, state)
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
  return resolved.loadUrl(BUDDY_DEFAULT_PACK[state])
}
