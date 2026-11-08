import { describe, expect, it } from 'vitest'

import { presetCameraCornerRect, snapCornerOf } from './stage-corner'

const close = (
  actual: { x: number; y: number; width: number; height: number },
  expected: typeof actual
): void => {
  for (const key of ['x', 'y', 'width', 'height'] as const)
    expect(actual[key], key).toBeCloseTo(expected[key], 9)
}

describe('corner drops', () => {
  it('finds the corner a move ends in, on both axes', () => {
    expect(snapCornerOf({ x: 0.02, y: 0.7, width: 0.25, height: 0.25 })).toBe('bottom-left')
    expect(snapCornerOf({ x: 0.7, y: 0.05, width: 0.26, height: 0.2 })).toBe('top-right')
    expect(snapCornerOf({ x: 0.3, y: 0.7, width: 0.25, height: 0.25 })).toBeNull()
    expect(snapCornerOf({ x: 0.02, y: 0.3, width: 0.25, height: 0.25 })).toBeNull()
  })

  // The same three boxes are pinned in Rust:
  // `scene_geometry::tests::preset_camera_corner_boxes_match_the_stage_drop_target`.
  it("is the backend's preset camera box at that corner", () => {
    close(
      presetCameraCornerRect(
        {
          cameraSize: 'medium',
          cameraShape: 'rectangle',
          cameraAspect: 'source',
          cameraMargin: 32
        },
        'bottom-right',
        1920,
        1080
      ),
      { x: 1332 / 1920, y: 727 / 1080, width: 540 / 1920, height: 305 / 1080 }
    )
    close(
      presetCameraCornerRect(
        { cameraSize: 'small', cameraShape: 'circle', cameraAspect: 'source', cameraMargin: 32 },
        'top-left',
        1080,
        1920
      ),
      { x: 27 / 1080, y: 27 / 1920, width: 219 / 1080, height: 219 / 1920 }
    )
    close(
      presetCameraCornerRect(
        {
          cameraSize: 'large',
          cameraShape: 'rounded',
          cameraAspect: 'portrait',
          cameraMargin: 500
        },
        'top-right',
        1280,
        720
      ),
      { x: 640 / 1280, y: 160 / 720, width: 480 / 1280, height: 640 / 720 }
    )
  })
})
