import { describe, expect, it } from 'vitest'

import type {
  ClipMoment,
  CohostReportPayload,
  CohostReportQuestion,
  CohostReportQuestions,
  CohostSessionReport,
  SessionSummary
} from './backend'
import { dayLabel } from './format'
import {
  isAutoSessionTitle,
  capReportList,
  chatMessagesLabel,
  formatMomentRange,
  isReportableStream,
  missedQuestions,
  momentKind,
  newestStreamedSessionId,
  BUDDY_REPORT_DESCRIPTION,
  BUDDY_REPORT_EMPTY,
  BUDDY_REPORT_LIST_CAP,
  BUDDY_REPORT_NEXT_STREAM,
  BUDDY_REPORT_OFF,
  BUDDY_REPORT_SWITCHER_LIMIT,
  BUDDY_REPORT_TURN_ON,
  buddyReportView,
  questionTally,
  reportAlertLabel,
  reportCommands,
  reportMoments,
  reportPlatforms,
  reportSessionChoice,
  reportSessionOptions,
  streamOffsetLabel
} from './buddy-report-view'

function question(overrides: Partial<CohostReportQuestion> = {}): CohostReportQuestion {
  return {
    id: 'q1',
    text: 'What keyboard is that?',
    priority: 'normal',
    firstSeenAt: '2026-08-22T10:12:04Z',
    outcome: 'open',
    ...overrides
  }
}

function questions(overrides: Partial<CohostReportQuestions> = {}): CohostReportQuestions {
  return {
    total: 0,
    markedAnswered: 0,
    dismissed: 0,
    replied: 0,
    answeredOnAir: 0,
    restored: 0,
    shownOnStream: 0,
    ...overrides
  }
}

function report(overrides: Partial<CohostSessionReport> = {}): CohostSessionReport {
  return {
    version: 1,
    sessionId: 'stream-1',
    startedAt: '2026-08-22T10:00:30Z',
    endedAt: '2026-08-22T11:30:00Z',
    segments: 1,
    streamTitle: 'Rust night',
    messagesSeen: 84,
    shownOnStream: 2,
    questions: questions({
      total: 5,
      markedAnswered: 1,
      dismissed: 1,
      replied: 1,
      answeredOnAir: 1,
      items: [
        question({ id: 'q1', outcome: 'replied' }),
        question({
          id: 'q2',
          text: 'Which editor theme?',
          askers: ['Ada', 'Grace', 'Linus'],
          platforms: ['twitch', 'youtube', 'twitch'],
          priority: 'high',
          firstSeenAt: '2026-08-22T10:20:00Z'
        }),
        question({ id: 'q3', outcome: 'answered-on-air' }),
        question({ id: 'q4', outcome: 'marked-answered' }),
        question({ id: 'q5', outcome: 'dismissed' })
      ]
    }),
    flags: { raised: 2, dismissed: 1 },
    promises: {
      heard: 2,
      kept: 1,
      dismissed: 0,
      reminded: 1,
      open: [{ text: 'Giveaway at 100 viewers', firstSeenAt: '2026-08-22T10:05:00Z' }]
    },
    greetings: {
      firstTimers: 3,
      firstTimersGreeted: 2,
      byVoice: 1,
      byChat: 1,
      onStream: 0,
      manual: 0
    },
    alerts: [
      { kind: 'audio', peakViewers: 3, active: true, firstSeenAt: '2026-08-22T10:40:00Z' },
      { kind: 'game', peakViewers: 1, active: false, firstSeenAt: '2026-08-22T11:02:10Z' }
    ],
    recap: { offered: 1, drafted: 0, dismissed: 1 },
    ...overrides
  }
}

const MOMENTS: ClipMoment[] = [
  {
    startMs: 280_000,
    endMs: 325_000,
    reason: 'Chat spiked: 9 messages in 30s',
    excerpt: 'chat is going wild right now',
    source: 'chat'
  },
  { startMs: 724_200, endMs: 754_200, reason: 'Marked', excerpt: '', source: 'manual' },
  {
    startMs: 275_400,
    endMs: 312_000,
    reason: "You said 'clip that'",
    excerpt: '  and it actually works first try clip that ',
    source: 'voice'
  }
]

function payload(overrides: Partial<CohostReportPayload> = {}): CohostReportPayload {
  return {
    sessionId: 'stream-1',
    report: report(),
    moments: MOMENTS,
    chat: {
      messages: 84,
      byPlatform: [
        { platform: 'twitch', messages: 60 },
        { platform: 'youtube', messages: 24 }
      ]
    },
    ...overrides
  }
}

const SESSION = {
  id: 'stream-1',
  title: 'Friday stream',
  startedAt: '2026-08-22T10:00:00Z',
  durationMs: 5_400_000
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'stream-1',
    title: 'Friday stream',
    startedAt: '2026-08-22T10:00:00Z',
    status: 'completed',
    mode: 'record+stream',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0,
    ...overrides
  }
}

describe('Golem report copy (plan 119 S3)', () => {
  it("says what the report holds in the website's words", () => {
    expect(BUDDY_REPORT_DESCRIPTION).toBe(
      'Golem saves a short report on your computer: questions caught and missed, flags, promises, first-timers greeted, and the moments you marked by saying clip that.'
    )
    expect(BUDDY_REPORT_EMPTY).toBe('The report appears here after your first stream with Golem.')
    expect(BUDDY_REPORT_TURN_ON).toBe('Turn on Golem to also catch questions.')
    for (const copy of [
      BUDDY_REPORT_DESCRIPTION,
      BUDDY_REPORT_EMPTY,
      BUDDY_REPORT_OFF,
      BUDDY_REPORT_TURN_ON,
      BUDDY_REPORT_NEXT_STREAM
    ]) {
      expect(copy).not.toContain('—')
      expect(copy).not.toMatch(/co-host|publish/i)
    }
  })
})

describe('question tally', () => {
  it('reads outcomes from the log while it holds every question', () => {
    const tally = questionTally(report().questions)
    expect(tally).toEqual({ caught: 5, answeredOnAir: 1, replied: 1, missed: 1 })
  })

  it('counts a question shown on stream as handled and a restored one as missed', () => {
    const tally = questionTally(
      questions({
        total: 3,
        // The counters still remember the voice answer that was undone.
        answeredOnAir: 2,
        restored: 1,
        items: [
          question({ id: 'a', outcome: 'shown' }),
          question({ id: 'b', outcome: 'open' }),
          question({ id: 'c', outcome: 'answered-on-air' })
        ]
      })
    )
    expect(tally).toEqual({ caught: 3, answeredOnAir: 1, replied: 0, missed: 1 })
  })

  it('falls back to the counters past the log cap', () => {
    const items = Array.from({ length: 200 }, (_, index) =>
      question({ id: `q${index}`, outcome: index < 10 ? 'open' : 'replied' })
    )
    expect(
      questionTally(
        questions({
          total: 260,
          replied: 190,
          answeredOnAir: 20,
          markedAnswered: 5,
          dismissed: 5,
          shownOnStream: 5,
          restored: 5,
          items
        })
      )
    ).toEqual({ caught: 260, answeredOnAir: 20, replied: 190, missed: 40 })
    // The open questions the log holds are a floor; the count never leaves 0..total.
    expect(questionTally(questions({ total: 210, replied: 400, items })).missed).toBe(10)
    expect(questionTally(questions({ total: 4 }))).toEqual({
      caught: 4,
      answeredOnAir: 0,
      replied: 0,
      missed: 4
    })
  })

  it('lists the missed questions in the order they were first seen', () => {
    expect(
      missedQuestions(
        questions({
          total: 3,
          items: [
            question({ id: 'first', outcome: 'open' }),
            question({ id: 'answered', outcome: 'replied' }),
            question({ id: 'second', outcome: 'open' })
          ]
        })
      ).map((item) => item.id)
    ).toEqual(['first', 'second'])
    expect(missedQuestions(questions())).toEqual([])
  })
})

describe('chat by platform', () => {
  it('groups each platform once, busiest first, and drops platforms without chat', () => {
    expect(
      reportPlatforms({
        messages: 92,
        byPlatform: [
          { platform: 'youtube', messages: 24 },
          { platform: 'kick', messages: 0 },
          { platform: 'twitch', messages: 50 },
          { platform: 'x', messages: 4 },
          { platform: 'twitch', messages: 10 },
          { platform: 'tiktok', messages: 4 }
        ]
      })
    ).toEqual([
      { platform: 'twitch', messages: 60, label: 'Twitch: 60 messages' },
      { platform: 'youtube', messages: 24, label: 'YouTube: 24 messages' },
      { platform: 'tiktok', messages: 4, label: 'TikTok: 4 messages' },
      { platform: 'x', messages: 4, label: 'X: 4 messages' }
    ])
    expect(
      reportPlatforms({ messages: 1, byPlatform: [{ platform: 'kick', messages: 1 }] })
    ).toEqual([{ platform: 'kick', messages: 1, label: 'Kick: 1 message' }])
  })

  it('names the chat total', () => {
    expect(chatMessagesLabel(0)).toBe('No chat messages')
    expect(chatMessagesLabel(1)).toBe('1 chat message')
    expect(chatMessagesLabel(84)).toBe('84 chat messages')
    expect(chatMessagesLabel(12_480)).toBe(`${(12_480).toLocaleString()} chat messages`)
  })
})

describe('moments', () => {
  it('puts the streamer’s marks first, then chat peaks, each in recording order', () => {
    const rows = reportMoments(MOMENTS)
    expect(rows.map((row) => [row.kind, row.label, row.range])).toEqual([
      ['voice', "You said 'clip that'", '4:35–5:12'],
      ['manual', 'Marked', '12:04–12:34'],
      ['chat', 'Chat spiked: 9 messages in 30s', '4:40–5:25']
    ])
    expect(rows[0].excerpt).toBe('and it actually works first try clip that')
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
  })

  it('labels marks by who placed them and keeps the phrase a voice mark heard', () => {
    const [voice, silentVoice, manual, legacy] = reportMoments([
      { startMs: 0, endMs: 30_000, reason: "You said 'clip it'", excerpt: '', source: 'voice' },
      { startMs: 40_000, endMs: 70_000, reason: '', excerpt: '', source: 'voice' },
      { startMs: 80_000, endMs: 110_000, reason: 'Clip', excerpt: '', source: 'manual' },
      { startMs: 5_000, endMs: 50_000, reason: 'Chat spiked: 4 messages in 30s', excerpt: '' }
    ])
    expect(voice.label).toBe("You said 'clip it'")
    expect(silentVoice.label).toBe("You said 'clip that'")
    expect(manual.label).toBe('Marked')
    // An older backend sends no source: that moment is a chat peak.
    expect(legacy.kind).toBe('chat')
    expect(momentKind({})).toBe('chat')
  })

  it('reads recording time as m:ss, or h:mm:ss from an hour', () => {
    expect(formatMomentRange(275_400, 312_000)).toBe('4:35–5:12')
    expect(formatMomentRange(3_590_000, 3_635_000)).toBe('59:50–1:00:35')
    expect(formatMomentRange(12_000, 12_000)).toBe('0:12')
  })
})

describe('report view', () => {
  it('builds the full card from a saved report', () => {
    const view = buddyReportView({ payload: payload(), session: SESSION, buddyOn: true })
    expect(view.kind).toBe('report')
    if (view.kind !== 'report') return
    expect(view.sessionId).toBe('stream-1')
    // The stream's own title wins over the Library name.
    expect(view.title).toBe('Rust night')
    expect(view.date).toBe(dayLabel(SESSION.startedAt))
    expect(view.duration).toBe('1 hour and 30 minutes')
    expect(view.chat.label).toBe('84 chat messages')
    expect(view.chat.platforms.map((entry) => entry.platform)).toEqual(['twitch', 'youtube'])
    expect(view.note).toBeNull()
    expect(view.stats.map((stat) => [stat.label, stat.value, stat.of ?? null])).toEqual([
      ['Questions caught', '5', null],
      ['Answered on air', '1', null],
      ['Replied', '1', null],
      ['Missed', '1', null],
      ['Flags', '2', null],
      ['Promises kept', '1', null],
      ['Promises open', '1', null],
      ['First-timers greeted', '2', '3'],
      ['On screen', '2', null]
    ])
    expect(view.missed).toEqual([
      {
        id: 'q2',
        text: 'Which editor theme?',
        askers: 'Ada +2',
        askersTitle: 'Ada, Grace, Linus',
        platforms: ['twitch', 'youtube'],
        high: true,
        // Time into the stream, from the session's own start.
        at: '20:00'
      }
    ])
    expect(view.promises.map((promise) => [promise.text, promise.at])).toEqual([
      ['Giveaway at 100 viewers', '5:00']
    ])
    expect(view.alerts.map((alert) => [alert.label, alert.viewers, alert.at])).toEqual([
      ['Chat said: no audio', '3 viewers', '40:00'],
      ['Chat said: game problem', '1 viewer', '1:02:10']
    ])
    expect(view.moments.map((moment) => moment.kind)).toEqual(['voice', 'manual', 'chat'])
  })

  it('names and times the stream from the report alone when the Library row is not loaded', () => {
    const view = buddyReportView({
      payload: payload({ report: report({ streamTitle: undefined }) }),
      session: null,
      buddyOn: true
    })
    if (view.kind !== 'report') throw new Error(view.kind)
    expect(view.title).toBe('Untitled stream')
    expect(view.date).toBe(dayLabel('2026-08-22T10:00:30Z'))
    expect(view.duration).toBe('1 hour and 29 minutes')
    expect(view.promises[0].at).toBe('4:30')

    const named = buddyReportView({
      payload: payload({ report: report({ streamTitle: '  ' }) }),
      session: SESSION,
      buddyOn: true
    })
    if (named.kind !== 'report') throw new Error(named.kind)
    expect(named.title).toBe('Friday stream')
  })

  it('keeps moments and chat for a stream Golem missed, and says how to catch questions', () => {
    const view = buddyReportView({
      payload: payload({ report: null }),
      session: SESSION,
      buddyOn: false
    })
    expect(view.kind).toBe('buddy-off')
    if (view.kind !== 'buddy-off') return
    expect(view.title).toBe('Friday stream')
    expect(view.note).toEqual({
      title: 'Golem was off for this stream.',
      hint: 'Turn on Golem to also catch questions.'
    })
    expect(view.stats).toEqual([])
    expect(view.missed).toEqual([])
    expect(view.moments).toHaveLength(3)
    expect(view.chat.label).toBe('84 chat messages')

    const on = buddyReportView({
      payload: payload({ report: null }),
      session: SESSION,
      buddyOn: true
    })
    if (on.kind !== 'buddy-off') throw new Error(on.kind)
    expect(on.note?.hint).toBe('It joins your next stream.')
  })

  it('is empty before the first stream', () => {
    expect(buddyReportView({ payload: null, session: null, buddyOn: false })).toEqual({
      kind: 'empty',
      message: 'The report appears here after your first stream with Golem.'
    })
  })

  it('shows zeros for a quiet stream instead of hiding the counts', () => {
    const quiet = buddyReportView({
      payload: payload({
        moments: [],
        chat: { messages: 0, byPlatform: [] },
        report: report({
          questions: questions(),
          flags: { raised: 0, dismissed: 0 },
          promises: { heard: 0, kept: 0, dismissed: 0, reminded: 0 },
          greetings: {
            firstTimers: 0,
            firstTimersGreeted: 0,
            byVoice: 0,
            byChat: 0,
            onStream: 0,
            manual: 0
          },
          alerts: undefined,
          shownOnStream: 0
        })
      }),
      session: SESSION,
      buddyOn: true
    })
    if (quiet.kind !== 'report') throw new Error(quiet.kind)
    expect(quiet.stats.every((stat) => stat.value === '0')).toBe(true)
    expect(quiet.chat).toEqual({ messages: 0, label: 'No chat messages', platforms: [] })
    expect([quiet.missed, quiet.promises, quiet.moments, quiet.alerts]).toEqual([[], [], [], []])
    expect(quiet.commands).toBeNull()
  })

  it('counts what voice commands did, non-zero counts only (plan 140)', () => {
    const counts = {
      highlighted: 3,
      cleared: 1,
      removed: 1,
      hiddenLocally: 1,
      cancelled: 0,
      expired: 1,
      failed: 0,
      notFound: 2
    }
    expect(reportCommands(counts)).toEqual({
      total: '9 commands',
      counts: [
        { id: 'highlighted', value: '3', label: 'Highlighted' },
        { id: 'cleared', value: '1', label: 'Cleared' },
        { id: 'removed', value: '1', label: 'Removed' },
        { id: 'hidden-locally', value: '1', label: 'Hidden in Videorc' },
        { id: 'expired', value: '1', label: 'No answer' },
        { id: 'not-found', value: '2', label: 'Not found' }
      ]
    })
    expect(
      reportCommands({
        ...counts,
        highlighted: 0,
        cleared: 0,
        hiddenLocally: 0,
        expired: 0,
        notFound: 0
      })
    ).toEqual({
      total: '1 command',
      counts: [{ id: 'removed', value: '1', label: 'Removed' }]
    })
    // A report from before voice commands, or one where nothing counted.
    expect(reportCommands(undefined)).toBeNull()
    expect(
      reportCommands({
        highlighted: 0,
        cleared: 0,
        removed: 0,
        hiddenLocally: 0,
        cancelled: 0,
        expired: 0,
        failed: 0,
        notFound: 0
      })
    ).toBeNull()
    // The card's view carries it; a stream Golem missed has none.
    const view = buddyReportView({
      payload: payload({ report: report({ commands: counts }) }),
      session: SESSION,
      buddyOn: true
    })
    if (view.kind !== 'report') throw new Error(view.kind)
    expect(view.commands?.total).toBe('9 commands')
    const off = buddyReportView({
      payload: payload({ report: null }),
      session: SESSION,
      buddyOn: true
    })
    if (off.kind !== 'buddy-off') throw new Error(off.kind)
    expect(off.commands).toBeNull()
  })

  it('times events into the stream and gives up on unreadable times', () => {
    expect(streamOffsetLabel('2026-08-22T10:12:04Z', '2026-08-22T10:00:00Z')).toBe('12:04')
    expect(streamOffsetLabel('2026-08-22T09:59:00Z', '2026-08-22T10:00:00Z')).toBe('0:00')
    expect(streamOffsetLabel('later', '2026-08-22T10:00:00Z')).toBeNull()
    expect(streamOffsetLabel('2026-08-22T10:12:04Z', null)).toBeNull()
    expect(reportAlertLabel('stream-health')).toBe('Chat said: stream is lagging')
    expect(reportAlertLabel('mystery' as never)).toBe('Chat said: something was wrong')
  })
})

describe('report lists', () => {
  it(`shows ${BUDDY_REPORT_LIST_CAP} rows, then the rest behind Show all`, () => {
    const rows = Array.from({ length: 8 }, (_, index) => index)
    expect(capReportList(rows, false)).toEqual({ visible: [0, 1, 2, 3, 4], hidden: 3 })
    expect(capReportList(rows, true)).toEqual({ visible: rows, hidden: 0 })
    expect(capReportList(rows.slice(0, 5), false)).toEqual({ visible: [0, 1, 2, 3, 4], hidden: 0 })
    expect(capReportList([], false)).toEqual({ visible: [], hidden: 0 })
  })
})

describe('stream switcher', () => {
  const sessions = [
    session({ id: 'old', title: 'Old stream', startedAt: '2026-08-01T10:00:00Z', mode: 'stream' }),
    session({
      id: 'recording',
      title: 'Tutorial',
      startedAt: '2026-08-30T10:00:00Z',
      mode: 'record'
    }),
    session({ id: 'new', title: '', startedAt: '2026-08-29T10:00:00Z' }),
    session({ id: 'legacy', startedAt: '2026-07-01T10:00:00Z', mode: 'streaming' }),
    session({ id: 'live', startedAt: '2026-09-01T10:00:00Z', status: 'running' }),
    session({ id: 'imported', startedAt: '2026-09-02T10:00:00Z', mode: 'imported' })
  ]

  it('offers streams that ended, newest first', () => {
    expect(isReportableStream(session({ mode: 'record+stream' }))).toBe(true)
    expect(isReportableStream(session({ mode: 'record' }))).toBe(false)
    expect(isReportableStream(session({ status: 'running' }))).toBe(false)
    expect(newestStreamedSessionId(sessions)).toBe('new')
    expect(newestStreamedSessionId([sessions[1]])).toBeNull()
    expect(reportSessionOptions(sessions, null)).toEqual([
      { id: 'new', title: 'Untitled stream', date: dayLabel('2026-08-29T10:00:00Z') },
      { id: 'old', title: 'Old stream', date: dayLabel('2026-08-01T10:00:00Z') },
      { id: 'legacy', title: 'Friday stream', date: dayLabel('2026-07-01T10:00:00Z') }
    ])
  })

  it(`lists at most ${BUDDY_REPORT_SWITCHER_LIMIT}, plus the shown stream when the Library page ends before it`, () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      session({
        id: `s${index}`,
        startedAt: new Date(Date.UTC(2026, 7, 1, index)).toISOString()
      })
    )
    const options = reportSessionOptions(many, null)
    expect(options).toHaveLength(BUDDY_REPORT_SWITCHER_LIMIT)
    expect(options[0].id).toBe('s29')
    const shown = { id: 'archived', title: 'Old one', date: 'Jan 1' }
    expect(reportSessionOptions(many, shown).at(-1)).toEqual(shown)
    expect(reportSessionOptions(many, { ...shown, id: 's29' })).toHaveLength(
      BUDDY_REPORT_SWITCHER_LIMIT
    )
  })

  it('follows the last stream again when the newest one is picked', () => {
    expect(reportSessionChoice('new', 'new')).toBeNull()
    expect(reportSessionChoice('old', 'new')).toBe('old')
    expect(reportSessionChoice('old', null)).toBe('old')
  })
})

describe('isAutoSessionTitle (plan 150)', () => {
  it("matches only the backend's start-time name", () => {
    expect(isAutoSessionTitle('Session 2026-10-02 14:55')).toBe(true)
    expect(isAutoSessionTitle(' Session 2026-10-02 14:55 ')).toBe(true)
    expect(isAutoSessionTitle('Session 2026-10-02')).toBe(false)
    expect(isAutoSessionTitle('Rust night')).toBe(false)
    expect(isAutoSessionTitle('Session with chat 2026-10-02 14:55')).toBe(false)
  })
})
