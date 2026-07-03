// Docked ("stick") preview placement math. The renderer reports the Studio
// slot's rect RELATIVE TO THE WINDOW CONTENT — a value that does not change
// while the app window is dragged — and main composes it with its own,
// synchronously-known main-window content bounds. The renderer is never in the
// movement path; that renderer-driven screen-space sync is what made the 2026-06-09
// glue attempt (9f815a23) lag and drift, and it must not come back.

import type { DockHiddenReason, DockSlotReport, PreviewWindowMode } from '../shared/backend'

export type { DockHiddenReason, DockSlotReport, PreviewWindowMode }

// Reports below this visible fraction hide the docked surface instead of
// clipping it: partial clip was the old glue attempt's complexity sink, and a
// stated hide beats a silently cropped preview.
export const DOCK_SLOT_MIN_VISIBLE_FRACTION = 0.98

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function parsePreviewWindowMode(raw: unknown): PreviewWindowMode {
  return raw === 'docked' ? 'docked' : 'floating'
}

// IPC boundary validation: a malformed renderer report must never reach the
// bounds pipeline. Numbers are required finite; the rect must have area.
export function parseDockSlotReport(raw: unknown): DockSlotReport | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const report = raw as Record<string, unknown>
  const epoch = finite(report.epoch)
  const x = finite(report.x)
  const y = finite(report.y)
  const width = finite(report.width)
  const height = finite(report.height)
  const visibleFraction = finite(report.visibleFraction)
  if (
    epoch === null ||
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    visibleFraction === null
  ) {
    return null
  }
  return {
    epoch,
    x,
    y,
    width: Math.max(0, width),
    height: Math.max(0, height),
    visibleFraction: Math.min(1, Math.max(0, visibleFraction)),
    mounted: report.mounted === true
  }
}

// Screen rect for the docked preview window: slot rect offset by the main
// window's CONTENT origin (CSS (0,0) maps to the content origin, so this holds
// for framed and hiddenInset chrome alike). Rounded to whole pixels because
// window managers reject fractional frames.
export function composeDockedScreenRect(slot: Rect, mainContentBounds: Rect): Rect {
  return {
    x: Math.round(mainContentBounds.x + slot.x),
    y: Math.round(mainContentBounds.y + slot.y),
    width: Math.max(1, Math.round(slot.width)),
    height: Math.max(1, Math.round(slot.height))
  }
}

export interface DockVisibilityInput {
  slot: DockSlotReport | null
  currentEpoch: number
  mainWindowVisible: boolean
  mainWindowMinimized: boolean
  mainWindowFullScreen: boolean
  overlayOpen: boolean
}

export interface DockVisibilityDecision {
  visible: boolean
  hiddenReason: DockHiddenReason | null
}

// One predicate decides whether the docked surface may show; every hide has a
// stated reason the slot UI can display (never a silently missing preview).
// Order matters: window-level conditions outrank slot-level ones so the reason
// shown matches what the user actually did last.
export function decideDockVisibility(input: DockVisibilityInput): DockVisibilityDecision {
  if (input.mainWindowFullScreen) {
    return { visible: false, hiddenReason: 'main-window-fullscreen' }
  }
  if (!input.mainWindowVisible || input.mainWindowMinimized) {
    return { visible: false, hiddenReason: 'main-window-hidden' }
  }
  if (input.overlayOpen) {
    return { visible: false, hiddenReason: 'overlay-open' }
  }
  const slot = input.slot
  if (!slot || slot.epoch !== input.currentEpoch) {
    return { visible: false, hiddenReason: 'no-slot-report' }
  }
  if (!slot.mounted) {
    return { visible: false, hiddenReason: 'slot-unmounted' }
  }
  if (slot.width < 1 || slot.height < 1 || slot.visibleFraction < DOCK_SLOT_MIN_VISIBLE_FRACTION) {
    return { visible: false, hiddenReason: 'scrolled-away' }
  }
  return { visible: true, hiddenReason: null }
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
