import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CohostFlagRow } from '@/components/cohost-flag-row'
import { CohostPane } from '@/components/cohost-pane'
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
    expect(markup).toContain('Answered from your co-host notes')
    expect(markup).toContain('On stream')
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
  })

  it('gives only high severity the destructive accent', () => {
    const markup = renderRow(
      createElement(CohostFlagRow, {
        flag: flag({ severity: 'high' }),
        nowMs: NOW,
        selected: false,
        onJump: () => undefined,
        onSelect: () => undefined
      })
    )
    expect(markup).toContain('text-destructive')
  })
})

describe('CohostPane', () => {
  it('names the empty state instead of showing nothing', () => {
    const markup = renderPane({ state: state({ questions: [], flags: [] }) })
    expect(markup).toContain('Listening — questions from chat will appear here.')
    expect(markup).toContain('listening')
  })

  it('replaces itself with a one-line upsell for a Basic account', () => {
    const markup = renderPane({
      gate: {
        allowed: false,
        featureId: 'live-cohost',
        reason: 'Live Co-host requires Videorc Premium.',
        upgradeUrl: 'https://www.videorc.com/premium'
      },
      onUpgrade: () => undefined
    })
    expect(markup).toContain('data-slot="cohost-notice"')
    expect(markup).toContain('Live Co-host requires Videorc Premium.')
    expect(markup).toContain('View Premium')
    expect(markup).not.toContain('data-slot="cohost-pane"')
  })

  it('asks for cloud-AI consent instead of quietly doing nothing', () => {
    const markup = renderPane({ consented: false, onEnableConsent: () => undefined })
    expect(markup).toContain('Turn on cloud AI')
    expect(markup).not.toContain('data-slot="cohost-pane"')
  })

  it('renders nothing at all when the streamer turned co-host off', () => {
    expect(renderPane({ enabled: false })).toBe('')
  })

  it('advertises every action with its key chip on the selected row', () => {
    const markup = renderPane({
      onShowOnStream: () => undefined,
      state: state({ questions: [question({ priority: 'high' })] })
    })
    expect(markup).toContain('data-slot="cohost-pane"')
    expect(markup).toContain('data-slot="cohost-actions"')
    for (const label of ['Reply', 'Show on stream', 'Answered', 'Dismiss']) {
      expect(markup).toContain(label)
    }
    expect(markup).toContain('Nothing sends without you.')
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
})
