import type { MainCaptureState } from '../shared/capture-state'
import { isActiveRecordingState } from '../shared/capture-state'

export type DeferredPermissionRestartState = {
  pendingReason: string | null
}

export type DeferredPermissionRestartDecision = {
  state: DeferredPermissionRestartState
  runReason: string | null
}

export const idleDeferredPermissionRestartState: DeferredPermissionRestartState = {
  pendingReason: null
}

export function requestPermissionRestart(
  state: DeferredPermissionRestartState,
  captureState: MainCaptureState,
  reason: string
): DeferredPermissionRestartDecision {
  if (captureState === 'unknown' || isActiveRecordingState(captureState)) {
    return {
      state: { pendingReason: state.pendingReason ?? reason },
      runReason: null
    }
  }
  return {
    state: { pendingReason: null },
    runReason: reason
  }
}

export function flushPermissionRestart(
  state: DeferredPermissionRestartState,
  captureState: MainCaptureState
): DeferredPermissionRestartDecision {
  if (!state.pendingReason || captureState === 'unknown' || isActiveRecordingState(captureState)) {
    return { state, runReason: null }
  }
  return {
    state: { pendingReason: null },
    runReason: state.pendingReason
  }
}
