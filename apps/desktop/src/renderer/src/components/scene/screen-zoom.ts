import { MAX_SOURCE_FRACTION, clampSourcePosition, roundRectForCommit } from './stage-transform'
import type { StageRect } from './stage-transform'

/**
 * The screen's Zoom in Freeform (plan 215 E4, D2): the box's size as a
 * percent of the canvas, 100 to 400. The slider scales the box around its
 * centre, so what was in the middle of the picture stays there; what runs
 * past the canvas edge is cut off, never squashed. Zooming upscales the
 * picture, so text goes soft: a crop is the sharp way to show part of the
 * screen, and the slider's hint says so.
 */
export const SCREEN_ZOOM_MIN = 100
export const SCREEN_ZOOM_MAX = MAX_SOURCE_FRACTION * 100

export const SCREEN_ZOOM_HINT = 'Zooming softens text. Crop to show part of the screen sharply.'

/**
 * The Zoom a box shows: its longer side as a percent of the canvas, never
 * below 100 (a box smaller than the canvas reads 100, the slider's floor).
 */
export function screenZoomOf(rect: StageRect): number {
  const zoom = Math.round(Math.max(rect.width, rect.height) * 100)
  return Math.min(Math.max(zoom, SCREEN_ZOOM_MIN), SCREEN_ZOOM_MAX)
}

/**
 * The transform patch a Zoom of `zoomPercent` commits for `committed`: both
 * axes scaled by the same factor around the box's centre, so the aspect and
 * the centre hold. The box may hang off the canvas; as with a drag, at least
 * 5% of the canvas stays covered.
 */
export function screenZoomPatch(committed: StageRect, zoomPercent: number): StageRect {
  const zoom = Math.min(Math.max(zoomPercent, SCREEN_ZOOM_MIN), SCREEN_ZOOM_MAX) / 100
  const longer = Math.max(committed.width, committed.height)
  const scale = longer > 0 ? zoom / longer : 1
  const width = committed.width * scale
  const height = committed.height * scale
  const centerX = committed.x + committed.width / 2
  const centerY = committed.y + committed.height / 2
  return roundRectForCommit({
    x: clampSourcePosition(centerX - width / 2, width),
    y: clampSourcePosition(centerY - height / 2, height),
    width,
    height
  })
}
