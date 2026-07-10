import { describe, expect, it } from 'vitest'

import type { LiveChatMessage } from '@/lib/backend'
import {
  HIGHLIGHT_MAX_TEXT_LINES,
  commentHighlightExpiryDelay,
  commentHighlightIdentity,
  commentHighlightPlatformBadge,
  expireCommentHighlightState,
  highlightMetrics,
  layoutCommentHighlight,
  nextHighlightState,
  wrapHighlightText
} from './comment-highlight'

const measure = (text: string, fontPx: number): number => text.length * fontPx * 0.55

const message = (id: string, text = 'hello there'): LiveChatMessage =>
  ({
    id,
    providerMessageId: id,
    platform: 'youtube',
    sessionId: 's1',
    authorName: 'Orc Dev',
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-07-05T12:00:00Z',
    receivedAt: '2026-07-05T12:00:00Z',
    messageText: text,
    fragments: [],
    eventType: 'message',
    isDeleted: false
  }) as unknown as LiveChatMessage

describe('wrapHighlightText', () => {
  const metrics = highlightMetrics(1920)

  it('keeps the HEAD and ellipsizes past the line cap', () => {
    const lines = wrapHighlightText('word '.repeat(60).trim(), metrics, measure)
    expect(lines).toHaveLength(HIGHLIGHT_MAX_TEXT_LINES)
    expect(lines.at(-1)).toMatch(/…$/)
    expect(lines[0]!.startsWith('word')).toBe(true)
  })

  it('returns short comments unwrapped and empties as no lines', () => {
    expect(wrapHighlightText('gg', metrics, measure)).toEqual(['gg'])
    expect(wrapHighlightText('   ', metrics, measure)).toEqual([])
  })
})

describe('layoutCommentHighlight', () => {
  it('sizes the card to its content within the width budget', () => {
    const layout = layoutCommentHighlight({
      authorName: 'Orc Dev',
      text: 'what capture card is that?',
      canvasWidth: 1920,
      platform: 'youtube',
      measure
    })!
    expect(layout.textLines.length).toBeGreaterThan(0)
    expect(layout.cardWidthPx).toBeLessThanOrEqual(Math.floor(1920 * 0.6))
    expect(layout.cardHeightPx).toBeGreaterThan(layout.metrics.avatarPx)
    expect(layout.name).toBe('YouTube · Orc Dev')
  })

  it('falls back to a Viewer name and survives empty text', () => {
    const layout = layoutCommentHighlight({
      authorName: '  ',
      text: '',
      canvasWidth: 1280,
      measure
    })!
    expect(layout.name).toBe('Viewer')
    expect(layout.textLines).toEqual([])
  })

  it('preserves platform identity on the stream card', () => {
    expect(commentHighlightIdentity('Orc Dev', 'twitch')).toBe('Twitch · Orc Dev')
    expect(commentHighlightIdentity(' ', 'x')).toBe('X · Viewer')
    expect(commentHighlightPlatformBadge('youtube')).toEqual({
      label: 'YouTube',
      color: '#FF0033',
      glyph: 'play'
    })
    expect(commentHighlightPlatformBadge(undefined)).toBeNull()
  })
})

describe('nextHighlightState', () => {
  it('click shows, same-click unpins, different click replaces', () => {
    const shown = nextHighlightState(null, { type: 'toggle', message: message('a'), nowMs: 1 })
    expect(shown?.message.id).toBe('a')
    expect(
      nextHighlightState(shown, { type: 'toggle', message: message('a'), nowMs: 2 })
    ).toBeNull()
    const replaced = nextHighlightState(shown, { type: 'toggle', message: message('b'), nowMs: 3 })
    expect(replaced?.message.id).toBe('b')
    expect(replaced?.shownAtMs).toBe(3)
  })

  it('a stale expiry never kills a newer highlight', () => {
    const shown = nextHighlightState(null, { type: 'toggle', message: message('a'), nowMs: 1 })
    const replaced = nextHighlightState(shown, { type: 'toggle', message: message('b'), nowMs: 2 })
    expect(nextHighlightState(replaced, { type: 'expire', messageId: 'a' })).toBe(replaced)
    expect(nextHighlightState(replaced, { type: 'expire', messageId: 'b' })).toBeNull()
  })

  it('clear always clears', () => {
    const shown = nextHighlightState(null, { type: 'toggle', message: message('a'), nowMs: 1 })
    expect(nextHighlightState(shown, { type: 'clear' })).toBeNull()
    expect(nextHighlightState(null, { type: 'clear' })).toBeNull()
  })
})

describe('backend highlight expiry presentation', () => {
  it('stops claiming On stream when the backend-owned expiry passes', () => {
    const live = {
      sessionId: 'session-1',
      messageId: 'message-1',
      generation: 4,
      phase: 'live',
      expiresAt: '2026-07-10T12:00:10.000Z'
    } as const
    const before = Date.parse('2026-07-10T12:00:09.000Z')
    const after = Date.parse('2026-07-10T12:00:10.001Z')

    expect(commentHighlightExpiryDelay(live, before)).toBe(1_000)
    expect(expireCommentHighlightState(live, live.generation, before)).toBe(live)
    expect(expireCommentHighlightState(live, live.generation, after)).toEqual({
      generation: 4,
      phase: 'idle'
    })
  })

  it('does not let an old expiry timer clear a newer generation', () => {
    const newer = {
      sessionId: 'session-1',
      messageId: 'message-2',
      generation: 5,
      phase: 'live',
      expiresAt: '2026-07-10T12:00:20.000Z'
    } as const

    expect(expireCommentHighlightState(newer, 4, Date.parse('2026-07-10T12:00:30.000Z'))).toBe(
      newer
    )
  })
})
