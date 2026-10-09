import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CohostFlagRow } from '@/components/cohost-flag-row'
import { CohostListenPrompt, CohostPane } from '@/components/cohost-pane'
import { CohostQuestionRow } from '@/components/cohost-question-row'
import { Command } from '@/components/ui/command'
import type { CohostFlag, CohostQuestion, CohostState } from '@/lib/backend'
import { EMPTY_COHOST_STATE } from '@/lib/cohost-view'
import type { EntitlementUiGate } from '@/lib/entitlement-ui'

const NOW = Date.parse('2026-08-22T12:00:00.000Z')

function question(overrides: Partial<CohostQuestion> = {}): CohostQuestion {
  return {
    id: 'q-1',
    text: 'What keyboard is that?',
    messageIds: ['twitch:m-1'],
    askers: ['Ada', 'Bo', 'Cy', 'Dee'],
    platforms: ['twitch', 'youtube'],
    priority: 'normal',
    suggestedReply: 'Keychron Q1.',
    fromNotes: false,
    firstSeenAt: '2026-08-22T11:56:00.000Z',
    updatedAt: '2026-08-22T11:56:00.000Z',
    ...overrides
  }
}

function flag(overrides: Partial<CohostFlag> = {}): CohostFlag {
  return {
    messageId: 'twitch:m-9',
    kind: 'toxicity',
    severity: 'low',
    reason: 'Insult aimed at another viewer.',
    at: '2026-08-22T11:59:50.000Z',
    ...overrides
  }
}

function state(overrides: Partial<CohostState> = {}): CohostState {
  return { ...EMPTY_COHOST_STATE, sessionId: 'session-1', status: 'listening', ...overrides }
}

/** Rows are cmdk options; they need the Command context to render. */
function renderRow(row: ReactElement): string {
  return renderToStaticMarkup(createElement(Command, { shouldFilter: false }, row))
}

function renderPane(props: Partial<Parameters<typeof CohostPane>[0]> = {}): string {
  const allowed: EntitlementUiGate = { allowed: true }
  return renderToStaticMarkup(
    createElement(CohostPane, {
      consented: true,
      enabled: true,
      gate: allowed,
      state: state(),
      onAnswered: () => undefined,
      onDismissFlag: () => undefined,
      onDismissQuestion: () => undefined,
      onReply: () => undefined,
      ...props
    })
  )
}

describe('CohostQuestionRow', () => {
  it('badges an on-topic question and nothing else (plan 068)', () => {
    const onTopic = renderRow(
      createElement(CohostQuestionRow, {
        nowMs: NOW,
        question: question({ onTopic: true }),
        selected: false,
        onReply: () => undefined,
        onSelect: () => undefined
      })
    )
    expect(onTopic).toContain('data-testid="cohost-on-topic"')
    expect(onTopic).toContain('On topic')
    const plain = renderRow(
      createElement(CohostQuestionRow, {
        nowMs: NOW,
        question: question(),
        selected: false,
        onReply: () => undefined,
        onSelect: () => undefined
      })
    )
    expect(plain).not.toContain('data-testid="cohost-on-topic"')
  })

  it('reads as one dense line: question, askers, age', () => {
    const markup = renderRow(
      createElement(CohostQuestionRow, {
        nowMs: NOW,
        question: question(),
        selected: false,
        onReply: () => undefined,
        onSelect: () => undefined
      })
    )

    expect(markup).toContain('What keyboard is that?')
    expect(markup).toContain('Ada +3')
    expect(markup).toContain('4m')
    expect(markup).toContain('data-cohost-row="question"')
    expect(markup).toContain('data-cohost-selected="false"')
  })

  it('shows the priority pill only when it is not the default, and never in colour', () => {
    const normal = renderRow(
      createElement(CohostQuestionRow, {
        nowMs: NOW,
        question: question({ priority: 'normal' }),
        selected: false,
        onReply: () => undefined,
        onSelect: () => undefined
      })
    )
    expect(normal).not.toContain('>High<')
    expect(normal).not.toContain('>Low<')

    const high = renderRow(
      createElement(CohostQuestionRow, {
        nowMs: NOW,
        question: question({ priority: 'high' }),
        selected: true,
        onReply: () => undefined,
        onSelect: () => undefined
      })
    )
    // High gets the PRIMARY TEXT TIER, not an accent colour.
    expect(high).toContain('>High<')
    expect(high).toContain('text-foreground')
    expect(high).not.toContain('text-destructive')
    expect(high).toContain('data-cohost-selected="true"')
  })

  it('marks a notes-backed answer and an on-stream question', () => {
    const markup = renderRow(
      createElement(CohostQuestionRow, {
        nowMs: NOW,
        onStream: true,
        question: question({ fromNotes: true }),
        selected: false,
        onReply: () => undefined,
        onSelect: () => undefined
      })
    )
    expect(markup).toContain('Answered from your Buddy notes')
    expect(markup).toContain('On stream')
  })
})

describe('CohostQuestionRow spotlight', () => {
  it('marks the question the streamer is talking about, quietly', () => {
    const markup = renderRow(
      createElement(CohostQuestionRow, {
        nowMs: NOW,
        question: question(),
        selected: false,
        talkingAbout: true,
        onReply: () => undefined,
        onSelect: () => undefined
      })
    )
    expect(markup).toContain('data-testid="cohost-talking-about"')
    expect(markup).toContain('Talking about this')
    expect(markup).toContain('data-variant="outline"')

    const quiet = renderRow(
      createElement(CohostQuestionRow, {
        nowMs: NOW,
        question: question(),
        selected: false,
        onReply: () => undefined,
        onSelect: () => undefined
      })
    )
    expect(quiet).not.toContain('Talking about this')
  })
})

describe('CohostFlagRow', () => {
  it('keeps medium and low severity monochrome', () => {
    const markup = renderRow(
      createElement(CohostFlagRow, {
        flag: flag({ severity: 'medium' }),
        nowMs: NOW,
        selected: false,
        onJump: () => undefined,
        onSelect: () => undefined
      })
    )
    expect(markup).toContain('Toxicity')
    expect(markup).toContain('Insult aimed at another viewer.')
    expect(markup).not.toContain('text-destructive')
    expect(markup).not.toContain('data-variant="destructive"')
  })

  it('gives only high severity the destructive emphasis chip', () => {
    const markup = renderRow(
      createElement(CohostFlagRow, {
        flag: flag({ severity: 'high' }),
        nowMs: NOW,
        selected: false,
        onJump: () => undefined,
        onSelect: () => undefined
      })
    )
    // Tinted glass (plan 050, D9), not red text on a tag.
    expect(markup).toContain('data-variant="destructive"')
    expect(markup).toContain('glass-chip-tinted')
  })
})

describe('CohostPane', () => {
  it('shows the topic, promises with their trigger hint, and the recap card (plan 068)', () => {
    const markup = renderPane({
      state: state({
        topic: 'mechanical keyboards',
        promises: [
          {
            id: 'p_1',
            text: 'Giveaway at 100 viewers',
            trigger: { kind: 'viewers', value: 100 },
            firstSeenAt: '2026-08-22T11:50:00.000Z'
          },
          {
            id: 'p_2',
            text: 'Show the build',
            trigger: { kind: 'none' },
            firstSeenAt: '2026-08-22T11:55:00.000Z'
          }
        ],
        // The pane clocks expiry on Date.now(); a far-future expiry keeps
        // the card current whenever the test runs.
        recap: {
          text: 'So far: unboxed the parts.',
          at: '2026-08-22T11:59:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z'
        }
      }),
      onPromiseDone: () => undefined,
      onPromiseDismiss: () => undefined,
      onRecapDismiss: () => undefined,
      onRecapPost: () => undefined,
      onRecapDraft: () => undefined
    })
    expect(markup).toContain('data-slot="cohost-topic"')
    expect(markup).toContain('Talking about:')
    expect(markup).toContain('mechanical keyboards')
    expect(markup).toContain('data-slot="cohost-promises"')
    expect(markup).toContain('Giveaway at 100 viewers')
    expect(markup).toContain('at 100 viewers')
    expect(markup).toContain('Show the build')
    expect(markup).toContain('>Done<')
    expect(markup).toContain('>Dismiss<')
    expect(markup).toContain('data-slot="cohost-recap"')
    expect(markup).toContain('So far: unboxed the parts.')
    expect(markup).toContain('Post to chat')
    // A live recap card replaces the draft button; nothing sends from here.
    expect(markup).not.toContain('Draft a recap')
    expect(markup).not.toContain('>Send<')
  })

  it('lists first-time chatters to say hi to, each with a Greeted button (plan 068 D9)', () => {
    const markup = renderPane({
      state: state({
        sayHi: [
          {
            authorKey: '"twitch":id-sam',
            name: 'x_Dark_Knight_x',
            platform: 'twitch',
            firstSeenAt: '2026-08-22T11:57:00.000Z'
          },
          {
            authorKey: '"youtube":id-bo',
            name: 'Bo',
            platform: 'youtube',
            firstSeenAt: '2026-08-22T11:59:40.000Z'
          }
        ]
      }),
      onSayHiGreeted: () => undefined
    })
    expect(markup).toContain('data-slot="cohost-say-hi"')
    expect(markup).toContain('>Say hi<')
    expect(markup.split('data-slot="cohost-say-hi-row"')).toHaveLength(3)
    expect(markup).toContain('x_Dark_Knight_x')
    expect(markup).toContain('aria-label="Twitch"')
    expect(markup).toContain('aria-label="YouTube"')
    expect(markup).toContain('>Greeted<')
    // Nothing waiting: no section at all.
    expect(renderPane({ state: state() })).not.toContain('data-slot="cohost-say-hi"')
    // Without the relay the button cannot act.
    expect(
      renderPane({
        state: state({
          sayHi: [
            {
              authorKey: 'k',
              name: 'Sam',
              platform: 'kick',
              firstSeenAt: '2026-08-22T11:59:00.000Z'
            }
          ]
        })
      })
    ).toMatch(/disabled=""[^>]*>Greeted</)
  })

  it('offers a recap draft while none is shown, and hides an expired recap', () => {
    const drafting = renderPane({ state: state(), onRecapDraft: () => undefined })
    expect(drafting).toContain('data-slot="cohost-recap-draft"')
    expect(drafting).toContain('Draft a recap')
    expect(drafting).not.toContain('data-slot="cohost-topic"')
    expect(drafting).not.toContain('data-slot="cohost-promises"')
    const expired = renderPane({
      state: state({
        recap: {
          text: 'old',
          at: '2026-08-22T09:00:00.000Z',
          expiresAt: '2026-08-22T09:05:00.000Z'
        }
      }),
      onRecapDraft: () => undefined
    })
    expect(expired).not.toContain('data-slot="cohost-recap"')
    expect(expired).toContain('Draft a recap')
    // Without a draft handler (no relay), nothing is offered.
    expect(renderPane({ state: state() })).not.toContain('Draft a recap')
  })

  it('names the empty state instead of showing nothing', () => {
    const markup = renderPane({ state: state({ questions: [], flags: [] }) })
    expect(markup).toContain('Reading chat. Questions will appear here.')
    expect(markup).toContain('reading chat')
  })

  it('replaces itself with a one-line upsell for a Basic account', () => {
    const markup = renderPane({
      gate: {
        allowed: false,
        featureId: 'live-cohost',
        reason: 'Buddy requires Videorc Premium.',
        upgradeUrl: 'https://www.videorc.com/premium'
      },
      onUpgrade: () => undefined
    })
    expect(markup).toContain('data-slot="cohost-notice"')
    expect(markup).toContain('Buddy requires Videorc Premium.')
    expect(markup).toContain('View Premium')
    expect(markup).not.toContain('data-testid="cohost-pane"')
  })

  it('asks for cloud-AI consent instead of quietly doing nothing', () => {
    const markup = renderPane({ consented: false, onEnableConsent: () => undefined })
    expect(markup).toContain('Turn on cloud AI')
    expect(markup).not.toContain('data-testid="cohost-pane"')
  })

  it('renders nothing at all when the streamer turned co-host off', () => {
    expect(renderPane({ enabled: false })).toBe('')
  })

  it('advertises every action with its key chip on the selected row', () => {
    const markup = renderPane({
      onShowOnStream: () => undefined,
      state: state({ questions: [question({ priority: 'high' })] })
    })
    expect(markup).toContain('data-testid="cohost-pane"')
    expect(markup).toContain('data-slot="cohost-actions"')
    for (const label of ['Reply', 'Show on stream', 'Answered', 'Dismiss']) {
      expect(markup).toContain(label)
    }
    // Plan 140: Buddy can remove a comment, but only when asked; plan 164 D4:
    // it posts only in the modes you turn on.
    expect(markup).not.toContain('Nothing sends without you.')
    expect(markup).toContain('Posts only in the modes you turn on.')
    expect(markup).toContain(
      'title="The Buddy posts only in the modes you turn on. Everything is off by default. It removes a comment only when you tell it to."'
    )
  })

  it('fits a narrow window: key chips and hint fold, actions stay named and wrap', () => {
    const markup = renderPane({
      onShowOnStream: () => undefined,
      state: state({ questions: [question()] })
    })
    expect(markup).toContain('@container/cohost-pane')
    expect(markup).toMatch(/<div class="[^"]*flex-wrap[^"]*" data-slot="cohost-actions"/)
    for (const title of ['Reply (R)', 'Show on stream (H)', 'Answered (A)', 'Dismiss (⌫)']) {
      expect(markup).toContain(`title="${title}"`)
    }
    // Every key chip carries the narrow-tier class; none is unconditional.
    const chips = markup.match(/<kbd[^>]*>/g) ?? []
    expect(chips.length).toBeGreaterThan(0)
    for (const chip of chips) expect(chip).toContain('@max-[400px]/cohost-pane:hidden')
  })

  it('keeps the chat mood in the status tooltip when the mood label folds', () => {
    const markup = renderPane({ state: state({ mood: 'hype' }) })
    expect(markup).toContain('Chat mood: Chat is hyped')
  })

  it('offers jump + dismiss when a flag is the only row', () => {
    const markup = renderPane({
      state: state({ questions: [], flags: [flag()] }),
      onJumpToMessage: () => undefined
    })
    expect(markup).toContain('Jump to message')
    expect(markup).toContain('Dismiss')
    expect(markup).not.toContain('Show on stream')
  })

  it('surfaces a partial tick and the chat mood without colouring them', () => {
    const markup = renderPane({ state: state({ mood: 'hype', partial: true }) })
    expect(markup).toContain('Partial')
    expect(markup).toContain('Chat is hyped')
  })

  it("names the failed tick in the server's words as the chip tooltip and a secondary line", () => {
    const detail = 'ai-gateway-error (HTTP 502): The Buddy tick failed on every configured model.'
    const markup = renderPane({
      state: state({
        status: 'error',
        reason: 'gateway-error',
        detail: {
          code: 'ai-gateway-error',
          message: 'The Buddy tick failed on every configured model.',
          status: 502
        }
      })
    })
    expect(markup).toContain('data-slot="cohost-pane-status"')
    expect(markup).toContain('>error<')
    expect(markup).toContain('data-tone="destructive"')
    expect(markup).toContain(`title="${detail}"`)
    expect(markup).toContain('data-slot="cohost-error-detail"')
    expect(markup).toContain('once Buddy is reading chat again')
    expect(markup).not.toContain('Reading chat. Questions')
    // Monochrome: only the presence DOT carries the error accent; the label and
    // the detail line stay chrome.
    expect(markup).not.toContain('text-destructive')

    const healthy = renderPane({ state: state() })
    expect(healthy).not.toContain('data-slot="cohost-error-detail"')
    expect(healthy).toContain('Reading chat. Questions will appear here.')
  })
  it('mirrors the working shimmer in the segment header while chat is queued', () => {
    const reading = renderPane({ state: state({ pendingMessages: 4 }) })
    expect(reading).toContain('data-slot="cohost-typing-dots"')
    expect(reading).toContain('>reading 4 new…<')
    // The empty state stops claiming "Listening —" while there is real work.
    expect(reading).toContain('Reading 4 new messages…')
    expect(reading).not.toContain('Reading chat. Questions')

    const thinking = renderPane({ state: state({ tickInFlight: true, pendingMessages: 4 }) })
    expect(thinking).toContain('typing-dot-fast')
    expect(thinking).toContain('>thinking…<')
    expect(thinking).toContain('Thinking about the last batch…')
  })

  it('shows the presence dot for every state, live-green only while listening', () => {
    expect(renderPane({ state: state() })).toContain('data-tone="live"')
    expect(renderPane({ state: state({ status: 'off', sessionId: null }) })).toContain(
      'data-tone="muted"'
    )
  })

  it('flashes the grouped delta in place of the count', () => {
    const markup = renderPane({
      flash: 'grouped 2 questions',
      state: state({ questions: [question()] })
    })
    expect(markup).toContain('grouped 2 questions')
    expect(markup).not.toContain('>1 q<')
  })
})

describe('the one-time listening card (plan 068 D3)', () => {
  const renderPrompt = (enabled: boolean, listen: boolean | undefined): string =>
    renderToStaticMarkup(
      createElement(CohostListenPrompt, { enabled, listen, onTurnOn: () => undefined })
    )

  it('asks a Buddy user with listening off', () => {
    const markup = renderPrompt(true, false)
    expect(markup).toContain('data-slot="cohost-listen-prompt"')
    expect(markup).toContain('Buddy can hear you while you&#x27;re live')
    // The consent names the cloud step and what is (not) kept (plan 068 D3).
    expect(markup).toContain('goes to Videorc&#x27;s cloud speech-to-text to be turned into text')
    expect(markup).toContain('Videorc servers don&#x27;t keep it.')
    expect(markup).toContain('The transcript is saved with your recording on')
    expect(markup).toContain('>Turn on<')
    expect(markup).toContain('>Not now<')
  })

  it('stays away when listening is on or unknown, or Buddy cannot run', () => {
    expect(renderPrompt(true, true)).toBe('')
    expect(renderPrompt(true, undefined)).toBe('')
    expect(renderPrompt(false, false)).toBe('')
  })
})
