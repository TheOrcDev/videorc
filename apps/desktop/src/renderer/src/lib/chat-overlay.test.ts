import { describe, expect, it, vi } from 'vitest'

import type { LiveChatMessage, SetChatOverlayParams } from '@/lib/backend'
import {
  CHAT_OVERLAY_MAX_MESSAGES,
  CHAT_OVERLAY_REPAINT_MS,
  chatOverlayEligible,
  chatOverlayMessages,
  createChatOverlayCoalescer,
  createChatOverlayDriver,
  layoutChatOverlay,
  type ChatOverlayCanvas,
  type ChatOverlayClock,
  type ChatOverlayInput
} from '@/lib/chat-overlay'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'
import { HIDDEN_IN_VIDEORC_PROVIDER_TYPE } from '../../../shared/chat-moderation'

const SESSION = 'session-1'

function message(id: string, patch: Partial<LiveChatMessage> = {}): LiveChatMessage {
  return {
    id,
    providerMessageId: `p-${id}`,
    platform: 'twitch',
    sessionId: SESSION,
    authorName: `viewer ${id}`,
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-11-03T12:00:00.000Z',
    receivedAt: '2026-11-03T12:00:00.000Z',
    messageText: `hello ${id}`,
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...patch
  }
}

/** A clock the test moves by hand; timers fire on `advance`. */
function fakeClock(): ChatOverlayClock & { advance: (ms: number) => void } {
  let nowMs = 1_000
  let timers: { at: number; run: () => void; id: number }[] = []
  let nextId = 0
  return {
    now: () => nowMs,
    setTimer: (run, delayMs) => {
      const id = ++nextId
      timers.push({ at: nowMs + delayMs, run, id })
      return id
    },
    clearTimer: (id) => {
      timers = timers.filter((timer) => timer.id !== id)
    },
    advance: (ms) => {
      nowMs += ms
      const due = timers.filter((timer) => timer.at <= nowMs)
      timers = timers.filter((timer) => timer.at > nowMs)
      for (const timer of due) timer.run()
    }
  }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

describe('chat on stream: which messages (plan 215 D5)', () => {
  it('shows chat and paid messages with words or emotes, nothing else', () => {
    expect(chatOverlayEligible(message('a'))).toBe(true)
    expect(chatOverlayEligible(message('a', { eventType: 'paid', amountText: '$5' }))).toBe(true)
    expect(
      chatOverlayEligible(
        message('a', {
          messageText: '',
          fragments: [{ type: 'emote', text: 'Kappa', imageUrl: 'https://e.test/kappa' }]
        })
      )
    ).toBe(true)
    // Deleted by the platform, removed by you, hidden in Videorc: all tombstones.
    expect(chatOverlayEligible(message('a', { isDeleted: true }))).toBe(false)
    expect(
      chatOverlayEligible(
        message('a', { isDeleted: true, rawProviderType: HIDDEN_IN_VIDEORC_PROVIDER_TYPE })
      )
    ).toBe(false)
    for (const eventType of [
      'system',
      'membership',
      'deleted',
      'moderation',
      'follow',
      'power-up',
      'redemption'
    ] as const) {
      expect(chatOverlayEligible(message('a', { eventType }))).toBe(false)
    }
    expect(chatOverlayEligible(message('a', { messageText: '   ' }))).toBe(false)
  })

  it('keeps the newest five of this livestream, oldest first', () => {
    const messages = [
      message('other', { sessionId: 'session-0' }),
      ...['1', '2', '3', '4', '5', '6', '7'].map((id) => message(id)),
      message('notice', { eventType: 'system' })
    ]
    expect(chatOverlayMessages(messages, SESSION).map((entry) => entry.id)).toEqual([
      '3',
      '4',
      '5',
      '6',
      '7'
    ])
    expect(CHAT_OVERLAY_MAX_MESSAGES).toBe(5)
    expect(chatOverlayMessages(messages, undefined)).toEqual([])
    expect(chatOverlayMessages(messages, 'session-0').map((entry) => entry.id)).toEqual(['other'])
  })

  it('fills in from older chat when a message in the box is deleted', () => {
    const messages = ['1', '2', '3', '4', '5', '6'].map((id) => message(id))
    messages[4] = { ...messages[4]!, isDeleted: true }
    expect(chatOverlayMessages(messages, SESSION).map((entry) => entry.id)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '6'
    ])
  })
})

describe('chat on stream: the layout', () => {
  const measure = (text: string, fontPx: number): number => text.length * fontPx * 0.5
  const rows = ['1', '2', '3', '4', '5'].map((id) => ({
    id,
    authorName: `viewer ${id}`,
    platform: 'twitch' as const,
    text: `hello ${id}`,
    icon: 'badge' as const
  }))

  it('is the rect wide and fits five one-line rows in the default rect', () => {
    const rect = DEFAULT_OVERLAY_LAYOUT.chat.horizontal
    const layout = layoutChatOverlay({
      rows,
      canvasWidth: 1920,
      canvasHeight: 1080,
      rectWidthPx: Math.floor(rect.w * 1920),
      rectHeightPx: Math.floor(rect.h * 1080),
      measure,
      emoteSize: () => null
    })!
    expect(layout.boxWidthPx).toBe(Math.floor(rect.w * 1920))
    expect(layout.rows.map((row) => row.id)).toEqual(['1', '2', '3', '4', '5'])
    expect(layout.boxHeightPx).toBeLessThanOrEqual(Math.floor(rect.h * 1080))
    // The badge leads the row; the name starts after it.
    expect(layout.rows[0]!.nameXPx).toBe(layout.metrics.iconPx + layout.metrics.identityGapPx)
  })

  it('drops the oldest rows first when the rect is short, never the newest', () => {
    const layout = layoutChatOverlay({
      rows,
      canvasWidth: 1920,
      canvasHeight: 1080,
      rectWidthPx: 576,
      rectHeightPx: 200,
      measure,
      emoteSize: () => null
    })!
    expect(layout.rows.at(-1)!.id).toBe('5')
    expect(layout.rows.length).toBeLessThan(5)
    expect(layout.boxHeightPx).toBeLessThanOrEqual(200)
    const tiny = layoutChatOverlay({
      rows,
      canvasWidth: 1920,
      canvasHeight: 1080,
      rectWidthPx: 576,
      rectHeightPx: 10,
      measure,
      emoteSize: () => null
    })!
    expect(tiny.rows.map((row) => row.id)).toEqual(['5'])
  })

  it('gives a row with no icon its whole width for the name', () => {
    const layout = layoutChatOverlay({
      rows: [{ ...rows[0]!, icon: 'none' }],
      canvasWidth: 1080,
      canvasHeight: 1920,
      rectWidthPx: 864,
      rectHeightPx: 576,
      measure,
      emoteSize: () => null
    })!
    expect(layout.rows[0]!.nameXPx).toBe(0)
    expect(layout.rows[0]!.iconWidthPx).toBe(0)
  })
})

describe('chat on stream: coalescing', () => {
  it('runs at once, then folds a burst into one run at the end of the interval', async () => {
    const clock = fakeClock()
    const work = vi.fn(async () => {})
    const coalescer = createChatOverlayCoalescer(work, CHAT_OVERLAY_REPAINT_MS, clock)
    coalescer.request()
    await flush()
    expect(work).toHaveBeenCalledTimes(1)
    coalescer.request()
    coalescer.request()
    coalescer.request()
    await flush()
    expect(work).toHaveBeenCalledTimes(1)
    clock.advance(CHAT_OVERLAY_REPAINT_MS - 1)
    await flush()
    expect(work).toHaveBeenCalledTimes(1)
    clock.advance(1)
    await flush()
    expect(work).toHaveBeenCalledTimes(2)
    // Twice a second at most: nothing more without a new request.
    clock.advance(CHAT_OVERLAY_REPAINT_MS * 4)
    await flush()
    expect(work).toHaveBeenCalledTimes(2)
  })

  it('runs once more after a run that a request arrived during', async () => {
    const clock = fakeClock()
    let release: () => void = () => {}
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const coalescer = createChatOverlayCoalescer(work, CHAT_OVERLAY_REPAINT_MS, clock)
    coalescer.request()
    coalescer.request()
    expect(work).toHaveBeenCalledTimes(1)
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    release()
    await flush()
    expect(work).toHaveBeenCalledTimes(2)
    coalescer.dispose()
  })
})

describe('chat on stream: the driver', () => {
  function setup(vertical?: { width: number; height: number }) {
    const clock = fakeClock()
    const sets: SetChatOverlayParams[] = []
    const painted: string[][] = []
    const deps = {
      set: vi.fn(async (params: SetChatOverlayParams) => {
        sets.push(params)
        return null
      }),
      clear: vi.fn(async () => null),
      canvases: vi.fn(async () => (vertical ? { vertical } : {})),
      paint: vi.fn(
        async (
          messages: readonly LiveChatMessage[],
          _stream: ChatOverlayCanvas,
          verticalCanvas?: ChatOverlayCanvas
        ) => {
          painted.push(messages.map((entry) => entry.id))
          return verticalCanvas
            ? { pngBase64: 'h-png', verticalPngBase64: 'v-png' }
            : { pngBase64: 'h-png' }
        }
      ),
      warn: vi.fn(),
      clock
    }
    const driver = createChatOverlayDriver(deps)
    const input = (patch: Partial<ChatOverlayInput> = {}): ChatOverlayInput => ({
      on: true,
      sessionId: SESSION,
      messages: ['1', '2'].map((id) => message(id)),
      layout: DEFAULT_OVERLAY_LAYOUT.chat,
      canvas: { width: 1920, height: 1080 },
      ...patch
    })
    return { clock, sets, painted, deps, driver, input }
  }

  it('paints the box with the placed rect and never repaints the same box', async () => {
    const { clock, sets, painted, deps, driver, input } = setup()
    driver.update(input())
    await flush()
    expect(painted).toEqual([['1', '2']])
    expect(sets).toEqual([{ pngBase64: 'h-png', rect: DEFAULT_OVERLAY_LAYOUT.chat.horizontal }])
    driver.update(input())
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    await flush()
    expect(deps.paint).toHaveBeenCalledTimes(1)
  })

  it('takes a deleted message out of the box on the next draw', async () => {
    const { clock, painted, driver, input } = setup()
    const messages = ['1', '2', '3'].map((id) => message(id))
    driver.update(input({ messages }))
    await flush()
    driver.update(
      input({
        messages: messages.map((entry) =>
          entry.id === '2' ? { ...entry, isDeleted: true } : entry
        )
      })
    )
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    await flush()
    expect(painted).toEqual([
      ['1', '2', '3'],
      ['1', '3']
    ])
  })

  it('sends the portrait box when the session has a vertical leg, read once per livestream', async () => {
    const { clock, sets, deps, driver, input } = setup({ width: 1080, height: 1920 })
    driver.update(input())
    await flush()
    expect(sets[0]).toEqual({
      pngBase64: 'h-png',
      rect: DEFAULT_OVERLAY_LAYOUT.chat.horizontal,
      verticalPngBase64: 'v-png',
      verticalRect: DEFAULT_OVERLAY_LAYOUT.chat.vertical
    })
    driver.update(input({ messages: ['1', '2', '3'].map((id) => message(id)) }))
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    await flush()
    expect(deps.canvases).toHaveBeenCalledTimes(1)
  })

  it('clears once when switched off or when the livestream ends, and stays quiet before', async () => {
    const { clock, deps, driver, input } = setup()
    // Off from the start: nothing to clear.
    driver.update(input({ on: false }))
    await flush()
    expect(deps.clear).not.toHaveBeenCalled()
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    driver.update(input())
    await flush()
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    driver.update(input({ on: false }))
    await flush()
    expect(deps.clear).toHaveBeenCalledTimes(1)
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    driver.update(input({ on: false }))
    await flush()
    expect(deps.clear).toHaveBeenCalledTimes(1)
    // On again, then the session ends (no session id).
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    driver.update(input())
    await flush()
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    driver.update(input({ sessionId: undefined }))
    await flush()
    expect(deps.clear).toHaveBeenCalledTimes(2)
  })

  it('clears when every message in the box is deleted', async () => {
    const { clock, deps, driver, input } = setup()
    const only = [message('1')]
    driver.update(input({ messages: only }))
    await flush()
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    driver.update(input({ messages: [{ ...only[0]!, isDeleted: true }] }))
    await flush()
    expect(deps.clear).toHaveBeenCalledTimes(1)
  })

  it('retries a push that failed on the next change', async () => {
    const { clock, deps, driver, input } = setup()
    deps.set.mockRejectedValueOnce(new Error('backend away'))
    driver.update(input())
    await flush()
    expect(deps.warn).toHaveBeenCalledWith(
      'Chat on stream: the box did not reach the stream (backend away).'
    )
    clock.advance(CHAT_OVERLAY_REPAINT_MS)
    driver.update(input())
    await flush()
    expect(deps.set).toHaveBeenCalledTimes(2)
  })
})
