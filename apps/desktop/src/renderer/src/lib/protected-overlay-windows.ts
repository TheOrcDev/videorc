import type { DeviceList } from '@/lib/backend'

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
