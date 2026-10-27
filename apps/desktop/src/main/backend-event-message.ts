import type {
  Banner,
  CompositorFrameReady,
  CompositorStatus,
  OverlayLayout,
  PreviewSurfaceStatus,
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

/**
 * Feeds whose bad payload must never retire the main socket: that socket also
 * carries capture state and the preview present pump. Their payloads pass
 * through unvalidated here and their handler validates them at use, dropping
 * a bad one with a warning (plan 186: the banner list for the proof surface).
 */
export const MAIN_ISOLATED_BACKEND_EVENTS: ReadonlySet<string> = new Set([
  'banners.changed',
  'overlays.layout'
])

/** The privileged main-process socket uses the same bounded wire contract as the renderer. */
export function parseMainBackendWireMessage(raw: string): ServerResponse | ServerEvent {
  const message = parseBackendWireMessage(raw)
  if ('id' in message) return message
  if (MAIN_ISOLATED_BACKEND_EVENTS.has(message.event)) return message
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

export function parseMainPreviewSurfaceStatus(payload: unknown): PreviewSurfaceStatus {
  return validateBackendRpcResult('preview.surface.status', payload) as PreviewSurfaceStatus
}

export function parseMainPreviewSurfaceStatusEvent(payload: unknown): PreviewSurfaceStatus {
  return validateBackendEventPayload('preview.surface.status', payload) as PreviewSurfaceStatus
}

export function parseMainCompositorStatusEvent(payload: unknown): CompositorStatus {
  return validateBackendEventPayload('compositor.status', payload) as CompositorStatus
}

export function parseMainCompositorFrameReadyEvent(payload: unknown): CompositorFrameReady {
  return validateCompositorFrameReadyPayload(payload)
}

/** `banners.list` reply: the full list, strictly validated (plan 186). */
export function parseMainBannerList(payload: unknown): Banner[] {
  return validateBackendRpcResult('banners.list', payload) as Banner[]
}

/** `banners.changed` event: the full list, strictly validated (plan 186). */
export function parseMainBannersChangedEvent(payload: unknown): Banner[] {
  return validateBackendEventPayload('banners.changed', payload) as Banner[]
}

/** `overlays.layout.get` result: the proof surface's Buddy switches (plan 205 S9). */
export function parseMainOverlayLayout(payload: unknown): OverlayLayout {
  return validateBackendRpcResult('overlays.layout.get', payload) as OverlayLayout
}

/** `overlays.layout` event: the whole layout, strictly validated. */
export function parseMainOverlayLayoutEvent(payload: unknown): OverlayLayout {
  return validateBackendEventPayload('overlays.layout', payload) as OverlayLayout
}
