import type {
  CameraShape,
  EffectiveSceneBackground,
  LayoutPreset,
  LayoutSettings,
  SceneSource
} from './backend'

/** Keep the proof surface's background stage identical to Rust scene geometry. */
export function previewProofBackgroundStageMargin(
  background: Pick<EffectiveSceneBackground, 'visibilityPercent'> | null | undefined
): number {
  if (!background) return 0
  return Math.min(0.2, Math.max(0, background.visibilityPercent / 200))
}

// Mirrors Rust `scene_geometry::vertical_fill_preset`: every vertical scene's
// regions are short-form bands that are always FILLED (cover), never
// letterboxed.
const VERTICAL_FILL_PRESETS: readonly LayoutPreset[] = [
  'vertical-camera-top',
  'vertical-camera-bottom',
  'vertical-split',
  'vertical-screen-camera',
  'vertical-screen-only',
  'vertical-camera-only'
]

// Band cameras and the full-canvas vertical camera ignore the user's Fit —
// a contained camera letterboxes its region. Only the vertical screen+camera
// inset bubble keeps the Fit choice (like its horizontal twin).
const VERTICAL_FILLED_CAMERA_PRESETS: readonly LayoutPreset[] = [
  'vertical-camera-top',
  'vertical-camera-bottom',
  'vertical-split',
  'vertical-camera-only'
]

/**
 * Geometry policy used before the backend compositor has published its
 * authoritative per-source status. Keep this aligned with Rust
 * `scene_geometry::{scene_source_fit,camera_mask}`.
 */
export function previewProofLayerFit(
  source: SceneSource,
  layout: LayoutSettings
): 'contain' | 'cover' {
  if (source.kind === 'camera') {
    if (VERTICAL_FILLED_CAMERA_PRESETS.includes(layout.layoutPreset)) {
      return 'cover'
    }
    return layout.cameraFit === 'fit' && layout.cameraZoom <= 100 ? 'contain' : 'cover'
  }
  return layout.layoutPreset === 'side-by-side' ||
    VERTICAL_FILL_PRESETS.includes(layout.layoutPreset)
    ? 'cover'
    : 'contain'
}

/**
 * The camera mask the render paths actually draw: only the inset scenes
 * (screen-camera and its vertical twin) shape the bubble; band, region, and
 * full-frame scenes keep the camera rectangular. Mirrors Rust `camera_mask` —
 * every surface that DEPICTS the camera (proof surface, scene-editing stage)
 * must use this, or the editor shows a circle the recording won't have.
 */
export function effectiveCameraMaskShape(layout: LayoutSettings): CameraShape {
  return layout.layoutPreset === 'screen-camera' || layout.layoutPreset === 'vertical-screen-camera'
    ? layout.cameraShape
    : 'rectangle'
}

export function previewProofLayerShape(
  source: SceneSource,
  layout: LayoutSettings
): CameraShape | undefined {
  if (source.kind !== 'camera') {
    return undefined
  }
  return effectiveCameraMaskShape(layout)
}
