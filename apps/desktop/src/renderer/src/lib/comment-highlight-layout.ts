// Mixed word/emote layout for the on-stream highlight card (plan 095, S4).
// Pure: measurement and decoded image sizes are injected, so wrapping, the
// line cap, the ellipsis rule and the width caps are unit-tested. Only the
// card painter in `caption-overlay.ts` imports this, keeping it out of the
// eager Studio bundle (`comment-highlight.ts` is imported eagerly by
// use-studio and stays text-only).

import { gifTitle } from '../../../shared/chat-gif'
import type { LiveChatMessageFragment, StreamPlatform } from '@/lib/backend'
import { groupEmoteOverlays, type ChatMessagePiece } from '@/lib/chat-emotes'
import {
  commentHighlightIdentity,
  fitHighlightName,
  HIGHLIGHT_NAME_WEIGHT,
  HIGHLIGHT_TEXT_WEIGHT,
  HIGHLIGHT_MAX_TEXT_LINES,
  highlightMetrics,
  type HighlightMetrics,
  type HighlightTextMeasurer
} from '@/lib/comment-highlight'
import { YOUTUBE_MARK_ASPECT, YOUTUBE_MARK_MIN_PX } from '@/lib/youtube-mark'

/** An emote box is this many times the text size high: a little taller than
 * the x-height-and-ascender run of a word, like the chat row's `h-5`. */
export const HIGHLIGHT_EMOTE_HEIGHT_FACTOR = 1.2
/** Wide 7TV emotes (banners, long text emotes) are capped at this many box
 * heights so one emote can never take the whole line. */
export const HIGHLIGHT_EMOTE_MAX_ASPECT = 3
/** Distinct emote images one card loads; the rest show their names. */
export const HIGHLIGHT_MAX_EMOTES = 20

export type HighlightEmoteSize = { width: number; height: number }

export type HighlightToken =
  | { kind: 'word'; text: string }
  | {
      kind: 'emote'
      /** The emote's name, drawn as text when the image is missing. */
      name: string
      url: string
      /** Zero-width 7TV overlays painted in the same box (plan 089). */
      overlays: readonly string[]
    }

/** Where an emote's image size comes from: the decoded bitmap, or null when
 * it failed to load (the token then falls back to its name as text). */
export type HighlightEmoteSizer = (url: string) => HighlightEmoteSize | null

/**
 * Tokens for the message body. Fragments with images become emote tokens
 * (zero-width overlays folded onto the emote before them); every other
 * fragment and plain text splits into words. `text` is used when the
 * fragments carry no image, so activity prefixes and fragment-less messages
 * lay out exactly as before. A Twitch GIF (plan 155, D8) is never painted
 * on stream: the card says `GIF: <title>` in its place.
 */
export function highlightTokens(
  text: string,
  fragments: readonly LiveChatMessageFragment[] | undefined
): HighlightToken[] {
  const hasGif = fragments?.some((fragment) => fragment.type === 'gif') ?? false
  const drawable = hasGif
    ? fragments!.map((fragment) =>
        fragment.type === 'gif'
          ? { type: 'text', text: ` GIF: ${gifTitle(fragment.text)} ` }
          : fragment
      )
    : fragments
  if (!drawable?.some((fragment) => fragment.imageUrl)) {
    return words(hasGif ? drawable!.map((fragment) => fragment.text).join('') : text)
  }
  const tokens: HighlightToken[] = []
  for (const piece of groupEmoteOverlays(drawable)) {
    if (piece.kind === 'text') {
      tokens.push(...words(piece.text))
      continue
    }
    tokens.push(emoteToken(piece))
  }
  return tokens
}

function emoteToken(piece: Extract<ChatMessagePiece, { kind: 'emote' }>): HighlightToken {
  return {
    kind: 'emote',
    name: piece.emote.text,
    url: piece.emote.url,
    overlays: piece.overlays.map((overlay) => overlay.url)
  }
}

function words(text: string): HighlightToken[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({ kind: 'word', text: word }))
}

/** The distinct image URLs a card would paint, base emotes first, overlays
 * after, capped at HIGHLIGHT_MAX_EMOTES. */
export function highlightEmoteUrls(tokens: readonly HighlightToken[]): string[] {
  const urls = new Set<string>()
  for (const token of tokens) {
    if (token.kind !== 'emote') continue
    for (const url of [token.url, ...token.overlays]) {
      if (urls.size >= HIGHLIGHT_MAX_EMOTES) return [...urls]
      urls.add(url)
    }
  }
  return [...urls]
}

export type PlacedHighlightItem =
  | { kind: 'word'; text: string; xPx: number; widthPx: number }
  | {
      kind: 'emote'
      url: string
      overlays: readonly string[]
      xPx: number
      widthPx: number
      heightPx: number
    }

export interface HighlightLine {
  items: PlacedHighlightItem[]
  widthPx: number
}

export function highlightEmoteBoxHeightPx(metrics: HighlightMetrics): number {
  return Math.round(metrics.textFontPx * HIGHLIGHT_EMOTE_HEIGHT_FACTOR)
}

/** An emote box: the card's emote height, width from the decoded aspect
 * ratio, capped for wide emotes. A missing or degenerate size gives null. */
export function highlightEmoteBox(
  size: HighlightEmoteSize | null,
  metrics: HighlightMetrics
): { widthPx: number; heightPx: number } | null {
  if (!size || !(size.width > 0) || !(size.height > 0)) return null
  const heightPx = highlightEmoteBoxHeightPx(metrics)
  const aspect = Math.min(size.width / size.height, HIGHLIGHT_EMOTE_MAX_ASPECT)
  return { widthPx: Math.max(1, Math.round(heightPx * aspect)), heightPx }
}

type Measured =
  | { kind: 'word'; text: string; widthPx: number }
  | { kind: 'emote'; url: string; overlays: readonly string[]; widthPx: number; heightPx: number }

/**
 * Greedy wrap of mixed tokens into at most HIGHLIGHT_MAX_TEXT_LINES lines.
 * Like `wrapHighlightText`, overflow keeps the HEAD with a trailing ellipsis.
 * An emote whose image did not load is laid out as its name. A single token
 * wider than the line stands alone on its line (the painter's `maxWidth`
 * squeezes a word; an emote is already capped).
 */
export function wrapHighlightTokens(
  tokens: readonly HighlightToken[],
  metrics: HighlightMetrics,
  measure: HighlightTextMeasurer,
  emoteSize: HighlightEmoteSizer
): HighlightLine[] {
  const measured: Measured[] = []
  for (const token of tokens) {
    if (token.kind === 'word') {
      measured.push({
        kind: 'word',
        text: token.text,
        widthPx: measure(token.text, metrics.textFontPx, HIGHLIGHT_TEXT_WEIGHT)
      })
      continue
    }
    const box = highlightEmoteBox(emoteSize(token.url), metrics)
    if (!box) {
      measured.push({
        kind: 'word',
        text: token.name,
        widthPx: measure(token.name, metrics.textFontPx, HIGHLIGHT_TEXT_WEIGHT)
      })
      continue
    }
    measured.push({ kind: 'emote', url: token.url, overlays: token.overlays, ...box })
  }
  if (measured.length === 0) return []

  const spacePx = measure(' ', metrics.textFontPx, HIGHLIGHT_TEXT_WEIGHT)
  const maxWidthPx = metrics.maxTextWidthPx
  const lines: HighlightLine[] = []
  let current: HighlightLine = { items: [], widthPx: 0 }
  let overflow = false
  const place = (line: HighlightLine, item: Measured): void => {
    const xPx = line.items.length === 0 ? 0 : line.widthPx + spacePx
    line.items.push({ ...item, xPx })
    line.widthPx = xPx + item.widthPx
  }
  for (const item of measured) {
    const fits =
      current.items.length === 0 || current.widthPx + spacePx + item.widthPx <= maxWidthPx
    if (fits) {
      place(current, item)
      continue
    }
    lines.push(current)
    if (lines.length === HIGHLIGHT_MAX_TEXT_LINES) {
      overflow = true
      break
    }
    current = { items: [], widthPx: 0 }
    place(current, item)
  }
  if (!overflow) {
    lines.push(current)
    return lines
  }
  return [...lines.slice(0, -1), ellipsize(lines[lines.length - 1]!, metrics, measure, spacePx)]
}

/** A trailing ellipsis on the cut line: glued to a final word, or its own
 * item after a final emote. Items are dropped from the end until it fits. */
function ellipsize(
  line: HighlightLine,
  metrics: HighlightMetrics,
  measure: HighlightTextMeasurer,
  spacePx: number
): HighlightLine {
  const ellipsisPx = measure('…', metrics.textFontPx, HIGHLIGHT_TEXT_WEIGHT)
  const items = [...line.items]
  while (items.length > 0) {
    const last = items[items.length - 1]!
    if (last.kind === 'word') {
      const text = `${last.text}…`
      const widthPx = measure(text, metrics.textFontPx, HIGHLIGHT_TEXT_WEIGHT)
      if (last.xPx + widthPx <= metrics.maxTextWidthPx || items.length === 1) {
        items[items.length - 1] = { ...last, text, widthPx }
        return { items, widthPx: last.xPx + widthPx }
      }
    } else {
      const xPx = last.xPx + last.widthPx + spacePx
      if (xPx + ellipsisPx <= metrics.maxTextWidthPx || items.length === 1) {
        items.push({ kind: 'word', text: '…', xPx, widthPx: ellipsisPx })
        return { items, widthPx: xPx + ellipsisPx }
      }
    }
    items.pop()
  }
  return { items: [{ kind: 'word', text: '…', xPx: 0, widthPx: ellipsisPx }], widthPx: ellipsisPx }
}

export interface HighlightTokenLayout {
  metrics: HighlightMetrics
  name: string
  lines: HighlightLine[]
  cardWidthPx: number
  cardHeightPx: number
  /** YouTube's icon closing the identity row on the right (plan 165). */
  platformMark: HighlightPlatformMarkSize | null
}

export interface HighlightPlatformMarkSize {
  widthPx: number
  heightPx: number
}

/** YouTube's official icon on the card's identity row, in output pixels: the
 * name's size, never under 20 px tall (Google's ToS report, III.F.2a). Null
 * for every other platform, which keeps its badge over the avatar. The
 * identity gap (half the text size, at least 10 px) on each side keeps the
 * clear space brand.youtube asks for: the triangle's width, about 0.37 of the
 * mark's height. */
export function highlightPlatformMarkSize(
  metrics: HighlightMetrics,
  platform?: StreamPlatform
): HighlightPlatformMarkSize | null {
  if (platform !== 'youtube') return null
  const heightPx = Math.max(YOUTUBE_MARK_MIN_PX, metrics.nameFontPx)
  return { widthPx: Math.ceil(heightPx * YOUTUBE_MARK_ASPECT), heightPx }
}

/** The card layout with emotes: the same identity row and card sizing as
 * `layoutCommentHighlight`, with the message as placed words and emote boxes. */
export function layoutCommentHighlightTokens(params: {
  authorName: string
  text: string
  fragments?: readonly LiveChatMessageFragment[]
  canvasWidth: number
  canvasHeight?: number
  maxCardWidthPx?: number
  platform?: StreamPlatform
  /** The painter has YouTube's icon to draw beside the name (plan 165). */
  platformMark?: boolean
  measure: HighlightTextMeasurer
  emoteSize: HighlightEmoteSizer
}): HighlightTokenLayout | null {
  const metrics = highlightMetrics(params.canvasWidth, params.canvasHeight, params.maxCardWidthPx)
  if (metrics.maxTextWidthPx <= 0) {
    return null
  }
  const lines = wrapHighlightTokens(
    highlightTokens(params.text, params.fragments),
    metrics,
    params.measure,
    params.emoteSize
  )
  const platformMark = params.platformMark
    ? highlightPlatformMarkSize(metrics, params.platform)
    : null
  // The mark and its gap (on the row's right end) come out of the name's
  // share of the row.
  const markLeadPx = platformMark ? platformMark.widthPx + metrics.identityGapPx : 0
  const maxNameWidthPx = Math.max(0, metrics.maxNameWidthPx - markLeadPx)
  const name = fitHighlightName(
    commentHighlightIdentity(params.authorName, params.platform, platformMark !== null),
    metrics.nameFontPx,
    maxNameWidthPx,
    params.measure
  )
  const nameWidth = Math.min(
    params.measure(name, metrics.nameFontPx, HIGHLIGHT_NAME_WEIGHT),
    maxNameWidthPx
  )
  const identityRowWidth = metrics.avatarPx + metrics.identityGapPx + markLeadPx + nameWidth
  const widestLine = lines.reduce((widest, line) => Math.max(widest, line.widthPx), 0)
  const contentWidth = Math.min(Math.max(identityRowWidth, widestLine), metrics.maxTextWidthPx)
  const messageHeight =
    lines.length > 0 ? metrics.rowGapPx + lines.length * metrics.lineHeightPx : 0
  return {
    metrics,
    name,
    lines,
    cardWidthPx: Math.ceil(metrics.paddingPx * 2 + contentWidth),
    cardHeightPx: Math.ceil(metrics.paddingPx * 2 + metrics.avatarPx + messageHeight),
    platformMark
  }
}

/** The card asks Twitch for its 112 px emote (`/3.0`) instead of the chat
 * row's 28 px one: a 48 px box on a 1080p card blurs the small image. Kick
 * `fullsize` and 7TV `2x` are already sharp enough (plan 095). */
export function highlightEmoteImageUrl(url: string): string {
  return url.replace(
    /^(https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/[^/]+\/[^/]+\/[^/]+\/)1\.0$/,
    '$13.0'
  )
}
