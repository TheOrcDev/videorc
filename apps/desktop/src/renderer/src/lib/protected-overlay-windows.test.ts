import { describe, expect, it } from 'vitest'

import type { DeviceList } from '@/lib/backend'

import {
  deviceListWithoutProtectedOverlayWindows,
  protectedOverlayWindowIdsFromOverlayWindows
} from './protected-overlay-windows'

function deviceList(): DeviceList {
  return {
    warnings: [],
    devices: [
      { id: 'window:screencapturekit:11', name: 'Notes', kind: 'window', status: 'available' },
      { id: 'window:screencapturekit:22', name: 'Comments', kind: 'window', status: 'available' },
      { id: 'window:screencapturekit:33', name: 'Captions', kind: 'window', status: 'available' },
      { id: 'screen:screencapturekit:1', name: 'Display', kind: 'screen', status: 'available' }
    ]
  }
}

describe('protected overlay windows', () => {
  it('collects ids only from open overlay windows with native ids', () => {
    expect(
      protectedOverlayWindowIdsFromOverlayWindows(
        { open: true, windowId: 11 },
        { open: false, windowId: 22 },
        { open: true }
      )
    ).toEqual([11])
  })

  it('filters notes, comments, and captions windows from capturable window sources', () => {
    const filtered = deviceListWithoutProtectedOverlayWindows(
      deviceList(),
      { open: true, windowId: 11 },
      { open: true, windowId: 22 },
      { open: true, windowId: 33 }
    )

    expect(filtered.devices.map((device) => device.id)).toEqual(['screen:screencapturekit:1'])
  })

  it('returns the original device list when no protected windows match', () => {
    const current = deviceList()
    expect(deviceListWithoutProtectedOverlayWindows(current, { open: false, windowId: 11 })).toBe(
      current
    )
  })
})
