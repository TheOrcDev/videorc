import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import {
  chatAtBottom,
  chatFollowAfterScroll,
  chatKeyScrollsUp,
  chatUserScrolling,
  chatWheelScrollsUp,
  followChatOnResize
} from '@/lib/chat-follow'

export interface ChatFollow {
  /** The list follows its newest message (render the jump control when not). */
  pinned: boolean
  /** The same, for effects that must not re-run when it changes. */
  pinnedRef: RefObject<boolean>
  /** Puts the list on its newest message now; it keeps following if pinned. */
  stick: () => void
  /** Follow the newest message again and go there (the jump control). */
  follow: () => void
  /** Stop following, for a scroll the streamer asked for elsewhere. */
  release: () => void
}

/**
 * Keeps a live chat's scroll viewport on its newest message
 * (`lib/chat-follow.ts`). The list starts pinned. Resizes (rows whose emotes
 * or avatars load, the window, the composer) and scrolls the app made keep it
 * on the newest message; only the streamer scrolling up (wheel, touch, keys,
 * the scrollbar) takes it off, and reaching the bottom again pins it. The
 * caller calls `stick` when a new message arrives while pinned.
 */
export function useChatFollow(
  viewport: HTMLElement | null,
  { onFollow }: { onFollow?: () => void } = {}
): ChatFollow {
  const [pinned, setPinned] = useState(true)
  const pinnedRef = useRef(true)
  const onFollowRef = useRef(onFollow)
  onFollowRef.current = onFollow
  const setFollowing = useCallback((next: boolean): void => {
    const resumed = next && !pinnedRef.current
    pinnedRef.current = next
    setPinned(next)
    if (resumed) onFollowRef.current?.()
  }, [])

  const stick = useCallback((): void => {
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [viewport])

  useEffect(() => {
    if (!viewport) return
    // The scrollbar sits beside the viewport, inside the ScrollArea's root.
    const surface = viewport.closest<HTMLElement>('[data-slot="scroll-area"]') ?? viewport
    const doc = viewport.ownerDocument
    let lastGestureAtMs: number | null = null
    let dragging = false
    let lastScrollTop = viewport.scrollTop
    const gesture = (): void => {
      lastGestureAtMs = Date.now()
    }
    const onScroll = (): void => {
      const scrollTop = viewport.scrollTop
      const step = chatFollowAfterScroll({
        pinned: pinnedRef.current,
        atBottom: chatAtBottom(viewport),
        movedUp: scrollTop < lastScrollTop - 0.5,
        userScrolling: chatUserScrolling({ nowMs: Date.now(), lastGestureAtMs, dragging })
      })
      if (step.pinned !== pinnedRef.current) setFollowing(step.pinned)
      if (step.restick) viewport.scrollTop = viewport.scrollHeight
      lastScrollTop = viewport.scrollTop
    }
    const onWheel = (event: WheelEvent): void => {
      if (chatWheelScrollsUp(event)) gesture()
    }
    // Keys reach the viewport from the focused row too: ↑, Home and PageUp
    // walk or scroll toward older messages.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (chatKeyScrollsUp(event)) gesture()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if ((event.target as Element | null)?.closest?.('[data-slot="scroll-area-scrollbar"]')) {
        dragging = true
        gesture()
      }
    }
    const onPointerUp = (): void => {
      if (!dragging) return
      dragging = false
      gesture()
    }
    viewport.addEventListener('scroll', onScroll, { passive: true })
    viewport.addEventListener('wheel', onWheel, { passive: true })
    viewport.addEventListener('touchmove', gesture, { passive: true })
    viewport.addEventListener('keydown', onKeyDown)
    surface.addEventListener('pointerdown', onPointerDown)
    doc.addEventListener('pointerup', onPointerUp)
    doc.addEventListener('pointercancel', onPointerUp)
    const stopResizeFollow =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : followChatOnResize(viewport, () => pinnedRef.current)
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      viewport.removeEventListener('wheel', onWheel)
      viewport.removeEventListener('touchmove', gesture)
      viewport.removeEventListener('keydown', onKeyDown)
      surface.removeEventListener('pointerdown', onPointerDown)
      doc.removeEventListener('pointerup', onPointerUp)
      doc.removeEventListener('pointercancel', onPointerUp)
      stopResizeFollow?.()
    }
  }, [setFollowing, viewport])

  const follow = useCallback((): void => {
    setFollowing(true)
    stick()
  }, [setFollowing, stick])
  const release = useCallback((): void => setFollowing(false), [setFollowing])

  return { pinned, pinnedRef, stick, follow, release }
}
