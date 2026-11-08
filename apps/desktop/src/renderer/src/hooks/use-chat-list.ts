import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'

import {
  chatDeliveryProgress,
  deliveryCursor,
  type ChatDelivery,
  type ChatDeliveryMessage
} from '../../../shared/chat-delivery'
import { useChatFollow } from '@/hooks/use-chat-follow'

export interface ChatList {
  /** The ScrollArea's root: the viewport is found inside it. */
  rootRef: RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  /** The list follows its newest message (render the jump chip when not). */
  pinned: boolean
  /** Follow the newest message again and go there (the jump chip). */
  follow: () => void
  /** Stop following, for a scroll the streamer asked for elsewhere. */
  release: () => void
  /** Arrivals counted while the list was not following. */
  unread: number
  /** Arrivals the delivery could not count ("New chat" rather than a number). */
  incomplete: boolean
  /** The row that holds the list's one tab stop (the newest until one is chosen). */
  activeIndex: number
  setActiveId: (id: string | null) => void
  /** Moves the tab stop to a row, scrolls it in and focuses it. */
  focusRow: (index: number) => void
}

/**
 * A live chat list's mechanics, shared by the Stream Manager's chat and the
 * Studio's Chat section (plan 204): the virtualized rows, the follow that
 * keeps the newest message in view (`hooks/use-chat-follow.ts`, owner call
 * 2026-10-21), the unread count from delivery evidence, and the one tab stop
 * with roving focus (plan 174 S3.16a, H-7). The list's keys and rows stay
 * with each caller.
 *
 * `countsAsArrival` says whether a delivered message would show in this list
 * (its filters); pass a stable function, since a new one recounts.
 */
export function useChatList<T extends { id: string }>({
  shown,
  delivery,
  arrivalKey,
  countsAsArrival,
  estimateSize
}: {
  shown: readonly T[]
  delivery?: ChatDelivery
  arrivalKey?: string
  countsAsArrival: (message: ChatDeliveryMessage) => boolean
  /** A row's height before it is measured, in px. */
  estimateSize: number
}): ChatList {
  const rootRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    setViewport(
      rootRef.current?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null
    )
  }, [])
  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => viewport,
    estimateSize: () => estimateSize,
    overscan: 10,
    getItemKey: (index) => shown[index]?.id ?? index
  })

  const [unread, setUnread] = useState(0)
  const [incomplete, setIncomplete] = useState(false)
  const arrivalRef = useRef({ key: arrivalKey, cursor: deliveryCursor(delivery) })
  // Newest at the bottom, and the list stays there (hooks/use-chat-follow.ts):
  // only the streamer scrolling up stops it, and reaching the bottom (or the
  // jump chip) follows again with nothing unread.
  const clearUnread = useCallback((): void => {
    setUnread(0)
    setIncomplete(false)
  }, [])
  const { pinned, pinnedRef, stick, follow, release } = useChatFollow(viewport, {
    onFollow: clearUnread
  })

  // Paint retention and filter refreshes are not delivery evidence.
  useEffect(() => {
    const prior = arrivalRef.current
    const progress = chatDeliveryProgress(
      delivery,
      prior.key === arrivalKey ? prior.cursor : null,
      countsAsArrival
    )
    arrivalRef.current = { key: arrivalKey, cursor: progress.cursor }
    if (progress.reset || pinnedRef.current) {
      setUnread(0)
      setIncomplete(false)
    } else {
      setUnread((value) => value + progress.count)
      if (progress.incomplete) setIncomplete(true)
    }
  }, [arrivalKey, countsAsArrival, delivery, pinnedRef])
  // A new newest message while following: show it before the frame paints.
  // The bottom of the viewport, not the virtualizer's index scroll, whose
  // settle loop could pull a streamer who just scrolled up back down.
  const newestId = shown.at(-1)?.id
  useLayoutEffect(() => {
    if (pinnedRef.current) stick()
  }, [newestId, pinnedRef, shown.length, stick])

  // One tab stop with roving focus: the active row (the newest until one is
  // chosen) holds tabIndex 0, every other -1. Enter and Space are its
  // button's own click. A row that has scrolled out of the virtualized
  // window is focused once it is rendered again.
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIndex = useMemo(() => {
    const index = activeId ? shown.findIndex((message) => message.id === activeId) : -1
    return index >= 0 ? index : shown.length - 1
  }, [activeId, shown])
  const pendingFocusRef = useRef<string | null>(null)
  const focusPendingRow = useCallback((): void => {
    const id = pendingFocusRef.current
    if (!id || typeof CSS === 'undefined') return
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
    const target = row?.matches('[tabindex]')
      ? row
      : row?.querySelector<HTMLElement>(':scope > button')
    if (!target) return
    pendingFocusRef.current = null
    target.focus({ preventScroll: true })
  }, [])
  useEffect(focusPendingRow)
  const focusRow = (index: number): void => {
    const message = shown[index]
    if (!message) return
    setActiveId(message.id)
    pendingFocusRef.current = message.id
    virtualizer.scrollToIndex(index, { align: 'auto' })
    focusPendingRow()
  }

  return {
    rootRef,
    virtualizer,
    pinned,
    follow,
    release,
    unread,
    incomplete,
    activeIndex,
    setActiveId,
    focusRow
  }
}
