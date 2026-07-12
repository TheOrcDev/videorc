import type { CameraShape, EffectiveSceneBackground, LayoutSettings, SceneSource } from './backend'

/** Keep the proof surface's background stage identical to Rust scene geometry. */
export function previewProofBackgroundStageMargin(
  background: Pick<EffectiveSceneBackground, 'visibilityPercent'> | null | undefined
): number {
  if (!background) return 0
  return Math.min(0.2, Math.max(0, background.visibilityPercent / 200))
}

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
    return layout.cameraFit === 'fit' && layout.cameraZoom <= 100 ? 'contain' : 'cover'
  }
  return layout.layoutPreset === 'side-by-side' ? 'cover' : 'contain'
}

export function previewProofLayerShape(
  source: SceneSource,
  layout: LayoutSettings
): CameraShape | undefined {
  if (source.kind !== 'camera') {
    return undefined
  }
  // Only the inset scenes shape the camera bubble — mirrors Rust camera_mask.
  return layout.layoutPreset === 'screen-camera' || layout.layoutPreset === 'vertical-screen-camera'
    ? layout.cameraShape
    : 'rectangle'
}
