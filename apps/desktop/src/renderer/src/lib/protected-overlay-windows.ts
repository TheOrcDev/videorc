import type { DeviceList, StreamManagerHideMethod } from '@/lib/backend'

export type ProtectedOverlayWindow = {
  open: boolean
  windowId?: number
}

/**
 * The Stream Manager as a protected overlay window (plan 215 D6): it joins
 * the exclusion list, and leaves the window picker, only while its Hide
 * from stream switch is on. Off (the 2026-08-19 default) it is part of the
 * show, so it is neither excluded nor hidden from the picker.
 */
export function streamManagerProtectedOverlayWindow(state: {
  open: boolean
  windowId?: number
  hiddenFromStream: boolean
}): ProtectedOverlayWindow {
  return {
    open: state.open && state.hiddenFromStream,
    ...(typeof state.windowId === 'number' ? { windowId: state.windowId } : {})
  }
}

/** Plan 230: viewers really do not see the Stream Manager. The switch alone
 * is not enough: the capture filter needs the window id, content protection
 * must have taken, and Linux cannot hide it at all. */
export function streamManagerHiddenFromViewers(state: {
  open: boolean
  hiddenFromStream: boolean
  hideFromStreamMethod: StreamManagerHideMethod
  protected: boolean
  windowId?: number
}): boolean {
  if (!state.open || !state.hiddenFromStream) return false
  if (state.hideFromStreamMethod === 'capture-filter') return typeof state.windowId === 'number'
  if (state.hideFromStreamMethod === 'content-protection') return state.protected
  return false
}

export function protectedOverlayWindowIdsFromOverlayWindows(
  ...windows: ProtectedOverlayWindow[]
): number[] {
  return windows
    .filter((window) => window.open && typeof window.windowId === 'number')
    .map((window) => window.windowId as number)
}

export function deviceListWithoutProtectedOverlayWindows(
  deviceList: DeviceList,
  ...windows: ProtectedOverlayWindow[]
): DeviceList {
  const protectedWindowIds = protectedOverlayWindowIdsFromOverlayWindows(...windows)
  if (protectedWindowIds.length === 0) {
    return deviceList
  }
  const protectedIds = new Set(protectedWindowIds.map((id) => `window:screencapturekit:${id}`))
  const devices = deviceList.devices.filter((device) => !protectedIds.has(device.id))
  return devices.length === deviceList.devices.length ? deviceList : { ...deviceList, devices }
}
