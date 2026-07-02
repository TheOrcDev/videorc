// Burn-in caption bar rasterizer: turns a caption line into a glass-styled
// PNG the backend composites into the stream leg (captions.overlay.set).
// Layout is pure (measurement injected) so wrapping/sizing is unit-testable;
// the canvas painter is a thin shell over it.

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

export function captionBarMetrics(canvasWidth: number, textSize: CaptionTextSize): CaptionBarMetrics {
  const fontPx = Math.max(24, Math.round((canvasWidth / 38) * SIZE_FACTOR[textSize]))
  const paddingXPx = Math.round(fontPx * 0.9)
  return {
    fontPx,
    lineHeightPx: Math.round(fontPx * 1.3),
    paddingXPx,
    paddingYPx: Math.round(fontPx * 0.55),
    radiusPx: Math.round(fontPx * 0.6),
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

/**
 * Render the caption bar to a PNG (base64, no data: prefix) at the video's
 * output width. Glass solid-fallback look: translucent charcoal, hairline
 * ring, panel radius, primary-white text. Returns null for empty text.
 */
export async function renderCaptionOverlayPng(params: {
  text: string
  canvasWidth: number
  textSize: CaptionTextSize
}): Promise<string | null> {
  const probe = new OffscreenCanvas(1, 1)
  const probeContext = probe.getContext('2d')
  if (!probeContext) {
    return null
  }
  const fontFor = (fontPx: number): string =>
    `500 ${fontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`
  const measure: TextMeasurer = (text, fontPx) => {
    probeContext.font = fontFor(fontPx)
    return probeContext.measureText(text).width
  }

  const layout = layoutCaptionBar({ ...params, measure })
  if (!layout) {
    return null
  }

  const canvas = new OffscreenCanvas(layout.barWidthPx, layout.barHeightPx)
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }
  const { metrics } = layout

  // Glass solid fallback (videorc-design): translucent charcoal + hairline.
  context.beginPath()
  context.roundRect(0.5, 0.5, layout.barWidthPx - 1, layout.barHeightPx - 1, metrics.radiusPx)
  context.fillStyle = 'rgba(28, 28, 31, 0.85)'
  context.fill()
  context.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  context.lineWidth = 1
  context.stroke()

  context.font = fontFor(metrics.fontPx)
  context.fillStyle = '#F4F4F5'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  layout.lines.forEach((line, index) => {
    context.fillText(
      line,
      layout.barWidthPx / 2,
      metrics.paddingYPx + metrics.lineHeightPx * (index + 0.5),
      layout.barWidthPx - metrics.paddingXPx
    )
  })

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
