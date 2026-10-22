import { describe, expect, it } from 'vitest'

import {
  CHAT_BOTTOM_THRESHOLD_PX,
  CHAT_USER_SCROLL_WINDOW_MS,
  chatAtBottom,
  chatDistanceFromBottom,
  chatFollowAfterScroll,
  chatKeyScrollsUp,
  chatUserScrolling,
  chatWheelScrollsUp,
  followChatOnResize
} from './chat-follow'

const metrics = (fromBottom: number) => ({
  scrollTop: 10_000 - 600 - fromBottom,
  scrollHeight: 10_000,
  clientHeight: 600
})

describe('chatAtBottom', () => {
  it('counts a sub-pixel or small gap as at the newest message', () => {
    expect(chatAtBottom(metrics(0))).toBe(true)
    expect(chatAtBottom(metrics(0.4))).toBe(true)
    expect(chatAtBottom(metrics(CHAT_BOTTOM_THRESHOLD_PX))).toBe(true)
    expect(chatAtBottom(metrics(CHAT_BOTTOM_THRESHOLD_PX + 1))).toBe(false)
  })

  it('never reads an overscrolled or short list as away from the bottom', () => {
    expect(chatDistanceFromBottom(metrics(-30))).toBe(0)
    expect(chatAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 })).toBe(true)
  })
})

describe('chatFollowAfterScroll', () => {
  const step = (
    pinned: boolean,
    atBottom: boolean,
    movedUp: boolean,
    userScrolling: boolean
  ): ReturnType<typeof chatFollowAfterScroll> =>
    chatFollowAfterScroll({ pinned, atBottom, movedUp, userScrolling })

  it('pins whenever the list reaches the bottom, however it got there', () => {
    for (const pinned of [true, false])
      for (const movedUp of [true, false])
        for (const userScrolling of [true, false])
          expect(step(pinned, true, movedUp, userScrolling)).toEqual({
            pinned: true,
            restick: false
          })
  })

  it('unpins only when the streamer scrolls up', () => {
    expect(step(true, false, true, true)).toEqual({ pinned: false, restick: false })
  })

  it('puts a pinned list straight back when the app moved it (a row re-measured, anchoring, a clamp)', () => {
    expect(step(true, false, true, false)).toEqual({ pinned: true, restick: true })
    expect(step(true, false, false, false)).toEqual({ pinned: true, restick: true })
  })

  it('never unpins on a gesture that moved the list down toward the newest', () => {
    expect(step(true, false, false, true)).toEqual({ pinned: true, restick: true })
  })

  it('leaves a streamer reading back where they are', () => {
    expect(step(false, false, true, false)).toEqual({ pinned: false, restick: false })
    expect(step(false, false, false, true)).toEqual({ pinned: false, restick: false })
  })
})

describe('chatUserScrolling', () => {
  const now = 1_000_000
  it('holds for a short window after the gesture, and for as long as the scrollbar is held', () => {
    expect(chatUserScrolling({ nowMs: now, lastGestureAtMs: null, dragging: false })).toBe(false)
    expect(chatUserScrolling({ nowMs: now, lastGestureAtMs: now - 10, dragging: false })).toBe(true)
    expect(
      chatUserScrolling({
        nowMs: now,
        lastGestureAtMs: now - CHAT_USER_SCROLL_WINDOW_MS,
        dragging: false
      })
    ).toBe(true)
    expect(
      chatUserScrolling({
        nowMs: now,
        lastGestureAtMs: now - CHAT_USER_SCROLL_WINDOW_MS - 1,
        dragging: false
      })
    ).toBe(false)
    expect(chatUserScrolling({ nowMs: now, lastGestureAtMs: null, dragging: true })).toBe(true)
  })
})

describe('scroll-up gestures', () => {
  it('reads a wheel toward older messages, never a wheel down or a zoom', () => {
    expect(chatWheelScrollsUp({ deltaY: -4, ctrlKey: false })).toBe(true)
    expect(chatWheelScrollsUp({ deltaY: 4, ctrlKey: false })).toBe(false)
    expect(chatWheelScrollsUp({ deltaY: 0, ctrlKey: false })).toBe(false)
    expect(chatWheelScrollsUp({ deltaY: -4, ctrlKey: true })).toBe(false)
  })

  it('reads the keys that walk or scroll toward older messages', () => {
    for (const key of ['ArrowUp', 'PageUp', 'Home'])
      expect(chatKeyScrollsUp({ key, shiftKey: false })).toBe(true)
    expect(chatKeyScrollsUp({ key: ' ', shiftKey: true })).toBe(true)
    for (const key of ['ArrowDown', 'PageDown', 'End', ' ', 'Enter', 'r'])
      expect(chatKeyScrollsUp({ key, shiftKey: false })).toBe(false)
  })
})

describe('followChatOnResize (plan 057, P4)', () => {
  function setup(pinned: boolean) {
    const content = { id: 'content' } as unknown as Element
    const viewport = { scrollTop: 100, scrollHeight: 900, firstElementChild: content }
    const observed: Element[] = []
    let fire = (): void => undefined
    let disconnected = false
    const cleanup = followChatOnResize(
      viewport,
      () => pinned,
      (callback) => {
        fire = callback
        return {
          observe: (target) => observed.push(target),
          disconnect: () => {
            disconnected = true
          }
        }
      }
    )
    return {
      viewport,
      content,
      observed,
      fire: () => fire(),
      cleanup,
      isDisconnected: () => disconnected
    }
  }

  it('keeps a pinned chat on its newest row when the viewport or its rows resize', () => {
    const chat = setup(true)
    expect(chat.observed).toEqual([chat.viewport, chat.content])
    chat.fire()
    expect(chat.viewport.scrollTop).toBe(900)
  })

  it('leaves a streamer who scrolled back where they are', () => {
    const chat = setup(false)
    chat.fire()
    expect(chat.viewport.scrollTop).toBe(100)
    chat.cleanup()
    expect(chat.isDisconnected()).toBe(true)
  })
})
