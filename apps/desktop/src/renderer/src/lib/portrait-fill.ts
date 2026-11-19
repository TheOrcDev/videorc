import { portraitCoverBox, type Size } from '../../../shared/cloud-presentation-views'

// Plan 254 S2: the fill behind a portrait camera that is drawn whole, as the
// program page draws it (web `lib/cloud/program/stage-media.ts`), so the host
// sees what viewers see. A cover of the same frame, taken from its upper
// third, drawn very small and blurred there, shaded, then stretched over the
// tile by the canvas's own CSS size. Drawn about once a second from the
// frame the video already decoded: no second decode, nothing per frame.

/** How often the fill is drawn again while the camera flows. */
export const PORTRAIT_FILL_INTERVAL_MS = 1000
/** The fill is drawn this small, then stretched: that is its blur. */
const FILL_LONG_SIDE = 64
const FILL_BLUR_PX = 2
/** Drawn past the canvas by this much, so the blur has no faded rim. */
const FILL_OVERSCAN_PX = 3 * FILL_BLUR_PX
/** Black over the fill: the picture in front stays the brightest thing. */
const FILL_SHADE = 'rgba(0, 0, 0, 0.45)'

/**
 * Draws the fill for `video` in a tile of this shape into `canvas`, which it
 * sizes. False, and nothing drawn, while the video has no frame to draw.
 */
export function drawPortraitFill(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  tile: Size
): boolean {
  if (video.readyState < 2) return false
  const crop = portraitCoverBox({ w: video.videoWidth, h: video.videoHeight }, tile)
  if (!crop) return false
  const long = Math.max(tile.w, tile.h)
  const width = Math.max(1, Math.round((tile.w / long) * FILL_LONG_SIDE))
  const height = Math.max(1, Math.round((tile.h / long) * FILL_LONG_SIDE))
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return false
  try {
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.filter = `blur(${FILL_BLUR_PX}px)`
    context.drawImage(
      video,
      crop.x,
      crop.y,
      crop.w,
      crop.h,
      -FILL_OVERSCAN_PX,
      -FILL_OVERSCAN_PX,
      width + 2 * FILL_OVERSCAN_PX,
      height + 2 * FILL_OVERSCAN_PX
    )
    context.filter = 'none'
    context.fillStyle = FILL_SHADE
    context.fillRect(0, 0, width, height)
    return true
  } catch {
    return false
  }
}
