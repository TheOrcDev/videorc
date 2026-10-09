import { useEffect, useState, type ReactElement } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import type { CohostBubbleStyle, CohostPersona } from '@/lib/backend'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'
import { GOLEM_BUBBLE_LABELS } from '@/lib/golem-persona-view'
import { loadGolemStateImage, renderGolemOverlayPng } from '@/lib/golem-overlay'
import { cn } from '@/lib/utils'

/** The sample canvas: the bubble as it goes on a 1080p stream at the Golem's
 * default placement. */
const SAMPLE_CANVAS = { width: 1920, height: 1080 }
const SAMPLE_RECT = DEFAULT_OVERLAY_LAYOUT.golem.horizontal
/**
 * The zoomed sample is drawn on a canvas twice that size (36 px type, a
 * 691 px Golem), never a small bitmap scaled up: shown at about a 1080p
 * stream's own scale, it stays crisp on a Retina screen.
 */
const ZOOMED_CANVAS_SCALE = 2

export type GolemBubbleSampleSize = 'inline' | 'zoomed'

/**
 * A sample of the bubble (plan 164 S-A4), drawn by the overlay rasterizer
 * itself (S-C2) with the persona's talking image, so what the screen shows
 * is what the stream gets. The bubble is always the light variant: the
 * stream is not themed (D17). `inline` is the small sample beside the style
 * toggle; `zoomed` fills the zoom dialog's box, big enough to read the
 * bubble. A host without a 2D canvas (tests) shows the placeholder.
 */
export function GolemBubbleSample({
  persona,
  style,
  size = 'inline'
}: {
  persona: Pick<CohostPersona, 'id' | 'name' | 'images'>
  style: CohostBubbleStyle
  size?: GolemBubbleSampleSize
}): ReactElement {
  const [src, setSrc] = useState<string | null>(null)
  const { name } = persona
  const imagesKey = JSON.stringify(persona.images)
  const scale = size === 'zoomed' ? ZOOMED_CANVAS_SCALE : 1
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const image = await loadGolemStateImage(
        { images: JSON.parse(imagesKey) as CohostPersona['images'] },
        'talk',
        { warn: () => undefined }
      )
      const png = await renderGolemOverlayPng({
        image,
        bubble: `Welcome to the horde, ${name} says hi.`,
        style,
        canvas: { width: SAMPLE_CANVAS.width * scale, height: SAMPLE_CANVAS.height * scale },
        rect: SAMPLE_RECT
      })
      if (!cancelled) setSrc(png ? `data:image/png;base64,${png}` : null)
    })().catch(() => {
      if (!cancelled) setSrc(null)
    })
    return () => {
      cancelled = true
    }
  }, [imagesKey, name, style, scale])
  const zoomed = size === 'zoomed'
  return (
    <div
      aria-label={`${GOLEM_BUBBLE_LABELS[style]} bubble sample`}
      className={cn(
        'flex shrink-0 items-end justify-center',
        zoomed ? 'size-full min-h-0' : 'h-40 w-36'
      )}
      data-size={size}
      data-slot="golem-bubble-sample"
      data-style={style}
      role="img"
    >
      {src ? (
        <img alt="" className="max-h-full max-w-full object-contain" draggable={false} src={src} />
      ) : (
        <Skeleton className={zoomed ? 'h-full w-3/5 rounded-row' : 'h-40 w-28'} />
      )}
    </div>
  )
}
