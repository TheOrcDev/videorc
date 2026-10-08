// Burn-in caption bar rasterizer: turns a caption line into a glass-styled
// PNG the backend composites into the stream leg (captions.overlay.set).
// Layout is pure (measurement injected) so wrapping/sizing is unit-testable;
// the canvas painter is a thin shell over it.

import {
  commentHighlightPlatformBadge,
  HIGHLIGHT_NAME_WEIGHT,
  HIGHLIGHT_TEXT_WEIGHT,
  type HighlightTextMeasurer
} from '@/lib/comment-highlight'
import {
  highlightEmoteImageUrl,
  highlightEmoteUrls,
  highlightTokens,
  layoutCommentHighlightTokens,
  type HighlightEmoteSizer
} from '@/lib/comment-highlight-layout'
import { activityItems } from '@/lib/stream-activity'
import { YOUTUBE_ARTBOARD, YOUTUBE_ICON_URL, YOUTUBE_MARK } from '@/lib/youtube-mark'
import type { CaptionStyleId, LiveChatMessageFragment } from '@/lib/backend'
import { COMMENTS_HIGHLIGHT_TIMING_CONTRACT } from '../../../shared/comments-command-timing'

export type CaptionTextSize = 's' | 'm' | 'l'
export type CaptionPosition = 'top' | 'bottom'

export interface CaptionBarMetrics {
  fontPx: number
  lineHeightPx: number
  paddingXPx: number
  paddingYPx: number
  radiusPx: number
  maxTextWidthPx: number
}

export interface CaptionStyleDefinition {
  id: CaptionStyleId
  label: string
  description: string
  plate: 'none' | 'glass' | 'band' | 'solid'
  align: 'left' | 'center'
  fontWeight: 600 | 700
  maxWidthFraction: number
  wide: boolean
  lineHeightFactor: number
  paddingXFactor: number
  paddingYFactor: number
  radiusFactor: number
  backgroundColor: string
  textColor: string
  strokeColor?: string
  strokeWidthFactor?: number
}

export const CAPTION_STYLE_DEFINITIONS: Record<CaptionStyleId, CaptionStyleDefinition> = {
  classic: {
    id: 'classic',
    label: 'Classic',
    description: 'Clean outlined subtitles that stay legible over any video.',
    plate: 'none',
    align: 'center',
    fontWeight: 600,
    maxWidthFraction: 0.88,
    wide: false,
    lineHeightFactor: 1.28,
    paddingXFactor: 0.3,
    paddingYFactor: 0.24,
    radiusFactor: 0,
    backgroundColor: 'transparent',
    textColor: '#FFFFFF',
    strokeColor: 'rgba(0, 0, 0, 0.96)',
    strokeWidthFactor: 0.105
  },
  glass: {
    id: 'glass',
    label: 'Glass',
    description: 'Videorc black glass with a polished edge and soft elevation.',
    plate: 'glass',
    align: 'center',
    fontWeight: 600,
    maxWidthFraction: 0.92,
    wide: false,
    lineHeightFactor: 1.32,
    paddingXFactor: 0.72,
    paddingYFactor: 0.4,
    radiusFactor: 0.26,
    backgroundColor: 'rgba(16, 16, 18, 0.78)',
    textColor: '#F5F5F7'
  },
  'lower-third': {
    id: 'lower-third',
    label: 'Lower third',
    description: 'A wide, left-aligned broadcast band for conversations.',
    plate: 'band',
    align: 'left',
    fontWeight: 600,
    maxWidthFraction: 0.92,
    wide: true,
    lineHeightFactor: 1.3,
    paddingXFactor: 0.7,
    paddingYFactor: 0.34,
    radiusFactor: 0.12,
    backgroundColor: 'rgba(13, 13, 15, 0.9)',
    textColor: '#F5F5F7'
  },
  'high-contrast': {
    id: 'high-contrast',
    label: 'High contrast',
    description: 'Opaque black and bold white for maximum readability.',
    plate: 'solid',
    align: 'center',
    fontWeight: 700,
    maxWidthFraction: 0.88,
    wide: false,
    lineHeightFactor: 1.4,
    paddingXFactor: 0.62,
    paddingYFactor: 0.42,
    radiusFactor: 0.08,
    backgroundColor: '#050506',
    textColor: '#FFFFFF'
  }
}

export const CAPTION_STYLE_IDS = Object.keys(CAPTION_STYLE_DEFINITIONS) as CaptionStyleId[]

export function captionStyleDefinition(styleId: CaptionStyleId): CaptionStyleDefinition {
  return CAPTION_STYLE_DEFINITIONS[styleId]
}

export interface CaptionBarLayout {
  style: CaptionStyleDefinition
  metrics: CaptionBarMetrics
  lines: string[]
  barWidthPx: number
  barHeightPx: number
}

export type TextMeasurer = (text: string, fontPx: number) => number

const SIZE_FACTOR: Record<CaptionTextSize, number> = { s: 0.8, m: 1.0, l: 1.25 }
export const MAX_CAPTION_BAR_LINES = 2
/** A portrait bar stays narrow enough to clear the platform's right-hand
 *  action buttons (TikTok, Shorts, Reels). */
const PORTRAIT_MAX_BAR_WIDTH_FRACTION = 0.76

function isPortraitCanvas(canvasWidth: number, canvasHeight?: number): boolean {
  return canvasHeight !== undefined && canvasHeight > canvasWidth
}

function captionBarWidthFraction(style: CaptionStyleDefinition, portrait: boolean): number {
  return portrait
    ? Math.min(style.maxWidthFraction, PORTRAIT_MAX_BAR_WIDTH_FRACTION)
    : style.maxWidthFraction
}

/** Type sizes off the canvas LONG edge, so a 1080x1920 vertical bar reads on a
 *  phone like its 1920x1080 twin instead of shrinking to a width-based size
 *  (plan 077). `canvasHeight` omitted means landscape. */
export function captionBarMetrics(
  canvasWidth: number,
  textSize: CaptionTextSize,
  styleId: CaptionStyleId = 'glass',
  canvasHeight?: number
): CaptionBarMetrics {
  const style = captionStyleDefinition(styleId)
  const portrait = isPortraitCanvas(canvasWidth, canvasHeight)
  const scaleEdge = portrait ? (canvasHeight as number) : canvasWidth
  const fontPx = Math.max(24, Math.round((scaleEdge / 40) * SIZE_FACTOR[textSize]))
  const paddingXPx = Math.round(fontPx * style.paddingXFactor)
  return {
    fontPx,
    lineHeightPx: Math.round(fontPx * style.lineHeightFactor),
    paddingXPx,
    paddingYPx: Math.round(fontPx * style.paddingYFactor),
    radiusPx: Math.round(fontPx * style.radiusFactor),
    maxTextWidthPx:
      Math.floor(canvasWidth * captionBarWidthFraction(style, portrait)) - paddingXPx * 2
  }
}

/**
 * Greedy word wrap into at most MAX_CAPTION_BAR_LINES lines; overflow keeps
 * the TAIL of the text (captions read newest-last, so the freshest words win)
 * with a leading ellipsis.
 */
export function wrapCaptionText(
  text: string,
  metrics: CaptionBarMetrics,
  measure: TextMeasurer
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return []
  }

  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (current && measure(candidate, metrics.fontPx) > metrics.maxTextWidthPx) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  lines.push(current)

  if (lines.length <= MAX_CAPTION_BAR_LINES) {
    return lines
  }
  const kept = lines.slice(-MAX_CAPTION_BAR_LINES)
  kept[0] = `…${kept[0]}`
  return kept
}

export function layoutCaptionBar(params: {
  text: string
  canvasWidth: number
  /** Omitted = landscape. A portrait canvas gets the phone-sized bar. */
  canvasHeight?: number
  textSize: CaptionTextSize
  styleId?: CaptionStyleId
  measure: TextMeasurer
}): CaptionBarLayout | null {
  const style = captionStyleDefinition(params.styleId ?? 'glass')
  const metrics = captionBarMetrics(
    params.canvasWidth,
    params.textSize,
    style.id,
    params.canvasHeight
  )
  const lines = wrapCaptionText(params.text, metrics, params.measure)
  if (lines.length === 0) {
    return null
  }
  const widest = Math.max(...lines.map((line) => params.measure(line, metrics.fontPx)))
  const maxBarWidth = Math.floor(
    params.canvasWidth *
      captionBarWidthFraction(style, isPortraitCanvas(params.canvasWidth, params.canvasHeight))
  )
  const barWidthPx = style.wide
    ? maxBarWidth
    : Math.min(Math.ceil(widest) + metrics.paddingXPx * 2, maxBarWidth)
  const barHeightPx = metrics.paddingYPx * 2 + metrics.lineHeightPx * lines.length
  return { style, metrics, lines, barWidthPx, barHeightPx }
}

/** Vertical safe margin the compositor uses — mirrored for burned frames. */
export const CAPTION_FRAME_MARGIN_FRACTION = 0.04
/** Portrait platform safe area (TikTok, Shorts, Reels chrome), mirroring the
 *  compositor's PORTRAIT_OVERLAY_*_MARGIN (plan 077). */
export const PORTRAIT_FRAME_TOP_MARGIN_FRACTION = 0.08
export const PORTRAIT_FRAME_BOTTOM_MARGIN_FRACTION = 0.22

/** Transparent padding around the bar so the elevation shadow isn't clipped
 *  when the live overlay renders on a bar-sized bitmap. */
export function captionShadowPadPx(fontPx: number): number {
  return Math.ceil(fontPx * 0.65)
}

/** Where the bar sits inside a full frame (pure; unit-tested). */
export function captionBarFramePosition(params: {
  canvasWidth: number
  canvasHeight: number
  barWidthPx: number
  barHeightPx: number
  position: CaptionPosition
  /** Extra inset matching the live overlay's shadow padding, so the burned
   *  copy and the live bar sit at the same height. */
  shadowPadPx?: number
}): { x: number; y: number } {
  const fraction = !isPortraitCanvas(params.canvasWidth, params.canvasHeight)
    ? CAPTION_FRAME_MARGIN_FRACTION
    : params.position === 'top'
      ? PORTRAIT_FRAME_TOP_MARGIN_FRACTION
      : PORTRAIT_FRAME_BOTTOM_MARGIN_FRACTION
  const margin = Math.round(params.canvasHeight * fraction) + (params.shadowPadPx ?? 0)
  return {
    x: Math.round((params.canvasWidth - params.barWidthPx) / 2),
    y:
      params.position === 'top'
        ? margin
        : Math.max(0, params.canvasHeight - params.barHeightPx - margin)
  }
}

function paintCaptionBar(
  context: OffscreenCanvasRenderingContext2D,
  layout: CaptionBarLayout,
  fontFor: (fontPx: number, weight?: 600 | 700) => string,
  originX: number,
  originY: number
): void {
  const { metrics } = layout
  const { style } = layout
  if (style.plate !== 'none') {
    context.save()
    if (style.plate === 'glass') {
      context.shadowColor = 'rgba(0, 0, 0, 0.4)'
      context.shadowBlur = metrics.fontPx * 0.45
      context.shadowOffsetY = metrics.fontPx * 0.1
    }
    context.beginPath()
    context.roundRect(originX, originY, layout.barWidthPx, layout.barHeightPx, metrics.radiusPx)
    context.fillStyle = style.backgroundColor
    context.fill()
    context.restore()

    if (style.plate === 'glass') {
      const sheen = context.createLinearGradient(0, originY, 0, originY + layout.barHeightPx)
      sheen.addColorStop(0, 'rgba(255, 255, 255, 0.07)')
      sheen.addColorStop(0.35, 'rgba(255, 255, 255, 0.015)')
      sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
      context.beginPath()
      context.roundRect(originX, originY, layout.barWidthPx, layout.barHeightPx, metrics.radiusPx)
      context.fillStyle = sheen
      context.fill()
      context.beginPath()
      context.roundRect(
        originX + 0.5,
        originY + 0.5,
        layout.barWidthPx - 1,
        layout.barHeightPx - 1,
        metrics.radiusPx
      )
      context.strokeStyle = 'rgba(255, 255, 255, 0.1)'
      context.lineWidth = 1
      context.stroke()
    }
  }

  // Crisp text with a whisper of shadow so it survives bright video.
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, 0.58)'
  context.shadowBlur = metrics.fontPx * (style.plate === 'none' ? 0.12 : 0.08)
  context.shadowOffsetY = Math.max(1, Math.round(metrics.fontPx * 0.03))
  context.font = fontFor(metrics.fontPx, style.fontWeight)
  context.fillStyle = style.textColor
  context.textAlign = style.align
  context.textBaseline = 'middle'
  const textX =
    style.align === 'left' ? originX + metrics.paddingXPx : originX + layout.barWidthPx / 2
  layout.lines.forEach((line, index) => {
    const textY = originY + metrics.paddingYPx + metrics.lineHeightPx * (index + 0.5)
    if (style.strokeColor && style.strokeWidthFactor) {
      context.strokeStyle = style.strokeColor
      context.lineWidth = Math.max(2, metrics.fontPx * style.strokeWidthFactor)
      context.lineJoin = 'round'
      context.strokeText(line, textX, textY, layout.barWidthPx - metrics.paddingXPx * 2)
    }
    context.fillText(line, textX, textY, layout.barWidthPx - metrics.paddingXPx * 2)
  })
  context.restore()
}

function canvasFont(fontPx: number, weight: 400 | 600 | 700 = 600): string {
  return `${weight} ${fontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
}

function canvasMeasurer(styleId: CaptionStyleId = 'glass'): { measure: TextMeasurer } | null {
  const probe = new OffscreenCanvas(1, 1)
  const probeContext = probe.getContext('2d')
  if (!probeContext) {
    return null
  }
  return {
    measure: (text, fontPx) => {
      probeContext.font = canvasFont(fontPx, captionStyleDefinition(styleId).fontWeight)
      return probeContext.measureText(text).width
    }
  }
}

/** The highlight card's measurer: each run in the weight it is painted in
 * (the name semibold, the message regular), so emotes sit one space from the
 * words before them. */
function highlightCanvasMeasurer(): HighlightTextMeasurer | null {
  const probe = new OffscreenCanvas(1, 1)
  const probeContext = probe.getContext('2d')
  if (!probeContext) {
    return null
  }
  return (text, fontPx, weight) => {
    probeContext.font = canvasFont(fontPx, weight)
    return probeContext.measureText(text).width
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
 * Render the caption bar to a PNG (base64, no data: prefix) at the video's
 * output width. Returns null for empty text.
 */
export async function renderCaptionOverlayPng(params: {
  text: string
  canvasWidth: number
  /** Omitted = landscape. The vertical leg passes its portrait height. */
  canvasHeight?: number
  textSize: CaptionTextSize
  styleId?: CaptionStyleId
}): Promise<string | null> {
  const styleId = params.styleId ?? 'glass'
  const measurer = canvasMeasurer(styleId)
  if (!measurer) {
    return null
  }
  const layout = layoutCaptionBar({ ...params, styleId, measure: measurer.measure })
  if (!layout) {
    return null
  }
  const pad = captionShadowPadPx(layout.metrics.fontPx)
  const canvas = new OffscreenCanvas(layout.barWidthPx + pad * 2, layout.barHeightPx + pad * 2)
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }
  paintCaptionBar(context, layout, canvasFont, pad, pad)
  return canvasToBase64Png(canvas)
}

/**
 * Render one FULL-FRAME transparent PNG for the burned caption track (R2):
 * the bar composited at its on-video position inside a canvas-sized frame.
 * Empty text renders the blank (fully transparent) gap frame.
 */
export async function renderCaptionCueFramePng(params: {
  text: string
  canvasWidth: number
  canvasHeight: number
  position: CaptionPosition
  textSize: CaptionTextSize
  styleId?: CaptionStyleId
}): Promise<string | null> {
  const canvas = new OffscreenCanvas(
    Math.max(2, params.canvasWidth),
    Math.max(2, params.canvasHeight)
  )
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }
  if (params.text.trim().length > 0) {
    const styleId = params.styleId ?? 'glass'
    const measurer = canvasMeasurer(styleId)
    if (!measurer) {
      return null
    }
    const layout = layoutCaptionBar({
      text: params.text,
      canvasWidth: params.canvasWidth,
      canvasHeight: params.canvasHeight,
      textSize: params.textSize,
      styleId,
      measure: measurer.measure
    })
    if (layout) {
      const origin = captionBarFramePosition({
        canvasWidth: params.canvasWidth,
        canvasHeight: params.canvasHeight,
        barWidthPx: layout.barWidthPx,
        barHeightPx: layout.barHeightPx,
        position: params.position,
        shadowPadPx: captionShadowPadPx(layout.metrics.fontPx)
      })
      paintCaptionBar(context, layout, canvasFont, origin.x, origin.y)
    }
  }
  return canvasToBase64Png(canvas)
}

/**
 * Render a comment-highlight card (Comments upgrade S3) to a PNG (base64, no
 * data: prefix): the same glass treatment as the caption bar. Row one is the
 * identity row — a small avatar circle (monogram fallback) with the username
 * beside it — and up to three message lines sit below at full card width.
 * Best-effort: a failed avatar load still renders the card.
 */
/**
 * The highlight card's text. An activity event (a sub, a gift, a raid, a
 * Super Chat) leads with what happened, then the viewer's own words: the
 * event variant of the card (plan 055, S11). Plain chat is the message.
 */
export function commentHighlightCardText(message: import('@/lib/backend').LiveChatMessage): string {
  const item = message.details ? activityItems([message])[0] : undefined
  if (!item) return message.messageText
  return item.message ? `${item.line}: ${item.message}` : item.line
}

type HighlightCanvas = { width: number; height: number }

/** A decoded image the card paints: an ImageBitmap in the app, any sized
 * CanvasImageSource in tests. */
export type HighlightBitmap = CanvasImageSource & {
  readonly width: number
  readonly height: number
}

/** Reads one cached image's bytes from main (`avatars:read`). Injected so the
 * card renderer is unit-testable without Electron. */
export type HighlightImageReader = (localUrl: string) => Promise<Uint8Array | null | undefined>

/** Fetches a remote emote into main's allowlisted cache (`avatars:cache`)
 * and names the local URL, or null when main refused it. */
export type HighlightImageCacher = (remoteUrl: string) => Promise<string | null | undefined>

export interface HighlightCardImageDeps {
  readImage?: HighlightImageReader
  cacheImage?: HighlightImageCacher
  /** Decodes bytes to a bitmap; `createImageBitmap` in the app. */
  decode?: (bytes: Uint8Array) => Promise<HighlightBitmap>
  /** One line per failed image, with the reason. `console.warn` in the app. */
  warn?: (message: string) => void
  /** Every image for one card pair must decode within this slice. */
  deadlineMs?: number
  /** Loads YouTube's official icon for the identity row (plan 165). */
  loadYoutubeMark?: () => Promise<HighlightBitmap | null>
}

let youtubeMarkImage: Promise<HighlightBitmap | null> | null = null

/** YouTube's official icon file, decoded once per renderer. Drawn straight
 * from the vector file so it is sharp at every output size; null (logged) if
 * it cannot load, and the card then names YouTube in words instead. */
function loadYoutubeMarkImage(): Promise<HighlightBitmap | null> {
  youtubeMarkImage ??= (async () => {
    const image = new Image()
    image.src = YOUTUBE_ICON_URL
    await image.decode()
    return image
  })().catch((error: unknown) => {
    console.warn(`Highlight card: YouTube icon did not load (${describeImageFailure(error)}).`)
    youtubeMarkImage = null
    return null
  })
  return youtubeMarkImage
}

const defaultHighlightImageReader: HighlightImageReader = (localUrl) =>
  window.videorc?.readChatAvatar?.(localUrl) ?? Promise.resolve(null)

const defaultHighlightImageCacher: HighlightImageCacher = (remoteUrl) =>
  window.videorc?.cacheChatAvatar?.(remoteUrl) ?? Promise.resolve(null)

const defaultHighlightImageDecoder = (bytes: Uint8Array): Promise<HighlightBitmap> =>
  createImageBitmap(new Blob([bytes as BlobPart]))

class HighlightImageDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`not decoded within ${deadlineMs} ms`)
    this.name = 'HighlightImageDeadlineError'
  }
}

/**
 * Decode one cached image (`videorc-asset://avatar/<file>`) for the card.
 * The bytes come from main over IPC: the renderer cannot `fetch` the scheme
 * (no CORS; the owner's cards showed monograms on every platform, plan 095),
 * and a `videorc-asset:` <img> would taint the canvas so `convertToBlob`
 * throws. Rejects with the reason; the caller decides the fallback.
 */
async function decodeHighlightImage(
  localUrl: string,
  deps: Required<Pick<HighlightCardImageDeps, 'readImage' | 'decode' | 'deadlineMs'>>
): Promise<HighlightBitmap> {
  return withHighlightImageDeadline(deps.deadlineMs, async () => {
    const bytes = await deps.readImage(localUrl)
    if (!bytes || bytes.byteLength === 0) {
      throw new Error('main has no cached file for it')
    }
    return deps.decode(bytes)
  })
}

/** Cache (if needed) and decode one emote for the card (plan 095, S4). The
 * card asks for the sharper Twitch `/3.0`, which the chat row never cached,
 * so this may fetch; the whole fetch + decode shares one deadline. */
async function decodeHighlightEmote(
  remoteUrl: string,
  deps: Required<Pick<HighlightCardImageDeps, 'readImage' | 'cacheImage' | 'decode' | 'deadlineMs'>>
): Promise<HighlightBitmap> {
  return withHighlightImageDeadline(deps.deadlineMs, async () => {
    const localUrl = await deps.cacheImage(highlightEmoteImageUrl(remoteUrl))
    if (!localUrl) {
      throw new Error('main did not cache it')
    }
    const bytes = await deps.readImage(localUrl)
    if (!bytes || bytes.byteLength === 0) {
      throw new Error('main has no cached file for it')
    }
    return deps.decode(bytes)
  })
}

async function withHighlightImageDeadline<T>(
  deadlineMs: number,
  work: () => Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HighlightImageDeadlineError(deadlineMs)), deadlineMs)
  })
  try {
    return await Promise.race([work(), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The fragments the card draws emotes from. An activity card (a sub, a
 * raid) leads with the event line, so it stays text (plan 095, S4). */
function commentHighlightCardFragments(
  message: import('@/lib/backend').LiveChatMessage
): readonly LiveChatMessageFragment[] | undefined {
  return message.details ? undefined : message.fragments
}

function describeImageFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The card for the leg horizontal viewers watch and, when the backend reports
 * a vertical simulcast leg (`comments.highlight.canvases`), a second card
 * sized for its portrait canvas (plan 074). Null when the main card fails;
 * a failed vertical card still lets the horizontal one go on stream.
 *
 * Images are decoded ONCE here and shared by both cards: the avatar and up to
 * HIGHLIGHT_MAX_EMOTES distinct emotes, loaded in parallel inside the avatar
 * slice of the highlight timing contract. A failed avatar is logged once per
 * highlight with its reason and the card falls back to the monogram; failed
 * emotes are logged in one line and show their names as text. */
export async function renderCommentHighlightCards(
  message: import('@/lib/backend').LiveChatMessage,
  avatarUrl: string | null,
  stream: HighlightCanvas,
  vertical?: HighlightCanvas,
  imageDeps: HighlightCardImageDeps = {}
): Promise<{ pngBase64: string; verticalPngBase64?: string } | null> {
  const deps = {
    readImage: imageDeps.readImage ?? defaultHighlightImageReader,
    cacheImage: imageDeps.cacheImage ?? defaultHighlightImageCacher,
    decode: imageDeps.decode ?? defaultHighlightImageDecoder,
    deadlineMs: imageDeps.deadlineMs ?? COMMENTS_HIGHLIGHT_TIMING_CONTRACT.avatarFetchMs
  }
  const warn = imageDeps.warn ?? ((line: string) => console.warn(line))
  const youtubeMark =
    message.platform === 'youtube'
      ? await (imageDeps.loadYoutubeMark ?? loadYoutubeMarkImage)().catch(() => null)
      : null
  const text = commentHighlightCardText(message)
  const fragments = commentHighlightCardFragments(message)
  const tokens = highlightTokens(text, fragments)
  const emoteNames = new Map<string, string>()
  for (const token of tokens) {
    if (token.kind === 'emote') emoteNames.set(token.url, token.name)
  }
  const emotes = new Map<string, HighlightBitmap>()
  const emoteFailures: string[] = []
  const [avatar] = await Promise.all([
    avatarUrl
      ? decodeHighlightImage(avatarUrl, deps).catch((error: unknown) => {
          warn(
            `Highlight card: ${message.platform} avatar for ${message.authorName} fell back to the monogram (${describeImageFailure(error)}).`
          )
          return null
        })
      : null,
    ...highlightEmoteUrls(tokens).map(async (url) => {
      try {
        emotes.set(url, await decodeHighlightEmote(url, deps))
      } catch (error) {
        emoteFailures.push(`${emoteNames.get(url) ?? 'overlay'}: ${describeImageFailure(error)}`)
      }
    })
  ])
  if (emoteFailures.length > 0) {
    warn(
      `Highlight card: ${emoteFailures.length} emote(s) show as text (${emoteFailures.join('; ')}).`
    )
  }
  const render = (canvas: HighlightCanvas): Promise<string | null> =>
    renderCommentHighlightPng({
      authorName: message.authorName,
      text,
      fragments,
      avatar,
      emotes,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      platform: message.platform,
      platformMark: youtubeMark
    })
  const [pngBase64, verticalPngBase64] = await Promise.all([
    render(stream),
    vertical ? render(vertical) : null
  ])
  if (!pngBase64) return null
  return verticalPngBase64 ? { pngBase64, verticalPngBase64 } : { pngBase64 }
}

export async function renderCommentHighlightPng(params: {
  authorName: string
  text: string
  /** Emote fragments to draw inline (plan 095, S4); omitted draws `text`. */
  fragments?: readonly LiveChatMessageFragment[]
  /** Decoded by `renderCommentHighlightCards`; null paints the monogram. */
  avatar?: HighlightBitmap | null
  /** Decoded emote images by fragment URL; a missing one draws its name. */
  emotes?: ReadonlyMap<string, HighlightBitmap>
  canvasWidth: number
  /** Omitted = landscape. A portrait canvas gets the vertical-leg card. */
  canvasHeight?: number
  platform?: import('@/lib/backend').StreamPlatform
  /** YouTube's official icon (plan 165); omitted = the card names YouTube in
   * words. Drawn on the identity row, never over the avatar. */
  platformMark?: HighlightBitmap | null
}): Promise<string | null> {
  // Q8 (plan 022): use-studio already imports comment-highlight statically, so
  // the dynamic import here never split a chunk (Vite warned) — import it
  // statically like every other consumer.
  const { monogramInitials } = await import('@/lib/chat-avatar')
  const measure = highlightCanvasMeasurer()
  if (!measure) {
    return null
  }
  const emoteSize: HighlightEmoteSizer = (url) => {
    const bitmap = params.emotes?.get(url)
    return bitmap ? { width: bitmap.width, height: bitmap.height } : null
  }
  const layout = layoutCommentHighlightTokens({
    ...params,
    platformMark: Boolean(params.platformMark),
    measure,
    emoteSize
  })
  if (!layout) {
    return null
  }
  const { metrics } = layout
  const pad = Math.round(metrics.textFontPx * 0.6)
  const canvas = new OffscreenCanvas(layout.cardWidthPx + pad * 2, layout.cardHeightPx + pad * 2)
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }
  const originX = pad
  const originY = pad

  // Card: identical glass recipe to paintCaptionBar (shadow, sheen, hairline).
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, 0.4)'
  context.shadowBlur = metrics.textFontPx * 0.45
  context.shadowOffsetY = metrics.textFontPx * 0.1
  context.beginPath()
  context.roundRect(originX, originY, layout.cardWidthPx, layout.cardHeightPx, metrics.radiusPx)
  context.fillStyle = 'rgba(16, 16, 18, 0.78)'
  context.fill()
  context.restore()
  const sheen = context.createLinearGradient(0, originY, 0, originY + layout.cardHeightPx)
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.07)')
  sheen.addColorStop(0.35, 'rgba(255, 255, 255, 0.015)')
  sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
  context.beginPath()
  context.roundRect(originX, originY, layout.cardWidthPx, layout.cardHeightPx, metrics.radiusPx)
  context.fillStyle = sheen
  context.fill()
  context.beginPath()
  context.roundRect(
    originX + 0.5,
    originY + 0.5,
    layout.cardWidthPx - 1,
    layout.cardHeightPx - 1,
    metrics.radiusPx
  )
  context.strokeStyle = 'rgba(255, 255, 255, 0.1)'
  context.lineWidth = 1
  context.stroke()

  // Avatar circle (image when the local cache resolves, monogram otherwise).
  const avatarX = originX + metrics.paddingPx
  const avatarY = originY + metrics.paddingPx
  context.save()
  context.beginPath()
  context.arc(
    avatarX + metrics.avatarPx / 2,
    avatarY + metrics.avatarPx / 2,
    metrics.avatarPx / 2,
    0,
    Math.PI * 2
  )
  context.clip()
  if (params.avatar) {
    context.drawImage(params.avatar, avatarX, avatarY, metrics.avatarPx, metrics.avatarPx)
  } else {
    context.fillStyle = 'rgba(255, 255, 255, 0.12)'
    context.fillRect(avatarX, avatarY, metrics.avatarPx, metrics.avatarPx)
    context.font = canvasFont(Math.round(metrics.avatarPx * 0.42))
    context.fillStyle = '#A1A1AA'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(
      monogramInitials(params.authorName.trim() || 'Viewer'),
      avatarX + metrics.avatarPx / 2,
      avatarY + metrics.avatarPx / 2 + 1
    )
  }
  context.restore()

  // Platform glyph: compact brand-colored badge over the avatar. The identity
  // line also spells out the platform, preserving meaning in monochrome.
  const platformBadge = commentHighlightPlatformBadge(params.platform)
  if (platformBadge && platformBadge.glyph !== 'youtube-icon') {
    const badgeSize = Math.max(12, Math.round(metrics.avatarPx * 0.42))
    const badgeX = avatarX + metrics.avatarPx - badgeSize * 0.84
    const badgeY = avatarY + metrics.avatarPx - badgeSize * 0.84
    context.save()
    context.beginPath()
    context.arc(badgeX + badgeSize / 2, badgeY + badgeSize / 2, badgeSize / 2, 0, Math.PI * 2)
    context.fillStyle = platformBadge.color
    context.fill()
    context.strokeStyle = 'rgba(255, 255, 255, 0.28)'
    context.lineWidth = Math.max(1, Math.round(badgeSize * 0.06))
    context.stroke()
    context.strokeStyle = platformBadge.ink ?? '#FFFFFF'
    context.fillStyle = platformBadge.ink ?? '#FFFFFF'
    context.lineWidth = Math.max(1.5, badgeSize * 0.1)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    const centerX = badgeX + badgeSize / 2
    const centerY = badgeY + badgeSize / 2
    if (platformBadge.glyph === 'x') {
      context.beginPath()
      context.moveTo(centerX - badgeSize * 0.18, centerY - badgeSize * 0.22)
      context.lineTo(centerX + badgeSize * 0.18, centerY + badgeSize * 0.22)
      context.moveTo(centerX + badgeSize * 0.16, centerY - badgeSize * 0.22)
      context.lineTo(centerX - badgeSize * 0.16, centerY + badgeSize * 0.22)
      context.stroke()
    } else if (platformBadge.glyph === 'kick') {
      context.beginPath()
      context.moveTo(centerX - badgeSize * 0.14, centerY - badgeSize * 0.22)
      context.lineTo(centerX - badgeSize * 0.14, centerY + badgeSize * 0.22)
      context.moveTo(centerX + badgeSize * 0.16, centerY - badgeSize * 0.22)
      context.lineTo(centerX - badgeSize * 0.1, centerY)
      context.lineTo(centerX + badgeSize * 0.16, centerY + badgeSize * 0.22)
      context.stroke()
    } else if (platformBadge.glyph === 'twitch') {
      context.strokeRect(
        centerX - badgeSize * 0.2,
        centerY - badgeSize * 0.2,
        badgeSize * 0.4,
        badgeSize * 0.34
      )
      context.beginPath()
      context.moveTo(centerX - badgeSize * 0.06, centerY + badgeSize * 0.14)
      context.lineTo(centerX - badgeSize * 0.14, centerY + badgeSize * 0.24)
      context.stroke()
    } else {
      context.beginPath()
      context.arc(centerX, centerY, badgeSize * 0.12, 0, Math.PI * 2)
      context.fill()
    }
    context.restore()
  }

  // YouTube's official icon (plan 165): unmodified, at least 20 px tall,
  // centred on the identity row between the avatar and the name, on the
  // card's solid glass. Cropped to the mark's bounds inside the file.
  let markLeadPx = 0
  if (layout.platformMark && params.platformMark) {
    const mark = layout.platformMark
    const scaleX = params.platformMark.width / YOUTUBE_ARTBOARD.width
    const scaleY = params.platformMark.height / YOUTUBE_ARTBOARD.height
    context.drawImage(
      params.platformMark,
      YOUTUBE_MARK.x * scaleX,
      YOUTUBE_MARK.y * scaleY,
      YOUTUBE_MARK.width * scaleX,
      YOUTUBE_MARK.height * scaleY,
      avatarX + metrics.avatarPx + metrics.identityGapPx,
      Math.round(avatarY + (metrics.avatarPx - mark.heightPx) / 2),
      mark.widthPx,
      mark.heightPx
    )
    markLeadPx = mark.widthPx + metrics.identityGapPx
  }

  // Username beside the avatar (centred on it), message below from the card's
  // left padding.
  const nameX = avatarX + metrics.avatarPx + metrics.identityGapPx + markLeadPx
  const textX = originX + metrics.paddingPx
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, 0.45)'
  context.shadowBlur = metrics.textFontPx * 0.08
  context.shadowOffsetY = Math.max(1, Math.round(metrics.textFontPx * 0.03))
  context.textAlign = 'left'
  context.textBaseline = 'middle'
  context.font = canvasFont(metrics.nameFontPx, HIGHLIGHT_NAME_WEIGHT)
  context.fillStyle = '#F5F5F7'
  context.fillText(
    layout.name,
    nameX,
    avatarY + metrics.avatarPx / 2 + 1,
    Math.max(1, metrics.maxNameWidthPx - markLeadPx)
  )
  context.textBaseline = 'top'
  context.font = canvasFont(metrics.textFontPx, HIGHLIGHT_TEXT_WEIGHT)
  context.fillStyle = 'rgba(244, 244, 245, 0.92)'
  const textTop = avatarY + metrics.avatarPx + metrics.rowGapPx
  // With `textBaseline = 'top'` a line's glyphs centre about 0.58 em below
  // the line top; an emote box is centred on the same axis.
  const emoteAxisPx = metrics.textFontPx * 0.58
  layout.lines.forEach((line, index) => {
    const lineTop = textTop + metrics.lineHeightPx * index
    // Consecutive words are painted as one run, so a text-only card keeps
    // the font's own word spacing and kerning (what fillText did before).
    let run: { xPx: number; words: string[] } | null = null
    const flushRun = (): void => {
      if (!run) return
      context.fillText(
        run.words.join(' '),
        textX + run.xPx,
        lineTop,
        metrics.maxTextWidthPx - run.xPx
      )
      run = null
    }
    for (const item of line.items) {
      if (item.kind === 'word') {
        if (run) run.words.push(item.text)
        else run = { xPx: item.xPx, words: [item.text] }
        continue
      }
      flushRun()
      const x = textX + item.xPx
      const boxY = Math.round(lineTop + emoteAxisPx - item.heightPx / 2)
      // Zero-width overlays (7TV) share the base emote's box.
      for (const url of [item.url, ...item.overlays]) {
        const bitmap = params.emotes?.get(url)
        if (bitmap) context.drawImage(bitmap, x, boxY, item.widthPx, item.heightPx)
      }
    }
    flushRun()
  })
  context.restore()

  return canvasToBase64Png(canvas)
}
