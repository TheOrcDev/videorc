import { describe, expect, it } from 'vitest'

import { previewStartupSources } from './preview-startup'

describe('previewStartupSources', () => {
  it('waits for the chosen screen and camera with the names the Studio shows', () => {
    expect(
      previewStartupSources(
        {
          screenId: 'display:1',
          screenName: 'LG HDR 4K',
          cameraId: 'cam:1',
          cameraName: 'ZV-E10M2'
        },
        { state: 'starting' },
        { state: 'live' }
      )
    ).toEqual([
      { kind: 'screen', name: 'LG HDR 4K', live: false, blocked: false },
      { kind: 'camera', name: 'ZV-E10M2', live: true, blocked: false }
    ])
  })

  it('reads a stand-in pick and a window like the Sources rows do', () => {
    expect(
      previewStartupSources(
        { wantedWindowId: 'window:9', wantedWindowName: 'Keynote', wantedCameraId: 'cam:2' },
        undefined,
        undefined
      )
    ).toEqual([
      { kind: 'screen', name: 'Keynote', live: false, blocked: false },
      { kind: 'camera', name: null, live: false, blocked: false }
    ])
  })

  it('never waits for sources that are off or need no device', () => {
    expect(
      previewStartupSources(
        { screenId: 'display:1', testPattern: true, cameraId: 'cam:1', cameraOff: true },
        { state: 'starting' },
        { state: 'starting' }
      )
    ).toEqual([])
    expect(previewStartupSources({ captureOff: true }, undefined, undefined)).toEqual([])
  })

  it('counts a camera with no picture as not live, and a missing device as blocked', () => {
    const [camera] = previewStartupSources(
      { cameraId: 'cam:1', cameraName: 'ZV-E10M2' },
      undefined,
      { state: 'live', noVideo: true }
    )
    expect(camera.live).toBe(false)
    const [missing] = previewStartupSources({ cameraId: 'cam:1' }, undefined, {
      state: 'device-missing'
    })
    expect(missing.blocked).toBe(true)
  })
})
