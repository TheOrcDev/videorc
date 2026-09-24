import type {
  AudienceSnapshot,
  RecordingStatus,
  StreamHealth,
  StreamPlatform,
  StreamTargetRuntime,
  StreamTargetState,
  StreamTargetsSnapshot,
  ViewerSample
} from './backend'

/**
 * The Stream Manager's live data (plan 053, D7). The main renderer, which
 * owns the backend socket, builds it from `recording.status`,
 * `stream.viewers`, `stream.audience`, `stream.health` and `stream.targets`.
 * It pushes at most once a second to main, which caches the latest and
 * relays it to the window. History lives in the state, so a window opened
 * mid-stream starts with full sparklines.
 */
export interface LiveDashboardState {
  /** The session every other field describes; `null` when nothing is running. */
  sessionId: string | null
  session: LiveDashboardSession
  viewers: LiveDashboardViewers
  audience: AudienceSnapshot | null
  health: LiveDashboardHealth | null
  targets: StreamTargetRuntime[]
  /** Destination failures and recoveries this session, oldest first (S5). */
  destinationEvents: DestinationEvent[]
  updatedAt: string
}

export type LiveDashboardSessionState = 'off-air' | 'recording' | 'live'

export interface LiveDashboardSession {
  state: LiveDashboardSessionState
  startedAt: string | null
}

export interface ViewerHistoryPoint {
  at: string
  total: number
}

export interface LiveDashboardViewers {
  latest: ViewerSample | null
  /** The highest total this session. */
  peak: number | null
  /** Up to 60 minutes of totals, one point per 30-second sample. */
  history: ViewerHistoryPoint[]
}

export interface BitratePoint {
  at: string
  kbps: number
  /** Cumulative dropped frames when this point was taken. */
  droppedFrames?: number
}

export interface LiveDashboardHealth {
  latest: StreamHealth
  /** Up to 10 minutes of whole-output bitrate. */
  bitrateHistory: BitratePoint[]
}

export type DestinationEventKind = 'failed' | 'recovered'

export interface DestinationEvent {
  id: string
  kind: DestinationEventKind
  targetId: string
  platform: StreamPlatform
  label: string
  message?: string
  at: string
}

/** 60 minutes of 30-second viewer samples. */
export const VIEWER_HISTORY_POINTS = 120
export const VIEWER_HISTORY_WINDOW_MS = 60 * 60_000
/** Health arrives at most every 2 s; keep 10 minutes. */
export const BITRATE_HISTORY_WINDOW_MS = 10 * 60_000
export const BITRATE_HISTORY_POINTS = 300
/** Destination events kept per session. */
export const DESTINATION_EVENTS_LIMIT = 100

export function emptyLiveDashboardState(updatedAt: string): LiveDashboardState {
  return {
    sessionId: null,
    session: { state: 'off-air', startedAt: null },
    viewers: { latest: null, peak: null, history: [] },
    audience: null,
    health: null,
    targets: [],
    destinationEvents: [],
    updatedAt
  }
}

/** Every field of another session is dropped when a new session starts. */
function forSession(
  state: LiveDashboardState,
  sessionId: string,
  updatedAt: string
): LiveDashboardState {
  if (state.sessionId === sessionId) return state
  return { ...emptyLiveDashboardState(updatedAt), sessionId, session: state.session }
}

/** `null` for `starting` and `stopping`: the session keeps its last state. */
function sessionStateOf(status: RecordingStatus): LiveDashboardSessionState | null {
  if (status.state === 'streaming') return 'live'
  if (status.state === 'recording') return 'recording'
  if (status.state === 'idle' || status.state === 'failed') return 'off-air'
  return null
}

/**
 * `recording.status`. A terminal status keeps the finished session's data so
 * the window can show its summary; the next session replaces it.
 */
export function reduceDashboardRecording(
  state: LiveDashboardState,
  status: RecordingStatus,
  now: string
): LiveDashboardState {
  const sessionState = sessionStateOf(status)
  if (sessionState === null) return state
  if (sessionState === 'off-air') {
    if (state.session.state === 'off-air') return state
    return {
      ...state,
      session: { state: 'off-air', startedAt: state.session.startedAt },
      targets: [],
      updatedAt: now
    }
  }
  if (!status.sessionId) return state
  const scoped = forSession(state, status.sessionId, now)
  const startedAt = status.startedAt ?? scoped.session.startedAt ?? null
  if (scoped.session.state === sessionState && scoped.session.startedAt === startedAt) {
    return scoped
  }
  return { ...scoped, session: { state: sessionState, startedAt }, updatedAt: now }
}

function trimByWindow<T extends { at: string }>(
  points: T[],
  windowMs: number,
  limit: number,
  latestAt: string
): T[] {
  const cutoff = Date.parse(latestAt) - windowMs
  const kept = Number.isFinite(cutoff)
    ? points.filter((point) => {
        const at = Date.parse(point.at)
        return !Number.isFinite(at) || at >= cutoff
      })
    : points
  return kept.length > limit ? kept.slice(kept.length - limit) : kept
}

/** `stream.viewers`, or `null` when the session's chip should clear. */
export function reduceDashboardViewers(
  state: LiveDashboardState,
  sample: ViewerSample | null,
  now: string
): LiveDashboardState {
  if (!sample) {
    if (!state.viewers.latest) return state
    return { ...state, viewers: { ...state.viewers, latest: null }, updatedAt: now }
  }
  const scoped = forSession(state, sample.sessionId, now)
  const history = trimByWindow(
    [...scoped.viewers.history, { at: sample.at, total: sample.total }],
    VIEWER_HISTORY_WINDOW_MS,
    VIEWER_HISTORY_POINTS,
    sample.at
  )
  return {
    ...scoped,
    viewers: {
      latest: sample,
      peak: Math.max(scoped.viewers.peak ?? 0, sample.total),
      history
    },
    updatedAt: now
  }
}

/**
 * Backfills viewer history from `sessions.viewers.list` (a renderer reload
 * mid-stream). Points already held win; the peak covers the whole session.
 */
export function mergeDashboardViewerHistory(
  state: LiveDashboardState,
  sessionId: string,
  samples: ViewerSample[],
  now: string
): LiveDashboardState {
  if (state.sessionId !== sessionId || samples.length === 0) return state
  const known = new Set(state.viewers.history.map((point) => point.at))
  const merged = [
    ...samples
      .filter((sample) => sample.sessionId === sessionId && !known.has(sample.at))
      .map((sample) => ({ at: sample.at, total: sample.total })),
    ...state.viewers.history
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  const latestAt = merged.at(-1)?.at ?? now
  const peak = samples.reduce(
    (highest, sample) => Math.max(highest, sample.total),
    state.viewers.peak ?? 0
  )
  return {
    ...state,
    viewers: {
      ...state.viewers,
      peak: merged.length > 0 ? peak : state.viewers.peak,
      history: trimByWindow(merged, VIEWER_HISTORY_WINDOW_MS, VIEWER_HISTORY_POINTS, latestAt)
    },
    updatedAt: now
  }
}

export function reduceDashboardAudience(
  state: LiveDashboardState,
  snapshot: AudienceSnapshot,
  now: string
): LiveDashboardState {
  const scoped = forSession(state, snapshot.sessionId, now)
  return { ...scoped, audience: snapshot, updatedAt: now }
}

export function reduceDashboardHealth(
  state: LiveDashboardState,
  health: StreamHealth,
  now: string
): LiveDashboardState {
  const scoped = forSession(state, health.sessionId, now)
  const previous = scoped.health?.bitrateHistory ?? []
  const bitrateHistory =
    typeof health.bitrateKbps === 'number' && Number.isFinite(health.bitrateKbps)
      ? trimByWindow(
          [
            ...previous,
            {
              at: health.createdAt,
              kbps: health.bitrateKbps,
              ...(typeof health.droppedFrames === 'number'
                ? { droppedFrames: health.droppedFrames }
                : {})
            }
          ],
          BITRATE_HISTORY_WINDOW_MS,
          BITRATE_HISTORY_POINTS,
          health.createdAt
        )
      : previous
  return { ...scoped, health: { latest: health, bitrateHistory }, updatedAt: now }
}

const FAILED_STATES: ReadonlySet<StreamTargetState> = new Set(['failed'])
const HEALTHY_STATES: ReadonlySet<StreamTargetState> = new Set(['live'])

/**
 * `stream.targets`. A destination entering `failed` records one `failed`
 * event; its next `live` records one `recovered` (S5). Repeated snapshots in
 * the same state record nothing.
 */
export function reduceDashboardTargets(
  state: LiveDashboardState,
  snapshot: StreamTargetsSnapshot,
  now: string
): LiveDashboardState {
  const scoped = forSession(state, snapshot.sessionId, now)
  const previous = new Map(scoped.targets.map((target) => [target.targetId, target]))
  const failedBefore = new Set(
    scoped.destinationEvents.reduce<string[]>((failed, event) => {
      const index = failed.indexOf(event.targetId)
      if (event.kind === 'failed' && index < 0) failed.push(event.targetId)
      if (event.kind === 'recovered' && index >= 0) failed.splice(index, 1)
      return failed
    }, [])
  )
  const events: DestinationEvent[] = []
  for (const target of snapshot.targets) {
    const before = previous.get(target.targetId)
    if (FAILED_STATES.has(target.state) && before?.state !== target.state) {
      if (!failedBefore.has(target.targetId)) {
        events.push(destinationEvent('failed', target, now, scoped.destinationEvents.length))
      }
    } else if (HEALTHY_STATES.has(target.state) && failedBefore.has(target.targetId)) {
      events.push(destinationEvent('recovered', target, now, scoped.destinationEvents.length))
    }
  }
  const destinationEvents =
    events.length === 0
      ? scoped.destinationEvents
      : [...scoped.destinationEvents, ...events].slice(-DESTINATION_EVENTS_LIMIT)
  return { ...scoped, targets: snapshot.targets, destinationEvents, updatedAt: now }
}

function destinationEvent(
  kind: DestinationEventKind,
  target: StreamTargetRuntime,
  at: string,
  sequence: number
): DestinationEvent {
  return {
    id: `${target.targetId}:${kind}:${at}:${sequence}`,
    kind,
    targetId: target.targetId,
    platform: target.platform,
    label: target.label,
    ...(target.message ? { message: target.message } : {}),
    at
  }
}

const SESSION_STATES: ReadonlySet<string> = new Set(['off-air', 'recording', 'live'])

/**
 * A structural check of a pushed state before main caches it. The push comes
 * only from the main renderer (role-gated), so this guards shape, not trust.
 */
export function normalizeLiveDashboardState(value: unknown): LiveDashboardState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<LiveDashboardState>
  const session = state.session
  const viewers = state.viewers
  if (
    (state.sessionId !== null && typeof state.sessionId !== 'string') ||
    typeof state.updatedAt !== 'string' ||
    !session ||
    typeof session !== 'object' ||
    !SESSION_STATES.has(session.state) ||
    !viewers ||
    typeof viewers !== 'object' ||
    !Array.isArray(viewers.history) ||
    !Array.isArray(state.targets) ||
    !Array.isArray(state.destinationEvents)
  ) {
    return null
  }
  return state as LiveDashboardState
}

/**
 * Coalesces pushes to at most one per `intervalMs`: the first change goes
 * out at once, later ones as one trailing push with the latest state.
 */
export function createDashboardPushCoalescer(
  push: (state: LiveDashboardState) => void,
  intervalMs = 1_000,
  timers: {
    now: () => number
    setTimeout: (callback: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  } = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
): { schedule: (state: LiveDashboardState) => void; flush: () => void; dispose: () => void } {
  let lastPushAt = Number.NEGATIVE_INFINITY
  let pending: LiveDashboardState | null = null
  let timer: unknown = null
  const send = (): void => {
    timer = null
    if (!pending) return
    const state = pending
    pending = null
    lastPushAt = timers.now()
    push(state)
  }
  return {
    schedule(state) {
      pending = state
      if (timer !== null) return
      const wait = lastPushAt + intervalMs - timers.now()
      if (wait <= 0) {
        send()
        return
      }
      timer = timers.setTimeout(send, wait)
    },
    flush() {
      if (timer !== null) timers.clearTimeout(timer)
      send()
    },
    dispose() {
      if (timer !== null) timers.clearTimeout(timer)
      timer = null
      pending = null
    }
  }
}
