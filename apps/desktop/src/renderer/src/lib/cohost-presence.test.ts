import { describe, expect, it } from 'vitest'

import type { CohostQuestion, CohostState } from '@/lib/backend'
import { offCohostState } from '@/lib/backend'
import {
  cohostAgoLabel,
  cohostEmptyStateCopy,
  cohostGroupedDeltaFlash,
  cohostNextPassLabel,
  cohostPresenceView,
  cohostQuestionIds
} from '@/lib/cohost-presence'

const NOW = Date.parse('2026-08-24T12:00:00.000Z')

function question(overrides: Partial<CohostQuestion> = {}): CohostQuestion {
  return {
    id: 'q-1',
    text: 'What keyboard is that?',
    messageIds: ['twitch:m-1'],
    askers: ['Ada'],
    platforms: ['twitch'],
    priority: 'normal',
    suggestedReply: 'Keychron Q1.',
    fromNotes: false,
    firstSeenAt: '2026-08-24T11:59:00.000Z',
    updatedAt: '2026-08-24T11:59:00.000Z',
    ...overrides
  }
}

function listening(overrides: Partial<CohostState> = {}): CohostState {
  return {
    ...offCohostState(),
    sessionId: 'sess-1',
    status: 'listening',
    lastTickAt: '2026-08-24T11:59:48.000Z',
    tickSeq: 4,
    messagesSeen: 84,
    questionsTotal: 5,
    ...overrides
  }
}

describe('cohostPresenceView', () => {
  it('renders the off shape as a state, never as nothing', () => {
    const view = cohostPresenceView(offCohostState(), NOW)
    expect(view.kind).toBe('off')
    expect(view.label).toBe('Co-host off')
    expect(view.dotTone).toBe('muted')
    expect(view.dots).toBe(false)
    expect(view.pulse).toBe(false)
    expect(view.openCount).toBe(0)
    expect(view.tooltipLines[0]).toContain('Co-host is off')
  })

  it('treats a null state exactly like the off shape', () => {
    expect(cohostPresenceView(null, NOW).label).toBe(
      cohostPresenceView(offCohostState(), NOW).label
    )
  })

  it('reports starting when the caller asked the engine to come up', () => {
    const view = cohostPresenceView(offCohostState(), NOW, { starting: true })
    expect(view.kind).toBe('starting')
    expect(view.label).toBe('Co-host starting')
    expect(view.dotTone).toBe('muted')
    expect(view.pulse).toBe(true)
  })

  it('earns the live accent only while listening, with the open count', () => {
    const view = cohostPresenceView(
      listening({ questions: [question(), question({ id: 'q-2' }), question({ id: 'q-3' })] }),
      NOW
    )
    expect(view.kind).toBe('listening')
    expect(view.label).toBe('Co-host · 3 q')
    expect(view.dotTone).toBe('live')
    expect(view.dots).toBe(false)
    expect(view.openCount).toBe(3)
  })

  it('says listening (not "0 q") when the chat has asked nothing yet', () => {
    expect(cohostPresenceView(listening(), NOW).label).toBe('Co-host listening')
  })

  it('counts the queued messages it has seen but not sent', () => {
    const view = cohostPresenceView(listening({ pendingMessages: 4 }), NOW)
    expect(view.kind).toBe('reading')
    expect(view.label).toBe('Co-host · reading 4 new…')
    expect(view.dots).toBe(true)
    expect(view.pulse).toBe(false)
    expect(view.dotTone).toBe('live')
  })

  it('lets thinking outrank reading — the tick already carries the backlog', () => {
    const view = cohostPresenceView(listening({ pendingMessages: 4, tickInFlight: true }), NOW)
    expect(view.kind).toBe('thinking')
    expect(view.label).toBe('Co-host · thinking…')
    expect(view.dots).toBe(true)
    expect(view.pulse).toBe(true)
  })

  it('names the pause reason and stays monochrome', () => {
    const view = cohostPresenceView(listening({ status: 'paused', reason: 'quota-exhausted' }), NOW)
    expect(view.kind).toBe('paused')
    expect(view.label).toBe('Co-host paused · quota')
    expect(view.dotTone).toBe('muted')
  })

  it('uses destructive red for a real error only', () => {
    const view = cohostPresenceView(
      listening({
        status: 'error',
        reason: 'gateway-error',
        detail: { code: 'ai-gateway-error', message: 'Every model failed.', status: 502 }
      }),
      NOW
    )
    expect(view.kind).toBe('error')
    expect(view.label).toBe('Co-host error')
    expect(view.dotTone).toBe('destructive')
    expect(view.tooltipLines).toContain('ai-gateway-error (HTTP 502): Every model failed.')
  })

  it('builds the tooltip from lastTickAt, messagesSeen and questionsTotal', () => {
    const view = cohostPresenceView(listening({ questions: [question()] }), NOW)
    expect(view.tooltipLines).toEqual([
      'last pass 12s ago',
      '84 messages read',
      '5 questions found (1 open)'
    ])
  })

  it('adds the next-pass ETA whenever the scheduler published one', () => {
    const view = cohostPresenceView(
      listening({ pendingMessages: 2, nextTickAt: '2026-08-24T12:00:07.000Z' }),
      NOW
    )
    expect(view.tooltipLines).toContain('next pass in ~7s')
  })

  it('carries the unread badge through from the collapse reducer', () => {
    expect(cohostPresenceView(listening(), NOW, { unread: 2 }).unreadBadge).toBe(2)
    expect(cohostPresenceView(listening(), NOW, { unread: 0 }).unreadBadge).toBeUndefined()
  })
})

describe('relative formatters', () => {
  it('formats ages compactly', () => {
    expect(cohostAgoLabel('2026-08-24T12:00:00.000Z', NOW)).toBe('just now')
    expect(cohostAgoLabel('2026-08-24T11:59:48.000Z', NOW)).toBe('12s ago')
    expect(cohostAgoLabel('2026-08-24T11:56:00.000Z', NOW)).toBe('4m ago')
    expect(cohostAgoLabel('2026-08-24T10:00:00.000Z', NOW)).toBe('2h ago')
    expect(cohostAgoLabel(null, NOW)).toBeNull()
    expect(cohostAgoLabel('not-a-date', NOW)).toBeNull()
  })

  it('never promises a pass that is already due', () => {
    expect(cohostNextPassLabel('2026-08-24T12:00:07.000Z', NOW)).toBe('~7s')
    expect(cohostNextPassLabel('2026-08-24T12:02:00.000Z', NOW)).toBe('~2m')
    expect(cohostNextPassLabel('2026-08-24T11:59:00.000Z', NOW)).toBe('any moment')
    expect(cohostNextPassLabel(null, NOW)).toBeNull()
  })
})

describe('cohostEmptyStateCopy', () => {
  it('upgrades from static listening copy to the real work', () => {
    const reading = listening({ pendingMessages: 4 })
    expect(cohostEmptyStateCopy(cohostPresenceView(reading, NOW), reading)).toBe(
      'Reading 4 new messages…'
    )
    const one = listening({ pendingMessages: 1 })
    expect(cohostEmptyStateCopy(cohostPresenceView(one, NOW), one)).toBe('Reading 1 new message…')
    const idle = listening()
    expect(cohostEmptyStateCopy(cohostPresenceView(idle, NOW), idle)).toBe(
      'Listening — questions from chat will appear here.'
    )
    const off = offCohostState()
    expect(cohostEmptyStateCopy(cohostPresenceView(off, NOW), off)).toBe(
      'Questions from chat will appear here once co-host is listening again.'
    )
  })
})

describe('cohostGroupedDeltaFlash', () => {
  it('flashes the questions a newer tick actually added', () => {
    const previous = listening({ questions: [question()] })
    const next = listening({
      tickSeq: 5,
      questions: [question(), question({ id: 'q-2' }), question({ id: 'q-3' })]
    })
    expect(cohostGroupedDeltaFlash(previous, next)).toBe('grouped 2 questions')
  })

  it('uses the singular for one question', () => {
    const previous = listening({ questions: [] })
    const next = listening({ tickSeq: 5, questions: [question()] })
    expect(cohostGroupedDeltaFlash(previous, next)).toBe('grouped 1 question')
  })

  it('stays silent for action results, older ticks and a new session', () => {
    const previous = listening({ questions: [question()] })
    // Same tickSeq: an action result, not a pass.
    expect(
      cohostGroupedDeltaFlash(
        previous,
        listening({ questions: [question(), question({ id: 'q-2' })] })
      )
    ).toBeNull()
    // A newer tick that removed a question is not a "grouped" event.
    expect(cohostGroupedDeltaFlash(previous, listening({ tickSeq: 5, questions: [] }))).toBeNull()
    expect(
      cohostGroupedDeltaFlash(
        previous,
        listening({ sessionId: 'sess-2', tickSeq: 9, questions: [question({ id: 'q-9' })] })
      )
    ).toBeNull()
    expect(cohostGroupedDeltaFlash(null, listening({ questions: [question()] }))).toBeNull()
  })
})

describe('cohostQuestionIds', () => {
  it('reads ids out of any state shape, including null', () => {
    expect(
      cohostQuestionIds(listening({ questions: [question(), question({ id: 'q-2' })] }))
    ).toEqual(['q-1', 'q-2'])
    expect(cohostQuestionIds(null)).toEqual([])
  })
})
