import type { CameraShape, LayoutSettings, OverlayItem, OverlayLayout } from './backend'

// The Scene page's edits as pure rules (plan 209 S11b): what the inspector
// shows for the camera, the patch its Shape control sends, the patch its
// overlay switches send, and why visibility is locked. The page and an
// agent's Arrange tools (lib/studio-actions/scene-layout.ts) both read them,
// so a word from an agent lands exactly where the click would.

export const SCENE_VISIBILITY_LOCK_REASON = "Visibility is locked while you're recording or live."

/**
 * Which camera controls a layout has. The inset scenes (Screen + camera, and
 * its vertical twin) place the camera at a corner, at a size; freeform owns
 * position and size; the mask (shape) applies to both, never to the bands of
 * side by side or the vertical stacks.
 */
export function sceneCameraControls(
  layout: Pick<LayoutSettings, 'layoutPreset' | 'arrangementMode'>
): {
  inset: boolean
  freeform: boolean
  corner: boolean
  bubble: boolean
} {
  const inset =
    layout.layoutPreset === 'screen-camera' || layout.layoutPreset === 'vertical-screen-camera'
  const freeform = layout.arrangementMode === 'freeform'
  return { inset, freeform, corner: inset && !freeform, bubble: inset || freeform }
}

/** The Shape control's patch: Rounded means a rounded SQUARE by default
 * (owner decision 2026-07-06), so picking it snaps the aspect in the same
 * gesture; the Aspect control still allows the original or portrait after. */
export function cameraShapePatch(shape: CameraShape): Partial<LayoutSettings> {
  return shape === 'rounded'
    ? { cameraShape: 'rounded', cameraAspect: 'square' }
    : { cameraShape: shape }
}

/** The overlay inspector's "Show on stream" and "Show in recording" patch. */
export function withOverlaySwitches(
  layout: OverlayLayout,
  item: OverlayItem,
  patch: Partial<{ showOnStream: boolean; showInRecording: boolean }>
): OverlayLayout {
  return { ...layout, [item]: { ...layout[item], ...patch } }
}
