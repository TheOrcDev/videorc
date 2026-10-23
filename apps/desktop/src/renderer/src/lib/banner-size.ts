import type { Banner } from '@/lib/backend'
import { formatResolution, type VideoSize } from '@/lib/format-video'
import { bannerDrawRect, bannerRectForCanvas } from '../../../shared/banner-geometry'

// "Size for this place" (plan 186 D8 (b)): the exact pixel size a banner
// needs where the streamer put it, and whether their image is that big. Pure:
// the Scene inspector reads it. Only the Scene page imports it, so it stays
// out of the eager bundle.

/** An upscale of up to 10 % does not show, so 90 % of the needed width is sharp. */
export const BANNER_SHARP_FRACTION = 0.9

/** A canvas a banner can appear on, and what the first line calls it. */
export interface BannerSizeCanvas extends VideoSize {
  noun: 'recording' | 'vertical stream'
}

export interface BannerSizeAdvice {
  /** The canvas that draws the banner largest: the one the first line names. */
  canvas: BannerSizeCanvas
  /** The largest contained draw size, rounded up to even pixels. */
  needed: VideoSize
  sharp: boolean
  /** "Size on your 3840 × 2160 recording: 2304 × 384 px" */
  sizeLine: string
  /** "Your image is 2400 × 400 px: sharp at this size." or the soft sentence. */
  verdictLine: string
}

const upToEven = (value: number): number => (value % 2 === 0 ? value : value + 1)

/**
 * Where the banner appears and how big it needs to be there. The canvases:
 * the Output resolution with the rect for its shape (the horizontal rect, or
 * the vertical one for a vertical program), plus the vertical stream canvas
 * with the vertical rect while a vertical destination is armed. The draw
 * size is the contained one (`bannerDrawRect`), exactly as every render path
 * places the picture.
 */
export function bannerSizeAdvice({
  banner,
  output,
  verticalStream = null
}: {
  banner: Pick<Banner, 'width' | 'height' | 'horizontal' | 'vertical'>
  /** The Output resolution: the recording and every horizontal stream. */
  output: VideoSize
  /** The vertical stream's canvas, when a vertical destination is armed. */
  verticalStream?: VideoSize | null
}): BannerSizeAdvice {
  const canvases: BannerSizeCanvas[] = [{ noun: 'recording', ...output }]
  if (verticalStream) canvases.push({ noun: 'vertical stream', ...verticalStream })
  let canvas = canvases[0]!
  let drawn = { width: 0, height: 0 }
  for (const candidate of canvases) {
    const rect = bannerDrawRect(
      banner.width,
      banner.height,
      candidate.width,
      candidate.height,
      bannerRectForCanvas(banner, candidate.width, candidate.height)
    )
    if (rect.w > drawn.width || (rect.w === drawn.width && rect.h > drawn.height)) {
      canvas = candidate
      drawn = { width: rect.w, height: rect.h }
    }
  }
  const needed = { width: upToEven(drawn.width), height: upToEven(drawn.height) }
  const sharp = banner.width >= BANNER_SHARP_FRACTION * needed.width
  const image = formatResolution(banner)
  return {
    canvas,
    needed,
    sharp,
    sizeLine: `Size on your ${formatResolution(canvas)} ${canvas.noun}: ${formatResolution(needed)} px`,
    verdictLine: sharp
      ? `Your image is ${image} px: sharp at this size.`
      : `Your image is ${image} px: it will look soft at this size. Use one at least ${formatResolution(needed)} px.`
  }
}
