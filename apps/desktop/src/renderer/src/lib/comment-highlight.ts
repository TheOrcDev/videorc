import type { CommentHighlightState, LiveChatMessage, StreamPlatform } from '@/lib/backend'

// Click-to-highlight (Comments upgrade S3): puts one comment ON the stream as
// a glass card — avatar, username, text — via the compositor's dedicated
// highlight slot (top; captions own the bottom). Pure layout + lifecycle live
// here (unit-tested); the canvas painter is a thin shell.

export const HIGHLIGHT_AUTO_DISMISS_MS = 10_000
export const HIGHLIGHT_MAX_TEXT_LINES = 3
/** The card never exceeds this fraction of the video width. */
const MAX_CARD_WIDTH_FRACTION = 0.6

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

export type HighlightTextMeasurer = (text: string, fontPx: number) => number

export interface HighlightMetrics {
  nameFontPx: number
  textFontPx: number
  lineHeightPx: number
  paddingPx: number
  avatarPx: number
  radiusPx: number
  maxTextWidthPx: number
}

export function highlightMetrics(canvasWidth: number): HighlightMetrics {
  const textFontPx = Math.max(20, Math.round(canvasWidth / 48))
  const paddingPx = Math.round(textFontPx * 0.8)
  const avatarPx = Math.round(textFontPx * 2.2)
  return {
    nameFontPx: Math.round(textFontPx * 0.95),
    textFontPx,
    lineHeightPx: Math.round(textFontPx * 1.3),
    paddingPx,
    avatarPx,
    // Panel-tier corners (videorc-design).
    radiusPx: Math.round(textFontPx * 0.6),
    maxTextWidthPx: Math.floor(canvasWidth * MAX_CARD_WIDTH_FRACTION) - paddingPx * 3 - avatarPx
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
    if (current && measure(candidate, metrics.textFontPx) > metrics.maxTextWidthPx) {
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

export interface CommentHighlightPlatformBadge {
  label: string
  color: string
  glyph: 'play' | 'twitch' | 'x' | 'dot'
}

/** Small stream-safe brand mark painted over the avatar. The adjacent identity
 * line carries the platform name as text, so the card never relies on color or
 * an unfamiliar glyph alone. */
export function commentHighlightPlatformBadge(
  platform?: StreamPlatform
): CommentHighlightPlatformBadge | null {
  switch (platform) {
    case 'youtube':
      return { label: 'YouTube', color: '#FF0033', glyph: 'play' }
    case 'twitch':
      return { label: 'Twitch', color: '#9146FF', glyph: 'twitch' }
    case 'x':
      return { label: 'X', color: '#111111', glyph: 'x' }
    case 'custom':
      return { label: 'Custom', color: '#52525B', glyph: 'dot' }
    default:
      return null
  }
}

export function commentHighlightIdentity(authorName: string, platform?: StreamPlatform): string {
  const author = authorName.trim() || 'Viewer'
  const platformLabel = commentHighlightPlatformBadge(platform)?.label ?? null
  return platformLabel ? `${platformLabel} · ${author}` : author
}

export function layoutCommentHighlight(params: {
  authorName: string
  text: string
  canvasWidth: number
  platform?: StreamPlatform
  measure: HighlightTextMeasurer
}): HighlightLayout | null {
  const metrics = highlightMetrics(params.canvasWidth)
  if (metrics.maxTextWidthPx <= 0) {
    return null
  }
  const textLines = wrapHighlightText(params.text, metrics, params.measure)
  const name = commentHighlightIdentity(params.authorName, params.platform)
  const nameWidth = Math.min(params.measure(name, metrics.nameFontPx), metrics.maxTextWidthPx)
  const widestLine = textLines.reduce(
    (widest, line) => Math.max(widest, params.measure(line, metrics.textFontPx)),
    0
  )
  const contentWidth = Math.min(Math.max(nameWidth, widestLine), metrics.maxTextWidthPx)
  const contentHeight =
    metrics.nameFontPx +
    Math.round(metrics.textFontPx * 0.35) +
    textLines.length * metrics.lineHeightPx
  return {
    metrics,
    name,
    textLines,
    cardWidthPx: Math.ceil(metrics.paddingPx * 3 + metrics.avatarPx + contentWidth),
    cardHeightPx: Math.ceil(metrics.paddingPx * 2 + Math.max(metrics.avatarPx, contentHeight))
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
