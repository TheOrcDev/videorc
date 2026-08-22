import { describe, expect, it } from 'vitest'

import type { CohostFlag, CohostQuestion, CohostReason, CohostState } from '@/lib/backend'
import {
  applyCohostState,
  cohostAgeLabel,
  cohostAskersLabel,
  cohostChipView,
  cohostErrorToastReason,
  cohostFlagRowKey,
  cohostHighlightMessageId,
  cohostPaneMode,
  cohostQuestionRowKey,
  cohostRowAt,
  cohostRows,
  draftForQuestion,
  moveCohostSelection,
  resolveCohostSelection,
  sortedCohostFlags,
  sortedCohostQuestions,
  trimDraftToCap,
  EMPTY_COHOST_STATE
} from '@/lib/cohost-view'
import { CHAT_SEND_MAX_CHARS } from '@/lib/chat-send'

function question(overrides: Partial<CohostQuestion> = {}): CohostQuestion {
  return {
    id: 'q-1',
    text: 'What keyboard is that?',
    messageIds: ['twitch:m-1', 'youtube:m-2'],
    askers: ['Ada'],
    platforms: ['twitch'],
    priority: 'normal',
    suggestedReply: 'Keychron Q1 with Boba U4T switches.',
    fromNotes: false,
    firstSeenAt: '2026-08-22T12:00:00.000Z',
    updatedAt: '2026-08-22T12:00:05.000Z',
    ...overrides
  }
}

function flag(overrides: Partial<CohostFlag> = {}): CohostFlag {
  return {
    messageId: 'twitch:m-9',
    kind: 'spam',
    severity: 'low',
    reason: 'Repeated link drop.',
    at: '2026-08-22T12:00:10.000Z',
    ...overrides
  }
}

function state(overrides: Partial<CohostState> = {}): CohostState {
  return {
    ...EMPTY_COHOST_STATE,
    sessionId: 'session-1',
    status: 'listening',
    tickSeq: 4,
    ...overrides
  }
}

describe('applyCohostState', () => {
  it('takes the first state it is given', () => {
    const next = state()
    expect(applyCohostState(null, next)).toBe(next)
  })

  it('drops a stale tick for the SAME session', () => {
    const current = state({ tickSeq: 7 })
    const stale = state({ tickSeq: 6 })
    expect(applyCohostState(current, stale)).toBe(current)
  })

  it('keeps an action result that reuses the current tick', () => {
    const current = state({ tickSeq: 7, questions: [question()] })
    const answered = state({ tickSeq: 7, questions: [] })
    expect(applyCohostState(current, answered)).toBe(answered)
  })

  it('always accepts a different session — the engine restarted', () => {
    const current = state({ sessionId: 'session-1', tickSeq: 99 })
    const restarted = state({ sessionId: 'session-2', tickSeq: 0 })
    expect(applyCohostState(current, restarted)).toBe(restarted)
  })
})

describe('ordering', () => {
  it('sorts questions by priority, then oldest first, then id', () => {
    const rows = sortedCohostQuestions([
      question({ id: 'b', priority: 'low', firstSeenAt: '2026-08-22T12:00:00.000Z' }),
      question({ id: 'c', priority: 'high', firstSeenAt: '2026-08-22T12:05:00.000Z' }),
      question({ id: 'a', priority: 'high', firstSeenAt: '2026-08-22T12:01:00.000Z' }),
      question({ id: 'd', priority: 'normal', firstSeenAt: '2026-08-22T12:02:00.000Z' })
    ])
    expect(rows.map((row) => row.id)).toEqual(['a', 'c', 'd', 'b'])
  })

  it('keeps equal questions in a stable id order', () => {
    const rows = sortedCohostQuestions([
      question({ id: 'zeta' }),
      question({ id: 'alpha' }),
      question({ id: 'mid' })
    ])
    expect(rows.map((row) => row.id)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('sorts flags newest first', () => {
    const rows = sortedCohostFlags([
      flag({ messageId: 'old', at: '2026-08-22T12:00:00.000Z' }),
      flag({ messageId: 'new', at: '2026-08-22T12:09:00.000Z' })
    ])
    expect(rows.map((row) => row.messageId)).toEqual(['new', 'old'])
  })
})

describe('cohostChipView', () => {
  it('hides entirely without state', () => {
    expect(cohostChipView(null)).toBeNull()
  })

  it('is the only chip that earns the live accent while listening', () => {
    expect(cohostChipView(state({ questions: [question(), question({ id: 'q-2' })] }))).toEqual({
      label: 'Co-host: listening · 2 q',
      tone: 'live'
    })
    expect(cohostChipView(state({ questions: [] }))).toEqual({
      label: 'Co-host: listening',
      tone: 'live'
    })
  })

  it('names every paused reason in the destination strip vocabulary', () => {
    const cases: Array<[CohostReason, string]> = [
      ['premium-required', 'Co-host: paused · Premium'],
      ['consent-required', 'Co-host: paused · consent'],
      ['quota-exhausted', 'Co-host: paused · quota'],
      ['session-expired', 'Co-host: paused · session expired'],
      ['signed-out', 'Co-host: paused · signed out'],
      ['server-unconfigured', 'Co-host: paused · unavailable'],
      ['network', 'Co-host: paused · offline'],
      ['gateway-error', 'Co-host: paused · AI error']
    ]
    for (const [reason, label] of cases) {
      expect(cohostChipView(state({ status: 'paused', reason }))).toEqual({ label, tone: 'muted' })
    }
  })

  it('stays monochrome for off and error', () => {
    expect(cohostChipView(state({ status: 'off', reason: null }))).toEqual({
      label: 'Co-host: off',
      tone: 'muted'
    })
    expect(cohostChipView(state({ status: 'error', reason: 'gateway-error' }))).toEqual({
      label: 'Co-host: error · AI error',
      tone: 'muted'
    })
    expect(cohostChipView(state({ status: 'error', reason: null }))).toEqual({
      label: 'Co-host: error',
      tone: 'muted'
    })
  })
})

describe('cohostPaneMode', () => {
  const locked = {
    allowed: false as const,
    featureId: 'live-cohost' as const,
    reason: 'Live Co-host requires Videorc Premium.',
    upgradeUrl: 'https://www.videorc.com/premium'
  }

  it('shows the upsell before anything else — a Basic user never sees a consent prompt', () => {
    expect(cohostPaneMode({ gate: locked, consented: false, enabled: false })).toEqual({
      kind: 'upsell',
      reason: locked.reason,
      upgradeUrl: locked.upgradeUrl
    })
  })

  it('asks for cloud-AI consent before the engine can run', () => {
    expect(cohostPaneMode({ gate: { allowed: true }, consented: false, enabled: true }).kind).toBe(
      'consent'
    )
  })

  it('hides itself when the streamer turned the feature off', () => {
    expect(cohostPaneMode({ gate: { allowed: true }, consented: true, enabled: false }).kind).toBe(
      'disabled'
    )
  })

  it('renders the pane once Premium, consent, and the toggle all agree', () => {
    expect(cohostPaneMode({ gate: { allowed: true }, consented: true, enabled: true })).toEqual({
      kind: 'live'
    })
  })
})

describe('keyboard selection', () => {
  const current = state({
    questions: [question({ id: 'q-1' }), question({ id: 'q-2' })],
    flags: [flag({ messageId: 'f-1' })]
  })

  it('walks questions then flags in one flat list', () => {
    expect(cohostRows(current).map((row) => row.key)).toEqual([
      cohostQuestionRowKey('q-1'),
      cohostQuestionRowKey('q-2'),
      cohostFlagRowKey('f-1')
    ])
  })

  it('defaults to the top row and keeps a live selection across ticks', () => {
    const rows = cohostRows(current)
    expect(resolveCohostSelection(rows, null)).toBe(cohostQuestionRowKey('q-1'))
    expect(resolveCohostSelection(rows, cohostFlagRowKey('f-1'))).toBe(cohostFlagRowKey('f-1'))
  })

  it('falls back to the top row when the selected question was answered away', () => {
    const rows = cohostRows(state({ questions: [question({ id: 'q-2' })] }))
    expect(resolveCohostSelection(rows, cohostQuestionRowKey('q-1'))).toBe(
      cohostQuestionRowKey('q-2')
    )
    expect(resolveCohostSelection([], 'anything')).toBeNull()
  })

  it('clamps at both ends instead of wrapping', () => {
    const rows = cohostRows(current)
    expect(moveCohostSelection(rows, null, -1)).toBe(cohostQuestionRowKey('q-1'))
    expect(moveCohostSelection(rows, cohostQuestionRowKey('q-1'), 1)).toBe(
      cohostQuestionRowKey('q-2')
    )
    expect(moveCohostSelection(rows, cohostFlagRowKey('f-1'), 1)).toBe(cohostFlagRowKey('f-1'))
    expect(moveCohostSelection([], null, 1)).toBeNull()
  })

  it('resolves the selected row back to its kind and id', () => {
    const rows = cohostRows(current)
    expect(cohostRowAt(rows, cohostFlagRowKey('f-1'))).toEqual({
      key: cohostFlagRowKey('f-1'),
      kind: 'flag',
      id: 'f-1'
    })
  })
})

describe('reply drafts', () => {
  it('keeps a draft that already fits', () => {
    expect(draftForQuestion(question(), ['twitch', 'youtube'])).toBe(
      'Keychron Q1 with Boba U4T switches.'
    )
  })

  it('trims to the SMALLEST cap of the targets it will reach', () => {
    const long = 'a'.repeat(CHAT_SEND_MAX_CHARS + 40)
    expect(draftForQuestion(question({ suggestedReply: long }), ['twitch']).length).toBe(
      CHAT_SEND_MAX_CHARS
    )
    // No targets is still capped: the composer must never accept an over-cap draft.
    expect(draftForQuestion(question({ suggestedReply: long }), []).length).toBe(
      CHAT_SEND_MAX_CHARS
    )
  })

  it('breaks on a word when a clean break is close to the cap', () => {
    expect(trimDraftToCap('hello there friend', 14)).toBe('hello there')
    expect(trimDraftToCap('  padded  ', 20)).toBe('padded')
    expect(trimDraftToCap('supercalifragilistic', 5)).toBe('super')
    expect(trimDraftToCap('anything', 0)).toBe('')
  })
})

describe('row copy', () => {
  it('names the first asker and counts the rest', () => {
    expect(cohostAskersLabel([])).toBe('')
    expect(cohostAskersLabel(['Ada'])).toBe('Ada')
    expect(cohostAskersLabel(['Ada', 'Bo', 'Cy', 'Dee'])).toBe('Ada +3')
  })

  it('reads ages compactly', () => {
    const now = Date.parse('2026-08-22T12:00:00.000Z')
    expect(cohostAgeLabel('2026-08-22T11:59:40.000Z', now)).toBe('now')
    expect(cohostAgeLabel('2026-08-22T11:56:00.000Z', now)).toBe('4m')
    expect(cohostAgeLabel('2026-08-22T10:00:00.000Z', now)).toBe('2h')
    expect(cohostAgeLabel('2026-08-20T12:00:00.000Z', now)).toBe('2d')
    expect(cohostAgeLabel('not-a-date', now)).toBe('')
  })

  it('highlights the first source message of a group', () => {
    expect(cohostHighlightMessageId(question())).toBe('twitch:m-1')
    expect(cohostHighlightMessageId(question({ messageIds: [] }))).toBeNull()
  })
})

describe('cohostErrorToastReason', () => {
  it('says nothing for states the pane already shows', () => {
    expect(cohostErrorToastReason(null, state())).toBeNull()
    expect(
      cohostErrorToastReason(null, state({ status: 'paused', reason: 'quota-exhausted' }))
    ).toBeNull()
  })

  it('toasts a NEW error reason exactly once', () => {
    const errored = state({ status: 'error', reason: 'gateway-error' })
    expect(cohostErrorToastReason(state(), errored)).toBe('gateway-error')
    expect(cohostErrorToastReason(errored, errored)).toBeNull()
  })

  it('toasts again when the error reason changes', () => {
    const first = state({ status: 'error', reason: 'gateway-error' })
    const second = state({ status: 'error', reason: 'network' })
    expect(cohostErrorToastReason(first, second)).toBe('network')
  })
})
