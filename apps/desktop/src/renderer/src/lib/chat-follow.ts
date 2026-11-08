// How a live chat list follows its newest message. The list is pinned to the
// bottom while the streamer is there, and only the streamer's own scroll up
// (wheel, touch, keys, the scrollbar) takes it off. Nothing the app does by
// itself moves it away: rows that grow once their emotes or avatars load,
// Buddy's marks, a highlight, a removal, a re-measure. A live stream made the
// owner scroll down again and again (2026-10-21) because Buddy's "Talking
// about this" pulled the list up and a layout scroll away from the bottom
// counted as the streamer leaving.

/** How near the bottom still counts as at the newest message. */
export const CHAT_BOTTOM_THRESHOLD_PX = 64

/**
 * How long after the streamer's scroll gesture a scroll event still counts as
 * theirs: a key press's smooth scroll and the last frames of a drag land a
 * little after the input that started them.
 */
export const CHAT_USER_SCROLL_WINDOW_MS = 750

export interface ChatScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function chatDistanceFromBottom(metrics: ChatScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight)
}

export function chatAtBottom(
  metrics: ChatScrollMetrics,
  threshold: number = CHAT_BOTTOM_THRESHOLD_PX
): boolean {
  return chatDistanceFromBottom(metrics) <= threshold
}

export interface ChatFollowStep {
  /** Following the newest message after this scroll. */
  pinned: boolean
  /** Put the list back on its newest message now. */
  restick: boolean
}

/**
 * What one scroll event does to a chat that follows its newest message.
 * Reaching the bottom always pins. Only the streamer scrolling up unpins: a
 * scroll the app caused (a row above re-measured, scroll anchoring, a clamp)
 * while pinned puts the list straight back on the newest message.
 */
export function chatFollowAfterScroll({
  pinned,
  atBottom,
  movedUp,
  userScrolling
}: {
  pinned: boolean
  atBottom: boolean
  /** The scroll position went up since the previous scroll event. */
  movedUp: boolean
  /** A scroll gesture by the streamer is under way (chatUserScrolling). */
  userScrolling: boolean
}): ChatFollowStep {
  if (atBottom) return { pinned: true, restick: false }
  if (!pinned) return { pinned: false, restick: false }
  if (userScrolling && movedUp) return { pinned: false, restick: false }
  return { pinned: true, restick: true }
}

/** Is a scroll event now part of the streamer's own gesture? */
export function chatUserScrolling({
  nowMs,
  lastGestureAtMs,
  dragging
}: {
  nowMs: number
  lastGestureAtMs: number | null
  /** The scrollbar is held. */
  dragging: boolean
}): boolean {
  if (dragging) return true
  return lastGestureAtMs !== null && nowMs - lastGestureAtMs <= CHAT_USER_SCROLL_WINDOW_MS
}

/** A wheel that scrolls toward older messages (never a Ctrl-wheel zoom). */
export function chatWheelScrollsUp(event: Pick<WheelEvent, 'deltaY' | 'ctrlKey'>): boolean {
  return event.deltaY < 0 && !event.ctrlKey
}

const SCROLL_UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

/** A key that scrolls the list, or walks its rows, toward older messages. */
export function chatKeyScrollsUp(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return SCROLL_UP_KEYS.has(event.key) || (event.key === ' ' && event.shiftKey)
}

/** The part of a ResizeObserver the chat follow needs (a fake in tests). */
export interface ResizeObserverLike {
  observe: (target: Element) => void
  disconnect: () => void
}

/**
 * Keeps a pinned chat on its newest row when the scroll viewport or its
 * content resizes (plan 057, P4). Following on new rows alone missed a window
 * resize, the composer growing, and a row that grows once its emotes load:
 * the newest message sat out of view with no paused chip. Returns the cleanup.
 */
export function followChatOnResize(
  viewport: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'firstElementChild'>,
  isPinned: () => boolean,
  createObserver: (callback: () => void) => ResizeObserverLike = (callback) =>
    new ResizeObserver(callback)
): () => void {
  const observer = createObserver(() => {
    if (isPinned()) viewport.scrollTop = viewport.scrollHeight
  })
  observer.observe(viewport as Element)
  if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
  return () => observer.disconnect()
}
