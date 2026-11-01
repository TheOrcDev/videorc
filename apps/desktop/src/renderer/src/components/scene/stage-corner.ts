import type { CameraAspect, CameraCorner, CameraShape, CameraSize } from '@/lib/backend'

import type { StageRect } from './stage-transform'

// A camera moved into a canvas corner of an inset preset scene is not placed
// where it was let go: the release re-enters the preset at that corner, at the
// preset's size and margin (`applyCameraPreset({ cameraCorner })`). The stage
// shows that box while the pointer is in the corner, so the drop lands where
// it was shown. Pure helpers, unit-tested.

/** How close to a canvas corner (canvas units, on both axes) a move ends in it. */
const CORNER_ZONE = 0.06

/** A move that ends in a canvas corner becomes a preset corner snap. */
export function snapCornerOf(rect: StageRect): CameraCorner | null {
  if (
    (rect.x <= CORNER_ZONE || rect.x + rect.width >= 1 - CORNER_ZONE) &&
    (rect.y <= CORNER_ZONE || rect.y + rect.height >= 1 - CORNER_ZONE)
  )
    return `${rect.y <= CORNER_ZONE ? 'top' : 'bottom'}-${rect.x <= CORNER_ZONE ? 'left' : 'right'}`
  return null
}

/** The camera presets are drawn for this canvas, then scaled to the output. */
const CAMERA_REFERENCE_WIDTH = 1280
const CAMERA_REFERENCE_HEIGHT = 720
const CAMERA_PRESET_WIDTH: Record<CameraSize, number> = { small: 260, medium: 360, large: 480 }
const CAMERA_MARGIN_MAX = 160

export interface PresetCameraLayout {
  cameraSize: CameraSize
  cameraShape: CameraShape
  cameraAspect: CameraAspect
  cameraMargin: number
}

/**
 * The camera's box at `corner` of a preset scene, in canvas units: the twin of
 * the backend's `scene_geometry::preset_camera_transform` (`camera_box_size`,
 * `camera_output_scale`, `scale_camera_dimension`, `scaled_camera_margin`),
 * with the same whole-pixel rounding, so the drop target and the committed
 * scene are the same box.
 */
export function presetCameraCornerRect(
  layout: PresetCameraLayout,
  corner: CameraCorner,
  outputWidth: number,
  outputHeight: number
): StageRect {
  const width = Math.max(1, Math.round(outputWidth))
  const height = Math.max(1, Math.round(outputHeight))
  const scale = Math.min(width / CAMERA_REFERENCE_WIDTH, height / CAMERA_REFERENCE_HEIGHT)
  const scaled = (value: number): number => Math.max(1, Math.round(value * scale))
  const boxWidth = CAMERA_PRESET_WIDTH[layout.cameraSize]
  const boxHeight =
    layout.cameraShape === 'circle' || layout.cameraAspect === 'square'
      ? boxWidth
      : layout.cameraAspect === 'portrait'
        ? Math.ceil((boxWidth * 4) / 3)
        : Math.floor((boxWidth * 9 + 8) / 16)
  const cameraWidth = scaled(boxWidth)
  const cameraHeight = scaled(boxHeight)
  const margin = scaled(Math.min(Math.max(0, Math.floor(layout.cameraMargin)), CAMERA_MARGIN_MAX))
  const left = corner.endsWith('left')
  const top = corner.startsWith('top')
  const x = left ? margin : Math.max(0, width - cameraWidth - margin)
  const y = top ? margin : Math.max(0, height - cameraHeight - margin)
  return { x: x / width, y: y / height, width: cameraWidth / width, height: cameraHeight / height }
}
