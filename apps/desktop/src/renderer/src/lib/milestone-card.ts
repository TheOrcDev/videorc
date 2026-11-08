import {
  fitHighlightName,
  highlightMetrics,
  HIGHLIGHT_NAME_WEIGHT,
  HIGHLIGHT_TEXT_WEIGHT,
  type HighlightMetrics,
  type HighlightTextMeasurer
} from '@/lib/comment-highlight'

// The milestone card (plan 225 D9, B6): the highlight card's renderer
// variant for a person's milestone. It draws the avatar, the name, the
// milestone ("10th stream") and the persona's mark, and never the message
// text: the API has no text input, so it cannot. Pure layout lives here
// (unit-tested); `caption-overlay.ts` paints it with the highlight card's
// glass recipe, on both canvases.

/** The milestone line is a little larger than a message line. */
const LABEL_SCALE = 1.2
/** The avatar is the card's picture, bigger than a comment's identity avatar. */
const AVATAR_SCALE = 1.6
/** The persona's mark ("with Buddy") is small and quiet. */
const FOOTER_SCALE = 0.8

export interface MilestoneCardLayout {
  metrics: HighlightMetrics
  cardWidthPx: number
  cardHeightPx: number
  avatarPx: number
  /** The name as drawn, ellipsized to the card. */
  name: string
  nameFontPx: number
  /** "10th stream". */
  label: string
  labelFontPx: number
  /** "with Buddy", or empty for no persona. */
  footer: string
  footerFontPx: number
  /** Where the text column starts, from the card's left edge. */
  textX: number
  /** The rows' baselines (middle), from the card's top edge. */
  nameY: number
  labelY: number
  footerY: number
}

/**
 * Lay the milestone card out for one canvas. Text scales off the canvas's
 * long edge like the comment card, so the vertical leg reads the same on a
 * phone; the card never passes the placed rect's width (`maxCardWidthPx`)
 * or the comment card's fraction of the canvas.
 */
export function layoutMilestoneCard(params: {
  name: string
  label: string
  personaName?: string | null
  canvasWidth: number
  canvasHeight?: number
  maxCardWidthPx?: number
  measure: HighlightTextMeasurer
}): MilestoneCardLayout | null {
  const label = params.label.trim()
  if (!label) return null
  const metrics = highlightMetrics(params.canvasWidth, params.canvasHeight, params.maxCardWidthPx)
  const avatarPx = Math.round(metrics.avatarPx * AVATAR_SCALE)
  const labelFontPx = Math.round(metrics.textFontPx * LABEL_SCALE)
  const footerFontPx = Math.round(metrics.textFontPx * FOOTER_SCALE)
  const persona = params.personaName?.trim() ?? ''
  const footer = persona ? `with ${persona}` : ''
  const textX = metrics.paddingPx + avatarPx + metrics.identityGapPx
  const maxTextWidthPx = Math.max(
    1,
    metrics.maxTextWidthPx + metrics.paddingPx * 2 - textX - metrics.paddingPx
  )
  const name = fitHighlightName(
    params.name.trim() || 'Viewer',
    metrics.nameFontPx,
    maxTextWidthPx,
    params.measure
  )
  const nameWidthPx = params.measure(name, metrics.nameFontPx, HIGHLIGHT_NAME_WEIGHT)
  const labelWidthPx = Math.min(
    maxTextWidthPx,
    params.measure(label, labelFontPx, HIGHLIGHT_NAME_WEIGHT)
  )
  const footerWidthPx = footer
    ? Math.min(maxTextWidthPx, params.measure(footer, footerFontPx, HIGHLIGHT_TEXT_WEIGHT))
    : 0
  const textWidthPx = Math.max(nameWidthPx, labelWidthPx, footerWidthPx)
  const cardWidthPx = Math.round(textX + textWidthPx + metrics.paddingPx)
  const nameLinePx = Math.round(metrics.nameFontPx * 1.25)
  const labelLinePx = Math.round(labelFontPx * 1.25)
  const footerLinePx = footer ? Math.round(footerFontPx * 1.3) : 0
  const textHeightPx = nameLinePx + labelLinePx + footerLinePx
  const columnPx = Math.max(avatarPx, textHeightPx)
  const cardHeightPx = Math.round(metrics.paddingPx * 2 + columnPx)
  const textTop = metrics.paddingPx + Math.round((columnPx - textHeightPx) / 2)
  return {
    metrics,
    cardWidthPx,
    cardHeightPx,
    avatarPx,
    name,
    nameFontPx: metrics.nameFontPx,
    label,
    labelFontPx,
    footer,
    footerFontPx,
    textX,
    nameY: textTop + Math.round(nameLinePx / 2),
    labelY: textTop + nameLinePx + Math.round(labelLinePx / 2),
    footerY: textTop + nameLinePx + labelLinePx + Math.round(footerLinePx / 2)
  }
}
