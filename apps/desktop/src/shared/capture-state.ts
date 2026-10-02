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
  const state = (payload as Partial<RecordingStatus>).state
  return typeof state === 'string' &&
    ['idle', 'starting', 'recording', 'streaming', 'stopping', 'failed'].includes(state)
    ? (state as RecordingState)
    : null
}

/** A malformed status is not evidence of idleness. Fail closed until a valid
 * backend status arrives. */
export function captureStateAfterStatusPayload(payload: unknown): MainCaptureState {
  return recordingStateFromPayload(payload) ?? 'unknown'
}

/** Losing the main-process event socket invalidates the last sampled status,
 * even while the backend process itself remains connected. */
export function captureStateAfterTransportLoss(): MainCaptureState {
  return 'unknown'
}
