import type { BrowserWindow } from 'electron'

import type { MainOwnedPreviewSurfaceBoundsParams, PreviewSurfaceBounds } from '../shared/backend'
import {
  mainOwnedPreviewSurfaceBoundsParams,
  normalizePreviewSurfaceBounds
} from '../shared/native-preview-bounds'

type PreviewWindowHandleAuthority = Pick<BrowserWindow, 'getNativeWindowHandle' | 'isDestroyed'>

export interface TrustedPreviewWindowStackingInput {
  platform: NodeJS.Platform
  bounds: PreviewSurfaceBounds
  generation: number
  currentGeneration: number
  previewWindowOpen: boolean
  previewWindow: PreviewWindowHandleAuthority | null
  orderAboveWindowId?: number
  elevated: boolean
}

/**
 * The only Electron-main boundary allowed to add a native preview-window
 * identity. The handle is read inside this call so each backend/native-host
 * command receives a fresh HWND tied to the current lifecycle generation.
 */
export function withTrustedPreviewWindowStacking<T>(
  input: TrustedPreviewWindowStackingInput,
  apply: (params: MainOwnedPreviewSurfaceBoundsParams) => T
): T {
  const normalized = normalizePreviewSurfaceBounds(input.bounds)
  if (input.generation !== input.currentGeneration) {
    throw new Error('Native preview stacking rejected a stale lifecycle generation.')
  }
  if (!input.previewWindowOpen || !input.previewWindow || input.previewWindow.isDestroyed()) {
    throw new Error('Native preview stacking requires the current live preview window.')
  }

  const bounds: PreviewSurfaceBounds = {
    ...normalized,
    ...(input.orderAboveWindowId !== undefined
      ? { orderAboveWindowId: input.orderAboveWindowId }
      : {}),
    elevated: input.elevated
  }
  if (input.platform !== 'win32') {
    return apply(mainOwnedPreviewSurfaceBoundsParams(bounds, input.generation))
  }

  const handle = input.previewWindow.getNativeWindowHandle()
  if (handle.length !== 4 && handle.length !== 8) {
    throw new Error(
      `Native preview HWND must use a four- or eight-byte pointer buffer; received ${handle.length}.`
    )
  }
  const value = handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
  if (value === 0n) {
    throw new Error('Native preview HWND must be nonzero.')
  }
  const opaqueHandle = `0x${value.toString(16).padStart(16, '0')}`
  return apply(mainOwnedPreviewSurfaceBoundsParams(bounds, input.generation, opaqueHandle))
}

/**
 * The window the Electron proof surface hangs off: the one the Preview is seen
 * in. An in-window dock (plan 213 D3) keeps the preview window hidden, and on
 * macOS showing a child window orders its hidden parent on screen too, so the
 * empty Preview window appeared at its old floating frame beside the docked
 * one. There the surface is a child of the main window, over the slot it covers.
 */
export function proofSurfaceParentWindow<T extends Pick<BrowserWindow, 'isDestroyed'>>(input: {
  dockedInMainWindow: boolean
  mainWindow: T | null
  previewWindow: T | null
}): T | null {
  const parent = input.dockedInMainWindow
    ? input.mainWindow
    : (input.previewWindow ?? input.mainWindow)
  return parent && !parent.isDestroyed() ? parent : null
}

export type NativePreviewRealSurfaceDriverKind = 'in-process' | 'external-module' | 'helper-process'

/**
 * Where the Electron proof surface lives: inside its host window as a
 * WebContentsView (in-window-proof-surface.ts), or as a separate child
 * window. Linux needs the view because Wayland places no toplevel. macOS gets
 * it too (plan 216 D4): docked over the Scene canvas, the fallback was two
 * borderless windows each asked to ignore the mouse, and on a streamer's
 * macOS no press or drag crossed them to the canvas while the arrow keys
 * worked. The view forwards its mouse to the host window, so no window
 * hit-testing sits in the path. Windows keeps the opaque child window: a
 * transparent window needs its GPU compositor, and the D3D11 presenter orders
 * above the preview window.
 */
export function proofSurfaceHostedInWindowOn(platform: NodeJS.Platform): boolean {
  return platform !== 'win32'
}

/**
 * Whether a docked Preview is drawn inside the main window (one window, as in
 * OBS) with the lifecycle preview window hidden: on macOS the in-process
 * CAMetalLayer is a sublayer of the main window's view (plan 213 D3), and on
 * macOS and Linux the in-window proof surface is a view in it. The macOS
 * helper-process and external drivers still need the child window they order
 * above, so while one of them is resolved the dock keeps its window; after a
 * driver reset (no driver) the proof surface takes the dock inside the main
 * window, which is where the streamer's mouse has to land.
 */
export function previewDockedInsideMainWindow(input: {
  mode: 'docked' | 'floating'
  platform: NodeJS.Platform
  driverKind: NativePreviewRealSurfaceDriverKind | null
}): boolean {
  if (input.mode !== 'docked') {
    return false
  }
  if (input.platform === 'darwin' && input.driverKind === 'in-process') {
    return true
  }
  const driverNeedsChildWindow =
    input.platform === 'darwin' &&
    (input.driverKind === 'helper-process' || input.driverKind === 'external-module')
  return proofSurfaceHostedInWindowOn(input.platform) && !driverNeedsChildWindow
}
