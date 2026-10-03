import type {
  AudienceSnapshot,
  RecordingStatus,
  StreamHealth,
  StreamTargetsSnapshot,
  ViewerSample,
  SessionChatTotals
} from '@/lib/backend'
import type { BackendClient } from '@/backendClient'
import { sessionChatTotalsSchema } from '../../../shared/session-chat-totals'

import {
  createDashboardPushCoalescer,
  emptyLiveDashboardState,
  mergeDashboardViewerHistory,
  reduceDashboardAudience,
  reduceDashboardHealth,
  reduceDashboardRecording,
  reduceDashboardTargets,
  reduceDashboardViewers,
  reduceDashboardChatTotals,
  normalizeLiveDashboardState,
  type LiveDashboardState
} from '../../../shared/live-dashboard'

/** The backend events the dashboard folds (plan 055, D7). */
export type DashboardEvent =
  | 'recording.status'
  | 'stream.viewers'
  | 'stream.audience'
  | 'stream.health'
  | 'stream.targets'
  | 'liveChat.totals'
  | 'events.lagged'

export interface LiveDashboardRelay {
  recording: (status: RecordingStatus) => void
  viewers: (sample: ViewerSample | null) => void
  audience: (snapshot: AudienceSnapshot) => void
  health: (health: StreamHealth) => void
  targets: (snapshot: StreamTargetsSnapshot) => void
  chatTotals: (totals: SessionChatTotals) => void
  /** Adopts main's cached state after a renderer reload mid-session. */
  seed: (state: LiveDashboardState | null) => void
  backfillViewers: (sessionId: string, samples: ViewerSample[]) => void
  current: () => LiveDashboardState
  dispose: () => void
}

/**
 * The main renderer's half of the Stream Manager relay (plan 055, S7): folds
 * backend events into one `LiveDashboardState` and pushes it to main at most
 * once a second. Nothing here renders; React state is never touched.
 */
export function createLiveDashboardRelay(
  push: (state: LiveDashboardState) => void,
  now: () => string = () => new Date().toISOString()
): LiveDashboardRelay {
  let state = emptyLiveDashboardState(now())
  let confirmedSessionId: string | null = null
  let pendingTotals: SessionChatTotals | null = null
  const coalescer = createDashboardPushCoalescer(push)
  const apply = (next: LiveDashboardState): void => {
    if (next === state) return
    state = next
    coalescer.schedule(state)
  }
  return {
    recording: (status) => {
      if (
        status.sessionId &&
        (status.state === 'idle' || status.state === 'failed') &&
        confirmedSessionId &&
        status.sessionId !== confirmedSessionId
      )
        return
      if (status.sessionId && (status.state === 'recording' || status.state === 'streaming'))
        confirmedSessionId = status.sessionId
      apply(reduceDashboardRecording(state, status, now()))
      if (pendingTotals?.sessionId === confirmedSessionId)
        apply(reduceDashboardChatTotals(state, pendingTotals, now()))
      pendingTotals = null
    },
    viewers: (sample) => {
      if (!sample || sample.sessionId === confirmedSessionId)
        apply(reduceDashboardViewers(state, sample, now()))
    },
    audience: (snapshot) => {
      if (snapshot.sessionId === confirmedSessionId)
        apply(reduceDashboardAudience(state, snapshot, now()))
    },
    health: (health) => {
      if (health.sessionId === confirmedSessionId)
        apply(reduceDashboardHealth(state, health, now()))
    },
    targets: (snapshot) => {
      if (snapshot.sessionId === confirmedSessionId)
        apply(reduceDashboardTargets(state, snapshot, now()))
    },
    chatTotals: (totals) => {
      sessionChatTotalsSchema.parse(totals)
      if (totals.sessionId !== confirmedSessionId) {
        if (
          pendingTotals?.sessionId === totals.sessionId &&
          pendingTotals.status === 'available' &&
          (totals.status !== 'available' || totals.revision <= pendingTotals.revision)
        )
          return
        pendingTotals = totals
        return
      }
      apply(reduceDashboardChatTotals(state, totals, now()))
    },
    seed: (seeded) => {
      if (!seeded || state.sessionId !== null || !normalizeLiveDashboardState(seeded)) return
      state = seeded
    },
    backfillViewers: (sessionId, samples) => {
      if (sessionId === confirmedSessionId)
        apply(mergeDashboardViewerHistory(state, sessionId, samples, now()))
    },
    current: () => state,
    dispose: () => coalescer.dispose()
  }
}

/**
 * Starts the relay for one backend connection: seeds from main's cache (a
 * renderer reload mid-stream keeps its history), then returns the feed
 * Studio forwards events to. The first time a session is seen on air it
 * backfills viewer history and the audience snapshot from the backend.
 */
export async function startLiveDashboardRelay({
  client,
  isCurrent
}: {
  client: BackendClient
  isCurrent: () => boolean
}): Promise<{ feed: (event: DashboardEvent, payload: unknown) => void; dispose: () => void }> {
  const relay = createLiveDashboardRelay((state) => {
    if (isCurrent()) void window.videorc?.pushDashboard?.(state)
  })
  relay.seed((await window.videorc?.getDashboard?.().catch(() => null)) ?? null)
  let hydratedSessionId: string | null = null
  let totalsRequest: Promise<void> | null = null
  let queuedTotalsSession: string | null = null
  const refreshTotals = (sessionId: string): void => {
    if (totalsRequest) {
      queuedTotalsSession = sessionId
      return
    }
    totalsRequest = client
      .requestTyped('sessions.comments.totals', { sessionId })
      .then(
        (totals) => {
          if (
            isCurrent() &&
            totals?.sessionId === sessionId &&
            relay.current().sessionId === sessionId
          )
            relay.chatTotals(totals)
        },
        () => undefined
      )
      .finally(() => {
        totalsRequest = null
        const next = queuedTotalsSession
        queuedTotalsSession = null
        if (isCurrent() && next && relay.current().sessionId === next) refreshTotals(next)
      })
  }
  const hydrate = (sessionId: string): void => {
    if (hydratedSessionId === sessionId) return
    hydratedSessionId = sessionId
    refreshTotals(sessionId)
    void client.requestTyped('sessions.viewers.list', { sessionId }).then(
      (page) => isCurrent() && relay.backfillViewers(sessionId, page.samples),
      () => undefined
    )
    void client.requestTyped('stream.audience.snapshot').then(
      (snapshot) => isCurrent() && snapshot?.sessionId === sessionId && relay.audience(snapshot),
      () => undefined
    )
  }
  const feed = (event: DashboardEvent, payload: unknown): void => {
    switch (event) {
      case 'recording.status': {
        const status = payload as RecordingStatus
        relay.recording(status)
        if (status.sessionId && (status.state === 'recording' || status.state === 'streaming')) {
          hydrate(status.sessionId)
        }
        return
      }
      case 'stream.viewers':
        relay.viewers(payload as ViewerSample | null)
        return
      case 'stream.audience':
        relay.audience(payload as AudienceSnapshot)
        return
      case 'stream.health':
        relay.health(payload as StreamHealth)
        return
      case 'stream.targets':
        relay.targets(payload as StreamTargetsSnapshot)
        return
      case 'liveChat.totals':
        relay.chatTotals(payload as SessionChatTotals)
        return
      case 'events.lagged': {
        const sessionId = relay.current().sessionId
        if (sessionId) refreshTotals(sessionId)
      }
    }
  }
  return { feed, dispose: () => relay.dispose() }
}
