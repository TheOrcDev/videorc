import { describe, expect, it } from 'vitest'

import type { Device, SourceSelection } from '../../../shared/backend'
import { rebindRememberedWindow, shouldRefreshWindowListBeforeStart } from './window-source-rebind'

const alphaOld = 'window:screencapturekit:40696'
const alphaNew = 'window:screencapturekit:51234'

function window(id: string, name: string, status: Device['status'] = 'available'): Device {
  return { id, name, kind: 'window', status }
}

function screen(id: string, name: string): Device {
  return { id, name, kind: 'screen', status: 'available' }
}

const picked: SourceSelection = {
  windowId: alphaOld,
  windowName: 'Fixture Alpha - Alpha',
  cameraOff: true
}

describe('plan 219 S3: a closed-and-reopened window is picked up again', () => {
  it('rebinds the pick to the same window under its new id', () => {
    const rebound = rebindRememberedWindow(picked, [
      screen('screen:screencapturekit:1', 'Display 1'),
      window(alphaNew, 'Fixture Alpha - Alpha'),
      window('window:screencapturekit:777', 'Fixture Beta - Beta')
    ])
    expect(rebound).toEqual({ ...picked, windowId: alphaNew, windowName: 'Fixture Alpha - Alpha' })
  })

  it('leaves the selection alone when the window is listed under its own id', () => {
    expect(
      rebindRememberedWindow(picked, [
        window(alphaOld, 'Fixture Alpha - Alpha'),
        window(alphaNew, 'Fixture Alpha - Alpha')
      ])
    ).toBeNull()
  })

  it('leaves the selection unchanged when nothing matches, so the backend can say it was closed', () => {
    expect(
      rebindRememberedWindow(picked, [
        screen('screen:screencapturekit:1', 'Display 1'),
        window('window:screencapturekit:777', 'Fixture Beta - Beta'),
        window(alphaNew, 'Fixture Alpha - Alpha', 'unavailable')
      ])
    ).toBeNull()
  })

  it('never substitutes a display, even one with the same name', () => {
    expect(
      rebindRememberedWindow(picked, [screen('screen:screencapturekit:9', 'Fixture Alpha - Alpha')])
    ).toBeNull()
  })

  it('never touches a display pick or a portal window', () => {
    expect(
      rebindRememberedWindow({ screenId: 'screen:screencapturekit:1', screenName: 'Display 1' }, [
        window(alphaNew, 'Display 1')
      ])
    ).toBeNull()
    expect(
      rebindRememberedWindow({ windowId: 'window:portal:window', windowName: 'Portal' }, [
        window(alphaNew, 'Portal')
      ])
    ).toBeNull()
  })

  it('reads the list only when the capture is not live on the picked window', () => {
    expect(shouldRefreshWindowListBeforeStart(picked, { state: 'live', sourceId: alphaOld })).toBe(
      false
    )
    expect(shouldRefreshWindowListBeforeStart(picked, { state: 'live', sourceId: alphaNew })).toBe(
      true
    )
    expect(
      shouldRefreshWindowListBeforeStart(picked, { state: 'source-missing', sourceId: alphaOld })
    ).toBe(true)
    expect(shouldRefreshWindowListBeforeStart(picked, { state: 'failed' })).toBe(true)
    expect(shouldRefreshWindowListBeforeStart({ windowId: undefined }, { state: 'failed' })).toBe(
      false
    )
  })
})
