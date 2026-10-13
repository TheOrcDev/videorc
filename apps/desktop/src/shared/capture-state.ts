import type { RecordingState, RecordingStatus } from './backend'

export type MainCaptureState = RecordingState | 'unknown'

const ACTIVE_CAPTURE_STATES = new Set<RecordingState>([
  'starting',
  'recording',
  'streaming',
  'stopping'
])

export function isActiveRecordingState(state: RecordingState): boolean {
  return ACTIVE_CAPTURE_STATES.has(state)
}

/**
 * Whether the running session is on air (plan 095 S5). Go Live records too,
 * and the backend reports a record+stream session as `recording`: only a
 * stream-only session reads `streaming`. A running status carries `streamUrl`
 * exactly when the session streams.
 */
export function sessionIsLive(status: {
  state?: string | null
  streamUrl?: string | null
}): boolean {
  return status.state === 'streaming' || (status.state === 'recording' && Boolean(status.streamUrl))
}

/**
 * What a running session does, for the notices that describe it: `recording`
 * records only, `live-stream` streams only, and `record+stream` is Go Live's
 * default, on air and saving a file at once. The state alone calls that last
 * one `recording`, so this reads it through `sessionIsLive` (plan 174 B-6).
 */
export type SessionActivity = 'recording' | 'live-stream' | 'record+stream'

export function sessionActivity(status: {
  state?: string | null
  streamUrl?: string | null
}): SessionActivity {
  if (!sessionIsLive(status)) {
    return 'recording'
  }
  return status.state === 'streaming' ? 'live-stream' : 'record+stream'
}

export function captureStateBlocksInterruption(
  state: MainCaptureState,
  backendConnected: boolean
): boolean {
  return backendConnected && (state === 'unknown' || isActiveRecordingState(state))
}

export function recordingStateFromPayload(payload: unknown): RecordingState | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const status = payload as Partial<RecordingStatus>
  const state = status.state
  if (
    typeof state !== 'string' ||
    !['idle', 'starting', 'recording', 'streaming', 'stopping', 'failed'].includes(state)
  ) {
    return null
  }
  // Plan 181: a buffer-only session writes nothing permanent, so it blocks
  // no quit, update or permission restart; main reads it as idle.
  return sessionIsReplayOnly(status) ? 'idle' : (state as RecordingState)
}

/** The session exists only for the replay buffer (plan 181): no file, no
 * stream. The Studio keeps its live controls on it, but no surface calls it
 * "Recording" and the transport still offers Record and Go Live. */
export function sessionIsReplayOnly(status: { replayOnly?: boolean } | null | undefined): boolean {
  return status?.replayOnly === true
}

/** A running session that owns the transport: active and not buffer-only. */
export function sessionOwnsTransport(status: {
  state?: string | null
  replayOnly?: boolean
}): boolean {
  return (
    typeof status.state === 'string' &&
    isActiveRecordingState(status.state as RecordingState) &&
    !sessionIsReplayOnly(status)
  )
}

/** A malformed status is not evidence of idleness. Fail closed until a valid
 * backend status arrives. */
export function captureStateAfterStatusPayload(payload: unknown): MainCaptureState {
  return recordingStateFromPayload(payload) ?? 'unknown'
}

/**
 * Main's own reading of "on air" from a `recording.status` payload (plan 174
 * S3.1, D2): quitting or closing the main window while a livestream runs asks
 * first, so main needs the fact without a round trip. A malformed status is
 * not on air: there is nothing a question could protect.
 */
export function livestreamOnAirFromPayload(payload: unknown): boolean {
  const state = recordingStateFromPayload(payload)
  if (!state) {
    return false
  }
  const streamUrl = (payload as Partial<RecordingStatus>).streamUrl
  return sessionIsLive({ state, streamUrl: typeof streamUrl === 'string' ? streamUrl : null })
}

/** Losing the main-process event socket invalidates the last sampled status,
 * even while the backend process itself remains connected. */
export function captureStateAfterTransportLoss(): MainCaptureState {
  return 'unknown'
}
