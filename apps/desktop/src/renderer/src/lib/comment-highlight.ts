import type { CommentHighlightState, LiveChatMessage, StreamPlatform } from '@/lib/backend'

// Click-to-highlight (Comments upgrade S3): puts one message ON the stream as
// a glass card via the compositor's dedicated highlight slot, anchored to the
// corner the streamer picked. The card mirrors a Chat window row: an identity
// row (small avatar with the username beside it) and the message underneath at
// full card width. Pure layout + lifecycle live here (unit-tested); the canvas
// painter is a thin shell.

export const HIGHLIGHT_AUTO_DISMISS_MS = 10_000
export const HIGHLIGHT_MAX_TEXT_LINES = 3
/** The card never exceeds this fraction of the video width. */
const MAX_CARD_WIDTH_FRACTION = 0.6
/** A portrait canvas (the vertical simulcast leg, a vertical scene) is narrow
 * and watched on a phone: the card spans most of its width but, like the
 * caption bar, stays clear of the platform's right-hand buttons (plan 077). */
const MAX_PORTRAIT_CARD_WIDTH_FRACTION = 0.78

export function commentHighlightExpiryDelay(
  state: CommentHighlightState,
  nowMs: number
): number | null {
  if (state.phase !== 'live' || !state.expiresAt) return null
  const expiresAtMs = Date.parse(state.expiresAt)
  return Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - nowMs) : null
}

/** The backend owns the expiry timestamp. This only prevents a disconnected
 * renderer from continuing to claim `On stream` after that timestamp passed. */
export function expireCommentHighlightState(
  current: CommentHighlightState,
  expectedGeneration: number,
  nowMs: number
): CommentHighlightState {
  if (current.generation !== expectedGeneration) return current
  const delay = commentHighlightExpiryDelay(current, nowMs)
  return delay === 0 ? { generation: current.generation, phase: 'idle' } : current
}

/** The card's two weights: the name is semibold, the message regular. Each
 * run is measured in the weight it is painted in; measuring the message
 * semibold placed its emotes a gap past the regular-weight words. */
export type HighlightFontWeight = 400 | 600
export const HIGHLIGHT_NAME_WEIGHT: HighlightFontWeight = 600
export const HIGHLIGHT_TEXT_WEIGHT: HighlightFontWeight = 400

export type HighlightTextMeasurer = (
  text: string,
  fontPx: number,
  weight: HighlightFontWeight
) => number

export interface HighlightMetrics {
  nameFontPx: number
  textFontPx: number
  lineHeightPx: number
  paddingPx: number
  /** Identity-row avatar: sized to the name line, never the whole card. */
  avatarPx: number
  /** Space between the avatar and the username on the identity row. */
  identityGapPx: number
  /** Space between the identity row and the first message line. */
  rowGapPx: number
  radiusPx: number
  /** Message lines span the full content width of the card. */
  maxTextWidthPx: number
  /** The username shares its row with the avatar, so it gets less. */
  maxNameWidthPx: number
}

/** Text scales off the canvas's LONG edge, so a 1080x1920 vertical leg gets
 * the same type size as its 1920x1080 horizontal twin instead of shrinking to
 * a width-based size that is unreadable on a phone. `canvasHeight` omitted
 * means landscape. */
export function highlightMetrics(canvasWidth: number, canvasHeight?: number): HighlightMetrics {
  const portrait = canvasHeight !== undefined && canvasHeight > canvasWidth
  const longEdge = portrait ? canvasHeight : canvasWidth
  const textFontPx = Math.max(20, Math.round(longEdge / 48))
  const paddingPx = Math.round(textFontPx * 0.8)
  const avatarPx = Math.round(textFontPx * 1.5)
  const identityGapPx = Math.round(textFontPx * 0.5)
  const widthFraction = portrait ? MAX_PORTRAIT_CARD_WIDTH_FRACTION : MAX_CARD_WIDTH_FRACTION
  const maxTextWidthPx = Math.floor(canvasWidth * widthFraction) - paddingPx * 2
  return {
    nameFontPx: Math.round(textFontPx * 0.95),
    textFontPx,
    lineHeightPx: Math.round(textFontPx * 1.3),
    paddingPx,
    avatarPx,
    identityGapPx,
    rowGapPx: Math.round(textFontPx * 0.45),
    // Panel-tier corners (videorc-design).
    radiusPx: Math.round(textFontPx * 0.6),
    maxTextWidthPx,
    maxNameWidthPx: maxTextWidthPx - avatarPx - identityGapPx
  }
}

/** Greedy word wrap capped at HIGHLIGHT_MAX_TEXT_LINES; overflow keeps the
 * HEAD of the comment with a trailing ellipsis (a highlight quotes the start
 * of what someone said — unlike live captions, which keep the tail). */
export function wrapHighlightText(
  text: string,
  metrics: HighlightMetrics,
  measure: HighlightTextMeasurer
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return []
  }
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (
      current &&
      measure(candidate, metrics.textFontPx, HIGHLIGHT_TEXT_WEIGHT) > metrics.maxTextWidthPx
    ) {
      lines.push(current)
      current = word
      if (lines.length === HIGHLIGHT_MAX_TEXT_LINES) {
        break
      }
    } else {
      current = candidate
    }
  }
  if (lines.length < HIGHLIGHT_MAX_TEXT_LINES && current) {
    lines.push(current)
  } else if (lines.length === HIGHLIGHT_MAX_TEXT_LINES) {
    lines[HIGHLIGHT_MAX_TEXT_LINES - 1] = `${lines[HIGHLIGHT_MAX_TEXT_LINES - 1]}…`
  }
  return lines.slice(0, HIGHLIGHT_MAX_TEXT_LINES)
}

export interface HighlightLayout {
  metrics: HighlightMetrics
  name: string
  textLines: string[]
  cardWidthPx: number
  cardHeightPx: number
}

export type CommentHighlightPlatformBadge =
  | {
      label: string
      color: string
      /** Glyph colour; white unless the brand colour is too light for it. */
      ink?: string
      glyph: 'twitch' | 'kick' | 'x' | 'dot'
    }
  /** YouTube is never redrawn (plan 165, Google's ToS report III.F.2a): the
   * card shows YouTube's own icon file on the identity row, at least 20 px
   * tall, instead of a badge over the avatar. */
  | { label: 'YouTube'; glyph: 'youtube-icon' }

/** Small stream-safe brand mark painted over the avatar. The adjacent identity
 * line carries the platform name as text, so the card never relies on color or
 * an unfamiliar glyph alone. */
export function commentHighlightPlatformBadge(
  platform?: StreamPlatform
): CommentHighlightPlatformBadge | null {
  switch (platform) {
    case 'youtube':
      return { label: 'YouTube', glyph: 'youtube-icon' }
    case 'twitch':
      return { label: 'Twitch', color: '#9146FF', glyph: 'twitch' }
    case 'kick':
      return { label: 'Kick', color: '#53FC18', ink: '#0B1A05', glyph: 'kick' }
    case 'x':
      return { label: 'X', color: '#111111', glyph: 'x' }
    case 'custom':
      return { label: 'Custom', color: '#52525B', glyph: 'dot' }
    default:
      return null
  }
}

/** The identity line: "Twitch · name". When the card draws YouTube's own icon
 * beside the name (`markShown`), the icon is the attribution and the line is
 * just the name; if the icon could not be loaded the word stays. */
export function commentHighlightIdentity(
  authorName: string,
  platform?: StreamPlatform,
  markShown = false
): string {
  const author = authorName.trim() || 'Viewer'
  if (markShown && platform === 'youtube') return author
  const platformLabel = commentHighlightPlatformBadge(platform)?.label ?? null
  return platformLabel ? `${platformLabel} · ${author}` : author
}

/** Canvas `maxWidth` squeezes glyphs instead of cutting them, so an over-long
 * username is ellipsized here, keeping its head (the platform label). */
export function fitHighlightName(
  name: string,
  fontPx: number,
  maxWidthPx: number,
  measure: HighlightTextMeasurer
): string {
  if (measure(name, fontPx, HIGHLIGHT_NAME_WEIGHT) <= maxWidthPx) return name
  const chars = Array.from(name)
  while (
    chars.length > 1 &&
    measure(`${chars.join('')}…`, fontPx, HIGHLIGHT_NAME_WEIGHT) > maxWidthPx
  ) {
    chars.pop()
  }
  return `${chars.join('').trimEnd()}…`
}

export function layoutCommentHighlight(params: {
  authorName: string
  text: string
  canvasWidth: number
  canvasHeight?: number
  platform?: StreamPlatform
  measure: HighlightTextMeasurer
}): HighlightLayout | null {
  const metrics = highlightMetrics(params.canvasWidth, params.canvasHeight)
  if (metrics.maxTextWidthPx <= 0) {
    return null
  }
  const textLines = wrapHighlightText(params.text, metrics, params.measure)
  const name = fitHighlightName(
    commentHighlightIdentity(params.authorName, params.platform),
    metrics.nameFontPx,
    metrics.maxNameWidthPx,
    params.measure
  )
  const nameWidth = Math.min(
    params.measure(name, metrics.nameFontPx, HIGHLIGHT_NAME_WEIGHT),
    metrics.maxNameWidthPx
  )
  const identityRowWidth = metrics.avatarPx + metrics.identityGapPx + nameWidth
  const widestLine = textLines.reduce(
    (widest, line) =>
      Math.max(widest, params.measure(line, metrics.textFontPx, HIGHLIGHT_TEXT_WEIGHT)),
    0
  )
  const contentWidth = Math.min(Math.max(identityRowWidth, widestLine), metrics.maxTextWidthPx)
  // Identity row, then the message. A message-less card is just the identity row.
  const messageHeight =
    textLines.length > 0 ? metrics.rowGapPx + textLines.length * metrics.lineHeightPx : 0
  return {
    metrics,
    name,
    textLines,
    cardWidthPx: Math.ceil(metrics.paddingPx * 2 + contentWidth),
    cardHeightPx: Math.ceil(metrics.paddingPx * 2 + metrics.avatarPx + messageHeight)
  }
}

// --- Lifecycle (pure reducer, unit-tested) -------------------------------------

export interface HighlightState {
  message: LiveChatMessage
  shownAtMs: number
}

export type HighlightAction =
  | { type: 'toggle'; message: LiveChatMessage; nowMs: number }
  | { type: 'expire'; messageId: string }
  | { type: 'clear' }

/**
 * Click shows a comment; clicking the SAME comment un-pins it; clicking a
 * different one replaces it (timer restarts). Expiry only clears the comment
 * it was armed for — a stale timer must never kill a newer highlight.
 */
export function nextHighlightState(
  current: HighlightState | null,
  action: HighlightAction
): HighlightState | null {
  switch (action.type) {
    case 'toggle':
      if (current && current.message.id === action.message.id) {
        return null
      }
      return { message: action.message, shownAtMs: action.nowMs }
    case 'expire':
      return current && current.message.id === action.messageId ? null : current
    case 'clear':
      return null
  }
}
