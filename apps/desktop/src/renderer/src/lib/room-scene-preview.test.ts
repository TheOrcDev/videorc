import { describe, expect, it } from 'vitest'
import type { CloudRoomStatus } from './backend'
import type { RoomSceneStatus } from './room-scene-publisher'
import {
  SCENE_PREVIEW_CANVAS,
  backgroundNote,
  programScenePreview,
  scenePreviewPicture,
  sceneStatusLine
} from './room-scene-preview'
import { planSceneTiles, scenePicture, type CloudScene } from '../../../shared/cloud-scene'
import fixture from '../../../../../../protocol-fixtures/cloud-parity-scenes.json'

const HOST = 'host:sh_x'
const scene = fixture.snapshots[0].snapshot.scene as CloudScene
const status = (patch: Partial<RoomSceneStatus> = {}): RoomSceneStatus => ({
  enabled: true,
  state: 'applied',
  reason: null,
  generation: 3,
  sceneId: { h: scene.id, v: null },
  content: { h: scene, v: null, transition: { kind: 'cut', durationMs: 0 } },
  observed: {},
  productionQualified: false,
  ...patch
})
const room = (onStage: string[], screen?: string): CloudRoomStatus =>
  ({
    stage: { layout: 'side-by-side', onStage },
    participants: onStage.map((identity) => ({ identity })),
    shown: { onStage, ...(screen ? { screen } : {}) }
  }) as unknown as CloudRoomStatus

describe('S12 scene in the Program preview', () => {
  it('uses the shared scene plan for the people and screen the page reports drawing', () => {
    const preview = programScenePreview(status(), room([HOST, 'g_a', 'g_b'], HOST), HOST)
    expect(preview?.sceneId).toBe(scene.id)
    expect(preview?.tiles).toEqual(
      planSceneTiles(scene, SCENE_PREVIEW_CANVAS, {
        host: HOST,
        guests: ['g_a', 'g_b'],
        hostOnStage: true,
        screen: HOST
      })
    )
    expect(preview?.tiles.map((t) => t.role)).toEqual([
      'screen',
      'host-camera',
      'guest:0',
      'guest:1'
    ])
  })
  it('a page that dropped a guest or the screen draws without them, as the page does', () => {
    const tiles = programScenePreview(status(), room([HOST, 'g_a']), HOST)!.tiles
    expect(tiles.map((t) => t.role)).toEqual(['host-camera', 'guest:0'])
  })
  it('shows the room layouts when scenes are off, cleared, vertical-only or hostless', () => {
    expect(programScenePreview(status({ enabled: false }), room([HOST]), HOST)).toBeNull()
    expect(
      programScenePreview(
        status({ content: { h: null, v: scene, transition: { kind: 'cut', durationMs: 0 } } }),
        room([HOST]),
        HOST
      )
    ).toBeNull()
    expect(programScenePreview(status({ content: null }), room([HOST]), HOST)).toBeNull()
    expect(programScenePreview(status(), room([HOST]), null)).toBeNull()
    expect(programScenePreview(undefined, room([HOST]), HOST)).toBeNull()
  })
  it('places the picture with the shared crop and fit, in percent of its tile', () => {
    const tile = {
      rect: { x: 0, y: 0, w: 1920, h: 1080 },
      crop: { l: 0, t: 0, r: 0, b: 0 },
      fit: 'contain' as const
    }
    // A 4:3 screen contained in 16:9: pillarboxed, whole picture shown.
    const contain = scenePreviewPicture(tile, { w: 1440, h: 1080 })
    expect(contain.clip).toEqual({ left: '12.5%', top: '0%', width: '75%', height: '100%' })
    expect(contain.full).toEqual({ left: '0%', top: '0%', width: '100%', height: '100%' })
    // A zoomed camera covering a square bubble: the clip is the frame and the
    // whole source overflows it so the crop lands on the bubble.
    const bubble = {
      rect: { x: 1400, y: 700, w: 400, h: 400 },
      crop: { l: 0.125, t: 0.125, r: 0.125, b: 0.125 },
      fit: 'cover' as const
    }
    const cover = scenePreviewPicture(bubble, { w: 1280, h: 720 })
    const exact = scenePicture(
      { x: 0, y: 0, w: 400, h: 400 },
      { w: 1280, h: 720 },
      bubble.crop,
      'cover'
    )
    expect(cover.clip).toEqual({ left: '0%', top: '0%', width: '100%', height: '100%' })
    expect(cover.full.width).toBe(`${(exact.full.w / 400) * 100}%`)
    expect(cover.full.left).toBe(`${(exact.full.x / 400) * 100}%`)
    // Unknown size: the frame's own shape, nothing cut.
    expect(scenePreviewPicture(tile, null).clip.width).toBe('100%')
  })
  it('says only what the outputs confirmed', () => {
    expect(sceneStatusLine(status())).toMatch(/drawn by each output/)
    expect(sceneStatusLine(status({ state: 'preview' }))).toMatch(/Shows once/)
    expect(sceneStatusLine(status({ state: 'waiting', reason: null }))).toBe(
      'Scene sent · Output unconfirmed'
    )
    expect(sceneStatusLine(status({ state: 'failed', reason: 'Scene delivery failed.' }))).toBe(
      'Scene delivery failed.'
    )
    expect(sceneStatusLine(status({ enabled: false }))).toBeNull()
  })
})

describe('S14 background note', () => {
  const status = (background: RoomSceneStatus['background']): RoomSceneStatus => ({
    enabled: true,
    state: 'applied',
    reason: null,
    generation: 1,
    sceneId: { h: 'aaaaaaaa', v: null },
    content: null,
    observed: {},
    ...(background ? { background } : {}),
    productionQualified: false
  })
  it('says nothing when every output drew the background', () => {
    expect(
      sceneStatusLine(
        status({
          wanted: { h: '0badf00d', v: 'none' },
          drawn: { EG_a: { key: '0badf00d', rendering: 'shader' } },
          unsupported: 0,
          productionQualified: false
        })
      )
    ).toBe('Scene drawn by each output · Preview reconstruction')
  })
  it('never reports a still poster as moving, and names older pages', () => {
    expect(
      backgroundNote(
        status({
          wanted: { h: '0badf00d', v: 'none' },
          drawn: { EG_a: { key: '0badf00d', rendering: 'still', reason: 'no-webgl2' } },
          unsupported: 0,
          productionQualified: false
        })
      )
    ).toBe('Background shows still: the output cannot animate it')
    expect(
      backgroundNote(
        status({
          wanted: { h: '0badf00d', v: 'none' },
          drawn: {},
          unsupported: 1,
          productionQualified: false
        })
      )
    ).toMatch(/reload older program pages/)
  })
})
