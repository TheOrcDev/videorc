import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { StreamManager, type StreamManagerProps } from '@/components/stream-manager/stream-manager'
import type {
  CohostQuestion,
  CommentHighlightState,
  LiveChatMessage,
  LiveChatProviderState,
  LiveChatSnapshot,
  ModerationOperation,
  StreamPlatform
} from '@/lib/backend'
import { EMPTY_COHOST_STATE } from '@/lib/cohost-view'
import { emptyLiveDashboardState } from '../../../../shared/live-dashboard'

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
    const activity = between(markup, 'data-slot="activity-pane"', 'data-pane="buddy"')
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
    // The Buddy question behind another message is not on stream.
    const buddy = markup.slice(markup.indexOf('data-pane="buddy"'))
    expect(buddy).not.toMatch(/data-variant="success"[^>]*>On stream</)
  })

  it('lights the Buddy badge for the question on stream, without the Activity dot', () => {
    const markup = render(live(chat.id))
    const buddy = markup.slice(markup.indexOf('data-pane="buddy"'))
    expect(buddy).toMatch(/data-variant="success"[^>]*>On stream</)
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

describe('StreamManager Remove messages reconnect (plan 140, S5)', () => {
  // The backend's per-destination `moderate` state (S4) drives the rows.
  const provider = (platform: StreamPlatform, moderate: string): LiveChatProviderState =>
    ({
      id: `${platform}-destination`,
      platform,
      read: 'ready',
      write: 'ready',
      state: 'connected',
      message: '',
      moderate
    }) as LiveChatProviderState
  const missing = [
    provider('twitch', 'missing-scope'),
    provider('youtube', 'missing-scope'),
    provider('kick', 'ready')
  ]
  const renderWith = (patch: Partial<StreamManagerProps>): string =>
    renderToStaticMarkup(
      createElement(StreamManager, {
        snapshot: { ...snapshot, providers: missing },
        dashboard: null,
        cohostGate: { allowed: true },
        cohostConsented: true,
        cohostEnabled: true,
        cohostState: { ...EMPTY_COHOST_STATE, sessionId: 's1', status: 'listening' },
        onReconnectScopes: () => undefined,
        ...patch
      })
    )

  it('scrolls the Buddy pane as a whole, so a short window never hides the Say box', () => {
    // Hyprland tiled the window at 320x331 (under its 360 px minimum): the
    // fixed header, chat controls and Say footer overflowed under the status
    // bar, which then took every click meant for the Say box.
    const pane = renderWith({}).match(/<div class="([^"]*)" data-slot="buddy-pane"/)
    expect(pane?.[1].split(' ')).toEqual(expect.arrayContaining(['min-h-0', 'overflow-y-auto']))
  })

  it('puts one quiet row in the Buddy pane for each platform missing the permission', () => {
    const markup = renderWith({})
    const buddy = markup.slice(markup.indexOf('data-slot="buddy-pane"'))
    expect(buddy).toContain('data-slot="remove-messages-reconnect"')
    expect(buddy).toContain('Reconnect Twitch to let Buddy remove messages.')
    expect(markup.match(/to let Buddy remove messages/g)).toHaveLength(1)
    expect(markup).not.toContain('Reconnect YouTube')
    expect(markup).not.toContain('Reconnect Kick')
  })

  it('stays away in history, without a handler, and when nothing is missing', () => {
    expect(
      renderWith({
        viewMode: {
          kind: 'history',
          sessionId: 's1',
          title: 'Earlier stream',
          startedAt: '2026-10-02T10:00:00Z'
        }
      })
    ).not.toContain('remove-messages-reconnect')
    expect(renderWith({ onReconnectScopes: undefined })).not.toContain('remove-messages-reconnect')
    expect(
      renderWith({
        snapshot: { ...snapshot, providers: [provider('twitch', 'ready')] }
      })
    ).not.toContain('remove-messages-reconnect')
  })
})

describe('StreamManager removal cards (plan 140, S6)', () => {
  const pending: ModerationOperation = {
    operationId: '6f1c2e9a-3b7d-4c51-9e2f-0a1b2c3d4e5f',
    sessionId: 's1',
    messageId: chat.id,
    platform: 'twitch',
    authorName: 'Ada',
    excerpt: 'What keyboard is that?',
    source: 'orcle-voice',
    reason: 'spam',
    phase: 'pending-confirm',
    confirmMode: 'confirm',
    requiresExplicitConfirm: true,
    confirmBy: '2099-01-01T00:00:00Z',
    createdAt: '2026-10-04T12:00:00Z',
    updatedAt: '2026-10-04T12:00:00Z'
  }
  const renderWith = (patch: Partial<StreamManagerProps>): string =>
    renderToStaticMarkup(
      createElement(StreamManager, {
        snapshot,
        dashboard: null,
        cohostGate: { allowed: true },
        cohostConsented: true,
        cohostEnabled: true,
        cohostState: { ...EMPTY_COHOST_STATE, sessionId: 's1', status: 'listening' },
        onReconnectScopes: () => undefined,
        moderationOperations: [pending],
        onAnswerRemoval: () => undefined,
        onRemoveFromChat: () => undefined,
        ...patch
      })
    )

  it('puts the open card at the top of the Buddy pane, above everything that scrolls', () => {
    const markup = renderWith({})
    const buddy = markup.slice(markup.indexOf('data-slot="buddy-pane"'))
    const cards = buddy.indexOf('data-slot="removal-cards"')
    expect(cards).toBeGreaterThan(buddy.indexOf('data-slot="buddy-pane-header"'))
    expect(cards).toBeLessThan(buddy.indexOf('data-testid="cohost-pane"'))
    expect(buddy).toContain('Remove from chat?')
    expect(buddy).toContain('spam')
    // Only the Buddy pane carries cards.
    expect(markup.match(/data-testid="removal-card"/g)).toHaveLength(1)
  })

  it('puts what Buddy heard, then the chooser, above the removal cards (part B)', () => {
    const markup = renderWith({
      onAnswerCommand: () => undefined,
      cohostState: {
        ...EMPTY_COHOST_STATE,
        sessionId: 's1',
        status: 'listening',
        command: {
          id: 'cmd-1',
          heard: 'buddy remove it',
          kind: 'remove',
          status: 'ambiguous',
          message: 'Which comment?',
          candidates: [
            { messageId: chat.id, authorName: 'Ada', platform: 'twitch', excerpt: 'hi' }
          ],
          at: '2099-01-01T00:00:00Z',
          expiresAt: '2099-01-01T00:00:20Z'
        }
      }
    })
    const buddy = markup.slice(markup.indexOf('data-slot="buddy-pane"'))
    const strip = buddy.indexOf('data-slot="command-strip"')
    const chooser = buddy.indexOf('data-testid="command-chooser"')
    expect(strip).toBeGreaterThan(-1)
    expect(chooser).toBeGreaterThan(strip)
    expect(buddy.indexOf('data-slot="removal-cards"')).toBeGreaterThan(chooser)
    expect(buddy).toContain('Heard: “buddy remove it”')
    // History never shows a command.
    expect(
      renderWith({
        onAnswerCommand: () => undefined,
        viewMode: {
          kind: 'history',
          sessionId: 's1',
          title: 'Earlier stream',
          startedAt: '2026-10-02T10:00:00Z'
        }
      })
    ).not.toContain('data-slot="command-strip"')
  })

  it('never shows a card in history, without a handler, or for a manual removal', () => {
    expect(
      renderWith({
        viewMode: {
          kind: 'history',
          sessionId: 's1',
          title: 'Earlier stream',
          startedAt: '2026-10-02T10:00:00Z'
        }
      })
    ).not.toContain('data-testid="removal-card"')
    expect(renderWith({ onAnswerRemoval: undefined })).not.toContain('data-testid="removal-card"')
    expect(
      renderWith({ moderationOperations: [{ ...pending, source: 'manual', phase: 'executing' }] })
    ).not.toContain('data-testid="removal-card"')
  })
})

describe('StreamManager Buddy Live and how Buddy talks (plan 174 S3.14a, D7, plan 211 D1)', () => {
  const autoChat = {
    talk: 'suggest' as const,
    mode: 'suggest' as const,
    greetings: { enabled: true, templates: [] },
    answers: { enabled: false, cooldownSeconds: 20 },
    banter: { enabled: false, cooldownSeconds: 240 }
  }
  const renderWith = (patch: Partial<StreamManagerProps>): string =>
    renderToStaticMarkup(
      createElement(StreamManager, {
        snapshot,
        dashboard: null,
        cohostGate: { allowed: true },
        cohostConsented: true,
        cohostEnabled: false,
        cohostState: EMPTY_COHOST_STATE,
        cohostAutoChat: autoChat,
        onCohostAutoChatChange: () => undefined,
        onCohostEnable: () => undefined,
        ...patch
      })
    )

  it('puts the Buddy Live switch in the pane header, with no popover and no second home', () => {
    const markup = renderWith({})
    const header = between(
      markup,
      'data-slot="buddy-pane-header"',
      'data-slot="buddy-chat-controls"'
    )
    expect(header).toContain('data-slot="buddy-live-switch"')
    expect(header).toMatch(/role="switch"[^>]*aria-checked="false"/)
    expect(header).not.toContain('cohost-status-enable')
    expect(markup.match(/data-slot="buddy-live-switch"/g)).toHaveLength(1)
    // Off: the status says so, and the pane shows only its header and controls.
    expect(header).toContain('data-state-kind="off"')
    expect(renderWith({ cohostEnabled: true })).toMatch(
      /data-slot="buddy-live-switch"[\s\S]*?aria-checked="true"/
    )
  })

  it('shows how Buddy talks and the read-only behaviour chips under the header', () => {
    const markup = renderWith({ onCohostOpenChatSettings: () => undefined })
    const controls = between(
      markup,
      'data-slot="buddy-chat-controls"',
      'data-slot="buddy-talk-hint"'
    )
    expect(controls).toContain('Buddy talks')
    expect(controls).toMatch(/data-buddy-talk="suggest"[^>]*aria-checked="true"/)
    expect(controls).not.toContain('data-buddy-talk="auto"')
    expect(controls).not.toContain('role="switch"')
    expect(controls).toContain('Greetings on')
    expect(controls).toContain('Answers off')
    expect(controls).toContain('Banter off')
    expect(markup).toContain('Each message is a card here; one click posts it to chat as you.')
  })

  it('says Bubble says nothing while the Buddy is on no output, Buddy Live on or off (plan 211 D9)', () => {
    const onAir = {
      ...emptyLiveDashboardState('now'),
      sessionId: 's1',
      session: { state: 'live' as const, startedAt: '2026-10-02T10:00:00Z' }
    }
    const offStream = {
      persona: {
        id: 'p-1',
        name: 'Golmar',
        images: {},
        bubbleStyle: 'speech' as const,
        source: 'default' as const
      },
      state: 'idle' as const,
      bubble: null,
      showOnStream: false,
      showInRecording: false
    }
    const notice = (patch: Partial<StreamManagerProps>): string | undefined =>
      renderWith({
        dashboard: onAir,
        cohostBuddy: offStream,
        onBuddyShowOnStream: () => undefined,
        ...patch
      }).match(/data-testid="buddy-off-outputs"[\s\S]*?Show on stream/)?.[0]
    const bubble = { ...autoChat, talk: 'bubble' as const }
    for (const cohostEnabled of [false, true]) {
      const shown = notice({ cohostAutoChat: bubble, cohostEnabled })
      expect(shown).toContain('Golmar isn&#x27;t on stream.')
      expect(shown).toContain('Viewers can&#x27;t see its bubble, so Bubble says nothing.')
    }
    // Suggest is unchanged: only with Buddy Live on.
    expect(notice({})).toBeUndefined()
    expect(notice({ cohostEnabled: true })).toContain('its bubbles or its reactions')
  })

  it('says the greetings are written with AI only with Premium and cloud AI (plan 192 D7)', () => {
    const greetingsChip = (patch: Partial<StreamManagerProps>): string | undefined =>
      renderWith({ onCohostOpenChatSettings: () => undefined, ...patch }).match(
        /data-behaviour="greetings"[^>]*>([^<]*)</
      )?.[1]
    expect(greetingsChip({})).toBe('Greetings on · AI')
    expect(greetingsChip({ cohostConsented: false })).toBe('Greetings on')
    expect(
      greetingsChip({
        cohostGate: {
          allowed: false,
          featureId: 'live-cohost',
          reason: 'Buddy requires Videorc Premium.',
          upgradeUrl: 'https://www.videorc.com/premium'
        }
      })
    ).toBe('Greetings on')
    expect(
      greetingsChip({
        cohostAutoChat: { ...autoChat, greetings: { ...autoChat.greetings, ai: false } }
      })
    ).toBe('Greetings on')
  })

  it('locks the switch off, with the Premium reason, for a Basic account that has Buddy off', () => {
    const basic = {
      allowed: false as const,
      featureId: 'live-cohost' as const,
      reason: 'Buddy requires Videorc Premium.',
      upgradeUrl: 'https://www.videorc.com/premium'
    }
    const locked = renderWith({ cohostGate: basic })
    expect(locked).toMatch(/data-slot="buddy-live-switch"[\s\S]*?data-slot="disabled-reason"/)
    expect(locked).toMatch(/role="switch"[^>]*disabled=""/)
    // On already: the lock never keeps a streamer from turning Buddy off.
    const on = renderWith({ cohostGate: basic, cohostEnabled: true })
    expect(on).not.toMatch(/role="switch"[^>]*disabled=""/)
  })
})

it('uses confirmed whole-session stats only for the visible session owner', () => {
  const totals = {
    status: 'available' as const,
    sessionId: 's1',
    revision: 6003,
    messageCount: 6003,
    chatters: 6002,
    platforms: ['twitch' as const, 'youtube' as const],
    supporters: 7,
    follows: 0,
    bits: 0,
    tips: [{ currency: 'USD', amountMicros: 20_000_000 }],
    raids: 0
  }
  const dashboard = { ...emptyLiveDashboardState('now'), sessionId: 's1', chatTotals: totals }
  const renderStats = (owner: string, history = false) =>
    renderToStaticMarkup(
      createElement(StreamManager, {
        snapshot: {
          ...snapshot,
          sessionId: owner,
          messages: [{ ...chat, platform: 'x', sessionId: owner }]
        },
        dashboard,
        ...(history
          ? {
              viewMode: {
                kind: 'history' as const,
                sessionId: owner,
                title: 'Finished',
                startedAt: 'now'
              },
              history: { viewers: [], audience: null, chatTotals: totals }
            }
          : {})
      })
    )
  const current = renderStats('s1')
  expect(current).toContain('aria-label="7 new supporters this stream"')
  expect(current).toContain('aria-label="Tips this stream: $20"')
  expect(renderStats('s1', true)).toContain('aria-label="6,003 messages, 6,002 chatters"')
  expect(renderStats('s2')).not.toContain('7 new supporters this stream')
  expect(renderStats('s2', true)).not.toContain('6,003 messages, 6,002 chatters')
})
