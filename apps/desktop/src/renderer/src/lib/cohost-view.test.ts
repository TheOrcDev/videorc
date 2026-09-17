import { describe, expect, it } from 'vitest'

import type {
  CohostErrorDetail,
  CohostFlag,
  CohostQuestion,
  CohostReason,
  CohostState
} from '@/lib/backend'
import {
  applyCohostState,
  cohostAgeLabel,
  cohostAskersLabel,
  cohostChipView,
  cohostErrorDetailText,
  cohostErrorToast,
  cohostErrorToastKey,
  cohostErrorToastMessage,
  cohostFlagRowKey,
  cohostHighlightMessageId,
  cohostNudgeDismissedFromStorage,
  cohostNudgeVisible,
  cohostPaneMode,
  cohostQuestionRowKey,
  cohostQuestionToast,
  cohostQuestionToastMessage,
  cohostRowAt,
  cohostRows,
  draftForQuestion,
  moveCohostSelection,
  reduceCohostUnread,
  resolveCohostSelection,
  sortedCohostFlags,
  sortedCohostQuestions,
  trimDraftToCap,
  COHOST_QUESTION_TOAST_THROTTLE_MS,
  EMPTY_COHOST_STATE,
  EMPTY_COHOST_UNREAD
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

/** The 2026-08-23 incident envelope: web answered 502 `ai-gateway-error`. */
const GATEWAY_502: CohostErrorDetail = {
  code: 'ai-gateway-error',
  message: 'The co-host tick failed on every configured model.',
  status: 502
}

const TIMEOUT: CohostErrorDetail = {
  code: 'timeout',
  message: 'The co-host service did not answer within 12 s.',
  status: null
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
      tone: 'live',
      detail: null
    })
    expect(cohostChipView(state({ questions: [] }))).toEqual({
      label: 'Co-host: listening',
      tone: 'live',
      detail: null
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
      expect(cohostChipView(state({ status: 'paused', reason }))).toEqual({
        label,
        tone: 'muted',
        detail: null
      })
    }
  })

  it('stays monochrome for off and error', () => {
    expect(cohostChipView(state({ status: 'off', reason: null }))).toEqual({
      label: 'Co-host: off',
      tone: 'muted',
      detail: null
    })
    expect(cohostChipView(state({ status: 'error', reason: 'gateway-error' }))).toEqual({
      label: 'Co-host: error · AI error',
      tone: 'muted',
      detail: null
    })
    expect(cohostChipView(state({ status: 'error', reason: null }))).toEqual({
      label: 'Co-host: error',
      tone: 'muted',
      detail: null
    })
  })

  it("carries the failed tick in the server's own words as the chip detail", () => {
    expect(
      cohostChipView(state({ status: 'error', reason: 'gateway-error', detail: GATEWAY_502 }))
    ).toEqual({
      label: 'Co-host: error · AI error',
      tone: 'muted',
      detail: 'ai-gateway-error (HTTP 502): The co-host tick failed on every configured model.'
    })
    // No HTTP status for a desktop-side failure.
    expect(
      cohostChipView(state({ status: 'error', reason: 'network', detail: TIMEOUT }))?.detail
    ).toBe('timeout: The co-host service did not answer within 12 s.')
    // A server-side pause (quota) carries its detail too...
    expect(
      cohostChipView(
        state({
          status: 'paused',
          reason: 'quota-exhausted',
          detail: { code: 'quota-exhausted', message: 'Resets at midnight UTC.', status: 429 }
        })
      )?.detail
    ).toBe('quota-exhausted (HTTP 429): Resets at midnight UTC.')
    // ...but a stale detail never leaks onto a listening or off chip.
    expect(cohostChipView(state({ detail: GATEWAY_502 }))?.detail).toBeNull()
    expect(cohostChipView(state({ status: 'off', detail: GATEWAY_502 }))?.detail).toBeNull()
    // Optional on the wire: an older backend omits the key entirely.
    const { detail: _omitted, ...legacy } = state({ status: 'error', reason: 'gateway-error' })
    expect(cohostChipView(legacy as CohostState)?.detail).toBeNull()
  })
})

describe('cohostErrorDetailText', () => {
  it('formats code, status and message, degrading when parts are missing', () => {
    expect(cohostErrorDetailText(null)).toBeNull()
    expect(cohostErrorDetailText(undefined)).toBeNull()
    expect(cohostErrorDetailText(GATEWAY_502)).toBe(
      'ai-gateway-error (HTTP 502): The co-host tick failed on every configured model.'
    )
    expect(cohostErrorDetailText({ code: 'ai-gateway-error', message: '  ', status: 502 })).toBe(
      'ai-gateway-error (HTTP 502)'
    )
    expect(cohostErrorDetailText({ code: 'network', message: 'dns', status: null })).toBe(
      'network: dns'
    )
    expect(cohostErrorDetailText({ code: '  ', message: 'x', status: 500 })).toBeNull()
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

describe('cohostErrorToast', () => {
  it('says nothing for states the pane already shows', () => {
    expect(cohostErrorToast(null, state())).toBeNull()
    expect(
      cohostErrorToast(null, state({ status: 'paused', reason: 'quota-exhausted' }))
    ).toBeNull()
    expect(cohostErrorToastKey(state())).toBeNull()
    expect(cohostErrorToastKey(state({ status: 'error', reason: null }))).toBeNull()
  })

  it('toasts a NEW error reason exactly once', () => {
    const errored = state({ status: 'error', reason: 'gateway-error' })
    expect(cohostErrorToast(state(), errored)).toEqual({
      reason: 'gateway-error',
      key: 'gateway-error:',
      message: 'Co-host stopped: Videorc AI returned an error.'
    })
    expect(cohostErrorToast(errored, errored)).toBeNull()
  })

  it('toasts again when the error reason changes', () => {
    const first = state({ status: 'error', reason: 'gateway-error' })
    const second = state({ status: 'error', reason: 'network' })
    expect(cohostErrorToast(first, second)?.reason).toBe('network')
  })

  it("puts the server's code and message in the toast copy", () => {
    const errored = state({ status: 'error', reason: 'gateway-error', detail: GATEWAY_502 })
    expect(cohostErrorToast(state(), errored)).toEqual({
      reason: 'gateway-error',
      key: 'gateway-error:ai-gateway-error',
      message:
        'Co-host stopped: Videorc AI returned an error (ai-gateway-error: The co-host tick failed on every configured model).'
    })
    expect(cohostErrorToastMessage('network', TIMEOUT)).toBe(
      'Co-host stopped: no connection to Videorc AI (timeout: The co-host service did not answer within 12 s).'
    )
    // A code without a message still names itself; no detail keeps the base copy.
    expect(
      cohostErrorToastMessage('gateway-error', {
        code: 'ai-gateway-error',
        message: '',
        status: 502
      })
    ).toBe('Co-host stopped: Videorc AI returned an error (ai-gateway-error).')
    expect(cohostErrorToastMessage('gateway-error', null)).toBe(
      'Co-host stopped: Videorc AI returned an error.'
    )
    expect(cohostErrorToastMessage('gateway-error', undefined)).toBe(
      'Co-host stopped: Videorc AI returned an error.'
    )
  })

  it('dedupes on the (reason, code) pair, not per tick', () => {
    const tick5 = state({
      status: 'error',
      reason: 'gateway-error',
      detail: GATEWAY_502,
      tickSeq: 5
    })
    const tick6 = { ...tick5, tickSeq: 6 }
    const tick7 = { ...tick5, tickSeq: 7 }
    expect(cohostErrorToast(state(), tick5)).not.toBeNull()
    // Backoff retries of the same failure are silent...
    expect(cohostErrorToast(tick5, tick6)).toBeNull()
    expect(cohostErrorToast(tick6, tick7)).toBeNull()
    // ...even when the server's sentence changes but the code does not.
    expect(
      cohostErrorToast(tick7, {
        ...tick7,
        tickSeq: 8,
        detail: { ...GATEWAY_502, message: 'Model ladder exhausted (3 tried).' }
      })
    ).toBeNull()
    // A different code under the same reason is news.
    const upstream = {
      ...tick7,
      tickSeq: 9,
      detail: { code: 'upstream-timeout', message: 'Gateway timed out.', status: 504 }
    }
    expect(cohostErrorToast(tick7, upstream)?.key).toBe('gateway-error:upstream-timeout')
    // Recovery then the same failure again is news again.
    const recovered = state({ tickSeq: 10 })
    expect(cohostErrorToast(upstream, recovered)).toBeNull()
    expect(cohostErrorToast(recovered, { ...tick5, tickSeq: 11 })?.key).toBe(
      'gateway-error:ai-gateway-error'
    )
  })
})

describe('reduceCohostUnread', () => {
  it('counts nothing while the pane is open, and re-baselines what is on screen', () => {
    const next = reduceCohostUnread(EMPTY_COHOST_UNREAD, {
      questionIds: ['q-1', 'q-2'],
      open: true
    })
    expect(next.count).toBe(0)
    expect(next.seenIds).toEqual(['q-1', 'q-2'])
  })

  it('counts only the questions that arrived after the collapse', () => {
    const seen = reduceCohostUnread(EMPTY_COHOST_UNREAD, { questionIds: ['q-1'], open: true })
    const collapsed = reduceCohostUnread(seen, { questionIds: ['q-1', 'q-2', 'q-3'], open: false })
    expect(collapsed.count).toBe(2)
    // Expanding clears the badge and moves the baseline forward.
    const reopened = reduceCohostUnread(collapsed, {
      questionIds: ['q-1', 'q-2', 'q-3'],
      open: true
    })
    expect(reopened.count).toBe(0)
    expect(
      reduceCohostUnread(reopened, { questionIds: ['q-1', 'q-2', 'q-3'], open: false }).count
    ).toBe(0)
  })

  it('returns the same object when nothing changed', () => {
    const seen = reduceCohostUnread(EMPTY_COHOST_UNREAD, { questionIds: ['q-1'], open: true })
    expect(reduceCohostUnread(seen, { questionIds: ['q-1'], open: true })).toBe(seen)
    const collapsed = reduceCohostUnread(seen, { questionIds: ['q-1', 'q-2'], open: false })
    expect(reduceCohostUnread(collapsed, { questionIds: ['q-1', 'q-2'], open: false })).toBe(
      collapsed
    )
  })
})

describe('cohostQuestionToast', () => {
  const previous = state({ questions: [question({ id: 'q-1' })] })
  const arrival = state({
    tickSeq: 5,
    questions: [question({ id: 'q-1' }), question({ id: 'q-hot', priority: 'high' })]
  })

  it('raises one keyed toast for a new high-priority question on a collapsed pane', () => {
    const raised = cohostQuestionToast({
      previous,
      next: arrival,
      paneOpen: false,
      lastToastAtMs: null,
      nowMs: 1_000
    })
    expect(raised?.message).toContain('Co-host:')
    expect(raised?.message).toContain('⌘J')
    expect(raised?.atMs).toBe(1_000)
  })

  it('stays silent while the pane is open — the row is already on screen', () => {
    expect(
      cohostQuestionToast({
        previous,
        next: arrival,
        paneOpen: true,
        lastToastAtMs: null,
        nowMs: 1_000
      })
    ).toBeNull()
  })

  it('never toasts a normal-priority question or one it already knew', () => {
    expect(
      cohostQuestionToast({
        previous,
        next: state({ tickSeq: 5, questions: [question({ id: 'q-1' }), question({ id: 'q-2' })] }),
        paneOpen: false,
        lastToastAtMs: null,
        nowMs: 1_000
      })
    ).toBeNull()
    expect(
      cohostQuestionToast({
        previous: arrival,
        next: arrival,
        paneOpen: false,
        lastToastAtMs: null,
        nowMs: 1_000
      })
    ).toBeNull()
  })

  it('throttles to one toast a minute', () => {
    const laterArrival = state({
      tickSeq: 6,
      questions: [question({ id: 'q-1' }), question({ id: 'q-hot2', priority: 'high' })]
    })
    expect(
      cohostQuestionToast({
        previous,
        next: laterArrival,
        paneOpen: false,
        lastToastAtMs: 1_000,
        nowMs: 1_000 + COHOST_QUESTION_TOAST_THROTTLE_MS - 1
      })
    ).toBeNull()
    expect(
      cohostQuestionToast({
        previous,
        next: laterArrival,
        paneOpen: false,
        lastToastAtMs: 1_000,
        nowMs: 1_000 + COHOST_QUESTION_TOAST_THROTTLE_MS
      })
    ).not.toBeNull()
  })

  it('does not toast from a state that is not listening', () => {
    expect(
      cohostQuestionToast({
        previous,
        next: { ...arrival, status: 'paused', reason: 'quota-exhausted' },
        paneOpen: false,
        lastToastAtMs: null,
        nowMs: 1_000
      })
    ).toBeNull()
  })

  it('names how many people are asking', () => {
    expect(
      cohostQuestionToastMessage(question({ askers: ['Ada', 'Bo', 'Cy', 'Dee', 'Eve'] }))
    ).toBe('Co-host: 5 people asking — What keyboard is that? — ⌘J')
    expect(cohostQuestionToastMessage(question({ askers: ['Ada'] }))).toBe(
      'Co-host: Ada is asking — What keyboard is that? — ⌘J'
    )
  })
})

describe('cohostNudgeVisible', () => {
  const base = {
    sessionId: 'session-1',
    gateAllowed: true,
    consented: true,
    enabled: false,
    dismissedForever: false,
    dismissedSessionId: null
  }

  it('shows for the one audience it helps', () => {
    expect(cohostNudgeVisible(base)).toBe(true)
  })

  it('never nudges toward a locked, unconsented, already-on, or idle co-host', () => {
    expect(cohostNudgeVisible({ ...base, sessionId: null })).toBe(false)
    expect(cohostNudgeVisible({ ...base, gateAllowed: false })).toBe(false)
    expect(cohostNudgeVisible({ ...base, consented: false })).toBe(false)
    expect(cohostNudgeVisible({ ...base, enabled: true })).toBe(false)
  })

  it('answers "no thanks" once per session and once forever', () => {
    expect(cohostNudgeVisible({ ...base, dismissedSessionId: 'session-1' })).toBe(false)
    // A new session is a new chance — unless the answer was persisted.
    expect(cohostNudgeVisible({ ...base, dismissedSessionId: 'session-0' })).toBe(true)
    expect(cohostNudgeVisible({ ...base, dismissedForever: true })).toBe(false)
  })

  it('reads the persisted flag from storage', () => {
    expect(cohostNudgeDismissedFromStorage('1')).toBe(true)
    expect(cohostNudgeDismissedFromStorage('true')).toBe(true)
    expect(cohostNudgeDismissedFromStorage('0')).toBe(false)
    expect(cohostNudgeDismissedFromStorage(null)).toBe(false)
  })
})
