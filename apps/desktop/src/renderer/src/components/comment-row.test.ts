import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  CommentRow,
  commentCanHighlight,
  commentHighlightPresentationForMessage,
  formatCommentTime,
  type CommentHighlightPresentation
} from '@/components/comment-row'
import type { LiveChatMessage } from '@/lib/backend'

function message(overrides: Partial<LiveChatMessage> = {}): LiveChatMessage {
  return {
    id: 'youtube:message-1',
    providerMessageId: 'message-1',
    platform: 'youtube',
    targetId: 'broadcast-1',
    sessionId: 'session-1',
    authorId: 'author-1',
    authorName: 'Ada Lovelace',
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-07-10T12:00:00.000Z',
    receivedAt: '2026-07-10T12:00:01.000Z',
    messageText: 'Ship it!',
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...overrides
  }
}

function renderRow(highlight: CommentHighlightPresentation): string {
  return renderToStaticMarkup(
    createElement(CommentRow, {
      highlight,
      message: message(),
      onHighlight: () => undefined
    })
  )
}

describe('CommentRow', () => {
  it('keeps backend live truth while a different row shows a command failure', () => {
    const state = { generation: 7, phase: 'live' as const, messageId: 'live-comment' }
    const failure = { messageId: 'failed-comment', reason: 'Output unavailable.' }

    expect(
      commentHighlightPresentationForMessage({
        messageId: 'live-comment',
        state,
        failure
      })
    ).toEqual({ phase: 'live', reason: undefined, commandError: undefined })
    expect(
      commentHighlightPresentationForMessage({
        messageId: 'failed-comment',
        state,
        failure
      })
    ).toEqual({ phase: 'failed', reason: 'Output unavailable.' })
  })

  it('keeps On stream visible when removing the active card fails', () => {
    expect(
      commentHighlightPresentationForMessage({
        messageId: 'live-comment',
        state: { generation: 7, phase: 'live', messageId: 'live-comment' },
        failure: { messageId: 'live-comment', reason: 'Backend unavailable.' }
      })
    ).toEqual({
      phase: 'live',
      reason: undefined,
      commandError: 'Backend unavailable.'
    })
  })

  it('keeps only viewer comments highlightable', () => {
    expect(commentCanHighlight(message())).toBe(true)
    expect(commentCanHighlight(message({ eventType: 'membership' }))).toBe(false)
    expect(commentCanHighlight(message({ eventType: 'moderation' }))).toBe(false)
    expect(commentCanHighlight(message({ eventType: 'system' }))).toBe(false)
    expect(commentCanHighlight(message({ eventType: 'deleted' }))).toBe(false)
    expect(commentCanHighlight(message({ isDeleted: true }))).toBe(false)
  })

  it('renders one accessible row contract with avatar, platform, author, and message', () => {
    const markup = renderRow({ phase: 'idle' })

    expect(markup).toContain('data-slot="avatar"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('Ada Lovelace')
    expect(markup).toContain('Ship it!')
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).toContain('Show Ada Lovelace&#x27;s comment on the stream')
  })

  it.each([
    [{ phase: 'applying' } as const, 'Applying…'],
    [{ phase: 'live' } as const, 'On stream'],
    [{ phase: 'failed', reason: 'Overlay unavailable' } as const, 'Failed']
  ])('renders the %s highlight state', (highlight, label) => {
    const markup = renderRow(highlight)

    expect(markup).toContain(label)
    expect(markup).toContain(`data-highlight-phase="${highlight.phase}"`)
  })

  it('renders paid status without changing the normalized row shape', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentRow, {
        message: message({ amountText: '€5.00', eventType: 'paid' })
      })
    )

    expect(markup).toContain('€5.00')
    expect(markup).toContain('Ship it!')
  })

  it('returns no visible time for malformed timestamps', () => {
    expect(formatCommentTime('not-a-date')).toBe('')
  })
})
