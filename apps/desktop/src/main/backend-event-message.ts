import type {
  Banner,
  CompositorFrameReady,
  HtmlOverlayTargets,
  CompositorStatus,
  OverlayLayout,
  PreviewSurfaceStatus,
  RecordingStatus,
  Scene,
  ServerEvent,
  ServerResponse,
  VirtualCameraStatus
} from '../shared/backend'
import {
  parseBackendWireMessage,
  validateBackendEventPayload,
  validateBackendRpcResult,
  validateCompositorFrameReadyPayload
} from '../shared/backend-rpc-contract'
import { LIVE_BACKGROUND_IDS, type LiveBackgroundId } from '../shared/live-background-ids'
import {
  enumSchema,
  numberSchema,
  objectSchema,
  optionalSchema,
  stringSchema
} from '../shared/runtime-schema'

/**
 * Feeds whose bad payload must never retire the main socket: that socket also
 * carries capture state and the preview present pump. Their payloads pass
 * through unvalidated here and their handler validates them at use, dropping
 * a bad one with a warning (plan 186: the banner list for the proof surface).
 */
export const MAIN_ISOLATED_BACKEND_EVENTS: ReadonlySet<string> = new Set([
  'banners.changed',
  // Plan 232: a bad target list stops no overlay and never the socket.
  'htmlOverlays.targets',
  'overlays.layout',
  // Plan 214 B3: the camera switch activates the extension; a bad status
  // is dropped with a warning, never the socket.
  'virtualCamera.changed',
  // The proof surface draws the committed scene's background; a bad scene
  // is dropped with a warning, never the socket.
  'scene.changed'
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

/** `htmlOverlays.targets.get` reply: what main renders now (plan 232). */
export function parseMainHtmlOverlayTargets(payload: unknown): HtmlOverlayTargets {
  return validateBackendRpcResult('htmlOverlays.targets.get', payload) as HtmlOverlayTargets
}

/** `htmlOverlays.targets` event, strictly validated (plan 232). */
export function parseMainHtmlOverlayTargetsEvent(payload: unknown): HtmlOverlayTargets {
  return validateBackendEventPayload('htmlOverlays.targets', payload) as HtmlOverlayTargets
}

/** `overlays.layout.get` result: the proof surface's Buddy switches (plan 205 S9). */
export function parseMainOverlayLayout(payload: unknown): OverlayLayout {
  return validateBackendRpcResult('overlays.layout.get', payload) as OverlayLayout
}

/** `overlays.layout` event: the whole layout, strictly validated. */
export function parseMainOverlayLayoutEvent(payload: unknown): OverlayLayout {
  return validateBackendEventPayload('overlays.layout', payload) as OverlayLayout
}

// The shared scene contract leaves the background as a bounded payload; the
// proof surface draws it, so main checks every field it reads (Rust
// `EffectiveSceneBackground`, which skips an absent `live`).
const sceneBackgroundSchema = objectSchema(
  {
    assetId: stringSchema({ minLength: 1, maxLength: 16_384 }),
    managedAssetPath: stringSchema({ minLength: 1, maxLength: 16_384 }),
    fit: enumSchema(['fill', 'fit', 'stretch']),
    scale: numberSchema(),
    offsetX: numberSchema(),
    offsetY: numberSchema(),
    blurPx: numberSchema(),
    dimPercent: numberSchema(),
    saturationPercent: numberSchema(),
    vignettePercent: numberSchema(),
    visibilityPercent: numberSchema(),
    live: optionalSchema(
      objectSchema(
        {
          id: enumSchema(LIVE_BACKGROUND_IDS as [LiveBackgroundId, ...LiveBackgroundId[]]),
          look: stringSchema({ minLength: 1, maxLength: 64 }),
          motion: enumSchema(['calm', 'normal'])
        },
        { allowUnknown: false }
      )
    )
  },
  { allowUnknown: false }
)

function withSceneBackground(scene: Scene, path: string): Scene {
  if (scene.background !== undefined)
    sceneBackgroundSchema.parse(scene.background, `${path}.background`)
  return scene
}

/** `scene.get` result: the committed scene, for the proof surface's background. */
export function parseMainScene(payload: unknown): Scene {
  return withSceneBackground(
    validateBackendRpcResult('scene.get', payload) as Scene,
    'backend.scene.get.result'
  )
}

/** `scene.changed` event: the whole committed scene, strictly validated. */
export function parseMainSceneChangedEvent(payload: unknown): Scene {
  return withSceneBackground(
    validateBackendEventPayload('scene.changed', payload) as Scene,
    'backend.event.scene.changed'
  )
}

export function parseMainVirtualCameraStatus(payload: unknown): VirtualCameraStatus {
  return validateBackendRpcResult('virtualCamera.status', payload) as VirtualCameraStatus
}

export function parseMainVirtualCameraChangedEvent(payload: unknown): VirtualCameraStatus {
  return validateBackendEventPayload('virtualCamera.changed', payload) as VirtualCameraStatus
}
