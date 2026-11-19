import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudStatus, SessionChatTotals } from '@/lib/backend'
import type { BackendClient } from '@/backendClient'
import { emptyLiveDashboardState } from '../../../shared/live-dashboard'
import { createLiveDashboardRelay, startLiveDashboardRelay } from './live-dashboard-relay'
import { statItems } from './stream-manager-stats'

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

// A managed talk show on 0.32.1 (2026-11-19): the show was live with Twitch
// chat and viewers, and the Stream Manager's header read "Off air" because the
// dashboard only folded native `recording.status`, which a room never sends.
describe('talk show room as the session', () => {
  const show = 'sh_talk'
  const twitch = {
    targetId: 'twitch-1',
    platform: 'twitch' as const,
    label: 'Twitch',
    state: 'live' as const
  }
  const cloud = (
    room: Partial<NonNullable<CloudStatus['room']>> | null,
    extra: Partial<CloudStatus> = {}
  ): CloudStatus => ({
    phase: 'live',
    entitled: true,
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [300] },
    show: { id: show, nodeId: 'eu-1', resumable: false, kind: 'talk' },
    connected: true,
    directFallbackAvailable: false,
    ...(room
      ? {
          room: {
            phase: 'open',
            doorOpen: false,
            declinedCount: 0,
            stage: { layout: 'solo', onStage: [] },
            hostAway: false,
            connected: true,
            client: 'connected',
            returnEnabled: false,
            stageSet: false,
            live: false,
            ...room
          }
        }
      : {}),
    ...extra
  })
  const sample = (sessionId: string, total: number) => ({
    sessionId,
    at,
    total,
    platforms: [{ platform: 'twitch' as const, count: total }]
  })

  it('reads a live room as on air under the show id, with its viewers and legs', () => {
    const relay = createLiveDashboardRelay(
      () => undefined,
      () => at
    )
    try {
      relay.recording({ state: 'idle' })
      relay.cloud(cloud({ live: true, liveSince: '2026-10-02T23:50:00.000Z' }, { legs: [twitch] }))
      expect(relay.current().sessionId).toBe(show)
      expect(relay.current().session).toEqual({
        state: 'live',
        startedAt: '2026-10-02T23:50:00.000Z'
      })
      expect(relay.current().targets).toEqual([twitch])
      // No native status speaks for the room, and its end of a native
      // session never clears the show's count.
      relay.viewers(sample(show, 8))
      relay.recording({ state: 'idle' })
      relay.viewers(null)
      relay.recording({ state: 'recording', sessionId: 'native', startedAt: at, replayOnly: true })
      expect(relay.current().session.state).toBe('live')
      expect(relay.current().viewers.latest?.total).toBe(8)
      const [session, viewers] = statItems({
        sessionId: show,
        dashboard: relay.current(),
        viewerSample: null,
        messages: [],
        providers: [],
        nowMs: Date.parse(at)
      })
      expect(session).toMatchObject({ badge: 'live', value: '10:00' })
      expect(viewers).toMatchObject({ id: 'viewers', value: '8' })
    } finally {
      relay.dispose()
    }
  })

  it('takes the runner clock once when there is no hand-over stamp', () => {
    let now = at
    const relay = createLiveDashboardRelay(
      () => undefined,
      () => now
    )
    try {
      relay.cloud(cloud({ live: true }, { liveSeconds: 60 }))
      expect(relay.current().session.startedAt).toBe('2026-10-02T23:59:00.000Z')
      now = '2026-10-03T00:00:01.400Z'
      relay.cloud(cloud({ live: true }, { liveSeconds: 61 }))
      expect(relay.current().session.startedAt).toBe('2026-10-02T23:59:00.000Z')
    } finally {
      relay.dispose()
    }
  })

  it('follows the cloud recording, End livestream and the room closing', () => {
    const relay = createLiveDashboardRelay(
      () => undefined,
      () => at
    )
    try {
      relay.chatTotals(totals(show, 4))
      relay.cloud(cloud({}, { recording: { active: true, since: at, seconds: 1, bytes: 1 } }))
      expect(relay.current().session).toEqual({ state: 'recording', startedAt: at })
      expect(relay.current().chatTotals).toEqual(totals(show, 4))
      relay.viewers(sample(show, 3))
      // An open room with nothing running is off air, and its count clears.
      relay.cloud(cloud({}))
      expect(relay.current().session.state).toBe('off-air')
      expect(relay.current().viewers.latest).toBeNull()
      relay.recording({ state: 'recording', sessionId: 'native', startedAt: at })
      expect(relay.current().session.state).toBe('off-air')
      // The room closed: native sessions own the window again.
      relay.cloud(cloud({ phase: 'closed' }))
      relay.recording({ state: 'recording', sessionId: 'native', startedAt: at })
      expect(relay.current().sessionId).toBe('native')
      expect(relay.current().session.state).toBe('recording')
    } finally {
      relay.dispose()
    }
  })

  it('reads the show once on start and hydrates its totals', async () => {
    vi.useFakeTimers()
    const pushed: import('../../../shared/live-dashboard').LiveDashboardState[] = []
    vi.stubGlobal('window', {
      videorc: {
        getDashboard: async () => null,
        pushDashboard: async (state: (typeof pushed)[number]) => {
          pushed.push(state)
        }
      }
    })
    const requestTyped = vi.fn((method: string) => {
      if (method === 'cloud.status') return Promise.resolve(cloud({ live: true, liveSince: at }))
      if (method === 'sessions.comments.totals') return Promise.resolve(totals(show, 5))
      if (method === 'sessions.viewers.list') return Promise.resolve({ samples: [] })
      return Promise.resolve(null)
    })
    const relay = await startLiveDashboardRelay({
      client: { requestTyped } as unknown as BackendClient,
      isCurrent: () => true
    })
    try {
      await vi.advanceTimersByTimeAsync(1000)
      expect(pushed.at(-1)?.sessionId).toBe(show)
      expect(pushed.at(-1)?.session.state).toBe('live')
      expect(pushed.at(-1)?.chatTotals).toEqual(totals(show, 5))
      expect(requestTyped).toHaveBeenCalledWith('sessions.comments.totals', { sessionId: show })
    } finally {
      relay.dispose()
    }
  })
})
