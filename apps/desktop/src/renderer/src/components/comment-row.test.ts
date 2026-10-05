import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  CommentRow,
  RemovalStatus,
  commentCanHighlight,
  commentHighlightPresentationForMessage,
  commentRowMenu,
  formatCommentTime,
  type CommentHighlightPresentation
} from '@/components/comment-row'
import type { LiveChatMessage } from '@/lib/backend'
import { removalStatusView, removeFromChatAvailable } from '@/lib/chat-removal-view'

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

  it('lets activity events go on stream, never plain notices (plan 055, S11)', () => {
    expect(
      commentCanHighlight(
        message({ eventType: 'system', details: { kind: 'raid', viewerCount: 234 } })
      )
    ).toBe(true)
    expect(
      commentCanHighlight(
        message({
          eventType: 'membership',
          details: { kind: 'subscription', subscription: 'resub', isPrime: false, months: 8 }
        })
      )
    ).toBe(true)
    expect(commentCanHighlight(message({ eventType: 'follow', details: { kind: 'follow' } }))).toBe(
      true
    )
    expect(
      commentCanHighlight(
        message({ eventType: 'moderation', details: { kind: 'raid', viewerCount: 1 } })
      )
    ).toBe(false)
  })

  it('renders one accessible row contract with avatar, platform, author, and message', () => {
    const markup = renderRow({ phase: 'idle' })

    expect(markup).toContain('data-slot="avatar"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('Ada Lovelace')
    expect(markup).toContain('Ship it!')
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).toContain('Show Ada Lovelace&#x27;s message on the stream')
  })

  it('keeps the username beside the avatar instead of centring it over the message', () => {
    // A highlightable row is a Button (centred text). Without an explicit
    // left alignment the flex-1 name floats to the middle of the row.
    const markup = renderRow({ phase: 'idle' })
    const nameSpan = /<span class="([^"]*)">Ada Lovelace<\/span>/.exec(markup)

    expect(nameSpan?.[1]).toContain('text-left')
    // The name also appears earlier in the button's aria-label, so order the
    // rendered name span itself: avatar, then name, then message.
    const nameAt = nameSpan?.index ?? -1
    expect(markup.indexOf('data-slot="avatar"')).toBeLessThan(nameAt)
    expect(nameAt).toBeLessThan(markup.indexOf('Ship it!'))
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

describe('CommentRow: Talking about this', () => {
  it('marks the comment the streamer is talking about on the accent row block', () => {
    const markup = renderToStaticMarkup(
      createElement(CommentRow, {
        cohostSpotlight: true,
        cohostSuggested: true,
        message: message(),
        onHighlight: () => undefined
      })
    )
    expect(markup).toContain('data-slot="cohost-comment-spotlight"')
    expect(markup).toContain('Talking about this')
    expect(markup).toContain('data-spotlight="true"')
    expect(markup).toContain('bg-accent')
    // One Orcle mark at a time: the pull-up wins over the suggestion.
    expect(markup).not.toContain('data-slot="cohost-comment-suggested"')
  })

  it('never pulls up a flagged comment, and stays quiet without a spotlight', () => {
    const flagged = renderToStaticMarkup(
      createElement(CommentRow, {
        cohostFlag: {
          messageId: 'youtube:message-1',
          kind: 'spam',
          severity: 'low',
          reason: 'Link drop.',
          at: '2026-07-10T12:00:02.000Z'
        },
        cohostSpotlight: true,
        message: message(),
        onHighlight: () => undefined
      })
    )
    expect(flagged).not.toContain('Talking about this')

    const quiet = renderToStaticMarkup(
      createElement(CommentRow, { message: message(), onHighlight: () => undefined })
    )
    expect(quiet).not.toContain('Talking about this')
    expect(quiet).not.toContain('data-spotlight')
  })
})

describe('CommentRow: member tint (plan 154)', () => {
  const member = (overrides: Partial<LiveChatMessage> = {}): LiveChatMessage =>
    message({ authorRoles: ['member'], ...overrides })

  it("tints a member's row under both shells and keeps the Member chip", () => {
    for (const onHighlight of [() => undefined, undefined]) {
      const markup = renderToStaticMarkup(
        createElement(CommentRow, { message: member(), onHighlight })
      )
      expect(markup).toContain('bg-member/8')
      expect(markup).toContain('data-member="true"')
      expect(markup).toContain('data-row-tint="member"')
      expect(markup).toContain('data-slot="comment-role"')
      expect(markup).toContain('>Member<')
      expect(markup).not.toContain('bg-accent')
      expect(markup).not.toContain('bg-warning/10')
    }
  })

  it('lets a paid message and the pull-up win over the member tint', () => {
    const paid = renderToStaticMarkup(
      createElement(CommentRow, {
        message: member({ eventType: 'paid', amountText: '$5' }),
        onHighlight: () => undefined
      })
    )
    expect(paid).toContain('bg-warning/10 ring-1 ring-warning/30')
    expect(paid).toContain('data-row-tint="paid"')
    expect(paid).not.toContain('bg-member/8')
    expect(paid).toContain('>Member<')

    const spotlight = renderToStaticMarkup(
      createElement(CommentRow, {
        cohostSpotlight: true,
        message: member(),
        onHighlight: () => undefined
      })
    )
    expect(spotlight).toContain('bg-accent')
    expect(spotlight).toContain('data-row-tint="spotlight"')
    expect(spotlight).not.toContain('bg-member/8')
  })

  it('paints no tint on stream, on a removed message, or without the role', () => {
    const onStream = renderToStaticMarkup(
      createElement(CommentRow, {
        cohostSpotlight: true,
        highlight: { phase: 'live' },
        message: member(),
        onHighlight: () => undefined
      })
    )
    expect(onStream).not.toContain('bg-member/8')
    expect(onStream).not.toContain('bg-accent')
    expect(onStream).not.toContain('data-row-tint')

    const removed = renderToStaticMarkup(
      createElement(CommentRow, { message: member({ isDeleted: true }) })
    )
    expect(removed).not.toContain('bg-member/8')
    expect(removed).not.toContain('data-member')

    const viewer = renderToStaticMarkup(createElement(CommentRow, { message: message() }))
    expect(viewer).not.toContain('data-member')
    expect(viewer).not.toContain('data-row-tint')
  })
})

describe('CommentRow: Remove from chat (plan 140, S6)', () => {
  const remove = (): void => undefined
  const reply = (): void => undefined
  const menuIds = (target: LiveChatMessage, onRemoveFromChat?: () => void): string[] =>
    commentRowMenu({
      message: target,
      highlightable: commentCanHighlight(target),
      highlightPhase: 'idle',
      onHighlight: () => undefined,
      onReply: reply,
      onRemoveFromChat
    }).map((item) => item.id)
  /** What the chat pane passes: the action only for a row that can be removed. */
  const offered = (target: LiveChatMessage): (() => void) | undefined =>
    removeFromChatAvailable(target) ? remove : undefined

  it('offers Remove from chat last, as the destructive item, on a viewer message', () => {
    const items = commentRowMenu({
      message: message(),
      highlightable: true,
      highlightPhase: 'idle',
      onHighlight: () => undefined,
      onReply: reply,
      onRemoveFromChat: remove
    })
    expect(items.map((item) => item.id)).toEqual(['show', 'reply', 'copy', 'remove-from-chat'])
    expect(items.at(-1)).toMatchObject({ label: 'Remove from chat', destructive: true })
    expect(items.filter((item) => item.destructive)).toHaveLength(1)
    // The stream toggle never says "Remove" next to the irreversible item.
    const live = commentRowMenu({
      message: message(),
      highlightable: true,
      highlightPhase: 'live',
      onHighlight: () => undefined,
      onReply: reply,
      onRemoveFromChat: remove
    })
    expect(live[0]).toMatchObject({ id: 'show', label: 'Take off stream' })
    expect(live.filter((item) => item.label.startsWith('Remove'))).toEqual([
      expect.objectContaining({ id: 'remove-from-chat', destructive: true })
    ])
    const paid = message({ eventType: 'paid', amountText: '$5' })
    expect(menuIds(paid, offered(paid))).toContain('remove-from-chat')
  })

  it('never on the streamer, a tombstone, or a notification row', () => {
    for (const target of [
      message({ authorRoles: ['owner'] }),
      message({ authorRoles: ['broadcaster'] }),
      message({ isDeleted: true, eventType: 'deleted', rawProviderType: 'videorc.removed' }),
      message({ eventType: 'membership' }),
      message({ eventType: 'follow' }),
      message({ eventType: 'system', details: { kind: 'raid', viewerCount: 3 } }),
      message({ rawProviderType: 'channel.chat.notification.resub' })
    ]) {
      expect(menuIds(target, offered(target))).not.toContain('remove-from-chat')
    }
  })

  it('has no menu at all outside a live session', () => {
    expect(
      commentRowMenu({
        message: message(),
        highlightable: true,
        highlightPhase: 'idle'
      })
    ).toEqual([])
    // Remove from chat alone still opens the menu, without Reply.
    expect(
      commentRowMenu({
        message: message(),
        highlightable: false,
        highlightPhase: 'idle',
        onRemoveFromChat: remove
      }).map((item) => item.id)
    ).toEqual(['copy', 'remove-from-chat'])
  })

  it('shows the removal chip outside the struck-through text, readable', () => {
    const tombstone = message({
      isDeleted: true,
      eventType: 'deleted',
      messageText: 'Hidden in Videorc',
      rawProviderType: 'videorc.hidden'
    })
    const markup = renderToStaticMarkup(
      createElement(CommentRow, {
        message: tombstone,
        removal: removalStatusView(tombstone, {
          operationId: 'op-1',
          sessionId: 'session-1',
          messageId: tombstone.id,
          platform: 'youtube',
          authorName: 'Ada Lovelace',
          excerpt: 'Ship it!',
          source: 'manual',
          phase: 'hidden-locally',
          confirmMode: 'confirm',
          requiresExplicitConfirm: false,
          outcome: 'Hidden in Videorc. Viewers on YouTube still see it. YouTube quota is paused.',
          createdAt: '2026-07-10T12:00:02.000Z',
          updatedAt: '2026-07-10T12:00:03.000Z'
        })
      })
    )
    const chip = /<span[^>]*data-slot="removal-status"[^>]*>([^<]*)<\/span>/.exec(markup)
    expect(chip?.[0]).toContain('data-removal="hidden"')
    expect(chip?.[0]).toContain(
      'title="Hidden in Videorc. Viewers on YouTube still see it. YouTube quota is paused."'
    )
    expect(chip?.[1]).toBe('Hidden in Videorc')
    // The body keeps its muted line-through; the chip is not inside it.
    expect(markup).toContain('line-through')
    expect(markup.indexOf('data-slot="removal-status"')).toBeLessThan(
      markup.indexOf('line-through')
    )
  })

  it('spins while removing, and says nothing when there is nothing to say', () => {
    const removing = renderToStaticMarkup(
      createElement(RemovalStatus, { status: removalStatusView(message(), undefined, true) })
    )
    expect(removing).toContain('Removing…')
    expect(removing).toContain('motion-safe:animate-spin')
    expect(renderToStaticMarkup(createElement(RemovalStatus, { status: null }))).toBe('')
  })
})

describe("CommentRow: a Twitch notice's own words (plan 151, D3)", () => {
  const streak = message({
    platform: 'twitch',
    authorName: 'Snowy77x',
    eventType: 'system',
    rawProviderType: 'channel.chat.notification:watch_streak',
    messageText: 'Snowy77x watched 20 consecutive streams and sparked a watch streak!',
    fragments: [{ type: 'text', text: 'welcome back hands <3' }],
    details: { kind: 'watch-streak', streakCount: 20 }
  })

  it("shows Twitch's sentence, then the viewer's words below it", () => {
    const html = renderToStaticMarkup(createElement(CommentRow, { message: streak }))
    expect(html).toContain('data-slot="comment-notice"')
    expect(html).toContain('watched 20 consecutive streams')
    expect(html).toMatch(/data-slot="comment-notice-words"[^>]*>welcome back hands &lt;3/)
  })

  it('keeps emotes in the words and the sentence above them', () => {
    const html = renderToStaticMarkup(
      createElement(CommentRow, {
        message: {
          ...streak,
          fragments: [
            { type: 'text', text: 'see you ' },
            { type: 'emote', text: 'Kappa', imageUrl: 'https://static-cdn.jtvnw.net/e/1' }
          ]
        }
      })
    )
    expect(html).toContain('watched 20 consecutive streams')
    // Before its image is cached an emote reads as its name, in the words.
    expect(html).toMatch(
      /data-slot="comment-notice-words"[^>]*><span>see you <\/span><span[^>]*>Kappa/
    )
  })

  it('is the sentence alone when the viewer typed nothing', () => {
    const html = renderToStaticMarkup(
      createElement(CommentRow, { message: { ...streak, fragments: [] } })
    )
    expect(html).not.toContain('comment-notice')
    expect(html).toContain('watched 20 consecutive streams')
  })

  it('goes on stream as an activity event', () => {
    expect(commentCanHighlight(streak)).toBe(true)
  })
})
