// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ClipMoment,
  CohostReportPayload,
  CohostSessionReport,
  SessionSummary
} from '@/lib/backend'
import { dayLabel } from '@/lib/format'
import { ORCLE_REPORT_DESCRIPTION } from '@/lib/orcle-report-view'

import { OrcleReportCard } from './orcle-report-card'

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  report: {} as Record<string, unknown>,
  asked: [] as Array<string | null>
}))
vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => mocked.core }))
vi.mock('@/hooks/use-orcle-report', () => ({
  useOrcleReport: (sessionId: string | null) => {
    mocked.asked.push(sessionId)
    return mocked.report
  }
}))

let root: Root
let container: HTMLDivElement
const onSessionChange = vi.fn((_sessionId: string | null) => undefined)
const reload = vi.fn()

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'stream-1',
    title: 'Friday stream',
    startedAt: '2026-08-22T10:00:00Z',
    durationMs: 5_400_000,
    status: 'completed',
    mode: 'record+stream',
    healthEventCount: 0,
    sessionLogCount: 0,
    aiArtifactCount: 0,
    commentCount: 0,
    ...overrides
  }
}

const SESSIONS = [
  session({ id: 'stream-1' }),
  session({ id: 'tutorial', title: 'Tutorial', mode: 'record', startedAt: '2026-08-23T10:00:00Z' }),
  session({ id: 'stream-0', title: 'Launch day', startedAt: '2026-08-01T18:00:00Z' })
]

const REPORT: CohostSessionReport = {
  version: 1,
  sessionId: 'stream-1',
  startedAt: '2026-08-22T10:00:00Z',
  endedAt: '2026-08-22T11:30:00Z',
  segments: 1,
  streamTitle: 'Rust night',
  messagesSeen: 84,
  shownOnStream: 2,
  questions: {
    total: 2,
    markedAnswered: 0,
    dismissed: 0,
    replied: 1,
    answeredOnAir: 0,
    restored: 0,
    shownOnStream: 0,
    items: [
      {
        id: 'q1',
        text: 'What keyboard is that?',
        priority: 'normal',
        firstSeenAt: '2026-08-22T10:01:00Z',
        outcome: 'replied'
      },
      {
        id: 'q2',
        text: 'Which editor theme?',
        askers: ['Ada', 'Grace'],
        platforms: ['twitch'],
        priority: 'high',
        firstSeenAt: '2026-08-22T10:20:00Z',
        outcome: 'open'
      }
    ]
  },
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
  alerts: [{ kind: 'audio', peakViewers: 3, active: true, firstSeenAt: '2026-08-22T10:40:00Z' }],
  recap: { offered: 0, drafted: 0, dismissed: 0 }
}

const MOMENTS: ClipMoment[] = [
  {
    startMs: 275_400,
    endMs: 312_000,
    reason: "You said 'clip that'",
    excerpt: 'and it actually works first try',
    source: 'voice'
  },
  { startMs: 724_200, endMs: 754_200, reason: 'Marked', excerpt: '', source: 'manual' },
  {
    startMs: 280_000,
    endMs: 325_000,
    reason: 'Chat spiked: 9 messages in 30s',
    excerpt: 'chat is going wild',
    source: 'chat'
  }
]

function payload(overrides: Partial<CohostReportPayload> = {}): CohostReportPayload {
  return {
    sessionId: 'stream-1',
    report: REPORT,
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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  onSessionChange.mockClear()
  reload.mockClear()
  mocked.asked = []
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render({
  sessionId = null as string | null,
  report = { payload: payload(), loading: false, error: null } as Record<string, unknown>,
  sessions = SESSIONS,
  orcleOn = true
} = {}): Promise<void> {
  mocked.core = { sessions, cohostSettings: { enabled: orcleOn } }
  mocked.report = { reload, ...report }
  await act(async () => root.render(createElement(OrcleReportCard, { sessionId, onSessionChange })))
}

function card(): HTMLElement {
  return document.querySelector('[data-slot="orcle-report"]') as HTMLElement
}

function text(): string {
  return document.body.textContent ?? ''
}

function stat(id: string): string {
  return document.querySelector(`[data-stat="${id}"] dd`)?.textContent ?? ''
}

function rows(list: string): HTMLElement[] {
  return [
    ...document.querySelectorAll(`[data-slot="orcle-report-${list}"] [data-slot="list-row"]`)
  ] as HTMLElement[]
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(match, label).toBeTruthy()
  return match as HTMLButtonElement
}

describe('Golem report card (plan 119 S3)', () => {
  it('shows what Golem caught in the last stream', async () => {
    await render()
    // Follows the newest stream that ended (a recording is not a stream).
    expect(mocked.asked.at(-1)).toBe('stream-1')
    // Plan 150: one title; the picker names which stream.
    expect(text()).toContain('Stream report')
    expect(text()).not.toContain('Last stream')
    expect(text()).toContain(ORCLE_REPORT_DESCRIPTION)
    expect(card().getAttribute('data-state')).toBe('report')

    const stream = document.querySelector('[data-slot="orcle-report-stream"]')?.textContent
    expect(stream).toContain('Rust night')
    expect(stream).toContain('1 hour and 30 minutes')
    expect(stream).toContain('84 chat messages')
    expect(
      document.querySelector('[data-slot="orcle-report-stream"] [title="Twitch: 60 messages"]')
    ).toBeTruthy()

    expect(stat('questions')).toBe('2')
    expect(stat('replied')).toBe('1')
    expect(stat('missed')).toBe('1')
    expect(stat('flags')).toBe('2')
    expect(stat('promises-kept')).toBe('1')
    expect(stat('promises-open')).toBe('1')
    expect(stat('first-timers')).toBe('2 / 3')
    expect(stat('on-screen')).toBe('2')

    expect(rows('missed').map((row) => row.textContent)).toEqual([
      expect.stringContaining('Which editor theme?')
    ])
    expect(rows('missed')[0].textContent).toContain('Ada +1')
    expect(rows('missed')[0].textContent).toContain('High')
    expect(rows('missed')[0].textContent).toContain('20:00')
    expect(rows('promises')[0].textContent).toContain('Giveaway at 100 viewers')
    expect(rows('moments').map((row) => row.getAttribute('data-moment'))).toEqual([
      'voice',
      'manual',
      'chat'
    ])
    expect(rows('moments')[0].textContent).toContain("You said 'clip that'")
    expect(rows('moments')[0].textContent).toContain('4:35–5:12')
    expect(rows('moments')[1].textContent).toContain('Marked')
    expect(rows('moments')[2].textContent).toContain('chat is going wild')
    expect(rows('alerts')[0].textContent).toContain('Chat said: no audio')
    expect(rows('alerts')[0].textContent).toContain('3 viewers')

    // The switcher names the shown stream by when it ran.
    const trigger = document.querySelector('[aria-label="Stream"]')
    expect(trigger?.textContent).toContain(dayLabel('2026-08-22T10:00:00Z'))
    expect(text()).not.toMatch(/co-host/i)
  })

  it('keeps long lists short until asked', async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      startMs: index * 60_000,
      endMs: index * 60_000 + 30_000,
      reason: 'Marked',
      excerpt: '',
      source: 'manual' as const
    }))
    await render({ report: { payload: payload({ moments: many }), loading: false, error: null } })
    expect(rows('moments')).toHaveLength(5)
    await act(async () => button('Show all 7').click())
    expect(rows('moments')).toHaveLength(7)
    await act(async () => button('Show fewer').click())
    expect(rows('moments')).toHaveLength(5)
  })

  it('keeps moments and chat for a stream Golem was off for', async () => {
    await render({
      orcleOn: false,
      report: { payload: payload({ report: null }), loading: false, error: null }
    })
    expect(card().getAttribute('data-state')).toBe('orcle-off')
    const note = document.querySelector('[data-slot="orcle-report-off"]')?.textContent
    expect(note).toContain('Golem was off for this stream.')
    expect(note).toContain('Turn on Golem to also catch questions.')
    expect(document.querySelector('[data-slot="orcle-report-stats"]')).toBeNull()
    expect(rows('moments')).toHaveLength(3)
    expect(document.querySelector('[data-slot="orcle-report-stream"]')?.textContent).toContain(
      'Friday stream'
    )
  })

  it('explains the report before the first stream', async () => {
    await render({ sessions: [], report: { payload: null, loading: false, error: null } })
    expect(mocked.asked.at(-1)).toBeNull()
    expect(card().getAttribute('data-state')).toBe('empty')
    expect(text()).toContain('The report appears here after your first stream with Golem.')
    expect(document.querySelector('[aria-label="Stream"]')).toBeNull()
  })

  it('says it is loading, and offers Try again when the read fails', async () => {
    await render({ report: { payload: null, loading: true, error: null } })
    expect(card().getAttribute('aria-busy')).toBe('true')
    expect(text()).toContain('Loading the report…')

    await render({ report: { payload: null, loading: false, error: "Couldn't read this report." } })
    expect(text()).toContain("Couldn't read this report.")
    await act(async () => button('Try again').click())
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('switches to an older stream and back to the last one', async () => {
    await render()
    const trigger = document.querySelector('[aria-label="Stream"]') as HTMLElement
    await act(async () => trigger.click())
    const options = [...document.querySelectorAll('[role="option"]')] as HTMLElement[]
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Friday stream'),
      expect.stringContaining('Launch day')
    ])
    await act(async () => options[1].click())
    expect(onSessionChange).toHaveBeenLastCalledWith('stream-0')

    await render({
      sessionId: 'stream-0',
      report: {
        payload: payload({ sessionId: 'stream-0', report: { ...REPORT, sessionId: 'stream-0' } }),
        loading: false,
        error: null
      }
    })
    expect(mocked.asked.at(-1)).toBe('stream-0')
    expect(text()).toContain('Stream report')
    await act(async () => (document.querySelector('[aria-label="Stream"]') as HTMLElement).click())
    const newest = [...document.querySelectorAll('[role="option"]')][0] as HTMLElement
    await act(async () => newest.click())
    expect(onSessionChange).toHaveBeenLastCalledWith(null)
  })
})

describe('OrcleReportCard: the Commands row (plan 140, S6)', () => {
  it('shows what voice commands did, counts only', async () => {
    await render({
      report: {
        payload: payload({
          report: {
            ...REPORT,
            commands: {
              highlighted: 3,
              cleared: 1,
              removed: 2,
              hiddenLocally: 0,
              cancelled: 1,
              expired: 0,
              failed: 0,
              notFound: 0
            }
          }
        }),
        loading: false,
        error: null
      }
    })
    const [row] = rows('commands')
    expect(row).toBeTruthy()
    expect(row.textContent).toContain('Commands')
    expect(row.textContent).toContain('Highlighted 3 · Cleared 1 · Removed 2 · Cancelled 1')
    expect(row.textContent).toContain('7 commands')
    // Counts only: never a viewer's name or words.
    expect(row.textContent).not.toContain('coders_x')
  })

  it('leaves the row out when no command was counted', async () => {
    await render()
    expect(document.querySelector('[data-slot="orcle-report-commands"]')).toBeNull()
  })
})

describe('Reports tab layout (plan 150 S6)', () => {
  it('repeats no auto session name the picker already says', async () => {
    await render({
      report: {
        payload: payload({ report: { ...REPORT, streamTitle: 'Session 2026-10-02 14:55' } }),
        loading: false,
        error: null
      },
      sessions: [session({ title: 'Session 2026-10-02 14:55' })]
    })
    const stream = document.querySelector('[data-slot="orcle-report-stream"]')
    expect(stream?.textContent).not.toContain('Session 2026-10-02 14:55')
    expect(stream?.textContent).toContain('84 chat messages')
  })

  it('keeps a real stream title', async () => {
    await render()
    expect(document.querySelector('[data-slot="orcle-report-stream"]')?.textContent).toContain(
      'Rust night'
    )
  })

  it('names the empty tab before any stream with Golem', async () => {
    await render({ report: { payload: null, loading: false, error: null }, sessions: [] })
    const empty = document.querySelector('[data-slot="orcle-report-empty"]')
    expect(empty?.textContent).toContain('No stream reports yet')
    expect(empty?.textContent).toContain(
      'The report appears here after your first stream with Golem.'
    )
  })

  it('sets what needs you beside what happened', async () => {
    await render()
    const lists = document.querySelector('[data-slot="orcle-report-lists"]') as HTMLElement
    expect(lists.children.length).toBeGreaterThan(0)
    expect(lists.children.length).toBeLessThanOrEqual(2)
  })
})
