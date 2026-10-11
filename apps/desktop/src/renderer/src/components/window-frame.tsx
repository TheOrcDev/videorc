import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { WINDOW_TITLE_CLASS } from '@/components/pane'
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

/**
 * The header row of a single-pane window (plan 174 S1.6b, J1-18): Stream
 * Manager, Notes and Captions share it. It sits on the traffic lights' line
 * (the gutter), is the window's drag band, and carries the window's title as
 * its `h1` in the main window's recipe (14 px / 600). `meta` is a quiet
 * inline fact after the title (the Captions reader's state); `children` are
 * the window's few controls, trailing, opted out of the drag region. Stream
 * Manager keeps its row to the title (owner call, 2026-09-23).
 */
export function WindowHeader({
  title,
  meta,
  children,
  className,
  ...props
}: {
  title: ReactNode
  meta?: ReactNode
  children?: ReactNode
  className?: string
} & Omit<ComponentProps<'header'>, 'title' | 'children' | 'className'>): ReactElement {
  const trafficLightGutter = useTrafficLightGutter()
  return (
    <header
      className={cn(
        'flex h-toolbar shrink-0 items-center gap-2 overflow-hidden border-b border-border pr-2 select-none [-webkit-app-region:drag]',
        trafficLightGutter,
        className
      )}
      data-slot="window-header"
      {...props}
    >
      <h1 className={cn(WINDOW_TITLE_CLASS, 'shrink-0')} data-slot="window-header-title">
        {title}
      </h1>
      {meta ? (
        <span className="flex min-w-0 items-center gap-2" data-slot="window-header-meta">
          {meta}
        </span>
      ) : null}
      {children ? (
        <div
          className="ml-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
          data-slot="window-header-actions"
        >
          {children}
        </div>
      ) : null}
    </header>
  )
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
