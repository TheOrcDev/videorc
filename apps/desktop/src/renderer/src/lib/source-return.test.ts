import { describe, expect, it } from 'vitest'
import type { Device } from './backend'
import {
  buildCameraSources,
  persistableCaptureConfig,
  defaultCaptureConfig,
  reconcileSourceSelection
} from './capture'
import {
  cameraIsAvailable,
  cameraPreviewStartAllowed,
  returningSourceChoices,
  sourceReturnAction
} from './source-return'

const screen: Device = {
  id: 'screen:screencapturekit:1',
  name: 'Display',
  kind: 'screen',
  status: 'available'
}
const camera: Device = { id: 'iphone', name: 'iPhone', kind: 'camera', status: 'available' }
const substitute: Device = { ...camera, id: 'builtin', name: 'Built-in' }

describe('wanted devices returning (D6)', () => {
  const wanted = { cameraId: camera.id, cameraName: camera.name }
  const standIn = reconcileSourceSelection(wanted, [screen, substitute])
  const devices = [screen, substitute, camera]

  it('switches back immediately while idle', () => {
    expect(reconcileSourceSelection(standIn, devices).cameraId).toBe(camera.id)
    expect(returningSourceChoices(reconcileSourceSelection(standIn, devices), devices)).toEqual([])
  })

  it('holds the substitute in-session and offers the wanted camera for a click', () => {
    expect(reconcileSourceSelection(standIn, devices, { holdStandIns: true })).toEqual(standIn)
    expect(returningSourceChoices(standIn, devices)).toEqual([{ kind: 'camera', device: camera }])
    const clicked = buildCameraSources(standIn, devices, camera.id)
    expect(clicked.cameraId).toBe(camera.id)
    expect(clicked.wantedCameraId).toBeUndefined()
    expect(returningSourceChoices(clicked, devices)).toEqual([])
    expect(
      persistableCaptureConfig({ ...defaultCaptureConfig, sources: standIn }).sources.cameraId
    ).toBe(camera.id)
  })

  it('does not offer missing or permission-blocked devices on unrelated list changes', () => {
    expect(returningSourceChoices(standIn, [screen, substitute])).toEqual([])
    expect(
      returningSourceChoices(standIn, [
        ...devices.filter((d) => d.id !== camera.id),
        { ...camera, status: 'permission-required' }
      ])
    ).toEqual([])
    expect(cameraIsAvailable(camera.id, [screen, substitute])).toBe(false)
    expect(cameraIsAvailable(camera.id, devices)).toBe(true)
  })

  it('offers a returned screen or window without changing it mid-session', () => {
    for (const kind of ['screen', 'window'] as const) {
      const device: Device = { ...screen, id: `${kind}:screencapturekit:2`, name: 'Wanted', kind }
      const sources = reconcileSourceSelection(
        kind === 'screen'
          ? { screenId: device.id, screenName: device.name }
          : { windowId: device.id, windowName: device.name },
        [screen]
      )
      const back = [screen, device]
      expect(reconcileSourceSelection(sources, back, { holdStandIns: true })).toEqual(sources)
      expect(returningSourceChoices(sources, back)).toEqual([{ kind: 'capture', device }])
      const idle = reconcileSourceSelection(sources, back)
      expect(idle.windowId ?? idle.screenId).toBe(device.id)
    }
  })
})

it('does not re-grab a failed camera on unrelated device-list updates', () => {
  for (const state of ['failed', 'device-missing']) {
    expect(cameraPreviewStartAllowed(camera.id, [screen, camera], 'key', 'key', state)).toBe(false)
    expect(
      cameraPreviewStartAllowed(camera.id, [screen, camera, substitute], 'key', 'key', state)
    ).toBe(false)
    expect(cameraPreviewStartAllowed(camera.id, [screen, substitute], 'key', null, state)).toBe(
      false
    )
    expect(cameraPreviewStartAllowed(camera.id, [screen, camera], 'key', null, state)).toBe(true)
  }
})

it('restores while idle with Clips on, and offers a click for recordings and streams', () => {
  expect(sourceReturnAction({ state: 'idle' })).toBe('restore')
  for (const state of ['starting', 'recording', 'streaming', 'stopping'] as const) {
    expect(sourceReturnAction({ state, replayOnly: true })).toBe('restore')
    expect(sourceReturnAction({ state })).toBe('offer')
  }
})
