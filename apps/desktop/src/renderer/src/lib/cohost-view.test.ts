import { describe, expect, it } from 'vitest'

import type {
  CohostErrorDetail,
  CohostFlag,
  CohostQuestion,
  CohostReason,
  CohostState
} from '@/lib/backend'
import {
  activeCohostSpotlight,
  cohostCommentMarks,
  EMPTY_COHOST_COMMENT_MARKS
} from '@/lib/cohost-marks'
import {
  activeCohostAlerts,
  applyCohostState,
  cohostAgeLabel,
  cohostAlertLabel,
  cohostFlagActionLabel,
  cohostFlagChipLabel,
  cohostFlagDetail,
  cohostFlagKindLabel,
  cohostFlagVisible,
  cohostMoodScoresLabel,
  cohostSensitivityFromStorage,
  cohostStateForSensitivity,
  cohostAskersLabel,
  cohostChipView,
  cohostErrorDetailText,
  cohostErrorToast,
  cohostErrorToastKey,
  cohostErrorToastMessage,
  cohostFlagRowKey,
  cohostHighlightMessageId,
  cohostStoppedToast,
  cohostListenAllowanceLabel,
  cohostListeningView,
  cohostListenPromptVisible,
  cohostListenTimeLabel,
  cohostNudgeDismissedFromStorage,
  cohostNudgeVisible,
  cohostPaneMode,
  persistCohostListenPromptDismissed,
  readCohostListenPromptDismissed,
  cohostDeadAirToast,
  cohostPromiseReminderToast,
  cohostPromiseTriggerLabel,
  cohostQuestionRowKey,
  cohostQuestionToast,
  cohostQuestionToastMessage,
  activeCohostRecap,
  cohostRowAt,
  cohostRows,
  draftForQuestion,
  moveCohostSelection,
  reduceCohostUnread,
  resolveCohostSelection,
  sortedCohostFlags,
  sortedCohostQuestions,
  trimDraftToCap,
  COHOST_CHAT_CONSENT_SENTENCE,
  COHOST_CONSENT_SENTENCE,
  COHOST_LISTEN_CONSENT_SENTENCE,
  COHOST_LISTEN_PROMPT_STORAGE_KEY,
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
  message: 'The Orcle tick failed on every configured model.',
  status: 502
}

const TIMEOUT: CohostErrorDetail = {
  code: 'timeout',
  message: 'Orcle did not answer within 12 s.',
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

  it('puts on-topic questions first within a priority, never across one (plan 068)', () => {
    const rows = sortedCohostQuestions([
      question({ id: 'off-high', priority: 'high', firstSeenAt: '2026-08-22T12:00:00.000Z' }),
      question({
        id: 'on-high',
        priority: 'high',
        firstSeenAt: '2026-08-22T12:05:00.000Z',
        onTopic: true
      }),
      question({ id: 'on-normal', priority: 'normal', onTopic: true }),
      question({ id: 'off-normal', priority: 'normal', firstSeenAt: '2026-08-22T11:00:00.000Z' })
    ])
    expect(rows.map((row) => row.id)).toEqual(['on-high', 'off-high', 'on-normal', 'off-normal'])
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
      label: 'Orcle: listening · 2 q',
      tone: 'live',
      detail: null
    })
    expect(cohostChipView(state({ questions: [] }))).toEqual({
      label: 'Orcle: listening',
      tone: 'live',
      detail: null
    })
  })

  it('names every paused reason in the destination strip vocabulary', () => {
    const cases: Array<[CohostReason, string]> = [
      ['premium-required', 'Orcle: paused · Premium'],
      ['consent-required', 'Orcle: paused · consent'],
      ['quota-exhausted', 'Orcle: paused · quota'],
      ['session-expired', 'Orcle: paused · session expired'],
      ['signed-out', 'Orcle: paused · signed out'],
      ['server-unconfigured', 'Orcle: paused · unavailable'],
      ['network', 'Orcle: paused · offline'],
      ['gateway-error', 'Orcle: paused · AI error']
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
      label: 'Orcle: off',
      tone: 'muted',
      detail: null
    })
    expect(cohostChipView(state({ status: 'error', reason: 'gateway-error' }))).toEqual({
      label: 'Orcle: error · AI error',
      tone: 'muted',
      detail: null
    })
    expect(cohostChipView(state({ status: 'error', reason: null }))).toEqual({
      label: 'Orcle: error',
      tone: 'muted',
      detail: null
    })
  })

  it("carries the failed tick in the server's own words as the chip detail", () => {
    expect(
      cohostChipView(state({ status: 'error', reason: 'gateway-error', detail: GATEWAY_502 }))
    ).toEqual({
      label: 'Orcle: error · AI error',
      tone: 'muted',
      detail: 'ai-gateway-error (HTTP 502): The Orcle tick failed on every configured model.'
    })
    // No HTTP status for a desktop-side failure.
    expect(
      cohostChipView(state({ status: 'error', reason: 'network', detail: TIMEOUT }))?.detail
    ).toBe('timeout: Orcle did not answer within 12 s.')
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
      'ai-gateway-error (HTTP 502): The Orcle tick failed on every configured model.'
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
    reason: 'Orcle requires Videorc Premium.',
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

  it('points a disabled Orcle at the Orcle tab, its one home since Settings lost it', () => {
    const mode = cohostPaneMode({ gate: { allowed: true }, consented: true, enabled: false })
    expect(mode.kind === 'disabled' ? mode.reason : null).toMatch(
      /^Orcle is off\. Turn it on in the Orcle tab \((?:⌘|Ctrl\+)9\)\.$/
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
      message: 'Orcle stopped: Videorc AI returned an error.'
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
        'Orcle stopped: Videorc AI returned an error (ai-gateway-error: The Orcle tick failed on every configured model).'
    })
    expect(cohostErrorToastMessage('network', TIMEOUT)).toBe(
      'Orcle stopped: no connection to Videorc AI (timeout: Orcle did not answer within 12 s).'
    )
    // A code without a message still names itself; no detail keeps the base copy.
    expect(
      cohostErrorToastMessage('gateway-error', {
        code: 'ai-gateway-error',
        message: '',
        status: 502
      })
    ).toBe('Orcle stopped: Videorc AI returned an error (ai-gateway-error).')
    expect(cohostErrorToastMessage('gateway-error', null)).toBe(
      'Orcle stopped: Videorc AI returned an error.'
    )
    expect(cohostErrorToastMessage('gateway-error', undefined)).toBe(
      'Orcle stopped: Videorc AI returned an error.'
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

describe('cohostStoppedToast', () => {
  const stoppedForPremium = state({ sessionId: null, status: 'off', reason: 'premium-required' })

  it('says one plain line when the backend ends a running session', () => {
    expect(cohostStoppedToast(state(), stoppedForPremium)).toBe('Orcle stopped. Premium ended.')
    expect(
      cohostStoppedToast(
        state({ status: 'paused', reason: 'consent-required' }),
        state({ sessionId: null, status: 'off', reason: 'signed-out' })
      )
    ).toBe('Orcle stopped. You signed out.')
    // It is never the error toast: an off state has no error key.
    expect(cohostErrorToast(state(), stoppedForPremium)).toBeNull()
  })

  it("stays silent for a streamer's own Stop and for the first state seen", () => {
    expect(cohostStoppedToast(state(), state({ sessionId: null, status: 'off' }))).toBeNull()
    expect(cohostStoppedToast(null, stoppedForPremium)).toBeNull()
    expect(
      cohostStoppedToast(state({ sessionId: null, status: 'off' }), stoppedForPremium)
    ).toBeNull()
    // A paused Premium precondition is the pane's to show, not a toast.
    expect(
      cohostStoppedToast(state(), state({ status: 'paused', reason: 'premium-required' }))
    ).toBeNull()
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
    expect(raised?.message).toContain('Orcle:')
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
    ).toBe('Orcle: 5 people asking: What keyboard is that? · ⌘J')
    expect(cohostQuestionToastMessage(question({ askers: ['Ada'] }))).toBe(
      'Orcle: Ada is asking: What keyboard is that? · ⌘J'
    )
  })

  it('writes the shortcut the way the platform does (Ctrl+J on Windows)', () => {
    expect(cohostQuestionToastMessage(question({ askers: ['Ada'] }), 'Ctrl+J')).toBe(
      'Orcle: Ada is asking: What keyboard is that? · Ctrl+J'
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

describe('tick wire v2 view', () => {
  it('labels every flag kind, and renders an unknown one generically', () => {
    expect(cohostFlagKindLabel('harassment')).toBe('Harassment')
    expect(cohostFlagKindLabel('unknown')).toBe('Flagged')
    // A string the type does not know (newer backend) still gets a label.
    expect(cohostFlagKindLabel('brigading' as CohostFlag['kind'])).toBe('Flagged')
  })

  it('builds the chip from kind, target and the broken rule', () => {
    expect(cohostFlagChipLabel(flag())).toBe('Spam')
    expect(cohostFlagChipLabel(flag({ kind: 'harassment', target: 'streamer' }))).toBe(
      'Harassment · at you'
    )
    expect(cohostFlagChipLabel(flag({ kind: 'rule', rule: 'No spoilers' }))).toBe(
      'Chat rule · No spoilers'
    )
    // Rule text only belongs to a rule flag; a rule flag without it still reads.
    expect(cohostFlagChipLabel(flag({ kind: 'spam', rule: 'No spoilers' }))).toBe('Spam')
    expect(cohostFlagChipLabel(flag({ kind: 'rule' }))).toBe('Chat rule')
  })

  it('labels a suggested action without ever being one', () => {
    expect(cohostFlagActionLabel(flag())).toBeNull()
    expect(cohostFlagActionLabel(flag({ action: 'timeout' }))).toBe('Suggests timeout')
    expect(cohostFlagDetail(flag({ alsoKinds: ['scam', 'unknown'] }))).toBe(
      'Repeated link drop.\nAlso: Scam, Flagged'
    )
  })

  it('filters shown flags by confidence per sensitivity step', () => {
    expect(cohostSensitivityFromStorage(null)).toBe('balanced')
    expect(cohostSensitivityFromStorage('nonsense')).toBe('balanced')
    expect(cohostSensitivityFromStorage('strict')).toBe('strict')

    // No confidence (wire v1) always shows.
    expect(cohostFlagVisible(flag(), 'relaxed')).toBe(true)
    expect(cohostFlagVisible(flag({ confidence: 0.7 }), 'relaxed')).toBe(false)
    expect(cohostFlagVisible(flag({ confidence: 0.7 }), 'balanced')).toBe(true)
    expect(cohostFlagVisible(flag({ confidence: 0.3 }), 'balanced')).toBe(false)
    expect(cohostFlagVisible(flag({ confidence: 0.3 }), 'strict')).toBe(true)

    const current = state({
      flags: [flag({ messageId: 'a', confidence: 0.95 }), flag({ messageId: 'b', confidence: 0.4 })]
    })
    expect(cohostStateForSensitivity(current, 'balanced').flags.map((f) => f.messageId)).toEqual([
      'a'
    ])
    // Nothing filtered → same object, so memoised derivations keep identity.
    expect(cohostStateForSensitivity(current, 'strict')).toBe(current)
    expect(cohostStateForSensitivity(null, 'strict')).toBeNull()
  })

  it('marks flagged and suggested comment rows, never both', () => {
    expect(cohostCommentMarks(null)).toBe(EMPTY_COHOST_COMMENT_MARKS)
    expect(cohostCommentMarks(state())).toBe(EMPTY_COHOST_COMMENT_MARKS)
    const marks = cohostCommentMarks(
      state({
        flags: [flag({ messageId: 'm-flagged' })],
        highlights: [
          { messageId: 'm-good', score: 0.8, type: 'joke' },
          { messageId: 'm-flagged', score: 0.9, type: 'other' }
        ]
      })
    )
    expect(marks.flags.get('m-flagged')?.kind).toBe('spam')
    expect([...marks.suggested]).toEqual(['m-good'])
  })

  it('marks the spotlit comment only while the spotlight is unexpired and not flagged', () => {
    const at = '2026-08-22T12:00:00.000Z'
    const expiresAt = '2026-08-22T12:00:15.000Z'
    const nowMs = Date.parse(at) + 5_000
    const spotlit = state({
      spotlight: { messageId: 'm-talked', score: 0.9, at, expiresAt }
    })
    const marks = cohostCommentMarks(spotlit, nowMs)
    expect(marks.spotlight).toBe('m-talked')
    expect(marks.flags.size).toBe(0)
    expect(marks.suggested.size).toBe(0)
    expect(activeCohostSpotlight(spotlit, nowMs)?.messageId).toBe('m-talked')

    // Expired on the renderer's clock: treated as none, even before the
    // engine's clearing event lands.
    const expiredMs = Date.parse(expiresAt)
    expect(cohostCommentMarks(spotlit, expiredMs)).toBe(EMPTY_COHOST_COMMENT_MARKS)
    expect(activeCohostSpotlight(spotlit, expiredMs)).toBeNull()

    // A flagged message is never pulled up.
    expect(
      cohostCommentMarks(
        state({
          flags: [flag({ messageId: 'm-talked' })],
          spotlight: { messageId: 'm-talked', score: 0.9, at, expiresAt }
        }),
        nowMs
      ).spotlight
    ).toBeNull()
    // Off or absent: nothing.
    expect(activeCohostSpotlight({ ...spotlit, status: 'off' }, nowMs)).toBeNull()
    expect(activeCohostSpotlight(state(), nowMs)).toBeNull()
    expect(cohostCommentMarks(state(), nowMs).spotlight).toBeNull()
  })

  it('shows only corroborated, unexpired alerts', () => {
    const seen = '2026-08-22T12:00:00.000Z'
    const nowMs = Date.parse(seen) + 30_000
    const current = state({
      alerts: [
        { kind: 'audio', viewers: 3, lastSeenAt: seen, active: true },
        { kind: 'video', viewers: 1, lastSeenAt: seen, active: false }
      ]
    })
    expect(activeCohostAlerts(current, nowMs).map((alert) => alert.kind)).toEqual(['audio'])
    expect(activeCohostAlerts(current, nowMs + 120_000)).toEqual([])
    expect(activeCohostAlerts(state(), nowMs)).toEqual([])
    expect(activeCohostAlerts({ ...current, status: 'off' }, nowMs)).toEqual([])
    expect(cohostAlertLabel({ kind: 'audio', viewers: 3 })).toBe('Chat says: no audio · 3 viewers')
    expect(cohostAlertLabel({ kind: 'other', viewers: 1 })).toBe(
      'Chat says: something is wrong · 1 viewer'
    )
  })

  it('formats mood scores for the mood tooltip', () => {
    expect(cohostMoodScoresLabel(undefined)).toBeNull()
    expect(cohostMoodScoresLabel({ hype: 0.2, tension: 0.7, confusion: 0.1 })).toBe(
      'Hype 20% · Tension 70% · Confusion 10%'
    )
  })
})

describe('listening (plan 068)', () => {
  it('shows nothing while listening is off or unknown', () => {
    expect(cohostListeningView(undefined)).toBeNull()
    expect(cohostListeningView(null)).toBeNull()
    expect(cohostListeningView({ state: 'off' })).toBeNull()
  })

  it('says Listening and Starting to listen in a word or three', () => {
    expect(cohostListeningView({ state: 'on' })).toEqual({
      state: 'on',
      label: 'Listening',
      detail: 'Orcle hears your microphone as text.'
    })
    expect(cohostListeningView({ state: 'on', remainingSeconds: 7_200 })?.detail).toBe(
      'Orcle hears your microphone as text. 2 h of listening left this month.'
    )
    expect(cohostListeningView({ state: 'starting' })).toEqual({
      state: 'starting',
      label: 'Starting to listen',
      detail: 'Orcle is starting to hear your microphone.'
    })
  })

  it('names every blocked reason plainly, with the backend sentence on hover', () => {
    const label = (reasonCode: string): string | undefined =>
      cohostListeningView({ state: 'blocked', reasonCode, message: 'm' })?.label
    expect(label('no-microphone')).toBe('Not listening: no microphone selected')
    expect(label('signed-out')).toBe('Not listening: sign in')
    expect(label('unauthorized')).toBe('Not listening: sign in')
    expect(label('listen-monthly-quota-exhausted')).toBe(
      'Not listening: monthly listening time used up'
    )
    expect(label('consent-required')).toBe('Not listening: turn on cloud AI')
    expect(label('no-capture')).toBe('Not listening: not live')
    expect(label('service-unavailable')).toBe("Not listening: can't reach Videorc")
    expect(label('signing-out')).toBe('Not listening: signing out')
    expect(label('shutting-down')).toBe('Not listening: Videorc is closing')
    expect(label('listen-disabled')).toBe('Not listening: unavailable right now')
    expect(label('cloud-ai-premium-required')).toBe('Not listening: needs Premium')

    const blocked = cohostListeningView({
      state: 'blocked',
      reasonCode: 'no-microphone',
      message: 'Select a microphone so Orcle can hear you.'
    })
    expect(blocked?.state).toBe('blocked')
    expect(blocked?.detail).toBe('Select a microphone so Orcle can hear you.')
  })

  it('reads an unknown or missing reason as a bare Not listening', () => {
    expect(
      cohostListeningView({ state: 'blocked', reasonCode: 'brand-new-code', message: 'Why.' })
    ).toEqual({ state: 'blocked', label: 'Not listening', detail: 'Why.' })
    // Object keys never leak through as reasons.
    expect(cohostListeningView({ state: 'blocked', reasonCode: 'constructor' })?.label).toBe(
      'Not listening'
    )
    expect(cohostListeningView({ state: 'blocked' })?.detail).toBe(
      "Orcle can't hear you right now."
    )
  })

  it('formats the listening time left', () => {
    expect(cohostListenTimeLabel(undefined)).toBeNull()
    expect(cohostListenTimeLabel(-1)).toBeNull()
    expect(cohostListenTimeLabel(Number.NaN)).toBeNull()
    expect(cohostListenTimeLabel(30)).toBe('under a minute')
    expect(cohostListenTimeLabel(12 * 60 + 40)).toBe('12 min')
    expect(cohostListenTimeLabel(3_600)).toBe('1 h')
    expect(cohostListenTimeLabel(98 * 3_600 + 20 * 60)).toBe('98 h 20 min')
  })

  it('says the monthly allowance only when the server reported it', () => {
    expect(cohostListenAllowanceLabel(undefined)).toBeNull()
    expect(cohostListenAllowanceLabel({ state: 'on' })).toBeNull()
    expect(cohostListenAllowanceLabel({ state: 'on', remainingSeconds: 5_400 })).toBe(
      '1 h 30 min of listening left this month.'
    )
    expect(cohostListenAllowanceLabel({ state: 'on', remainingSeconds: 45 })).toBe(
      'Under a minute of listening left this month.'
    )
    expect(cohostListenAllowanceLabel({ state: 'on', remainingSeconds: 0 })).toBe(
      'No listening time left this month.'
    )
    expect(
      cohostListenAllowanceLabel({
        state: 'blocked',
        reasonCode: 'listen-monthly-quota-exhausted',
        message: 'Used up.'
      })
    ).toBe('Your listening time for this month is used up.')
    // Another block with a known allowance still says what is left.
    expect(
      cohostListenAllowanceLabel({
        state: 'blocked',
        reasonCode: 'no-microphone',
        remainingSeconds: 600
      })
    ).toBe('10 min of listening left this month.')
  })

  it('offers the one-time card only to an Orcle user with listening off', () => {
    const base = { enabled: true, listen: false, dismissed: false }
    expect(cohostListenPromptVisible(base)).toBe(true)
    expect(cohostListenPromptVisible({ ...base, enabled: false })).toBe(false)
    expect(cohostListenPromptVisible({ ...base, listen: true })).toBe(false)
    expect(cohostListenPromptVisible({ ...base, listen: undefined })).toBe(false)
    expect(cohostListenPromptVisible({ ...base, dismissed: true })).toBe(false)
  })

  it('persists the answer and survives storage that throws', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value)
    }
    expect(readCohostListenPromptDismissed(storage)).toBe(false)
    persistCohostListenPromptDismissed(storage)
    expect(values.get(COHOST_LISTEN_PROMPT_STORAGE_KEY)).toBe('1')
    expect(COHOST_LISTEN_PROMPT_STORAGE_KEY).toBe('videorc.orcleListenPromptDismissed')
    expect(readCohostListenPromptDismissed(storage)).toBe(true)

    const broken = {
      getItem: (): string | null => {
        throw new Error('SecurityError')
      },
      setItem: (): void => {
        throw new Error('QuotaExceededError')
      }
    }
    expect(readCohostListenPromptDismissed(broken)).toBe(false)
    expect(() => persistCohostListenPromptDismissed(broken)).not.toThrow()
    expect(readCohostListenPromptDismissed(null)).toBe(false)
  })

  it('names the cloud step, the transcript and what is kept in the consent copy', () => {
    expect(COHOST_CONSENT_SENTENCE.startsWith(COHOST_CHAT_CONSENT_SENTENCE)).toBe(true)
    // Turning Orcle on turns listening on (plan 119), so hearing is not an option.
    expect(COHOST_CONSENT_SENTENCE).toContain("While you're live it also hears you")
    expect(COHOST_CONSENT_SENTENCE).not.toContain('If you turn on listening')
    for (const sentence of [COHOST_CONSENT_SENTENCE, COHOST_LISTEN_CONSENT_SENTENCE]) {
      expect(sentence).toContain('microphone audio')
      expect(sentence).toContain("goes to Videorc's cloud speech-to-text")
      expect(sentence).toContain('turned into text')
      expect(sentence).toContain("Videorc servers don't keep it.")
      expect(sentence).toContain('The transcript is saved with your recording on this computer.')
      expect(sentence).not.toContain('never stored as audio')
    }
    expect(cohostPaneMode({ gate: { allowed: true }, consented: false, enabled: true })).toEqual({
      kind: 'consent',
      reason: `${COHOST_CONSENT_SENTENCE} Turn on cloud AI to use it.`
    })
  })
})

describe('promises and recaps (plan 068 D8)', () => {
  it('names the trigger as a short hint, none for a promise without one', () => {
    expect(cohostPromiseTriggerLabel({ kind: 'viewers', value: 100 })).toBe('at 100 viewers')
    expect(cohostPromiseTriggerLabel({ kind: 'viewers', value: 1500 })).toBe('at 1,500 viewers')
    expect(cohostPromiseTriggerLabel({ kind: 'minutes', value: 10 })).toBe('in 10 min')
    expect(cohostPromiseTriggerLabel({ kind: 'none' })).toBeNull()
    expect(cohostPromiseTriggerLabel({ kind: 'viewers' })).toBeNull()
    expect(cohostPromiseTriggerLabel({ kind: 'followers', value: 5 })).toBeNull()
  })

  it('toasts a reminder once, when it is news for the same session', () => {
    const reminder = {
      promiseId: 'p_1',
      text: 'a giveaway at 100 viewers',
      at: '2026-08-22T12:00:00Z'
    }
    const next = state({ promiseReminder: reminder })
    expect(cohostPromiseReminderToast({ previous: null, next })).toBe(
      'You promised: a giveaway at 100 viewers'
    )
    expect(cohostPromiseReminderToast({ previous: state(), next })).toBe(
      'You promised: a giveaway at 100 viewers'
    )
    // The same reminder again is not news; a later one for another promise is.
    expect(cohostPromiseReminderToast({ previous: next, next })).toBeNull()
    expect(
      cohostPromiseReminderToast({
        previous: next,
        next: state({ promiseReminder: { ...reminder, promiseId: 'p_2', text: 'the build' } })
      })
    ).toBe('You promised: the build')
    expect(cohostPromiseReminderToast({ previous: next, next: state() })).toBeNull()
  })

  it('keeps a recap only until it expires', () => {
    const recap = {
      text: 'So far: unboxed the parts.',
      at: '2026-08-22T12:00:00Z',
      expiresAt: '2026-08-22T12:05:00Z'
    }
    const current = state({ recap })
    expect(activeCohostRecap(current, Date.parse('2026-08-22T12:04:59Z'))).toEqual(recap)
    expect(activeCohostRecap(current, Date.parse('2026-08-22T12:05:00Z'))).toBeNull()
    expect(activeCohostRecap(state(), Date.parse('2026-08-22T12:00:00Z'))).toBeNull()
    expect(activeCohostRecap(null, 0)).toBeNull()
  })

  it('toasts each dead-air nudge once, by key (plan 068 D9)', () => {
    const nudge = {
      key: 'dead-air-1-1',
      text: "Dead air: say hi to Sam, it's their first chat.",
      at: '2026-08-22T12:00:00Z'
    }
    expect(cohostDeadAirToast(null, null)).toBeNull()
    expect(cohostDeadAirToast(state(), null)).toBeNull()
    expect(cohostDeadAirToast(state({ deadAirNudge: nudge }), null)).toEqual({
      key: 'dead-air-1-1',
      text: nudge.text
    })
    // The same key again (another state event while it is fresh) is quiet.
    expect(cohostDeadAirToast(state({ deadAirNudge: nudge }), 'dead-air-1-1')).toBeNull()
    expect(
      cohostDeadAirToast(state({ deadAirNudge: { ...nudge, key: 'dead-air-1-2' } }), 'dead-air-1-1')
    ).toEqual({ key: 'dead-air-1-2', text: nudge.text })
    expect(cohostDeadAirToast(state({ deadAirNudge: { ...nudge, text: ' ' } }), null)).toBeNull()
  })
})
