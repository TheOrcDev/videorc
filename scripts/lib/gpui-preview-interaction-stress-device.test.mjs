import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  deviceCaptureSources,
  deviceLayout,
  minimumTakeSeconds
} from '../gpui-preview-interaction-stress.mjs'

describe('GPUI preview interaction stress, device mode', () => {
  it('records the picked window or display, and the camera or none', () => {
    assert.deepEqual(
      deviceCaptureSources({ kind: 'window', id: 'window:sck:1' }, { cameraId: 'cam:1' }),
      { windowId: 'window:sck:1', cameraId: 'cam:1', testPattern: false }
    )
    assert.deepEqual(
      deviceCaptureSources(
        { kind: 'screen', id: 'screen:sck:1' },
        { cameraId: null, cameraOff: true }
      ),
      { screenId: 'screen:sck:1', cameraId: null, testPattern: false }
    )
  })

  it("lays the take out as Electron's device gate does", () => {
    const layout = deviceLayout('screen-camera')
    assert.equal(layout.layoutPreset, 'screen-camera')
    assert.equal(layout.cameraCorner, 'bottom-right')
    assert.equal(layout.cameraTransform, null)
  })

  it('wants the take to last all but the last 8 s, at least 2 s', () => {
    assert.equal(minimumTakeSeconds(60000), 52)
    assert.equal(minimumTakeSeconds(5000), 2)
  })
})
