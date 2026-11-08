import { describe, expect, it } from 'vitest'

import { DEFAULT_OVERLAY_LAYOUT } from './overlay-layout'
import { cameraShapePatch, sceneCameraControls, withOverlaySwitches } from './scene-edits'

// Plan 209 S11b: the Scene page's edit rules, moved out of the page unchanged
// so an agent's Arrange tools land where the click would.
describe('the Scene page edit rules', () => {
  it('offers the corner in the inset scenes, the shape there and in freeform', () => {
    expect(
      sceneCameraControls({ layoutPreset: 'screen-camera', arrangementMode: 'preset' })
    ).toEqual({
      inset: true,
      freeform: false,
      corner: true,
      bubble: true
    })
    expect(
      sceneCameraControls({ layoutPreset: 'vertical-screen-camera', arrangementMode: 'freeform' })
    ).toEqual({ inset: true, freeform: true, corner: false, bubble: true })
    expect(
      sceneCameraControls({ layoutPreset: 'side-by-side', arrangementMode: 'preset' })
    ).toEqual({
      inset: false,
      freeform: false,
      corner: false,
      bubble: false
    })
  })

  it('makes Rounded a rounded square, and leaves the aspect alone otherwise', () => {
    expect(cameraShapePatch('rounded')).toEqual({ cameraShape: 'rounded', cameraAspect: 'square' })
    expect(cameraShapePatch('circle')).toEqual({ cameraShape: 'circle' })
    expect(cameraShapePatch('rectangle')).toEqual({ cameraShape: 'rectangle' })
  })

  it('changes one overlay switch and nothing else', () => {
    const next = withOverlaySwitches(DEFAULT_OVERLAY_LAYOUT, 'buddy', { showOnStream: true })
    expect(next.buddy).toEqual({ ...DEFAULT_OVERLAY_LAYOUT.buddy, showOnStream: true })
    expect(next.highlight).toBe(DEFAULT_OVERLAY_LAYOUT.highlight)
  })
})
