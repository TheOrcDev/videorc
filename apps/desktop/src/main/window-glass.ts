// One window material for every Videorc window (plan 050, D1).
//
// Real macOS vibrancy: an NSVisualEffectView blurring what sits behind the
// window. A 2026-09-23 region-capture probe showed it transmits on Electron 39
// / macOS 26 in the real Videorc window; the June 2026 "materials paint
// opaque" premise no longer reproduces. Every window's chrome (material,
// backing, title bar, traffic lights) is decided here and nowhere else, so the
// windows stay one family and a future material (e.g. macOS 26's
// NSGlassEffectView, not exposed by Electron 39) is a one-file change.

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

import { DARK_WINDOW_PALETTE, LIGHT_WINDOW_PALETTE } from './window-palette'

export type GlassWindowRole = 'main' | 'chat' | 'captions' | 'notes' | 'preview'

/** A material `setVibrancy` accepts (the deprecated `appearance-based` is not one). */
export type GlassMaterial = NonNullable<Parameters<BrowserWindow['setVibrancy']>[0]>

export type GlassMode =
  | { kind: 'material'; material: GlassMaterial }
  | { kind: 'mica' }
  | { kind: 'solid'; reason: 'disabled' | 'platform' | 'appearance-unpinned' }

export interface GlassEnvironment {
  platform: NodeJS.Platform
  /** `VIDEORC_GLASS`: `0` paints the solid palette; a material name overrides the material. */
  glass?: string
  /** Legacy `VIDEORC_GLASS_VIBRANCY`, honoured as an alias for one release. */
  legacyVibrancy?: string
  /** Windows build number (from `os.release()`), which decides Mica. */
  windowsBuild?: number
}

/**
 * Windows 11 22H2: the first build whose DWM backdrop (`backgroundMaterial`)
 * Electron can set. Older builds, and Windows 10, keep the solid palette.
 */
export const WINDOWS_MICA_MIN_BUILD = 22621

/** The build from an `os.release()` string such as `10.0.22631`. */
export function windowsBuildFromRelease(release: string): number | undefined {
  const build = Number.parseInt(release.split('.')[2] ?? '', 10)
  return Number.isFinite(build) ? build : undefined
}

/** The one material. `sidebar` and `fullscreen-ui` also transmit; `fullscreen-ui` is far too light over white. */
export const DEFAULT_GLASS_MATERIAL: GlassMaterial = 'under-window'

const GLASS_MATERIALS: readonly GlassMaterial[] = [
  'titlebar',
  'selection',
  'menu',
  'popover',
  'sidebar',
  'header',
  'sheet',
  'window',
  'hud',
  'fullscreen-ui',
  'tooltip',
  'content',
  'under-window',
  'under-page'
]

function glassMaterialFrom(value: string | undefined): GlassMaterial | null {
  const trimmed = value?.trim()
  return trimmed && (GLASS_MATERIALS as readonly string[]).includes(trimmed)
    ? (trimmed as GlassMaterial)
    : null
}

export function resolveGlassMode(environment: GlassEnvironment): GlassMode {
  const disabled = environment.glass?.trim() === '0' || environment.legacyVibrancy?.trim() === '0'
  if (environment.platform === 'win32') {
    // Mica (plan 050, D7): it tints from the wallpaper without a live blur, so
    // it stays cheap on the low-end iGPUs Windows testers use.
    if (disabled) {
      return { kind: 'solid', reason: 'disabled' }
    }
    return (environment.windowsBuild ?? 0) >= WINDOWS_MICA_MIN_BUILD
      ? { kind: 'mica' }
      : { kind: 'solid', reason: 'platform' }
  }
  if (environment.platform !== 'darwin') {
    return { kind: 'solid', reason: 'platform' }
  }
  if (disabled) {
    return { kind: 'solid', reason: 'disabled' }
  }
  const material =
    glassMaterialFrom(environment.glass) ??
    glassMaterialFrom(environment.legacyVibrancy) ??
    DEFAULT_GLASS_MATERIAL
  return { kind: 'material', material }
}

/** Header height per role: the traffic lights centre on it. */
export const WINDOW_HEADER_HEIGHT: Readonly<Record<GlassWindowRole, number>> = Object.freeze({
  main: 40,
  chat: 40,
  captions: 40,
  notes: 40,
  // Load-bearing: PREVIEW_WINDOW_BAR_HEIGHT drives the aspect lock and the
  // native surface placement. The preview frame keeps its compact strip.
  preview: 28
})

export const MAC_TRAFFIC_LIGHT_X = 14
export const MAC_TRAFFIC_LIGHT_DIAMETER = 14

export function trafficLightPosition(role: GlassWindowRole): { x: number; y: number } {
  return {
    x: MAC_TRAFFIC_LIGHT_X,
    y: Math.round((WINDOW_HEADER_HEIGHT[role] - MAC_TRAFFIC_LIGHT_DIAMETER) / 2)
  }
}

/**
 * Roles that stay dark whatever the app theme: only the Preview, which frames
 * video. Its appearance is pinned per window, because `nativeTheme` is
 * app-global and would otherwise turn its material light. Stream Manager,
 * Captions and Notes follow the app theme like main (their pages follow
 * prefers-color-scheme, which `nativeTheme.themeSource` drives).
 */
export const DARK_ALWAYS_ROLES: ReadonlySet<GlassWindowRole> = new Set(['preview'])

/**
 * A dark-always window whose appearance cannot be pinned paints the solid
 * palette: its material would otherwise follow a light app theme and put dark
 * text tokens on light glass. Windows has no per-window appearance pin, so
 * there the dark-always windows are always solid.
 */
export function glassModeForRole(
  role: GlassWindowRole,
  mode: GlassMode,
  appearancePinAvailable: boolean
): GlassMode {
  if (mode.kind !== 'solid' && DARK_ALWAYS_ROLES.has(role) && !appearancePinAvailable) {
    return { kind: 'solid', reason: 'appearance-unpinned' }
  }
  return mode
}

export function solidWindowBase(role: GlassWindowRole, dark: boolean): string {
  return (DARK_ALWAYS_ROLES.has(role) || dark ? DARK_WINDOW_PALETTE : LIGHT_WINDOW_PALETTE).base
}

export function windowGlassOptions(
  role: GlassWindowRole,
  context: { platform: NodeJS.Platform; mode: GlassMode; dark: boolean }
): BrowserWindowConstructorOptions {
  const chrome: BrowserWindowConstructorOptions =
    context.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: trafficLightPosition(role) }
      : {}
  if (context.mode.kind === 'mica') {
    // The web contents must be transparent for the backdrop to show through;
    // the body's window coat does the rest. The native frame stays.
    return { ...chrome, backgroundMaterial: 'mica', backgroundColor: '#00000000' }
  }
  if (context.mode.kind === 'material') {
    // No `transparent` backing: with a vibrancy material Electron already
    // renders the web contents transparent, and the window keeps its native
    // shadow and resize edges. `active` keeps the glass live when the window
    // is not focused (followWindow paints flat gray).
    return { ...chrome, vibrancy: context.mode.material, visualEffectState: 'active' }
  }
  return { ...chrome, backgroundColor: solidWindowBase(role, context.dark) }
}

export type GlassAppearance = 'follows-app' | 'pinned-dark' | 'pin-unavailable'

export interface AppliedGlass {
  role: GlassWindowRole
  mode: GlassMode
  appearance: GlassAppearance
  /** Why the appearance pin is unavailable, when it is. */
  appearanceNote?: string
}

const appliedGlassByWindow = new WeakMap<BrowserWindow, AppliedGlass>()

export function recordAppliedGlass(window: BrowserWindow, applied: AppliedGlass): void {
  appliedGlassByWindow.set(window, applied)
}

export function appliedGlass(window: BrowserWindow | null | undefined): AppliedGlass | null {
  return window ? (appliedGlassByWindow.get(window) ?? null) : null
}
