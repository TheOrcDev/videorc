import { describe, expect, it } from 'vitest'

import type { Device } from './backend'
import { defaultCaptureConfig } from './capture'
import {
  landscapeFramingShows,
  layoutAsksForScreen,
  sceneCardsCameraGaps,
  sceneLayoutCameraLine,
  sceneLayoutChoices,
  sceneSlotKeysLine,
  screenFieldWords
} from './scene-section'
import { normalizeSceneVisual } from './scene-presets'

// Plan 231 S6: the reads behind Studio's Scenes section.

const layout = (layoutPreset: typeof defaultCaptureConfig.layout.layoutPreset) => ({
  ...defaultCaptureConfig.layout,
  layoutPreset
})

describe('screenFieldWords (D8)', () => {
  it('names what the scene keeps, and says when its layout draws no screen', () => {
    const figma = {
      kind: 'app',
      bundleId: 'com.figma.Desktop',
      name: 'Figma',
      follows: true
    } as const
    expect(screenFieldWords(figma, layout('screen-camera'))).toEqual({
      words: 'Figma · front window',
      note: null
    })
    const display = { kind: 'display', screenId: 'screen:1', screenName: 'Display 1' } as const
    expect(screenFieldWords(display, layout('camera-only'))).toEqual({
      words: 'Display 1',
      note: 'Not shown in Camera only'
    })
    expect(screenFieldWords({ kind: 'none' }, layout('camera-only'))).toEqual({
      words: 'No screen',
      note: null
    })
    // Freeform draws what it has.
    expect(
      screenFieldWords(display, { ...layout('camera-only'), arrangementMode: 'freeform' }).note
    ).toBeNull()
  })
})

describe('layoutAsksForScreen (D19)', () => {
  it('asks only when a screen layout goes on a scene that shows none', () => {
    expect(layoutAsksForScreen({ kind: 'none' }, 'screen-camera')).toBe(true)
    expect(layoutAsksForScreen({ kind: 'none' }, 'vertical-split')).toBe(true)
    expect(layoutAsksForScreen({ kind: 'none' }, 'camera-only')).toBe(false)
    expect(layoutAsksForScreen({ kind: 'display', screenId: 'screen:1' }, 'screen-only')).toBe(
      false
    )
  })
})

describe('sceneLayoutChoices', () => {
  it('lists the layouts of the studio’s mode, the camera ones off without a camera', () => {
    expect(sceneLayoutChoices('horizontal', true).map((choice) => choice.label)).toEqual([
      'Screen + camera',
      'Screen only',
      'Camera only',
      'Side by side'
    ])
    expect(sceneLayoutChoices('vertical', true)).toHaveLength(6)
    const off = sceneLayoutChoices('horizontal', false)
    expect(off.filter((choice) => choice.disabled).map((choice) => choice.value)).toEqual([
      'screen-camera',
      'camera-only',
      'side-by-side'
    ])
    expect(sceneLayoutCameraLine(off)).toBe(
      'Choose a camera in Sources to use Screen + camera, Camera only, and Side by side.'
    )
    expect(sceneLayoutCameraLine(sceneLayoutChoices('horizontal', true))).toBeNull()
  })
})

describe('sceneCardsCameraGaps (D9)', () => {
  const devices: Device[] = [
    { id: 'camera:1', name: 'FaceTime', kind: 'camera', status: 'available' },
    { id: 'screen:screencapturekit:1', name: 'Display 1', kind: 'screen', status: 'available' }
  ]
  const scene = (
    id: string,
    name: string,
    preset: Parameters<typeof layout>[0],
    cameraId?: string
  ) => ({
    id,
    name,
    visual: normalizeSceneVisual({
      layout: layout(preset),
      sources: {
        screenId: 'screen:screencapturekit:1',
        ...(cameraId ? { cameraId } : { cameraOff: true })
      },
      background: null
    })
  })

  it('turns off the scenes that need the one camera, with one line naming them', () => {
    const gaps = sceneCardsCameraGaps(
      [
        scene('a', 'Figma', 'screen-only'),
        scene('b', 'Camera only', 'camera-only'),
        scene('c', 'Side by side', 'side-by-side')
      ],
      devices
    )
    expect([...gaps.blocked]).toEqual(['b', 'c'])
    expect(gaps.reason).toBe(
      'Camera is off. Choose one in Sources to use Camera only and Side by side.'
    )
  })

  it('says nothing while the camera works', () => {
    const gaps = sceneCardsCameraGaps(
      [scene('b', 'Camera only', 'camera-only', 'camera:1')],
      devices
    )
    expect(gaps.blocked.size).toBe(0)
    expect(gaps.reason).toBeNull()
  })
})

describe('landscapeFramingShows', () => {
  it('is for the landscape screen layouts with a choice of Fill or Fit', () => {
    expect(landscapeFramingShows(layout('screen-camera'))).toBe(true)
    expect(landscapeFramingShows(layout('screen-only'))).toBe(true)
    expect(landscapeFramingShows(layout('side-by-side'))).toBe(false)
    expect(landscapeFramingShows(layout('camera-only'))).toBe(false)
  })
})

describe('sceneSlotKeysLine (D5)', () => {
  it('teaches the platform’s position keys while they are the defaults', () => {
    expect(sceneSlotKeysLine(undefined, 'darwin')).toEqual({
      first: 'Control+Alt+1',
      last: 'Control+Alt+9'
    })
    expect(sceneSlotKeysLine({}, 'win32')).toEqual({
      first: 'Control+Alt+Shift+1',
      last: 'Control+Alt+Shift+9'
    })
    expect(sceneSlotKeysLine({ sceneSlots: { 9: '' } }, 'darwin')).toBeNull()
    expect(sceneSlotKeysLine({ sceneSlots: { 1: 'F13' } }, 'linux')).toBeNull()
  })
})
