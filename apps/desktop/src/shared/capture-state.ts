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
