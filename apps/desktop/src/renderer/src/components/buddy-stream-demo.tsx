import { useEffect, useState, type ReactElement } from 'react'

import streamBackdropUrl from '@/assets/backgrounds/livestream.webp'
import { Badge } from '@/components/ui/badge'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import type { CohostAvatarState } from '@/lib/backend'
import { BUDDY_ONBOARDING_STEP1 } from '@/lib/buddy-onboarding-copy'
import { renderBuddyBubblePng } from '@/lib/buddy-overlay'
import {
  BUDDY_DEMO_CANVAS,
  BUDDY_DEMO_RECT,
  BUDDY_DEMO_STILL_FRAME,
  BUDDY_DEMO_TIMELINE,
  buddyDemoBubbleWidthPercent,
  buddyDemoNextFrame
} from '@/lib/buddy-stream-demo'
import { cn } from '@/lib/utils'

/** The bubbles as PNG data URLs, drawn once per page (they never change). */
let bubbleCache: Promise<(string | null)[]> | null = null

function drawBubbles(): Promise<(string | null)[]> {
  bubbleCache ??= Promise.all(
    BUDDY_ONBOARDING_STEP1.demoBubbles.map((text) =>
      renderBuddyBubblePng({
        bubble: text,
        style: 'speech',
        canvas: BUDDY_DEMO_CANVAS,
        rect: BUDDY_DEMO_RECT
      }).then(
        (png) => (png ? `data:image/png;base64,${png}` : null),
        () => null
      )
    )
  )
  return bubbleCache
}

/**
 * "How it looks on stream" (plan 170 D14 step 1): a stream-shaped frame
 * (the app's livestream backdrop) with the Golem in its corner. It idles,
 * a follower arrives, it greets them, answers a viewer and laughs, on a
 * loop, from the four poses and the bubble the stream itself draws. The
 * frame is stream content, so it stays dark in both themes. With reduced
 * motion it is one still frame: the greeting.
 */
export function BuddyStreamDemo({
  poses,
  className
}: {
  poses: Readonly<Record<CohostAvatarState, string>>
  className?: string
}): ReactElement {
  const reducedMotion = useReducedMotion()
  const [frameIndex, setFrameIndex] = useState(0)
  const [bubbles, setBubbles] = useState<(string | null)[]>([])
  const index = reducedMotion ? BUDDY_DEMO_STILL_FRAME : frameIndex
  const frame = BUDDY_DEMO_TIMELINE[index]!

  useEffect(() => {
    let cancelled = false
    void drawBubbles().then((drawn) => {
      if (!cancelled) setBubbles(drawn)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (reducedMotion) return
    const timer = window.setTimeout(
      () => setFrameIndex((current) => buddyDemoNextFrame(current)),
      BUDDY_DEMO_TIMELINE[frameIndex]!.ms
    )
    return () => window.clearTimeout(timer)
  }, [frameIndex, reducedMotion])

  const bubbleText = frame.bubble === null ? null : BUDDY_ONBOARDING_STEP1.demoBubbles[frame.bubble]
  const bubbleUrl = frame.bubble === null ? null : (bubbles[frame.bubble] ?? null)

  return (
    <div
      aria-label={BUDDY_ONBOARDING_STEP1.demoHeading}
      className={cn(
        // Stream content: dark tokens whatever the app theme (like Preview).
        'dark relative aspect-video w-full overflow-hidden rounded-row border border-border',
        className
      )}
      data-frame={index}
      data-pose={frame.pose}
      data-testid="buddy-stream-demo"
      role="img"
    >
      <img
        alt=""
        className="absolute inset-0 size-full object-cover"
        draggable={false}
        src={streamBackdropUrl}
      />
      <Badge
        className={cn(
          'absolute top-[6%] left-[4%] transition-opacity duration-150 ease-out motion-reduce:transition-none',
          frame.chip ? 'opacity-100' : 'opacity-0'
        )}
        data-testid="buddy-stream-demo-chip"
        variant="default"
      >
        {BUDDY_ONBOARDING_STEP1.demoChip}
      </Badge>
      {/* The Golem's slot, bottom right; every pose stands on its baseline. */}
      <div className="absolute right-[4%] bottom-[3%] h-[46%] w-[26%]">
        {(['idle', 'talk', 'laugh', 'think'] as const).map((pose) => (
          <img
            key={pose}
            alt=""
            className={cn(
              'absolute inset-0 size-full object-contain object-bottom',
              pose === frame.pose ? 'opacity-100' : 'opacity-0'
            )}
            decoding="async"
            draggable={false}
            src={poses[pose]}
          />
        ))}
        {bubbleText ? (
          <div
            key={frame.bubble}
            className="absolute bottom-[96%] left-1/2 -translate-x-1/2 animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none"
            data-testid="buddy-stream-demo-bubble"
            style={{ width: `${(buddyDemoBubbleWidthPercent() * 100) / 26}%` }}
          >
            {bubbleUrl ? <img alt="" className="w-full" draggable={false} src={bubbleUrl} /> : null}
            <span className="sr-only">{bubbleText}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
