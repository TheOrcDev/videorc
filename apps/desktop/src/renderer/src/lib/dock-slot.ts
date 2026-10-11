// Docked ("stick") preview: renderer-side slot measurement. The renderer
// reports the slot rect (the Studio preview card or the Scene canvas) in
// WINDOW-RELATIVE CSS pixels only — never screen coordinates, never on window
// moves (main owns the window-position math; see main/preview-dock.ts for the
// history behind that rule).

import type { DockSlot, DockSlotReport } from './backend'

export interface SlotRect {
  x: number
  y: number
  width: number
  height: number
}

// Rect + visible fraction from one getBoundingClientRect measurement. The
// fraction is the slot area inside the viewport AND inside every scroll
// container that clips the slot: docked previews hide (with a stated reason)
// instead of clipping when the slot scrolls away. The viewport alone is not
// enough: the pane that scrolls starts under a 40 px toolbar, so a slot that
// has scrolled a little under it is still inside the window while the native
// surface, which no DOM clips, paints over the toolbar.
export function measureDockSlot(
  rect: SlotRect,
  viewport: { width: number; height: number },
  clip: SlotRect | null = null
): { rect: SlotRect; visibleFraction: number } {
  const area = rect.width * rect.height
  if (area <= 0) {
    return { rect, visibleFraction: 0 }
  }
  const window: SlotRect = { x: 0, y: 0, width: viewport.width, height: viewport.height }
  const visible = clipRectOf([rect, window, ...(clip ? [clip] : [])])
  const visibleArea = visible ? visible.width * visible.height : 0
  return { rect, visibleFraction: Math.min(1, visibleArea / area) }
}

/** The intersection of the rects (a slot and its clipping ancestors), or null
 * when they share no area or there are none. */
export function clipRectOf(rects: SlotRect[]): SlotRect | null {
  let clip: SlotRect | null = null
  for (const rect of rects) {
    if (!clip) {
      clip = { ...rect }
      continue
    }
    const x = Math.max(clip.x, rect.x)
    const y = Math.max(clip.y, rect.y)
    const right = Math.min(clip.x + clip.width, rect.x + rect.width)
    const bottom = Math.min(clip.y + clip.height, rect.y + rect.height)
    clip = { x, y, width: right - x, height: bottom - y }
  }
  if (!clip) {
    return null
  }
  return clip.width > 0 && clip.height > 0 ? clip : null
}

export function buildDockSlotReport(
  epoch: number,
  slot: DockSlot,
  measurement: { rect: SlotRect; visibleFraction: number },
  mounted: boolean
): DockSlotReport {
  return {
    epoch,
    slot,
    x: measurement.rect.x,
    y: measurement.rect.y,
    width: measurement.rect.width,
    height: measurement.rect.height,
    visibleFraction: measurement.visibleFraction,
    mounted
  }
}

// Send-only-on-change gate for the report loop: sub-pixel layout jitter must
// not turn into IPC chatter. Fractions compare at 1% so the 0.98 show/hide
// threshold in main stays crossable.
export function dockSlotReportChanged(
  previous: DockSlotReport | null,
  next: DockSlotReport
): boolean {
  if (!previous) {
    return true
  }
  return (
    previous.epoch !== next.epoch ||
    previous.slot !== next.slot ||
    previous.mounted !== next.mounted ||
    Math.abs(previous.x - next.x) >= 1 ||
    Math.abs(previous.y - next.y) >= 1 ||
    Math.abs(previous.width - next.width) >= 1 ||
    Math.abs(previous.height - next.height) >= 1 ||
    Math.round(previous.visibleFraction * 100) !== Math.round(next.visibleFraction * 100)
  )
}

// In-app overlays paint inside the main window's web contents, UNDER a native
// surface floating above the window — so the docked preview yields while one
// is up. Scrimmed overlays (dialogs) always block; popper content (popovers,
// menus, selects) blocks only when it geometrically overlaps the slot.
// Tooltips are deliberately exempt: they are transient and everywhere.
export const DOCK_BLOCKING_SCRIM_SELECTOR = '[data-slot="dialog-overlay"][data-state="open"]'

export const DOCK_BLOCKING_POPPER_SELECTOR = [
  '[data-slot="popover-content"][data-state="open"]',
  '[data-slot="dropdown-menu-content"][data-state="open"]',
  '[data-slot="dropdown-menu-sub-content"][data-state="open"]',
  '[data-slot="select-content"][data-state="open"]'
].join(', ')

export function rectsIntersect(a: SlotRect, b: SlotRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

// One decision for "does an open overlay occlude the docked slot right now".
export function overlaysOccludeSlot(
  scrimCount: number,
  popperRects: SlotRect[],
  slotRect: SlotRect | null
): boolean {
  if (scrimCount > 0) {
    return true
  }
  if (!slotRect) {
    return false
  }
  return popperRects.some(
    (rect) => rect.width > 0 && rect.height > 0 && rectsIntersect(rect, slotRect)
  )
}
