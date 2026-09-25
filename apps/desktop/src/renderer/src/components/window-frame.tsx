import type { ReactElement, ReactNode } from 'react'

import { cn } from '@/lib/utils'

// The frame every glass window shares (plan 050, D2). The OS material and the
// body's window coat come from main and styles.css; this adds the content coat
// for single-pane windows and the traffic-light gutter for header rows.

const MAC_RENDERER = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

/**
 * Header rows share their line with the macOS traffic lights (hiddenInset).
 * On current macOS the three 14 px lights end 74 px in, so 88 px leaves the
 * title 14 px of air. Off macOS the native frame owns the title bar.
 */
export const TRAFFIC_LIGHT_GUTTER_CLASS = 'pl-[88px]'

/**
 * Left padding for a header that shares its row with the traffic lights.
 * It stays in fullscreen too: macOS draws the lights over the header when
 * the title bar reveals on hover, and a window filling the screen under an
 * auto-hidden menu bar keeps them showing. Dropping the gutter there put the
 * lights on top of the Stream Manager title (2026-09-25).
 */
export function useTrafficLightGutter(): string {
  return MAC_RENDERER ? TRAFFIC_LIGHT_GUTTER_CLASS : 'pl-3'
}

/** A single-pane glass window (Chat, Captions, Notes): the content coat over the window coat. */
export function WindowFrame({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <div className={cn('h-screen bg-glass-content', className)} data-slot="window-frame">
      {children}
    </div>
  )
}
