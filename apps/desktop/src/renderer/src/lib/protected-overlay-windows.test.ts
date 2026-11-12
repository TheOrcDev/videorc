import { describe, expect, it } from 'vitest'

import type { DeviceList } from '@/lib/backend'

import {
  deviceListWithoutProtectedOverlayWindows,
  protectedOverlayWindowIdsFromOverlayWindows,
  streamManagerHiddenFromViewers,
  streamManagerProtectedOverlayWindow
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

  // Plan 215 D6: the Stream Manager is excluded, and left out of the window
  // picker, only while Hide from stream is on.
  it('counts the Stream Manager only while Hide from stream is on', () => {
    expect(
      protectedOverlayWindowIdsFromOverlayWindows(
        streamManagerProtectedOverlayWindow({ open: true, windowId: 22, hiddenFromStream: false })
      )
    ).toEqual([])
    expect(
      protectedOverlayWindowIdsFromOverlayWindows(
        streamManagerProtectedOverlayWindow({ open: true, windowId: 22, hiddenFromStream: true })
      )
    ).toEqual([22])
    expect(
      protectedOverlayWindowIdsFromOverlayWindows(
        streamManagerProtectedOverlayWindow({ open: false, windowId: 22, hiddenFromStream: true })
      )
    ).toEqual([])
    expect(
      protectedOverlayWindowIdsFromOverlayWindows(
        streamManagerProtectedOverlayWindow({ open: true, hiddenFromStream: true })
      )
    ).toEqual([])
    const current = deviceList()
    expect(
      deviceListWithoutProtectedOverlayWindows(
        current,
        streamManagerProtectedOverlayWindow({ open: true, windowId: 22, hiddenFromStream: false })
      )
    ).toBe(current)
    expect(
      deviceListWithoutProtectedOverlayWindows(
        current,
        { open: true, windowId: 11 },
        streamManagerProtectedOverlayWindow({ open: true, windowId: 22, hiddenFromStream: true })
      ).devices.map((device) => device.id)
    ).toEqual(['window:screencapturekit:33', 'screen:screencapturekit:1'])
  })

  it('returns the original device list when no protected windows match', () => {
    const current = deviceList()
    expect(deviceListWithoutProtectedOverlayWindows(current, { open: false, windowId: 11 })).toBe(
      current
    )
  })
})

describe('streamManagerHiddenFromViewers (plan 230)', () => {
  const on = {
    open: true,
    hiddenFromStream: true,
    protected: false,
    windowId: 7
  }

  it('is hidden only when the switch is on and the platform really hides it', () => {
    expect(streamManagerHiddenFromViewers({ ...on, hideFromStreamMethod: 'capture-filter' })).toBe(
      true
    )
    expect(
      streamManagerHiddenFromViewers({
        ...on,
        hideFromStreamMethod: 'content-protection',
        protected: true
      })
    ).toBe(true)
  })

  it('is not hidden when the method failed, is missing, or the switch is off', () => {
    for (const state of [
      { ...on, hideFromStreamMethod: 'capture-filter' as const, windowId: undefined },
      { ...on, hideFromStreamMethod: 'content-protection' as const, protected: false },
      { ...on, hideFromStreamMethod: 'unsupported' as const },
      { ...on, hideFromStreamMethod: 'capture-filter' as const, hiddenFromStream: false },
      { ...on, hideFromStreamMethod: 'capture-filter' as const, open: false }
    ]) {
      expect(streamManagerHiddenFromViewers(state)).toBe(false)
    }
  })
})
