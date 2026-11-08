// Docked ("stick") preview placement math. The renderer reports the Studio
// slot's rect RELATIVE TO THE WINDOW CONTENT — a value that does not change
// while the app window is dragged — and main composes it with its own,
// synchronously-known main-window content bounds. The renderer is never in the
// movement path; that renderer-driven screen-space sync is what made the 2026-06-09
// glue attempt (9f815a23) lag and drift, and it must not come back.

import type {
  DockHiddenReason,
  DockSlot,
  DockSlotReport,
  PreviewWindowMode
} from '../shared/backend'
import { DOCK_SLOTS } from '../shared/backend'

export type { DockHiddenReason, DockSlot, DockSlotReport, PreviewWindowMode }

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

/**
 * The mode a launch starts in (plan 213 D5). A saved choice wins. With none
 * saved, a new install starts stuck to the app: one window, as in OBS, and
 * nothing a tiling window manager can move on its own. An existing install
 * keeps floating: the mode is only written when the streamer toggles it, so
 * one who never did has prefs (a frame, open/closed) but no mode, and their
 * Preview must not dock itself after an update (D4: existing installs keep
 * their mode). Smoke and probe runs (`scripted`: nothing is restored or
 * saved) start floating, the state every probe assumes before it sets the
 * mode it tests.
 */
export function initialPreviewWindowMode(
  savedMode: unknown,
  options: { scripted: boolean; existingInstall: boolean }
): PreviewWindowMode {
  if (savedMode === 'docked' || savedMode === 'floating') {
    return savedMode
  }
  return options.scripted || options.existingInstall ? 'floating' : 'docked'
}

/**
 * What a floating Preview does with a size it did not choose (plan 213 D4): a
 * tiling window manager's tile, or a programmatic setBounds. On macOS AppKit
 * already keeps the user's own drags on the output aspect, so the window
 * keeps the size and draws the video aspect-fit inside, with bars; setting
 * the size back would start a fight with the manager (AeroSpace re-tiles, we
 * conform, it re-tiles). Elsewhere the backstop conforms the window.
 */
export type PreviewWindowExternalResizePolicy = 'fit-inside' | 'conform-window'

export function previewWindowExternalResizePolicy(
  platform: NodeJS.Platform
): PreviewWindowExternalResizePolicy {
  return platform === 'darwin' ? 'fit-inside' : 'conform-window'
}

/**
 * The largest rect of `ratio` (width / height) inside `region`, centred and
 * rounded to whole points: the video region of a floating Preview whose
 * window is not on the output aspect.
 */
export function aspectFitRect(region: Rect, ratio: number): Rect {
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9
  const regionWidth = Math.max(1, region.width)
  const regionHeight = Math.max(1, region.height)
  let width = regionWidth
  let height = Math.round(width / safeRatio)
  if (height > regionHeight) {
    height = regionHeight
    width = Math.round(height * safeRatio)
  }
  width = Math.max(1, Math.min(regionWidth, width))
  height = Math.max(1, Math.min(regionHeight, height))
  return {
    x: Math.round(region.x + (regionWidth - width) / 2),
    y: Math.round(region.y + (regionHeight - height) / 2),
    width,
    height
  }
}

/**
 * What the Preview window remembers as it closes: its frame, and that the
 * streamer closed it. Quitting closes every window without anyone choosing
 * to, so a quit keeps `open` as it was and the next launch restores a Preview
 * that was open (U3: the open/closed choice survives a relaunch). Notes, the
 * Stream Manager and Captions restore at launch too and close by this rule.
 */
export function previewWindowClosePrefs(
  frame: Rect | null,
  appQuitting: boolean
): { frame?: Rect; open?: false } {
  return {
    ...(frame ? { frame } : {}),
    ...(appQuitting ? {} : { open: false })
  }
}

export function parseDockSlot(raw: unknown): DockSlot | null {
  return typeof raw === 'string' && (DOCK_SLOTS as readonly string[]).includes(raw)
    ? (raw as DockSlot)
    : null
}

// IPC boundary validation: a malformed renderer report must never reach the
// bounds pipeline. Numbers are required finite; the rect must have area; the
// slot must name a known DOM slot (an unknown slot is a contract drift, not a
// placement to guess at).
export function parseDockSlotReport(raw: unknown): DockSlotReport | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const report = raw as Record<string, unknown>
  const slot = parseDockSlot(report.slot)
  if (slot === null) {
    return null
  }
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
    slot,
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

export interface Size {
  width: number
  height: number
}

/** The size a slot report measured, or null when it has none to give: no
 * report, a slot that unmounted (another tab), or a collapsed rect. */
export function usableDockSlotSize(slot: DockSlotReport | null): Size | null {
  if (!slot || !slot.mounted || slot.width < 1 || slot.height < 1) {
    return null
  }
  return { width: Math.round(slot.width), height: Math.round(slot.height) }
}

/**
 * The in-window dock's video rect (the Linux proof surface, the macOS
 * in-process layer): the slot while it has a rect, else the content origin at
 * `fallback`, the last size a slot measured. With no usable slot the surface
 * is hidden anyway (decideDockVisibility), but the backend sizes the idle
 * program from these bounds (preview_surface.rs), so a 1×1 rect would make
 * the program a single pixel on every other tab: what `get_picture` hands an
 * agent, and what the Preview first shows on return. 1×1 only before any
 * size is known at all.
 */
export function inWindowDockedRect(
  slot: DockSlotReport | null,
  mainContentBounds: Rect,
  fallback: Size | null
): Rect {
  if (slot && usableDockSlotSize(slot)) {
    return composeDockedScreenRect(slot, mainContentBounds)
  }
  return {
    x: Math.round(mainContentBounds.x),
    y: Math.round(mainContentBounds.y),
    width: Math.max(1, Math.round(fallback?.width ?? 1)),
    height: Math.max(1, Math.round(fallback?.height ?? 1))
  }
}

export interface DockVisibilityInput {
  slot: DockSlotReport | null
  currentEpoch: number
  mainWindowVisible: boolean
  mainWindowMinimized: boolean
  mainWindowFullScreen: boolean
  // The surface is drawn inside the main window's own view (the macOS
  // in-process layer, the Linux in-window proof surface), not in a child
  // window: fullscreen keeps it, since it is part of the window now.
  surfaceInsideMainWindow?: boolean
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
  if (input.mainWindowFullScreen && !input.surfaceInsideMainWindow) {
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
