import { useEffect, useState, type ReactElement } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import type { CohostBubbleStyle, CohostPersona } from '@/lib/backend'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'
import { GOLEM_BUBBLE_LABELS } from '@/lib/golem-persona-view'
import { loadGolemStateImage, renderGolemOverlayPng } from '@/lib/golem-overlay'

/** The sample canvas: the bubble as it goes on a 1080p stream at the Golem's
 * default placement, shown small. */
const SAMPLE_CANVAS = { width: 1920, height: 1080 }
const SAMPLE_RECT = DEFAULT_OVERLAY_LAYOUT.golem.horizontal

/**
 * A two-line sample of the bubble (plan 164 S-A4), drawn by the overlay
 * rasterizer itself (S-C2) with the persona's talking image, so what the
 * screen shows is what the stream gets. The bubble is always the light
 * variant: the stream is not themed (D17). A host without a 2D canvas (tests)
 * shows the placeholder.
 */
export function GolemBubbleSample({
  persona,
  style
}: {
  persona: Pick<CohostPersona, 'id' | 'name' | 'images'>
  style: CohostBubbleStyle
}): ReactElement {
  const [src, setSrc] = useState<string | null>(null)
  const { name } = persona
  const imagesKey = JSON.stringify(persona.images)
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
        canvas: SAMPLE_CANVAS,
        rect: SAMPLE_RECT
      })
      if (!cancelled) setSrc(png ? `data:image/png;base64,${png}` : null)
    })().catch(() => {
      if (!cancelled) setSrc(null)
    })
    return () => {
      cancelled = true
    }
  }, [imagesKey, name, style])
  return (
    <div
      aria-label={`${GOLEM_BUBBLE_LABELS[style]} bubble sample`}
      className="flex h-28 w-24 shrink-0 items-end justify-center"
      data-slot="golem-bubble-sample"
      data-style={style}
      role="img"
    >
      {src ? (
        <img alt="" className="max-h-28 w-auto" draggable={false} src={src} />
      ) : (
        <Skeleton className="h-28 w-20" />
      )}
    </div>
  )
}
