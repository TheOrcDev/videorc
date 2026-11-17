/** Plan 249 S13a camera-role scene cases on S12's committed saved-scene format.
 * Each case puts the unpacked host camera through one S12 geometry rule set
 * (crop, fit, mirror, mask) so final composited captures can prove it. */
import { layoutOf, savedScene } from './cloud-parity-scenes-contract.mjs'

const camera = (patch) => ({
  'source:camera': { x: 0.1, y: 0.1, width: 0.5, height: 0.5, ...patch }
})

export function cameraSceneCases() {
  return [
    {
      id: 'camera:cover-crop-rounded',
      expect: { fit: 'cover', mirror: false, mask: 'rounded', cropped: true },
      scene: savedScene(
        'parity-camera-cover-crop-rounded',
        layoutOf({
          arrangementMode: 'freeform',
          cameraShape: 'rounded',
          cameraCornerRadiusPct: 18,
          cameraFit: 'fill',
          sourceTransformOverrides: camera({ cropLeft: 0.2, cropTop: 0.1 })
        })
      )
    },
    {
      id: 'camera:contain-mirror',
      expect: { fit: 'contain', mirror: true, mask: 'rectangle', cropped: false },
      scene: savedScene(
        'parity-camera-contain-mirror',
        layoutOf({
          arrangementMode: 'freeform',
          cameraShape: 'rectangle',
          cameraFit: 'fit',
          cameraMirror: true,
          sourceTransformOverrides: camera({})
        })
      )
    },
    {
      // No zoom: the circle itself crops the sides, and the patch band at the
      // top quarter stays inside it (a zoomed circle hides every patch).
      id: 'camera:circle',
      expect: { fit: 'cover', mirror: false, mask: 'circle', cropped: true },
      scene: savedScene(
        'parity-camera-circle',
        layoutOf({
          arrangementMode: 'freeform',
          cameraShape: 'circle',
          sourceTransformOverrides: camera({})
        })
      )
    }
  ]
}
