import type { ReactElement, ReactNode } from 'react'

import { ChromeGround } from '@/components/chrome-ground'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * The four renderer windows (plan 174 S1.1, J1-6). Each is its own React root,
 * so each needs its own tooltip provider and toast host: a `Tooltip` without
 * a provider throws, and a `toast()` without a host is never seen.
 */
export type VideorcWindow = 'main' | 'stream-manager' | 'captions' | 'notes'

/** The status bar each window keeps at its bottom edge, in px (0: none). */
const WINDOW_STATUS_BAR_PX: Record<VideorcWindow, number> = {
  main: 26,
  // 32, not the shared 26: its platform icons need the room (plan 165).
  'stream-manager': 32,
  captions: 0,
  notes: 0
}

const TOAST_EDGE_PX = 16
const TOAST_ABOVE_STATUS_BAR_PX = 12

/** One toast policy for every window: three at a time, each dismissible. */
export const WINDOW_TOAST_POLICY = { visibleToasts: 3, closeButton: true } as const

/**
 * Where a window's toasts sit: above its status bar, so they never cover its
 * controls (J1-17; plan 022 Q3, plan 050 S11), or 16 px from the corner.
 */
export function windowToasterOffset(window: VideorcWindow): { bottom: number; right: number } {
  const statusBar = WINDOW_STATUS_BAR_PX[window]
  return {
    bottom: statusBar > 0 ? statusBar + TOAST_ABOVE_STATUS_BAR_PX : TOAST_EDGE_PX,
    right: TOAST_EDGE_PX
  }
}

/**
 * Every window entry wraps its tree in this: the chrome ground under
 * everything (plan 208; it mounts only while the root says
 * `data-ground="chrome"`), tooltips (600 ms, the desktop delay) and the
 * window's toast host. Toasts are never tinted (owner call, 2026-09-29): the
 * type colours the icon only, so there is no `richColors`.
 */
export function WindowProviders({
  window,
  children
}: {
  window: VideorcWindow
  children: ReactNode
}): ReactElement {
  return (
    <TooltipProvider>
      <ChromeGround />
      {children}
      <Toaster
        closeButton={WINDOW_TOAST_POLICY.closeButton}
        offset={windowToasterOffset(window)}
        position="bottom-right"
        visibleToasts={WINDOW_TOAST_POLICY.visibleToasts}
      />
    </TooltipProvider>
  )
}
