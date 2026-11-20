import type {
  AudienceSnapshot,
  CloudStatus,
  RecordingStatus,
  StreamHealth,
  StreamTargetsSnapshot,
  ViewerSample,
  SessionChatTotals,
  WatchdogAlertsView
} from '@/lib/backend'
import type { BackendClient } from '@/backendClient'
import { sessionIsLive, sessionIsReplayOnly } from '../../../shared/capture-state'
import { sessionChatTotalsSchema } from '../../../shared/session-chat-totals'
import { talkShowLiveStartedAt, talkShowSessionView } from './talk-show-session'

import {
  createDashboardPushCoalescer,
  emptyLiveDashboardState,
  mergeDashboardViewerHistory,
  reduceDashboardAudience,
  reduceDashboardAlerts,
  reduceDashboardCloud,
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
  | 'cloud.state'
  | 'watchdog.alerts'
  | 'events.lagged'

export interface LiveDashboardRelay {
  recording: (status: RecordingStatus) => void
  viewers: (sample: ViewerSample | null) => void
  audience: (snapshot: AudienceSnapshot) => void
  health: (health: StreamHealth) => void
  targets: (snapshot: StreamTargetsSnapshot) => void
  chatTotals: (totals: SessionChatTotals) => void
  /** The Videorc Cloud show carrying the session, if any (plan 184 C7). */
  cloud: (status: CloudStatus) => void
  /** Plan 223 A6: the watchdog's open alerts for the chip. */
  alerts: (view: WatchdogAlertsView) => void
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
/**
 * The session the window manages: a recording or a livestream, never a
 * buffer-only session (plan 181), which has no viewers, chat or targets.
 */
function sessionRunsForTheWindow(status: RecordingStatus): boolean {
  return (
    (status.state === 'recording' || status.state === 'streaming') && !sessionIsReplayOnly(status)
  )
}

/**
 * A talk show's session as the window folds it (plan 224 C-G6), or null when
 * no room is open and native sessions speak for themselves. While the room is
 * open the cloud owns the session: Record goes to the cloud recording and Go
 * Live hands the destinations to the runner, so no native `recording.status`
 * ever says the show is on air. The room reads as the status the Studio's
 * transport already shows, keyed on the show id (the chat's session, the
 * viewer samples' and the totals'); an open room with nothing running is off
 * air. The on-air start is the hand-over stamp, else the runner's clock taken
 * once, so the header's clock never jitters with a status tick.
 */
export function talkShowDashboardStatus(
  status: CloudStatus,
  current: LiveDashboardState,
  nowMs: number
): RecordingStatus | null {
  const room = status.room
  if (!room || room.phase === 'closed') return null
  const view = talkShowSessionView(status, null)
  if (!view) return { state: 'idle' }
  if (view.state !== 'streaming') return view
  const kept =
    !room.liveSince && current.sessionId === view.sessionId && current.session.state === 'live'
      ? current.session.startedAt
      : null
  return { ...view, startedAt: kept ?? talkShowLiveStartedAt(status, nowMs) }
}

export function createLiveDashboardRelay(
  push: (state: LiveDashboardState) => void,
  now: () => string = () => new Date().toISOString()
): LiveDashboardRelay {
  let state = emptyLiveDashboardState(now())
  let confirmedSessionId: string | null = null
  let pendingTotals: SessionChatTotals | null = null
  // Plan 224: an open talk-show room owns the session (`talkShowDashboardStatus`).
  let roomOwnsSession = false
  const coalescer = createDashboardPushCoalescer(push)
  const apply = (next: LiveDashboardState): void => {
    if (next === state) return
    state = next
    coalescer.schedule(state)
  }
  return {
    recording: (status) => {
      // The room's projection is the session; a native status speaks for nothing.
      if (roomOwnsSession) return
      if (
        status.sessionId &&
        (status.state === 'idle' || status.state === 'failed') &&
        confirmedSessionId &&
        status.sessionId !== confirmedSessionId
      )
        return
      // A buffer-only session (plan 181) is never the one the window manages.
      if (status.sessionId && sessionRunsForTheWindow(status)) confirmedSessionId = status.sessionId
      apply(reduceDashboardRecording(state, status, now()))
      if (pendingTotals?.sessionId === confirmedSessionId)
        apply(reduceDashboardChatTotals(state, pendingTotals, now()))
      pendingTotals = null
    },
    viewers: (sample) => {
      // A native session's end clears the count; the room clears its own.
      if (sample ? sample.sessionId === confirmedSessionId : !roomOwnsSession)
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
    cloud: (status) => {
      const at = now()
      const room = talkShowDashboardStatus(status, state, Date.parse(at))
      if (room) {
        roomOwnsSession = true
        const wasOnAir = state.session.state !== 'off-air'
        if (room.sessionId && sessionRunsForTheWindow(room)) confirmedSessionId = room.sessionId
        apply(reduceDashboardRecording(state, room, at))
        if (wasOnAir && state.session.state === 'off-air')
          apply(reduceDashboardViewers(state, null, at))
        if (confirmedSessionId && pendingTotals?.sessionId === confirmedSessionId) {
          apply(reduceDashboardChatTotals(state, pendingTotals, at))
          pendingTotals = null
        }
        // The runner's legs are the show's destinations (the Activity pane's
        // failures and recoveries); nothing sends `stream.targets` for them.
        if (
          room.sessionId &&
          sessionIsLive(room) &&
          status.legs &&
          JSON.stringify(status.legs) !== JSON.stringify(state.targets)
        )
          apply(
            reduceDashboardTargets(state, { sessionId: room.sessionId, targets: status.legs }, at)
          )
      } else if (roomOwnsSession) {
        roomOwnsSession = false
        apply(reduceDashboardRecording(state, { state: 'idle' }, at))
        apply(reduceDashboardViewers(state, null, at))
      }
      apply(reduceDashboardCloud(state, status, at))
    },
    alerts: (view) => apply(reduceDashboardAlerts(state, view, now())),
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
  let cloudStateSeen = false
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
        if (status.sessionId && sessionRunsForTheWindow(status)) {
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
      case 'cloud.state': {
        const status = payload as CloudStatus | null
        if (!status) return
        cloudStateSeen = true
        relay.cloud(status)
        const { sessionId, session } = relay.current()
        const showId = status.show?.id
        // Plan 254 S4: a show handed to another device, or off air, is read
        // again when this computer has it back (Continue here, or the next
        // Go Live): its viewers, audience and totals, with no manual step.
        if (status.stoppedBy || session.state === 'off-air') {
          if (showId && hydratedSessionId === showId) hydratedSessionId = null
          return
        }
        // A talk show on air or recording: its history and totals, once.
        if (sessionId && sessionId === showId) hydrate(sessionId)
        return
      }
      case 'watchdog.alerts':
        relay.alerts(payload as WatchdogAlertsView)
        return
      case 'events.lagged': {
        const sessionId = relay.current().sessionId
        if (sessionId) refreshTotals(sessionId)
      }
    }
  }
  // A reload mid-show: `cloud.state` fires on the show's next change, which
  // can be a while; until then the room's session would read off air.
  void client.requestTyped('cloud.status').then(
    (status) => {
      if (isCurrent() && !cloudStateSeen) feed('cloud.state', status)
    },
    () => undefined
  )
  return { feed, dispose: () => relay.dispose() }
}
