// Per-window AppKit appearance (plan 050, D1).
//
// Electron's `nativeTheme.themeSource` is app-global, so a light main window
// would give every window a light vibrancy material. The dark-always window
// (Preview, which frames video) pins `darkAqua` on its own NSWindow
// through the in-process native addon instead. The binding is loaded on its
// own, independent of the preview driver: a window must not lose its pin
// because the preview fell back to the helper process.

import type { NativePreviewInProcessModuleResolution } from './native-preview-in-process-module-path'

export type WindowAppearance = 'dark' | 'light' | 'system'

export interface WindowEffectView {
  state: 'active' | 'inactive' | 'follows-window'
  material: number
  blendingMode: number
  /** Plan 091 diagnostics (an addon built before them reports none of these). */
  className?: string
  /** The view carries the clear-glass class (`VideorcClearGlassView`). */
  clear?: boolean
  /** The backdrop's gaussian blur radius, read back from its filter. */
  blurRadius?: number | null
  /** A wallpaper-tinting layer is visible (null: none in the tree). */
  chameleonVisible?: boolean | null
  /** The material's saturation boost is still in the tree. */
  saturatePresent?: boolean
  /** The root layer's background (the snapshot base), if set. */
  rootBackground?: string | null
  /** The layer tree, one line per layer. */
  layerTree?: string[]
}

export interface WindowGlassStyleResult {
  restyled: boolean
  reason: string | null
}

export interface WindowAppearanceBinding {
  /** Pins the window's appearance; false when the view has no NSWindow yet. */
  setWindowAppearance(nativeWindowHandle: Buffer, appearance: WindowAppearance): boolean
  /** Reads back the window's vibrancy views (diagnostics; older addons lack it). */
  windowEffectViews?(nativeWindowHandle: Buffer): WindowEffectView[]
  /**
   * Re-classes the window's vibrancy view to the clear-glass subclass and
   * redraws it (plan 091; older addons lack it).
   */
  setWindowGlassStyle?(
    nativeWindowHandle: Buffer,
    options: { blurRadius: number }
  ): WindowGlassStyleResult
}

export type WindowAppearanceLoad =
  | { binding: WindowAppearanceBinding; unavailableReason: null }
  | { binding: null; unavailableReason: string }

export type WindowAppearancePin = { pinned: true } | { pinned: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function windowAppearanceBindingFromModule(
  moduleValue: unknown
): WindowAppearanceBinding | null {
  const candidate =
    isRecord(moduleValue) && isRecord(moduleValue.default) ? moduleValue.default : moduleValue
  if (!isRecord(candidate) || typeof candidate.setWindowAppearance !== 'function') {
    return null
  }
  const setWindowAppearance = candidate.setWindowAppearance as (
    nativeWindowHandle: Buffer,
    appearance: string
  ) => unknown
  const windowEffectViews =
    typeof candidate.windowEffectViews === 'function'
      ? (candidate.windowEffectViews as (nativeWindowHandle: Buffer) => WindowEffectView[])
      : null
  const setWindowGlassStyle =
    typeof candidate.setWindowGlassStyle === 'function'
      ? (candidate.setWindowGlassStyle as (
          nativeWindowHandle: Buffer,
          options: { blurRadius: number }
        ) => WindowGlassStyleResult)
      : null
  return {
    setWindowAppearance: (nativeWindowHandle, appearance) =>
      setWindowAppearance(nativeWindowHandle, appearance) === true,
    ...(windowEffectViews
      ? { windowEffectViews: (nativeWindowHandle: Buffer) => windowEffectViews(nativeWindowHandle) }
      : {}),
    ...(setWindowGlassStyle
      ? {
          setWindowGlassStyle: (nativeWindowHandle: Buffer, options: { blurRadius: number }) => {
            const result = setWindowGlassStyle(nativeWindowHandle, options)
            return {
              restyled: isRecord(result) && result.restyled === true,
              reason: isRecord(result) && typeof result.reason === 'string' ? result.reason : null
            }
          }
        }
      : {})
  }
}

export type ClearGlassApplication = { applied: true } | { applied: false; reason: string }

/**
 * Runs the clear-glass strip on a window's vibrancy view (plan 091). The
 * reason names what stood in the way: no addon, an addon built before the
 * export, a view the addon refused to re-class, or a thrown call.
 */
export function applyClearGlass(
  load: WindowAppearanceLoad,
  nativeWindowHandle: () => Buffer,
  blurRadius: number
): ClearGlassApplication {
  if (!load.binding) {
    return { applied: false, reason: load.unavailableReason }
  }
  if (!load.binding.setWindowGlassStyle) {
    return {
      applied: false,
      reason:
        'The native addon has no setWindowGlassStyle export; rebuild it with pnpm build:native-preview-addon.'
    }
  }
  try {
    const result = load.binding.setWindowGlassStyle(nativeWindowHandle(), { blurRadius })
    return result.restyled
      ? { applied: true }
      : { applied: false, reason: result.reason ?? 'The addon re-classed no effect view.' }
  } catch (error) {
    return {
      applied: false,
      reason: `Applying the clear glass failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export function loadWindowAppearanceBinding(options: {
  platform: NodeJS.Platform
  resolution: NativePreviewInProcessModuleResolution
  loadModule: (modulePath: string) => unknown
}): WindowAppearanceLoad {
  if (options.platform !== 'darwin') {
    return { binding: null, unavailableReason: 'Window appearance pins exist only on macOS.' }
  }
  if (options.resolution.source === 'unavailable') {
    return { binding: null, unavailableReason: options.resolution.reason }
  }
  try {
    const binding = windowAppearanceBindingFromModule(options.loadModule(options.resolution.path))
    return binding
      ? { binding, unavailableReason: null }
      : {
          binding: null,
          unavailableReason:
            'The native addon has no setWindowAppearance export; rebuild it with pnpm build:native-preview-addon.'
        }
  } catch (error) {
    return {
      binding: null,
      unavailableReason: `The native addon failed to load: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export function pinWindowAppearance(
  load: WindowAppearanceLoad,
  nativeWindowHandle: () => Buffer,
  appearance: WindowAppearance
): WindowAppearancePin {
  if (!load.binding) {
    return { pinned: false, reason: load.unavailableReason }
  }
  try {
    return load.binding.setWindowAppearance(nativeWindowHandle(), appearance)
      ? { pinned: true }
      : { pinned: false, reason: 'The window has no AppKit window to pin yet.' }
  } catch (error) {
    return {
      pinned: false,
      reason: `Pinning the window appearance failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}
