// Per-window AppKit appearance (plan 050, D1).
//
// Electron's `nativeTheme.themeSource` is app-global, so a light main window
// would give every window a light vibrancy material. The dark-always windows
// (Chat, Captions, Notes, Preview) pin `darkAqua` on their own NSWindow
// through the in-process native addon instead. The binding is loaded on its
// own, independent of the preview driver: a window must not lose its pin
// because the preview fell back to the helper process.

import type { NativePreviewInProcessModuleResolution } from './native-preview-in-process-module-path'

export type WindowAppearance = 'dark' | 'light' | 'system'

export interface WindowEffectView {
  state: 'active' | 'inactive' | 'follows-window'
  material: number
  blendingMode: number
}

export interface WindowAppearanceBinding {
  /** Pins the window's appearance; false when the view has no NSWindow yet. */
  setWindowAppearance(nativeWindowHandle: Buffer, appearance: WindowAppearance): boolean
  /** Reads back the window's vibrancy views (diagnostics; older addons lack it). */
  windowEffectViews?(nativeWindowHandle: Buffer): WindowEffectView[]
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
  return {
    setWindowAppearance: (nativeWindowHandle, appearance) =>
      setWindowAppearance(nativeWindowHandle, appearance) === true,
    ...(windowEffectViews
      ? { windowEffectViews: (nativeWindowHandle: Buffer) => windowEffectViews(nativeWindowHandle) }
      : {})
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
