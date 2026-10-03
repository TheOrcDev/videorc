import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionChatTotals } from '@/lib/backend'
import type { BackendClient } from '@/backendClient'
import { emptyLiveDashboardState } from '../../../shared/live-dashboard'
import { createLiveDashboardRelay, startLiveDashboardRelay } from './live-dashboard-relay'

const at = '2026-10-03T00:00:00.000Z'
const totals = (
  sessionId: string,
  revision = 0
): Extract<SessionChatTotals, { status: 'available' }> => ({
  status: 'available',
  sessionId,
  revision,
  messageCount: revision,
  chatters: revision,
  platforms: ['twitch'],
  supporters: revision,
  follows: 0,
  bits: 0,
  tips: [],
  raids: 0
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('confirmed session chat totals relay', () => {
  it('retains only validated newest pending totals and never lets telemetry select the owner', () => {
    const relay = createLiveDashboardRelay(
      () => undefined,
      () => at
    )
    try {
      relay.chatTotals(totals('b', 8))
      relay.chatTotals(totals('b', 2))
      expect(relay.current().sessionId).toBeNull()
      expect(() => relay.chatTotals({ ...totals('b'), revision: Infinity })).toThrow()
      relay.recording({ state: 'recording', sessionId: 'b', startedAt: at })
      expect(relay.current().chatTotals).toEqual(totals('b', 8))
      relay.audience({ sessionId: 'a', updatedAt: at, platforms: [] })
      relay.viewers({ sessionId: 'a', at, total: 99, platforms: [] })
      relay.health({ sessionId: 'a', createdAt: at, bitrateKbps: 10, fps: 30, droppedFrames: 0 })
      relay.targets({ sessionId: 'a', targets: [] })
      relay.chatTotals(totals('a', 99))
      expect(relay.current().sessionId).toBe('b')
      expect(relay.current().chatTotals).toEqual(totals('b', 8))
      relay.recording({ state: 'idle', sessionId: 'a' })
      expect(relay.current().session.state).toBe('recording')
      relay.recording({ state: 'idle', sessionId: 'b' })
      expect(relay.current().chatTotals).toEqual(totals('b', 8))
      relay.recording({ state: 'recording', sessionId: 'c', startedAt: at })
      expect(relay.current().chatTotals).toBeNull()
    } finally {
      relay.dispose()
    }
  })

  it('keeps cached data on reopen but requires recording confirmation before pending adoption', () => {
    const relay = createLiveDashboardRelay(
      () => undefined,
      () => at
    )
    try {
      relay.seed({ ...emptyLiveDashboardState(at), sessionId: 'a', chatTotals: totals('a', 6) })
      relay.chatTotals(totals('a', 8))
      relay.recording({ state: 'idle' })
      expect(relay.current().chatTotals).toEqual(totals('a', 6))
      relay.chatTotals(totals('a', 8))
      relay.recording({ state: 'recording', sessionId: 'a', startedAt: at })
      expect(relay.current().chatTotals).toEqual(totals('a', 8))
    } finally {
      relay.dispose()
    }
  })

  it('bounds lag hydration and rejects older replies after events or session replacement', async () => {
    vi.useFakeTimers()
    const a = deferred<SessionChatTotals>()
    const b = deferred<SessionChatTotals>()
    const pushed: import('../../../shared/live-dashboard').LiveDashboardState[] = []
    vi.stubGlobal('window', {
      videorc: {
        getDashboard: async () => null,
        pushDashboard: async (state: (typeof pushed)[number]) => {
          pushed.push(state)
        }
      }
    })
    const requestTyped = vi.fn((method: string, params?: { sessionId: string }) => {
      if (method === 'sessions.comments.totals')
        return params?.sessionId === 'a' ? a.promise : b.promise
      if (method === 'sessions.viewers.list') return Promise.resolve({ samples: [] })
      return Promise.resolve(null)
    })
    const relay = await startLiveDashboardRelay({
      client: { requestTyped } as unknown as BackendClient,
      isCurrent: () => true
    })
    try {
      relay.feed('recording.status', { state: 'recording', sessionId: 'a', startedAt: at })
      relay.feed('liveChat.totals', totals('a', 8))
      await vi.advanceTimersByTimeAsync(1000)
      expect(pushed.at(-1)?.chatTotals).toEqual(totals('a', 8))
      relay.feed('recording.status', { state: 'recording', sessionId: 'b', startedAt: at })
      for (let index = 0; index < 100; index++) relay.feed('events.lagged', { skipped: 1 })
      expect(
        requestTyped.mock.calls.filter(([method]) => method === 'sessions.comments.totals')
      ).toHaveLength(1)
      a.resolve(totals('a', 2))
      await vi.advanceTimersByTimeAsync(1000)
      expect(pushed.at(-1)?.sessionId).toBe('b')
      expect(pushed.at(-1)?.chatTotals).toBeNull()
      expect(
        requestTyped.mock.calls.filter(([method]) => method === 'sessions.comments.totals')
      ).toHaveLength(2)
      relay.feed('liveChat.totals', totals('b', 9))
      b.resolve(totals('b', 4))
      await vi.advanceTimersByTimeAsync(1000)
      expect(pushed.at(-1)?.chatTotals).toEqual(totals('b', 9))
    } finally {
      relay.dispose()
    }
  })
})
