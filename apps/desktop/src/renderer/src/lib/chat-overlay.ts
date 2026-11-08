// Chat on stream (plan 215 G, D5): the last five chat messages as one box the
// backend draws on every leg the overlay layout's `chat` switches carry
// (`chat.overlay.set`, `crates/videorc-backend/src/chat_overlay.rs`). The
// backend has no font crate, so the renderer paints the box; this file holds
// what is pure: which messages the box shows, its layout, the coalescing and
// the driver that pushes and clears it. The canvas painter is
// `renderChatOverlayCards` in `caption-overlay.ts`, beside the highlight
// card's. Both load lazily, only once the box is switched on.
//
// Off by default: it shows every viewer's name. No avatars and no fade in
// this version. A deleted or hidden message leaves the box on its next draw:
// the box is redrawn from chat as it is now, and a tombstone is never shown.

import type {
  ChatOverlayCanvases,
  LiveChatMessage,
  OverlayItemLayout,
  OverlayRect,
  SetChatOverlayParams,
  StreamPlatform
} from '@/lib/backend'
import {
  HIGHLIGHT_NAME_WEIGHT,
  type HighlightMetrics,
  type HighlightTextMeasurer
} from '@/lib/comment-highlight'
import {
  highlightTokens,
  wrapHighlightTokens,
  type HighlightEmoteSizer,
  type HighlightLine
} from '@/lib/comment-highlight-layout'
import { YOUTUBE_MARK_ASPECT, YOUTUBE_MARK_MIN_PX } from '@/lib/youtube-mark'

/** The box shows this many messages at most (D5). */
export const CHAT_OVERLAY_MAX_MESSAGES = 5
/** It repaints at most twice a second, however fast chat moves. */
export const CHAT_OVERLAY_REPAINT_MS = 500

// --- Which messages ----------------------------------------------------------

/**
 * A message the box shows: a viewer's chat message or a paid one (a Super
 * Chat, Twitch bits) with words or emotes. Never a deleted one (a provider's
 * deletion, "Removed by you" or "Hidden in Videorc", all `isDeleted`), never
 * a system notice, a membership notice, a moderation row or an activity-only
 * event (follows, Power-ups, rewards).
 */
export function chatOverlayEligible(
  message: Pick<LiveChatMessage, 'isDeleted' | 'eventType' | 'messageText' | 'fragments'>
): boolean {
  if (message.isDeleted) return false
  if (message.eventType !== 'message' && message.eventType !== 'paid') return false
  if (message.messageText.trim()) return true
  return message.fragments.some((fragment) => Boolean(fragment.imageUrl) || fragment.text.trim())
}

/** The newest eligible messages of this livestream, oldest first, at most
 * CHAT_OVERLAY_MAX_MESSAGES. A message from another session never counts. */
export function chatOverlayMessages<
  T extends Pick<
    LiveChatMessage,
    'sessionId' | 'isDeleted' | 'eventType' | 'messageText' | 'fragments'
  >
>(messages: readonly T[], sessionId: string | undefined, max = CHAT_OVERLAY_MAX_MESSAGES): T[] {
  if (!sessionId) return []
  const window: T[] = []
  for (let index = messages.length - 1; index >= 0 && window.length < max; index -= 1) {
    const message = messages[index]!
    if (message.sessionId === sessionId && chatOverlayEligible(message)) window.push(message)
  }
  return window.reverse()
}

export interface ChatOverlayCanvas {
  width: number
  height: number
  /** The placed chat rect on this canvas: the box takes its width and never
   * grows past its height. */
  rect: OverlayRect
}

/** What a paint depends on. The same signature twice means the box on stream
 * is already this one. */
export function chatOverlaySignature(
  messages: readonly Pick<LiveChatMessage, 'id'>[],
  stream: ChatOverlayCanvas,
  vertical?: ChatOverlayCanvas
): string {
  const canvas = (entry: ChatOverlayCanvas): string =>
    `${entry.width}x${entry.height}@${entry.rect.x},${entry.rect.y},${entry.rect.w},${entry.rect.h}`
  return JSON.stringify([
    messages.map((message) => message.id),
    canvas(stream),
    vertical ? canvas(vertical) : null
  ])
}

// --- Layout (pure; measurement and emote sizes injected) ---------------------

export interface ChatOverlayMetrics extends HighlightMetrics {
  /** The platform icon's height, YouTube's minimum (20 px) or more. */
  iconPx: number
  /** Space between two messages. */
  messageGapPx: number
  /** The box's width: the rect's, inside the canvas. */
  boxWidthPx: number
}

/**
 * Text scales off the canvas's long edge like the highlight card, smaller,
 * so five rows fit the default rect (30% × 44% of 1920 × 1080, 80% × 30% of
 * 1080 × 1920) with one line each.
 */
export function chatOverlayMetrics(
  canvasWidth: number,
  canvasHeight: number,
  rectWidthPx: number
): ChatOverlayMetrics {
  const longEdge = Math.max(canvasWidth, canvasHeight)
  const textFontPx = Math.max(16, Math.round(longEdge / 72))
  const nameFontPx = Math.round(textFontPx * 0.95)
  const paddingPx = Math.round(textFontPx * 0.7)
  const identityGapPx = Math.max(6, Math.round(textFontPx * 0.4))
  const iconPx = Math.max(YOUTUBE_MARK_MIN_PX, nameFontPx)
  const boxWidthPx = Math.max(0, Math.floor(Math.min(rectWidthPx, canvasWidth)))
  const maxTextWidthPx = boxWidthPx - paddingPx * 2
  return {
    nameFontPx,
    textFontPx,
    lineHeightPx: Math.round(textFontPx * 1.3),
    paddingPx,
    avatarPx: 0,
    identityGapPx,
    rowGapPx: Math.round(textFontPx * 0.15),
    radiusPx: Math.round(textFontPx * 0.6),
    maxTextWidthPx,
    maxNameWidthPx: maxTextWidthPx - iconPx - identityGapPx,
    iconPx,
    messageGapPx: Math.round(textFontPx * 0.55),
    boxWidthPx
  }
}

/** What leads a row: the platform's own file mark (YouTube's icon, X's kit
 * mark; plans 165, 167), the highlight's round badge (Twitch, Kick, custom),
 * or nothing, when the platform has neither or its mark did not load (the
 * name then says the platform in words). */
export type ChatOverlayRowIcon = 'mark' | 'badge' | 'none'

export function chatOverlayIconWidthPx(
  metrics: Pick<ChatOverlayMetrics, 'iconPx'>,
  platform: StreamPlatform,
  icon: ChatOverlayRowIcon
): number {
  if (icon === 'none') return 0
  if (platform === 'youtube' && icon === 'mark') {
    return Math.ceil(metrics.iconPx * YOUTUBE_MARK_ASPECT)
  }
  return metrics.iconPx
}

export interface ChatOverlayRowInput {
  id: string
  authorName: string
  platform: StreamPlatform
  text: string
  fragments?: LiveChatMessage['fragments']
  /** What the painter draws before the name; absent is none. */
  icon?: ChatOverlayRowIcon
}

export interface ChatOverlayRowLayout {
  id: string
  platform: StreamPlatform
  icon: ChatOverlayRowIcon
  name: string
  nameWidthPx: number
  iconWidthPx: number
  /** Where the name starts, from the box's content edge. */
  nameXPx: number
  lines: HighlightLine[]
  /** Top of the row from the box's top edge. */
  topPx: number
  heightPx: number
  /** The identity line (icon and name). */
  identityHeightPx: number
}

export interface ChatOverlayLayout {
  metrics: ChatOverlayMetrics
  rows: ChatOverlayRowLayout[]
  boxWidthPx: number
  boxHeightPx: number
}

/** Canvas `maxWidth` squeezes glyphs, so a long name is cut here instead. */
function fitName(
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

/**
 * The box: one row per message, oldest at the top, each an identity line
 * (the platform icon, then the name) over the message's words and emotes (at
 * most three lines, the head kept, like the highlight card). The box is the
 * rect's width. When the rows are taller than the rect, the oldest leave
 * first; the newest always stays. Null when the rect has no room for text.
 */
export function layoutChatOverlay(params: {
  rows: readonly ChatOverlayRowInput[]
  canvasWidth: number
  canvasHeight: number
  rectWidthPx: number
  rectHeightPx: number
  measure: HighlightTextMeasurer
  emoteSize: HighlightEmoteSizer
}): ChatOverlayLayout | null {
  const metrics = chatOverlayMetrics(params.canvasWidth, params.canvasHeight, params.rectWidthPx)
  if (metrics.maxTextWidthPx <= 0 || params.rows.length === 0) return null
  const identityHeightPx = Math.max(metrics.lineHeightPx, metrics.iconPx)
  const measured = params.rows.map((row) => {
    const icon = row.icon ?? 'none'
    const iconWidthPx = chatOverlayIconWidthPx(metrics, row.platform, icon)
    const nameXPx = iconWidthPx > 0 ? iconWidthPx + metrics.identityGapPx : 0
    const maxNameWidthPx = Math.max(1, metrics.maxTextWidthPx - nameXPx)
    const author = row.authorName.trim() || 'Viewer'
    const name = fitName(author, metrics.nameFontPx, maxNameWidthPx, params.measure)
    const lines = wrapHighlightTokens(
      highlightTokens(row.text, row.fragments),
      metrics,
      params.measure,
      params.emoteSize
    )
    const heightPx =
      identityHeightPx +
      (lines.length > 0 ? metrics.rowGapPx + lines.length * metrics.lineHeightPx : 0)
    return {
      id: row.id,
      platform: row.platform,
      icon,
      name,
      nameWidthPx: Math.min(
        params.measure(name, metrics.nameFontPx, HIGHLIGHT_NAME_WEIGHT),
        maxNameWidthPx
      ),
      iconWidthPx,
      nameXPx,
      lines,
      heightPx,
      identityHeightPx
    }
  })
  // Newest first until the rect is full; the newest always stays.
  const kept: typeof measured = []
  let contentPx = 0
  for (let index = measured.length - 1; index >= 0; index -= 1) {
    const row = measured[index]!
    const next = contentPx + (kept.length > 0 ? metrics.messageGapPx : 0) + row.heightPx
    if (kept.length > 0 && next + metrics.paddingPx * 2 > params.rectHeightPx) break
    kept.unshift(row)
    contentPx = next
  }
  let topPx = metrics.paddingPx
  const rows = kept.map((row) => {
    const placed = { ...row, topPx }
    topPx += row.heightPx + metrics.messageGapPx
    return placed
  })
  return {
    metrics,
    rows,
    boxWidthPx: metrics.boxWidthPx,
    boxHeightPx: Math.ceil(contentPx + metrics.paddingPx * 2)
  }
}

// --- Coalescing ----------------------------------------------------------------

export interface ChatOverlayClock {
  now: () => number
  setTimer: (run: () => void, delayMs: number) => unknown
  clearTimer: (timer: unknown) => void
}

const SYSTEM_CLOCK: ChatOverlayClock = {
  now: () => Date.now(),
  setTimer: (run, delayMs) => setTimeout(run, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
}

/**
 * Runs `work` at most once per interval: the first request at once, the
 * rest folded into one trailing run at the interval's end. A request while
 * `work` runs schedules one more run after it, so the last change always
 * reaches the stream.
 */
export function createChatOverlayCoalescer(
  work: () => Promise<void>,
  intervalMs = CHAT_OVERLAY_REPAINT_MS,
  clock: ChatOverlayClock = SYSTEM_CLOCK
): { request: () => void; dispose: () => void } {
  let lastStartMs = Number.NEGATIVE_INFINITY
  let timer: unknown = null
  let running = false
  let dirty = false
  let disposed = false
  const start = (): void => {
    timer = null
    if (disposed) return
    running = true
    dirty = false
    lastStartMs = clock.now()
    void work()
      .catch(() => {})
      .finally(() => {
        running = false
        if (dirty) request()
      })
  }
  const request = (): void => {
    if (disposed) return
    if (running) {
      dirty = true
      return
    }
    if (timer !== null) return
    const waitMs = Math.max(0, lastStartMs + intervalMs - clock.now())
    if (waitMs === 0) start()
    else timer = clock.setTimer(start, waitMs)
  }
  return {
    request,
    dispose: () => {
      disposed = true
      if (timer !== null) clock.clearTimer(timer)
      timer = null
    }
  }
}

// --- The driver ------------------------------------------------------------------

export interface ChatOverlayInput {
  /** A switch is on (stream or recording) and a livestream is on air. */
  on: boolean
  sessionId?: string
  messages: readonly LiveChatMessage[]
  layout: Pick<OverlayItemLayout, 'horizontal' | 'vertical'>
  /** The stream output's canvas from the stream settings: the fallback for
   * the landscape box when the session names no canvas
   * (`chat.overlay.canvases`). */
  canvas: { width: number; height: number }
}

export interface ChatOverlayDeps {
  set: (params: SetChatOverlayParams) => Promise<unknown>
  clear: () => Promise<unknown>
  canvases: () => Promise<ChatOverlayCanvases | null>
  /** Paints the box for the stream canvas and, when there is one, the
   * vertical leg's; null when it could not be painted. */
  paint: (
    messages: readonly LiveChatMessage[],
    stream: ChatOverlayCanvas,
    vertical?: ChatOverlayCanvas
  ) => Promise<{ pngBase64: string; verticalPngBase64?: string } | null>
  warn?: (line: string) => void
  clock?: ChatOverlayClock
  intervalMs?: number
}

/**
 * The box on stream follows `update`: painted when chat changes, cleared when
 * it empties, when both switches go off and when the livestream ends. The
 * vertical leg's canvas is read once per livestream. A failed push is logged
 * and retried on the next change.
 */
export interface ChatOverlayDriver {
  update: (input: ChatOverlayInput) => void
  dispose: () => void
}

export function createChatOverlayDriver(deps: ChatOverlayDeps): ChatOverlayDriver {
  const warn = deps.warn ?? ((line: string) => console.warn(line))
  let input: ChatOverlayInput | null = null
  let installed = false
  let painted: string | null = null
  let canvases: { sessionId: string; read: ChatOverlayCanvases | null } | null = null

  const run = async (): Promise<void> => {
    const current = input
    if (!current) return
    const messages = current.on ? chatOverlayMessages(current.messages, current.sessionId) : []
    if (messages.length === 0 || !current.sessionId) {
      if (!installed) return
      try {
        await deps.clear()
        installed = false
        painted = null
      } catch (error) {
        warn(`Chat on stream: the box did not clear (${describe(error)}).`)
      }
      return
    }
    if (canvases?.sessionId !== current.sessionId) {
      canvases = { sessionId: current.sessionId, read: await deps.canvases().catch(() => null) }
    }
    // The landscape box is painted for the leg it lands on, as the session
    // says: with a vertical leg the horizontal stream is the primary leg at
    // the session's own size, not the stream profile's, and the backend
    // crops a box painted wider than its rect (the box is exactly the rect's
    // width). The stream settings are the fallback, when the backend names
    // no canvas (no compositor leg, or the read failed).
    const landscape = canvases.read?.horizontal ?? current.canvas
    const orientation = landscape.height > landscape.width ? 'vertical' : 'horizontal'
    const stream: ChatOverlayCanvas = { ...landscape, rect: current.layout[orientation] }
    const vertical: ChatOverlayCanvas | undefined = canvases.read?.vertical
      ? { ...canvases.read.vertical, rect: current.layout.vertical }
      : undefined
    const signature = chatOverlaySignature(messages, stream, vertical)
    if (signature === painted) return
    try {
      const cards = await deps.paint(messages, stream, vertical)
      if (!cards) {
        warn('Chat on stream: the box could not be painted.')
        return
      }
      await deps.set({
        pngBase64: cards.pngBase64,
        rect: stream.rect,
        ...(cards.verticalPngBase64 && vertical
          ? { verticalPngBase64: cards.verticalPngBase64, verticalRect: vertical.rect }
          : {})
      })
      installed = true
      painted = signature
    } catch (error) {
      warn(`Chat on stream: the box did not reach the stream (${describe(error)}).`)
    }
  }

  const coalescer = createChatOverlayCoalescer(run, deps.intervalMs, deps.clock)
  return {
    update: (next) => {
      input = next
      coalescer.request()
    },
    dispose: coalescer.dispose
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
