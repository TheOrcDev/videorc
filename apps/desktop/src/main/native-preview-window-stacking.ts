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
