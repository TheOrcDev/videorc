import { describe, expect, it } from 'vitest'
import { transformLayoutIntent, transformSourceIdentity } from './scene-transform-commit'
import type { Scene } from './backend'

const scene: Scene = {
  id: 'scene',
  name: 'Scene',
  outputs: [],
  sources: [
    {
      id: 'camera',
      kind: 'camera',
      name: 'Camera',
      deviceId: 'a',
      visible: true,
      locked: false,
      transform: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        cropLeft: 0,
        cropRight: 0,
        cropTop: 0,
        cropBottom: 0
      },
      defaultTransform: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        cropLeft: 0,
        cropRight: 0,
        cropTop: 0,
        cropBottom: 0
      }
    }
  ]
}
describe('transform operation identity', () => {
  it('ignores transform echoes but detects a new mask or layout intent', () => {
    const layout = {
      layoutPreset: 'screen-camera',
      cameraShape: 'rectangle',
      arrangementMode: 'freeform'
    }
    expect(
      transformLayoutIntent({
        ...layout,
        sourceTransformOverrides: { camera: { x: 0.2 } },
        cameraTransformMode: 'custom',
        cameraTransform: { x: 0.2 }
      })
    ).toBe(transformLayoutIntent(layout))
    expect(transformLayoutIntent({ ...layout, cameraShape: 'circle' })).not.toBe(
      transformLayoutIntent(layout)
    )
  })
  it('detects replacement devices even when the source ID is reused', () => {
    const replacement = structuredClone(scene)
    replacement.sources[0].deviceId = 'b'
    expect(transformSourceIdentity(replacement)).not.toBe(transformSourceIdentity(scene))
    replacement.sources[0].deviceId = 'a'
    replacement.sources[0].transform.x = 0.25
    expect(transformSourceIdentity(replacement)).toBe(transformSourceIdentity(scene))
  })
})
