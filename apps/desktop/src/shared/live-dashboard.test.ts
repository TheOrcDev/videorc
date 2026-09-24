import { describe, expect, it, vi } from 'vitest'

import type { StreamTargetRuntime, ViewerSample } from './backend'
import {
  BITRATE_HISTORY_POINTS,
  VIEWER_HISTORY_POINTS,
  createDashboardPushCoalescer,
  emptyLiveDashboardState,
  mergeDashboardViewerHistory,
  normalizeLiveDashboardState,
  reduceDashboardAudience,
  reduceDashboardHealth,
  reduceDashboardRecording,
  reduceDashboardTargets,
  reduceDashboardViewers,
  type LiveDashboardState
} from './live-dashboard'

const T0 = Date.parse('2026-09-24T10:00:00Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString()

function sample(seconds: number, total: number, sessionId = 's1'): ViewerSample {
  return {
    sessionId,
    platforms: [{ platform: 'twitch', count: total }],
    total,
    at: at(seconds)
  }
}

function target(state: StreamTargetRuntime['state'], message?: string): StreamTargetRuntime {
  return {
    targetId: 'twitch',
    platform: 'twitch',
    label: 'Twitch',
    state,
    ...(message ? { message } : {})
  }
}

function live(): LiveDashboardState {
  return reduceDashboardRecording(
    emptyLiveDashboardState(at(0)),
    { state: 'streaming', sessionId: 's1', startedAt: at(0) },
    at(0)
  )
}

describe('live dashboard state', () => {
  it('follows the session through recording, live and off air', () => {
    const state = live()
    expect(state.sessionId).toBe('s1')
    expect(state.session).toEqual({ state: 'live', startedAt: at(0) })
    // Transitional states keep the last one.
    expect(reduceDashboardRecording(state, { state: 'stopping', sessionId: 's1' }, at(5))).toBe(
      state
    )
    const ended = reduceDashboardRecording(state, { state: 'idle' }, at(9))
    expect(ended.session).toEqual({ state: 'off-air', startedAt: at(0) })
    // The finished session's data stays for its summary.
    expect(ended.sessionId).toBe('s1')
  })

  it('keeps a peak and a bounded 60-minute viewer history', () => {
    let state = live()
    for (let index = 0; index < VIEWER_HISTORY_POINTS + 20; index += 1) {
      state = reduceDashboardViewers(state, sample(index * 30, index === 7 ? 900 : 100), at(index))
    }
    expect(state.viewers.history).toHaveLength(VIEWER_HISTORY_POINTS)
    expect(state.viewers.peak).toBe(900)
    expect(state.viewers.latest?.total).toBe(100)
    // A cleared chip keeps history and peak.
    const cleared = reduceDashboardViewers(state, null, at(9999))
    expect(cleared.viewers.latest).toBeNull()
    expect(cleared.viewers.history).toHaveLength(VIEWER_HISTORY_POINTS)
  })

  it("drops another session's data when a new session reports", () => {
    let state = reduceDashboardViewers(live(), sample(30, 500), at(30))
    state = reduceDashboardViewers(state, sample(60, 3, 's2'), at(60))
    expect(state.sessionId).toBe('s2')
    expect(state.viewers.history).toEqual([{ at: at(60), total: 3 }])
    expect(state.viewers.peak).toBe(3)
  })

  it('backfills history after a renderer reload without duplicating points', () => {
    const state = reduceDashboardViewers(live(), sample(90, 40), at(90))
    const merged = mergeDashboardViewerHistory(
      state,
      's1',
      [sample(30, 10), sample(60, 70), sample(90, 40), sample(30, 1, 'other')],
      at(91)
    )
    expect(merged.viewers.history.map((point) => point.total)).toEqual([10, 70, 40])
    expect(merged.viewers.peak).toBe(70)
    expect(mergeDashboardViewerHistory(state, 'other', [sample(1, 1)], at(92))).toBe(state)
  })

  it('keeps ten minutes of bitrate and skips health without a bitrate', () => {
    let state = live()
    for (let index = 0; index < BITRATE_HISTORY_POINTS + 50; index += 1) {
      state = reduceDashboardHealth(
        state,
        { sessionId: 's1', bitrateKbps: 6000 + index, createdAt: at(index * 2) },
        at(index * 2)
      )
    }
    expect(state.health?.bitrateHistory).toHaveLength(BITRATE_HISTORY_POINTS)
    const last = state.health?.bitrateHistory.at(-1)
    const withoutBitrate = reduceDashboardHealth(
      state,
      { sessionId: 's1', fps: 30, createdAt: at(10_000) },
      at(10_000)
    )
    expect(withoutBitrate.health?.bitrateHistory.at(-1)).toEqual(last)
    expect(withoutBitrate.health?.latest.fps).toBe(30)
  })

  it('records one failed and one recovered event per destination outage (S5)', () => {
    let state = reduceDashboardTargets(
      live(),
      { sessionId: 's1', targets: [target('live')] },
      at(1)
    )
    state = reduceDashboardTargets(
      state,
      { sessionId: 's1', targets: [target('failed', 'Twitch dropped the connection.')] },
      at(2)
    )
    // The same failure repeated is not a new event.
    state = reduceDashboardTargets(
      state,
      { sessionId: 's1', targets: [target('failed', 'Twitch dropped the connection.')] },
      at(3)
    )
    state = reduceDashboardTargets(
      state,
      { sessionId: 's1', targets: [target('connecting')] },
      at(4)
    )
    state = reduceDashboardTargets(state, { sessionId: 's1', targets: [target('live')] }, at(5))
    state = reduceDashboardTargets(state, { sessionId: 's1', targets: [target('live')] }, at(6))
    expect(
      state.destinationEvents.map(({ kind, targetId, message, at: eventAt }) => ({
        kind,
        targetId,
        message,
        at: eventAt
      }))
    ).toEqual([
      {
        kind: 'failed',
        targetId: 'twitch',
        message: 'Twitch dropped the connection.',
        at: at(2)
      },
      { kind: 'recovered', targetId: 'twitch', message: undefined, at: at(5) }
    ])
    expect(new Set(state.destinationEvents.map((event) => event.id)).size).toBe(2)
    // A destination that was never failed never "recovers".
    const fresh = reduceDashboardTargets(
      live(),
      { sessionId: 's1', targets: [target('live')] },
      at(1)
    )
    expect(fresh.destinationEvents).toEqual([])
  })

  it('takes audience snapshots for the session only', () => {
    const state = reduceDashboardAudience(
      live(),
      {
        sessionId: 's1',
        platforms: [
          { platform: 'twitch', metric: 'followers', capability: 'available', total: 12 }
        ],
        updatedAt: at(3)
      },
      at(3)
    )
    expect(state.audience?.platforms[0].total).toBe(12)
  })
})

describe('dashboard push validation', () => {
  it('caches only a structurally valid state', () => {
    const state = live()
    expect(normalizeLiveDashboardState(state)).toBe(state)
    expect(normalizeLiveDashboardState(null)).toBeNull()
    expect(normalizeLiveDashboardState({ ...state, session: { state: 'hacked' } })).toBeNull()
    expect(normalizeLiveDashboardState({ ...state, targets: undefined })).toBeNull()
    expect(normalizeLiveDashboardState({ ...state, sessionId: 42 })).toBeNull()
  })
})

describe('dashboard push coalescing', () => {
  it('sends the first change at once and at most one trailing push per second', () => {
    vi.useFakeTimers()
    try {
      const pushes: string[] = []
      const coalescer = createDashboardPushCoalescer((state) => pushes.push(state.updatedAt))
      coalescer.schedule(emptyLiveDashboardState('a'))
      coalescer.schedule(emptyLiveDashboardState('b'))
      coalescer.schedule(emptyLiveDashboardState('c'))
      expect(pushes).toEqual(['a'])
      vi.advanceTimersByTime(999)
      expect(pushes).toEqual(['a'])
      vi.advanceTimersByTime(1)
      expect(pushes).toEqual(['a', 'c'])
      coalescer.schedule(emptyLiveDashboardState('d'))
      coalescer.flush()
      expect(pushes).toEqual(['a', 'c', 'd'])
      coalescer.schedule(emptyLiveDashboardState('e'))
      coalescer.dispose()
      vi.advanceTimersByTime(5_000)
      expect(pushes).toEqual(['a', 'c', 'd'])
    } finally {
      vi.useRealTimers()
    }
  })
})
