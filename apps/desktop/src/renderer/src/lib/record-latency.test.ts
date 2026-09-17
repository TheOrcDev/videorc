import { describe, expect, it } from 'vitest'

import {
  RECORD_LATENCY_CLICK_TTL_MS,
  clickEpochMs,
  createRecordLatencyTracker,
  formatRecordLatencyLog,
  formatTimelineSummary,
  slowestTimelinePhase
} from './record-latency'

describe('record latency tracker', () => {
  it('measures click → starting → recording', () => {
    const tracker = createRecordLatencyTracker()
    tracker.markClick('start', 1000)
    expect(tracker.observe({ state: 'starting' }, 1012)).toBeNull()
    expect(tracker.observe({ state: 'recording', sessionId: 's-1' }, 1380)).toEqual({
      kind: 'start',
      origin: 'click',
      clickToStartingMs: 12,
      clickToRecordingMs: 380,
      sessionId: 's-1'
    })
    expect(tracker.hasPending('start')).toBe(false)
  })

  it('measures click → recording without an intermediate starting event', () => {
    const tracker = createRecordLatencyTracker()
    tracker.markClick('start', 0)
    expect(tracker.observe({ state: 'streaming', sessionId: 's-2' }, 250)).toEqual({
      kind: 'start',
      origin: 'click',
      clickToRecordingMs: 250,
      sessionId: 's-2'
    })
  })

  it('ignores stale clicks and unrelated statuses', () => {
    const tracker = createRecordLatencyTracker()
    tracker.markClick('start', 0)
    expect(tracker.observe({ state: 'recording' }, RECORD_LATENCY_CLICK_TTL_MS + 1)).toBeNull()
    expect(tracker.observe({ state: 'recording' }, 10)).toBeNull()
  })

  it('measures stop with and without a stopping event and clears a failed start', () => {
    const tracker = createRecordLatencyTracker()
    tracker.markClick('stop', 5000)
    expect(tracker.observe({ state: 'stopping', sessionId: 's-1' }, 5020)).toBeNull()
    expect(tracker.observe({ state: 'idle', sessionId: 's-1' }, 5230)).toEqual({
      kind: 'stop',
      origin: 'click',
      clickToStoppingMs: 20,
      clickToIdleMs: 230,
      sessionId: 's-1'
    })

    tracker.markClick('stop', 9000)
    expect(tracker.observe({ state: 'idle' }, 9100)).toEqual({
      kind: 'stop',
      origin: 'click',
      clickToIdleMs: 100
    })

    tracker.markClick('start', 12_000)
    expect(tracker.observe({ state: 'failed' }, 12_400)).toBeNull()
    expect(tracker.hasPending('start')).toBe(false)
  })

  it('keeps the earlier real click when a session-call mark follows it', () => {
    const tracker = createRecordLatencyTracker()
    tracker.markClick('start', 100, 'click')
    tracker.markClick('start', 140, 'session-call')
    expect(tracker.observe({ state: 'recording' }, 400)).toMatchObject({
      origin: 'click',
      clickToRecordingMs: 300
    })
  })

  it('reports the session-call origin for keyboard/remote paths without a click mark', () => {
    const tracker = createRecordLatencyTracker()
    tracker.markClick('stop', 100, 'session-call')
    expect(tracker.observe({ state: 'idle' }, 160)).toMatchObject({
      origin: 'session-call',
      clickToIdleMs: 60
    })
  })
})

describe('record latency helpers', () => {
  it('maps a performance.now() click to epoch milliseconds', () => {
    expect(clickEpochMs(1_000, 1_250, 1_700_000_000_250)).toBe(1_700_000_000_000)
  })

  it('formats log lines for both kinds', () => {
    expect(
      formatRecordLatencyLog({
        kind: 'start',
        origin: 'click',
        clickToStartingMs: 12,
        clickToRecordingMs: 380,
        sessionId: 's-1'
      })
    ).toBe('[record-latency] start click→starting 12 ms · click→recording 380 ms (session s-1)')
    expect(formatRecordLatencyLog({ kind: 'stop', origin: 'click', clickToIdleMs: 90 })).toBe(
      '[record-latency] stop click→idle 90 ms'
    )
  })

  it('finds the slowest phase in a backend timeline and summarizes it', () => {
    const snapshot = {
      kind: 'start',
      totalMs: 1200,
      outcome: 'running',
      cold: true,
      clickToOriginMs: 18,
      marks: [
        { phase: 'admission', atMs: 3 },
        { phase: 'mic-warm', atMs: 380 },
        { phase: 'running', atMs: 1200 }
      ]
    }
    expect(slowestTimelinePhase(snapshot)).toEqual({ phase: 'running', deltaMs: 820 })
    expect(slowestTimelinePhase({ kind: 'stop', totalMs: 0, outcome: 'idle' })).toBeNull()
    expect(formatTimelineSummary(snapshot)).toBe('1200 ms · running · cold · 18 ms click→backend')
    expect(formatTimelineSummary(null)).toBe('--')
  })
})
