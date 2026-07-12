import type {
  CompositorFrameReady,
  CompositorStatus,
  RecordingStatus,
  ServerEvent,
  ServerResponse
} from '../shared/backend'
import {
  parseBackendWireMessage,
  validateBackendEventPayload,
  validateBackendRpcResult,
  validateCompositorFrameReadyPayload
} from '../shared/backend-rpc-contract'

/** The privileged main-process socket uses the same bounded wire contract as the renderer. */
export function parseMainBackendWireMessage(raw: string): ServerResponse | ServerEvent {
  const message = parseBackendWireMessage(raw)
  if ('id' in message) return message
  return {
    event: message.event,
    payload:
      message.event === 'preview.frameReady'
        ? validateCompositorFrameReadyPayload(message.payload)
        : validateBackendEventPayload(message.event, message.payload)
  }
}

export function parseMainRecordingStatus(payload: unknown): RecordingStatus {
  return validateBackendRpcResult('recording.status', payload) as RecordingStatus
}

export function parseMainRecordingStatusEvent(payload: unknown): RecordingStatus {
  return validateBackendEventPayload('recording.status', payload) as RecordingStatus
}

export function parseMainCompositorStatusEvent(payload: unknown): CompositorStatus {
  return validateBackendEventPayload('compositor.status', payload) as CompositorStatus
}

export function parseMainCompositorFrameReadyEvent(payload: unknown): CompositorFrameReady {
  return validateCompositorFrameReadyPayload(payload)
}
