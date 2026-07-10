// Burn-in caption bar rasterizer: turns a caption line into a glass-styled
// PNG the backend composites into the stream leg (captions.overlay.set).
// Layout is pure (measurement injected) so wrapping/sizing is unit-testable;
// the canvas painter is a thin shell over it.

import { commentHighlightPlatformBadge, layoutCommentHighlight } from '@/lib/comment-highlight'

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

export interface CaptionBarLayout {
  metrics: CaptionBarMetrics
  lines: string[]
  barWidthPx: number
  barHeightPx: number
}

export type TextMeasurer = (text: string, fontPx: number) => number

const SIZE_FACTOR: Record<CaptionTextSize, number> = { s: 0.8, m: 1.0, l: 1.25 }
/** The bar never exceeds this fraction of the video width. */
const MAX_BAR_WIDTH_FRACTION = 0.92
export const MAX_CAPTION_BAR_LINES = 2

export function captionBarMetrics(
  canvasWidth: number,
  textSize: CaptionTextSize
): CaptionBarMetrics {
  const fontPx = Math.max(24, Math.round((canvasWidth / 40) * SIZE_FACTOR[textSize]))
  const paddingXPx = Math.round(fontPx * 0.72)
  return {
    fontPx,
    lineHeightPx: Math.round(fontPx * 1.32),
    paddingXPx,
    paddingYPx: Math.round(fontPx * 0.4),
    // Panel-tier corners (videorc-design): ~13px at 1080p — a caption panel,
    // never a pill button.
    radiusPx: Math.round(fontPx * 0.26),
    maxTextWidthPx: Math.floor(canvasWidth * MAX_BAR_WIDTH_FRACTION) - paddingXPx * 2
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
  textSize: CaptionTextSize
  measure: TextMeasurer
}): CaptionBarLayout | null {
  const metrics = captionBarMetrics(params.canvasWidth, params.textSize)
  const lines = wrapCaptionText(params.text, metrics, params.measure)
  if (lines.length === 0) {
    return null
  }
  const widest = Math.max(...lines.map((line) => params.measure(line, metrics.fontPx)))
  const barWidthPx = Math.min(
    Math.ceil(widest) + metrics.paddingXPx * 2,
    Math.floor(params.canvasWidth * MAX_BAR_WIDTH_FRACTION)
  )
  const barHeightPx = metrics.paddingYPx * 2 + metrics.lineHeightPx * lines.length
  return { metrics, lines, barWidthPx, barHeightPx }
}

/** Vertical safe margin the compositor uses — mirrored for burned frames. */
export const CAPTION_FRAME_MARGIN_FRACTION = 0.04

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
  const margin =
    Math.round(params.canvasHeight * CAPTION_FRAME_MARGIN_FRACTION) + (params.shadowPadPx ?? 0)
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
  fontFor: (fontPx: number) => string,
  originX: number,
  originY: number
): void {
  const { metrics } = layout
  // Glass panel over video (videorc-design solid fallback): translucent
  // charcoal that FLOATS — soft elevation shadow, inner-top sheen, hairline
  // ring — instead of a flat pill.
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, 0.4)'
  context.shadowBlur = metrics.fontPx * 0.45
  context.shadowOffsetY = metrics.fontPx * 0.1
  context.beginPath()
  context.roundRect(originX, originY, layout.barWidthPx, layout.barHeightPx, metrics.radiusPx)
  context.fillStyle = 'rgba(16, 16, 18, 0.78)'
  context.fill()
  context.restore()

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

  // Crisp text with a whisper of shadow so it survives bright video.
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, 0.45)'
  context.shadowBlur = metrics.fontPx * 0.08
  context.shadowOffsetY = Math.max(1, Math.round(metrics.fontPx * 0.03))
  context.font = fontFor(metrics.fontPx)
  context.fillStyle = '#F5F5F7'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  layout.lines.forEach((line, index) => {
    context.fillText(
      line,
      originX + layout.barWidthPx / 2,
      originY + metrics.paddingYPx + metrics.lineHeightPx * (index + 0.5),
      layout.barWidthPx - metrics.paddingXPx
    )
  })
  context.restore()
}

function canvasFont(fontPx: number): string {
  return `600 ${fontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
}

function canvasMeasurer(): { measure: TextMeasurer } | null {
  const probe = new OffscreenCanvas(1, 1)
  const probeContext = probe.getContext('2d')
  if (!probeContext) {
    return null
  }
  return {
    measure: (text, fontPx) => {
      probeContext.font = canvasFont(fontPx)
      return probeContext.measureText(text).width
    }
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
  textSize: CaptionTextSize
}): Promise<string | null> {
  const measurer = canvasMeasurer()
  if (!measurer) {
    return null
  }
  const layout = layoutCaptionBar({ ...params, measure: measurer.measure })
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
    const measurer = canvasMeasurer()
    if (!measurer) {
      return null
    }
    const layout = layoutCaptionBar({
      text: params.text,
      canvasWidth: params.canvasWidth,
      textSize: params.textSize,
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
 * data: prefix): the same glass treatment as the caption bar, with an avatar
 * circle (monogram fallback), the author name, and up to three text lines.
 * Best-effort: a failed avatar load still renders the card.
 */
export async function renderCommentHighlightPng(params: {
  authorName: string
  text: string
  avatarUrl: string | null
  canvasWidth: number
  platform?: import('@/lib/backend').StreamPlatform
}): Promise<string | null> {
  // Q8 (plan 022): use-studio already imports comment-highlight statically, so
  // the dynamic import here never split a chunk (Vite warned) — import it
  // statically like every other consumer.
  const { monogramInitials } = await import('@/lib/chat-avatar')
  const measurer = canvasMeasurer()
  if (!measurer) {
    return null
  }
  const layout = layoutCommentHighlight({ ...params, measure: measurer.measure })
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
  let avatarDrawn = false
  if (params.avatarUrl) {
    try {
      const response = await fetch(params.avatarUrl)
      if (response.ok) {
        const bitmap = await createImageBitmap(await response.blob())
        context.drawImage(bitmap, avatarX, avatarY, metrics.avatarPx, metrics.avatarPx)
        avatarDrawn = true
      }
    } catch {
      // Monogram fallback below.
    }
  }
  if (!avatarDrawn) {
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
  if (platformBadge) {
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
    context.strokeStyle = '#FFFFFF'
    context.fillStyle = '#FFFFFF'
    context.lineWidth = Math.max(1.5, badgeSize * 0.1)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    const centerX = badgeX + badgeSize / 2
    const centerY = badgeY + badgeSize / 2
    if (platformBadge.glyph === 'play') {
      context.beginPath()
      context.moveTo(centerX - badgeSize * 0.12, centerY - badgeSize * 0.2)
      context.lineTo(centerX + badgeSize * 0.2, centerY)
      context.lineTo(centerX - badgeSize * 0.12, centerY + badgeSize * 0.2)
      context.closePath()
      context.fill()
    } else if (platformBadge.glyph === 'x') {
      context.beginPath()
      context.moveTo(centerX - badgeSize * 0.18, centerY - badgeSize * 0.22)
      context.lineTo(centerX + badgeSize * 0.18, centerY + badgeSize * 0.22)
      context.moveTo(centerX + badgeSize * 0.16, centerY - badgeSize * 0.22)
      context.lineTo(centerX - badgeSize * 0.16, centerY + badgeSize * 0.22)
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

  // Name + comment text.
  const textX = avatarX + metrics.avatarPx + metrics.paddingPx
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, 0.45)'
  context.shadowBlur = metrics.textFontPx * 0.08
  context.shadowOffsetY = Math.max(1, Math.round(metrics.textFontPx * 0.03))
  context.textAlign = 'left'
  context.textBaseline = 'top'
  context.font = canvasFont(metrics.nameFontPx)
  context.fillStyle = '#F5F5F7'
  context.fillText(layout.name, textX, originY + metrics.paddingPx)
  context.font = `400 ${metrics.textFontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
  context.fillStyle = 'rgba(244, 244, 245, 0.92)'
  const textTop =
    originY + metrics.paddingPx + metrics.nameFontPx + Math.round(metrics.textFontPx * 0.35)
  layout.textLines.forEach((line, index) => {
    context.fillText(line, textX, textTop + metrics.lineHeightPx * index, metrics.maxTextWidthPx)
  })
  context.restore()

  return canvasToBase64Png(canvas)
}
