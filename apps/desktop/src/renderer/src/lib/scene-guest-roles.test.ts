import { describe, expect, it } from 'vitest'
import { defaultCaptureConfig } from './capture'
import { hydrateSceneLibrary, type SavedScene } from './scene-presets'
import {
  SCENE_GUEST_PLACEMENTS,
  sceneGuestPlacement,
  sceneGuestRoles,
  sceneWithGuestRoles
} from './scene-guest-roles'
import { cloudSceneFromNative } from './cloud-scene-native'
import {
  defaultSceneGuests,
  parseCloudSceneExtension,
  parseSceneGuests,
  planSceneTiles
} from '../../../shared/cloud-scene'

const scene = (preset: SavedScene['visual']['layout']['layoutPreset']): SavedScene => ({
  id: 's1',
  name: 'Podcast',
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
  visual: {
    layout: { ...structuredClone(defaultCaptureConfig.layout), layoutPreset: preset },
    sources: {},
    background: null
  }
})

describe('S12 guest roles (D7) chosen per saved scene', () => {
  it('every placement is a valid guest role set in both orientations', () => {
    for (const orientation of ['h', 'v'] as const)
      for (const placement of SCENE_GUEST_PLACEMENTS)
        expect(parseSceneGuests(sceneGuestRoles(placement, orientation))).not.toBeNull()
    expect(sceneGuestRoles('beside', 'h')).toEqual(defaultSceneGuests('h'))
  })

  it('saves as the versioned extension, keeps native fields, and survives a reload', () => {
    const saved = sceneWithGuestRoles(scene('screen-camera'), 'over', '2026-11-17T01:00:00.000Z')
    expect(saved.visual).toEqual(scene('screen-camera').visual)
    expect(saved.cloud).toMatchObject({ version: 1, placement: 'over' })
    expect(parseCloudSceneExtension(saved.cloud)?.guests).toEqual(sceneGuestRoles('over', 'h'))
    const reloaded = hydrateSceneLibrary({ version: 1, scenes: [saved] }).library.scenes[0]
    expect(sceneGuestPlacement(reloaded)).toBe('over')
    expect(sceneGuestPlacement(scene('camera-only'))).toBe('beside')
    // A vertical scene gets portrait boxes.
    const vertical = sceneWithGuestRoles(scene('vertical-camera-top'), 'over', 'x')
    expect(parseCloudSceneExtension(vertical.cloud)?.guests).toEqual(sceneGuestRoles('over', 'v'))
  })

  it('the room plan uses the chosen roles: over keeps the scene whole and places six guests apart', () => {
    const saved = sceneWithGuestRoles(scene('screen-camera'), 'over', 'x')
    const native = {
      id: 'scene:default',
      name: 'Default Scene',
      outputs: [],
      sources: [
        {
          id: 'source:base',
          name: 'Screen',
          kind: 'screen' as const,
          visible: true,
          locked: false,
          transform: {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            cropLeft: 0,
            cropTop: 0,
            cropRight: 0,
            cropBottom: 0
          },
          defaultTransform: {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            cropLeft: 0,
            cropTop: 0,
            cropRight: 0,
            cropBottom: 0
          }
        }
      ]
    }
    const translated = cloudSceneFromNative({
      scene: native,
      layout: saved.visual.layout,
      background: null,
      orientation: 'h',
      extension: saved.cloud
    }).scene
    const guests = Array.from({ length: 6 }, (_, i) => `g_${i}`)
    const tiles = planSceneTiles(
      translated,
      { width: 1920, height: 1080 },
      {
        host: 'host:x',
        guests,
        screen: 'host:x',
        hostOnStage: true
      }
    )
    expect(tiles.find((t) => t.role === 'screen')?.rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
    const boxes = tiles.filter((t) => t.role.startsWith('guest:')).map((t) => t.rect)
    expect(boxes).toHaveLength(6)
    for (const box of boxes) expect(box.x + box.w).toBeLessThanOrEqual(1920)
    for (let i = 1; i < boxes.length; i++)
      expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].w)
  })
})
