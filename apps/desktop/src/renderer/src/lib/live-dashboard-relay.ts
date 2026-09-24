import type {
  AudienceSnapshot,
  RecordingStatus,
  StreamHealth,
  StreamTargetsSnapshot,
  ViewerSample
} from '@/lib/backend'

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
