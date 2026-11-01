'use client'

import { useSyncExternalStore } from 'react'
import type { ComponentProps, ReactElement, ReactNode } from 'react'

import { WINDOW_TITLE_CLASS } from '@/components/pane'
import { currentPlatform, isMacPlatform } from '@/lib/platform'
import { cn } from '@/lib/utils'

// The frame every window shares. The window's opaque base and the body's
// window coat sit under it; this adds the content coat for single-pane
// windows and the traffic-light gutter for header rows.

/**
 * Header rows share their line with the macOS traffic lights (hiddenInset).
 * On current macOS the three 14 px lights end 74 px in, so 88 px leaves the
 * title 14 px of air. Off macOS the native frame owns the title bar.
 */
const TRAFFIC_LIGHT_GUTTER_CLASS = 'pl-[88px]'

const subscribe = (): (() => void) => () => {
  // The platform never changes while the window is open: nothing to watch.
}

/**
 * Left padding for a header that shares its row with the traffic lights.
 * It stays in fullscreen too: macOS draws the lights over the header when
 * the title bar reveals on hover, and a window filling the screen under an
 * auto-hidden menu bar keeps them showing. Dropping the gutter there put the
 * lights on top of the Stream Manager title.
 *
 * Without a `platform` it reads `data-platform` on <html>, then the user
 * agent. A server can't know the reader's platform: it renders the gutter
 * off macOS and the client corrects it as it hydrates.
 */
function useTrafficLightGutter(platform?: string): string {
  const mac = useSyncExternalStore(
    subscribe,
    () => isMacPlatform(currentPlatform(platform)),
    () => isMacPlatform(platform)
  )
  return mac ? TRAFFIC_LIGHT_GUTTER_CLASS : 'pl-3'
}

type WindowHeaderProps = {
  title: ReactNode
  /** A quiet inline fact after the title (the Captions reader's state). */
  meta?: ReactNode
  /** The window's few controls, trailing, out of the drag band. */
  children?: ReactNode
  /** `darwin`, `win32`, `linux`…: whether the traffic lights share the row. */
  platform?: string
  className?: string
} & Omit<ComponentProps<'header'>, 'title' | 'children' | 'className'>

/**
 * The header row of a single-pane window: Stream Manager, Notes and Captions
 * share it. It sits on the traffic lights' line (the gutter), is the window's
 * drag band, and carries the window's title as its `h1` in the main window's
 * recipe (14 px / 600). `meta` is a quiet inline fact after the title;
 * `children` are the window's few controls, trailing, opted out of the drag
 * region. Stream Manager keeps its row to the title.
 */
function WindowHeader({
  title,
  meta,
  children,
  platform,
  className,
  ...props
}: WindowHeaderProps): ReactElement {
  const trafficLightGutter = useTrafficLightGutter(platform)
  return (
    <header
      className={cn(
        'h-toolbar border-border flex shrink-0 items-center gap-2 overflow-hidden border-b pr-2 select-none [-webkit-app-region:drag]',
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

/** A single-pane window (Stream Manager, Captions, Notes): the content coat over the window coat. */
function WindowFrame({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): ReactElement {
  return (
    <div className={cn('bg-glass-content h-screen', className)} data-slot="window-frame">
      {children}
    </div>
  )
}

export {
  WindowFrame,
  WindowHeader,
  useTrafficLightGutter,
  TRAFFIC_LIGHT_GUTTER_CLASS,
  type WindowHeaderProps
}
