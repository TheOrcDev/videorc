import { describe, expect, it } from 'vitest'
import type { Device, PreviewCameraStatus } from './backend'
import {
  buildCameraSources,
  persistableCaptureConfig,
  defaultCaptureConfig,
  reconcileSourceSelection
} from './capture'
import {
  cameraIsAvailable,
  cameraSelectionDiagnostics,
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

it('lets the backend reconnect a disconnected camera without a renderer re-grab', () => {
  expect(
    cameraPreviewStartAllowed(
      camera.id,
      devicesForReconnect(),
      'key',
      null,
      'disconnected',
      camera.id
    )
  ).toBe(false)
  const wanted = { cameraId: camera.id, cameraName: camera.name }
  expect(
    reconcileSourceSelection(wanted, [substitute], { disconnectedCameraId: camera.id })
  ).toMatchObject(wanted)
  expect(
    reconcileSourceSelection(wanted, [substitute], { disconnectedCameraId: camera.id })
      .wantedCameraId
  ).toBeUndefined()
  expect(
    reconcileSourceSelection(wanted, [substitute], { disconnectedCameraId: 'other' }).cameraId
  ).toBe(substitute.id)
})

it('allows an explicit pick of another camera while the held camera is disconnected', () => {
  expect(
    cameraPreviewStartAllowed(
      substitute.id,
      devicesForReconnect(),
      'builtin-key',
      'iphone-key',
      'disconnected',
      camera.id
    )
  ).toBe(true)
})

function devicesForReconnect(): Device[] {
  return [camera, substitute]
}

it('records the wanted camera separately from the camera the backend holds', () => {
  const status: PreviewCameraStatus = {
    state: 'disconnected',
    cameraId: 'builtin',
    deviceUniqueId: 'builtin-uid',
    targetFps: 30,
    framesCaptured: 1,
    droppedFrames: 0,
    updatedAt: '2026-11-01T12:00:00Z'
  }
  expect(
    cameraSelectionDiagnostics(
      { cameraId: 'builtin', wantedCameraId: 'iphone', wantedCameraName: 'iPhone' },
      status
    )
  ).toEqual({
    wantedCameraId: 'iphone',
    wantedCameraName: 'iPhone',
    usedCameraId: 'builtin',
    deviceUniqueId: 'builtin-uid',
    state: 'disconnected'
  })
  expect(cameraSelectionDiagnostics({ cameraId: 'builtin' }, status).wantedCameraId).toBe('builtin')
})

describe('a disconnected camera standing in for another camera', () => {
  const standIn = reconcileSourceSelection({ cameraId: camera.id, cameraName: camera.name }, [
    screen,
    substitute
  ])

  it('retains the last frame without saving the substitute as the wanted camera', () => {
    const next = reconcileSourceSelection(standIn, [screen], {
      disconnectedCameraId: substitute.id
    })
    expect(next.cameraId).toBe(substitute.id)
    expect(next.wantedCameraId).toBe(camera.id)
    expect(
      persistableCaptureConfig({ ...defaultCaptureConfig, sources: next }).sources.cameraId
    ).toBe(camera.id)
  })

  it('holds that frame during a session when the original camera returns', () => {
    const next = reconcileSourceSelection(standIn, [screen, camera], {
      holdStandIns: true,
      disconnectedCameraId: substitute.id
    })
    expect(next.cameraId).toBe(substitute.id)
    expect(next.wantedCameraId).toBe(camera.id)
    expect(returningSourceChoices(next, [screen, camera])).toEqual([
      { kind: 'camera', device: camera }
    ])
  })

  it('restores the original camera when it returns while idle', () => {
    const next = reconcileSourceSelection(standIn, [screen, camera], {
      disconnectedCameraId: substitute.id
    })
    expect(next.cameraId).toBe(camera.id)
    expect(next.wantedCameraId).toBeUndefined()
  })
})
