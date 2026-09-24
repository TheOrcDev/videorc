import type {
  AudienceSnapshot,
  RecordingStatus,
  StreamHealth,
  StreamTargetsSnapshot,
  ViewerSample
} from '@/lib/backend'
import type { BackendClient } from '@/backendClient'

import {
  createDashboardPushCoalescer,
  emptyLiveDashboardState,
  mergeDashboardViewerHistory,
  reduceDashboardAudience,
  reduceDashboardHealth,
  reduceDashboardRecording,
  reduceDashboardTargets,
  reduceDashboardViewers,
  type LiveDashboardState
} from '../../../shared/live-dashboard'

/** The backend events the dashboard folds (plan 053, D7). */
export type DashboardEvent =
  | 'recording.status'
  | 'stream.viewers'
  | 'stream.audience'
  | 'stream.health'
  | 'stream.targets'

export interface LiveDashboardRelay {
  recording: (status: RecordingStatus) => void
  viewers: (sample: ViewerSample | null) => void
  audience: (snapshot: AudienceSnapshot) => void
  health: (health: StreamHealth) => void
  targets: (snapshot: StreamTargetsSnapshot) => void
  /** Adopts main's cached state after a renderer reload mid-session. */
  seed: (state: LiveDashboardState | null) => void
  backfillViewers: (sessionId: string, samples: ViewerSample[]) => void
  current: () => LiveDashboardState
  dispose: () => void
}

/**
 * The main renderer's half of the Stream Manager relay (plan 053, S7): folds
 * backend events into one `LiveDashboardState` and pushes it to main at most
 * once a second. Nothing here renders; React state is never touched.
 */
export function createLiveDashboardRelay(
  push: (state: LiveDashboardState) => void,
  now: () => string = () => new Date().toISOString()
): LiveDashboardRelay {
  let state = emptyLiveDashboardState(now())
  const coalescer = createDashboardPushCoalescer(push)
  const apply = (next: LiveDashboardState): void => {
    if (next === state) return
    state = next
    coalescer.schedule(state)
  }
  return {
    recording: (status) => apply(reduceDashboardRecording(state, status, now())),
    viewers: (sample) => apply(reduceDashboardViewers(state, sample, now())),
    audience: (snapshot) => apply(reduceDashboardAudience(state, snapshot, now())),
    health: (health) => apply(reduceDashboardHealth(state, health, now())),
    targets: (snapshot) => apply(reduceDashboardTargets(state, snapshot, now())),
    seed: (seeded) => {
      if (!seeded || state.sessionId !== null) return
      state = seeded
    },
    backfillViewers: (sessionId, samples) =>
      apply(mergeDashboardViewerHistory(state, sessionId, samples, now())),
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
  const hydrate = (sessionId: string): void => {
    if (hydratedSessionId === sessionId) return
    hydratedSessionId = sessionId
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
    }
  }
  return { feed, dispose: () => relay.dispose() }
}
