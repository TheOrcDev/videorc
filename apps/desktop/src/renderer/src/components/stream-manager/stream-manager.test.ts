import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { StreamManager } from '@/components/stream-manager/stream-manager'
import type {
  CohostQuestion,
  CommentHighlightState,
  LiveChatMessage,
  LiveChatSnapshot
} from '@/lib/backend'
import { EMPTY_COHOST_STATE } from '@/lib/cohost-view'

const message = (overrides: Partial<LiveChatMessage>): LiveChatMessage => ({
  id: 's1:twitch:t:m-chat',
  providerMessageId: 'm-chat',
  platform: 'twitch',
  sessionId: 's1',
  authorName: 'Ada',
  authorBadges: [],
  authorRoles: [],
  publishedAt: '2026-10-02T10:00:00Z',
  receivedAt: '2026-10-02T10:00:00Z',
  messageText: 'What keyboard is that?',
  fragments: [],
  eventType: 'message',
  isDeleted: false,
  ...overrides
})

const chat = message({})
const follow = message({
  id: 's1:x:t:follow:-1',
  providerMessageId: 'follow:-1',
  platform: 'x',
  authorName: 'New Fan',
  messageText: 'New Fan followed',
  eventType: 'follow',
  details: { kind: 'follow', handle: 'newfan' }
})

const snapshot: LiveChatSnapshot = {
  sessionId: 's1',
  providers: [],
  messages: [chat, follow],
  unreadCount: 0,
  updatedAt: '2026-10-02T10:00:05Z'
}

const question: CohostQuestion = {
  id: 'q-1',
  text: 'What keyboard is that?',
  messageIds: [chat.id],
  askers: ['Ada'],
  platforms: ['twitch'],
  priority: 'normal',
  suggestedReply: 'Keychron Q1.',
  fromNotes: false,
  firstSeenAt: '2026-10-02T10:00:00Z',
  updatedAt: '2026-10-02T10:00:00Z'
}

const live = (messageId: string): CommentHighlightState => ({
  sessionId: 's1',
  generation: 2,
  phase: 'live',
  messageId
})

/** The Stream Manager as the comments window mounts it: highlight state from
 * the relay, and never a `highlightedId` (plan 095, S2). */
function render(highlightState: CommentHighlightState): string {
  return renderToStaticMarkup(
    createElement(StreamManager, {
      snapshot,
      dashboard: null,
      highlightState,
      onHighlight: () => undefined,
      cohostGate: { allowed: true },
      cohostConsented: true,
      cohostEnabled: true,
      cohostState: {
        ...EMPTY_COHOST_STATE,
        sessionId: 's1',
        status: 'listening',
        questions: [question]
      }
    })
  )
}

const between = (markup: string, from: string, to: string): string => {
  const start = markup.indexOf(from)
  expect(start).toBeGreaterThan(-1)
  const end = markup.indexOf(to, start)
  return markup.slice(start, end === -1 ? undefined : end)
}

describe('StreamManager highlight slot (plan 095, S2)', () => {
  it('tells Activity which item is on stream, and dots its tab while hidden', () => {
    const markup = render(live(follow.id))
    const activity = between(markup, 'data-slot="activity-pane"', 'data-pane="orcle"')
    const row = between(activity, `data-activity-id="${follow.id}"`, '</li>')
    expect(row).toContain('data-highlight-phase="live"')
    expect(row).toContain('On stream')
    // Activity is behind a tab (nothing is on screen in a static render):
    // both tab rows carry the dot, on the Activity tab only.
    const narrowTabs = between(markup, 'data-slot="pane-tabs-narrow"', 'data-slot="pane-tabs-wide"')
    expect(narrowTabs.match(/data-slot="pane-on-stream"/g)).toHaveLength(1)
    expect(between(narrowTabs, 'data-slot="pane-on-stream"', '</button>')).toContain('Activity')
    const wideTabs = between(markup, 'data-slot="pane-tabs-wide"', 'data-pane="chat"')
    expect(wideTabs.match(/data-slot="pane-on-stream"/g)).toHaveLength(1)
    // The Orcle question behind another message is not on stream.
    const orcle = markup.slice(markup.indexOf('data-pane="orcle"'))
    expect(orcle).not.toMatch(/data-variant="success"[^>]*>On stream</)
  })

  it('lights the Orcle badge for the question on stream, without the Activity dot', () => {
    const markup = render(live(chat.id))
    const orcle = markup.slice(markup.indexOf('data-pane="orcle"'))
    expect(orcle).toMatch(/data-variant="success"[^>]*>On stream</)
    // A chat message has its own row in Chat: no Activity tab dot.
    expect(markup).not.toContain('data-slot="pane-on-stream"')
  })

  it('shows nothing once the slot is idle', () => {
    const markup = render({ sessionId: 's1', generation: 3, phase: 'idle' })
    expect(markup).not.toContain('data-slot="pane-on-stream"')
    expect(markup).not.toContain('data-highlight-phase="live"')
    expect(markup).not.toMatch(/data-variant="success"[^>]*>On stream</)
  })
})
