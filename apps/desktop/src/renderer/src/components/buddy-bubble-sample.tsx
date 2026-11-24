import { useEffect, useState, type ReactElement } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { useBuddyLookClient } from '@/hooks/use-buddy-look'
import type { CohostBubbleStyle, CohostPersona, OverlayPng } from '@/lib/backend'
import { buddyStateImageUrl } from '@/lib/buddy-default-pack'
import { DEFAULT_OVERLAY_LAYOUT } from '@/lib/overlay-layout'
import {
  BUDDY_BUBBLE_LABELS,
  BUDDY_BUBBLE_SAMPLE_CANVAS,
  BUDDY_BUBBLE_SAMPLE_ZOOM,
  buddyBubbleSampleLine
} from '@/lib/buddy-persona-view'
import { buddyOverlayMetrics } from '@/lib/buddy-overlay'
import { cn } from '@/lib/utils'

const SAMPLE_RECT = DEFAULT_OVERLAY_LAYOUT.buddy.horizontal

export type BuddyBubbleSampleSize = 'inline' | 'zoomed'

/**
 * A sample of the bubble (plan 164 S-A4) over the persona's talking image,
 * laid out as the stream lays them out: the bubble is drawn by the live
 * bubble's own painter in the backend (plan 260 S1.2e), and the picture
 * stands under it in a square the Buddy's width, bottom-aligned, as plan
 * 164's composite drew it. The bubble is always the light variant: the
 * stream is not themed (D17). `inline` is the small sample beside the style
 * toggle; `zoomed` fills the zoom dialog's box, big enough to read the
 * bubble. Until the backend answers (or without one, in tests) it shows the
 * placeholder.
 */
export function BuddyBubbleSample({
  persona,
  style,
  size = 'inline'
}: {
  persona: Pick<CohostPersona, 'id' | 'name' | 'images' | 'source'>
  style: CohostBubbleStyle
  size?: BuddyBubbleSampleSize
}): ReactElement {
  const client = useBuddyLookClient()
  const [bubble, setBubble] = useState<OverlayPng | null>(null)
  const { name } = persona
  const scale = size === 'zoomed' ? BUDDY_BUBBLE_SAMPLE_ZOOM : 1
  const canvasWidth = BUDDY_BUBBLE_SAMPLE_CANVAS.width * scale
  const canvasHeight = BUDDY_BUBBLE_SAMPLE_CANVAS.height * scale
  useEffect(() => {
    if (!client) return
    let cancelled = false
    client
      .requestTyped('buddy.bubble.render', {
        text: buddyBubbleSampleLine(name),
        style,
        canvasWidth,
        canvasHeight,
        rect: SAMPLE_RECT
      })
      .then(
        (png) => {
          if (!cancelled) setBubble(png)
        },
        () => {
          if (!cancelled) setBubble(null)
        }
      )
    return () => {
      cancelled = true
    }
  }, [canvasHeight, canvasWidth, client, name, style])
  const metrics = buddyOverlayMetrics(
    canvasWidth,
    canvasHeight,
    Math.floor(SAMPLE_RECT.w * canvasWidth),
    style
  )
  const zoomed = size === 'zoomed'
  return (
    <div
      aria-label={`${BUDDY_BUBBLE_LABELS[style]} bubble sample`}
      className={cn(
        'flex shrink-0 items-end justify-center',
        zoomed ? 'size-full min-h-0' : 'h-40 w-36'
      )}
      data-size={size}
      data-slot="buddy-bubble-sample"
      data-style={style}
      role="img"
    >
      {bubble ? (
        // One picture, scaled as a whole and standing on the box's floor like
        // the composite PNG it replaces: the bubble's bitmap on top, its tail
        // tip on the square's top edge. `size-auto`: its own size, held in
        // the box, never the zoom Button's icon size.
        <svg
          aria-hidden
          className="size-auto max-h-full max-w-full"
          data-testid="buddy-bubble-sample-picture"
          height={bubble.height + metrics.avatarPx + metrics.padPx}
          preserveAspectRatio="xMidYMax meet"
          viewBox={`0 0 ${bubble.width} ${bubble.height + metrics.avatarPx + metrics.padPx}`}
          width={bubble.width}
        >
          <image
            height={bubble.height}
            href={`data:image/png;base64,${bubble.pngBase64}`}
            width={bubble.width}
            x={0}
            y={0}
          />
          <image
            height={metrics.avatarPx}
            href={buddyStateImageUrl(persona, 'talk')}
            preserveAspectRatio="xMidYMax meet"
            width={metrics.avatarPx}
            x={metrics.padPx}
            y={bubble.height}
          />
        </svg>
      ) : (
        <Skeleton className={zoomed ? 'h-full w-3/5 rounded-row' : 'h-40 w-28'} />
      )}
    </div>
  )
}
