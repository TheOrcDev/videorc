import { afterEach, describe, expect, it, vi } from 'vitest'

import { stageRectToOverlay } from '@/components/scene/overlay-stage'
import type { Banner, OverlayOrientation, Scene, SceneSource } from '@/lib/backend'
import { OVERLAY_ITEMS } from '@/lib/backend'
import {
  BANNER_SNAPS,
  bannerDefaultPlaces,
  bannerFitRect,
  bannerSnapRect
} from '@/lib/banner-place'
import { defaultCaptureConfig } from '@/lib/capture'
import { freeformEntryPatch } from '@/lib/freeform-memory'
import {
  DEFAULT_OVERLAY_LAYOUT,
  OVERLAY_PLACES,
  OVERLAY_SNAPS,
  overlayDefaultSize,
  overlaySnapRect
} from '@/lib/overlay-layout'
import { SCENE_VISIBILITY_LOCK_REASON } from '@/lib/scene-edits'
import { executeAgentIntent, type AgentIntent } from './agent'
import type { SceneArrangeContext, SceneArrangeSnapshot, StudioActionContext } from './context'
import {
  SCENE_LAYOUT_COPY,
  bannerPlacement,
  overlayPlacement,
  sceneOverlaps,
  sourcePlacement,
  toSceneRect
} from './scene-layout'

// Plan 209 S11b (D22): arranging the picture by words lands exactly where the
// Scene canvas's own snaps put things, saves the way the canvas saves, and
// says what it covers now and where it was.

const ORIENTATIONS: readonly OverlayOrientation[] = ['horizontal', 'vertical']
const ASPECT: Record<OverlayOrientation, number> = { horizontal: 16 / 9, vertical: 9 / 16 }

function banner(
  id: string,
  width: number,
  height: number,
  overrides: Partial<Banner> = {}
): Banner {
  const places = bannerDefaultPlaces({ width, height })
  return {
    id,
    name: id === 'sponsor' ? 'Sponsor' : 'Logo',
    imageFile: `${id}.png`,
    thumbnailFile: `${id}.thumb.png`,
    width,
    height,
    hasAlpha: true,
    sortOrder: 0,
    shown: true,
    horizontal: places.horizontal,
    vertical: places.vertical,
    showOnStream: true,
    showInRecording: true,
    opacity: 1,
    createdAt: '2026-10-27T12:00:00Z',
    updatedAt: '2026-10-27T12:00:00Z',
    ...overrides
  }
}

function source(
  id: string,
  kind: SceneSource['kind'],
  name: string,
  rect: [number, number, number, number]
): SceneSource {
  const transform = {
    x: rect[0],
    y: rect[1],
    width: rect[2],
    height: rect[3],
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0
  }
  return { id, name, kind, transform, defaultTransform: transform, visible: true, locked: false }
}

const SCENE: Scene = {
  id: 'scene-1',
  name: 'Screen + camera',
  sources: [
    source('source:base', 'screen', 'Built-in Display', [0, 0, 1, 1]),
    source('source:camera', 'camera', 'FaceTime HD Camera', [0.7, 0.7, 0.28125, 0.28125])
  ],
  outputs: []
}

function snapshot(overrides: Partial<SceneArrangeSnapshot> = {}): SceneArrangeSnapshot {
  return {
    scene: SCENE,
    layout: {
      ...defaultCaptureConfig.layout,
      layoutPreset: 'screen-camera',
      arrangementMode: 'preset'
    },
    overlayLayout: DEFAULT_OVERLAY_LAYOUT,
    banners: [banner('sponsor', 2400, 400), banner('logo', 512, 512, { shown: false })],
    canvasAspect: ASPECT,
    orientation: 'horizontal',
    verticalStream: false,
    sessionActive: false,
    startTimeOverlays: false,
    blockedReason: null,
    ...overrides
  }
}

/** A fake canvas: saves land in the snapshot as the Studio's commits would. */
function arranged(initial: SceneArrangeSnapshot = snapshot()) {
  let state = initial
  const arrange: SceneArrangeContext = {
    read: () => state,
    setOverlayLayout: vi.fn(async (overlayLayout) => {
      state = { ...state, overlayLayout }
    }),
    updateBanner: vi.fn(async (id, patch) => {
      state = {
        ...state,
        banners: state.banners.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
      }
      return true
    }),
    applyCameraPreset: vi.fn(async (patch) => {
      state = { ...state, layout: { ...state.layout, ...patch } }
      return true
    }),
    applyLayoutPatch: vi.fn(async (patch) => {
      state = { ...state, layout: { ...state.layout, ...patch } }
      return true
    }),
    setSourceTransform: vi.fn(async (sourceId, rect) => {
      state = {
        ...state,
        scene: state.scene && {
          ...state.scene,
          sources: state.scene.sources.map((entry) =>
            entry.id === sourceId ? { ...entry, transform: { ...entry.transform, ...rect } } : entry
          )
        }
      }
      return true
    }),
    setSourceVisible: vi.fn(async (sourceId, visible) => {
      state = {
        ...state,
        scene: state.scene && {
          ...state.scene,
          sources: state.scene.sources.map((entry) =>
            entry.id === sourceId ? { ...entry, visible } : entry
          )
        }
      }
      return true
    })
  }
  const context = { arrange } as unknown as StudioActionContext
  return { arrange, context, state: () => state }
}

const call = (tool: string, args: Record<string, unknown>): AgentIntent => ({
  intentId: 'ai-1',
  agentId: 'agent-1',
  agentName: 'Claude Desktop',
  tool,
  args
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("every place is the editor's own snap (plan 209 S11b, D22)", () => {
  it('puts an overlay at its default size exactly where the inspector snaps it, both ways', () => {
    for (const item of OVERLAY_ITEMS) {
      for (const orientation of ORIENTATIONS) {
        const current = DEFAULT_OVERLAY_LAYOUT[item][orientation]
        for (const snap of OVERLAY_SNAPS) {
          expect(
            overlayPlacement(item, orientation, current, snap, undefined),
            `${item} ${orientation} ${snap}`
          ).toEqual(overlaySnapRect(item, orientation, snap))
          // medium is the default size, whatever size it has now.
          const resized = { ...current, w: 0.3, h: 0.3 }
          expect(overlayPlacement(item, orientation, resized, snap, 'medium')).toEqual(
            overlaySnapRect(item, orientation, snap)
          )
        }
      }
    }
  })

  it('puts a banner exactly where the inspector snaps it, both ways', () => {
    for (const image of [
      banner('sponsor', 2400, 400),
      banner('logo', 512, 512),
      banner('tall', 400, 1200)
    ]) {
      for (const orientation of ORIENTATIONS) {
        for (const snap of BANNER_SNAPS) {
          expect(
            bannerPlacement(image, orientation, ASPECT[orientation], snap, undefined),
            `${image.id} ${orientation} ${snap}`
          ).toEqual(
            bannerSnapRect(image, image[orientation], orientation, ASPECT[orientation], snap)
          )
        }
      }
    }
  })

  it("keeps the grid's other places inside the same margins and safe area", () => {
    for (const orientation of ORIENTATIONS) {
      const [w, h] = overlayDefaultSize('buddy', orientation)
      const current = DEFAULT_OVERLAY_LAYOUT.buddy[orientation]
      const top = orientation === 'vertical' ? 0.08 : 0.04
      const bottom = orientation === 'vertical' ? 0.22 : 0.04
      const center = overlayPlacement('buddy', orientation, current, 'center', undefined)
      expect(center.x).toBeCloseTo((1 - w) / 2, 6)
      expect(center.y).toBeCloseTo(top + (1 - top - bottom - h) / 2, 6)
      const topCenter = overlayPlacement('buddy', orientation, current, 'top-center', undefined)
      expect(topCenter.y).toBeCloseTo(top, 6)
      expect(topCenter.x).toBeCloseTo(center.x, 6)
      // The middle row lines up with the left and right snaps' columns.
      const left = overlayPlacement('buddy', orientation, current, 'middle-left', undefined)
      expect(left.x).toBe(overlaySnapRect('buddy', orientation, 'top-left').x)
      expect(left.y).toBe(center.y)
      const right = overlayPlacement('buddy', orientation, current, 'middle-right', undefined)
      expect(right.x).toBe(overlaySnapRect('buddy', orientation, 'top-right').x)
    }
    expect(OVERLAY_PLACES).toHaveLength(9)
  })

  it('keeps the size an item has, unless a size is asked for', () => {
    const resized = { x: 0.5, y: 0.5, w: 0.3, h: 0.5 }
    const placed = overlayPlacement('buddy', 'horizontal', resized, 'top-left', undefined)
    expect(placed).toMatchObject({ w: 0.3, h: 0.5 })
    expect(placed.x).toBe(overlaySnapRect('buddy', 'horizontal', 'top-left').x)
    expect(placed.y).toBe(overlaySnapRect('buddy', 'horizontal', 'top-left').y)
  })
})

describe('sizes and the clamp (plan 209 S11b)', () => {
  it('keeps Buddy square on the canvas and a banner its image shape', () => {
    for (const orientation of ORIENTATIONS) {
      const current = DEFAULT_OVERLAY_LAYOUT.buddy[orientation]
      for (const size of ['small', 'large', 0.25] as const) {
        const rect = overlayPlacement('buddy', orientation, current, 'top-left', size)
        // Square in pixels: width × canvas width = height × canvas height.
        expect(rect.w * ASPECT[orientation]).toBeCloseTo(rect.h, 5)
      }
      const sponsor = banner('sponsor', 2400, 400)
      for (const size of ['small', 'medium', 'large', 0.4] as const) {
        const rect = bannerPlacement(sponsor, orientation, ASPECT[orientation], 'bottom-left', size)
        expect((rect.w * ASPECT[orientation]) / rect.h).toBeCloseTo(2400 / 400, 3)
      }
      // medium is where an import puts it.
      const medium = bannerPlacement(sponsor, orientation, ASPECT[orientation], undefined, 'medium')
      expect(medium.w).toBeCloseTo(
        bannerFitRect(
          sponsor,
          bannerDefaultPlaces(sponsor)[orientation],
          ASPECT[orientation],
          orientation
        ).w,
        5
      )
    }
  })

  it('clamps an exact rect like a drag: inside the canvas, sides at least 0.02', async () => {
    const { context, state } = arranged()
    const rect = { x: 0.9, y: -0.2, width: 0.5, height: 0.001 }
    const outcome = await executeAgentIntent(
      call('move_on_scene', { item: 'highlight', rect }),
      context
    )
    expect(outcome.ok).toBe(true)
    const clamped = stageRectToOverlay(rect)
    expect(state().overlayLayout.highlight.horizontal).toEqual(clamped)
    expect(clamped).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.02 })
    // A rect writes the horizontal canvas alone unless told otherwise.
    expect(state().overlayLayout.highlight.vertical).toEqual(
      DEFAULT_OVERLAY_LAYOUT.highlight.vertical
    )
  })

  it("keeps a source inside the canvas and no smaller than a drag's minimum", () => {
    const camera = SCENE.sources[1]!
    expect(
      sourcePlacement(camera, 'horizontal', undefined, undefined, {
        x: 0.99,
        y: 0.5,
        width: 0.01,
        height: 2
      })
    ).toEqual({ x: 0.95, y: 0, width: 0.05, height: 1 })
  })
})

describe('move_on_scene (plan 209 S11b, D22)', () => {
  it("moves Buddy to the top left on both orientations, with the editor's rects and the old ones", async () => {
    const { arrange, context, state } = arranged()
    const outcome = await executeAgentIntent(
      call('move_on_scene', { item: 'buddy', place: 'top-left' }),
      context
    )
    expect(arrange.setOverlayLayout).toHaveBeenCalledTimes(1)
    for (const orientation of ORIENTATIONS) {
      expect(state().overlayLayout.buddy[orientation]).toEqual(
        overlaySnapRect('buddy', orientation, 'top-left')
      )
    }
    expect(outcome).toMatchObject({
      ok: true,
      message: 'Moved Buddy to the top left.',
      result: {
        item: 'buddy',
        rects: {
          horizontal: toSceneRect(overlaySnapRect('buddy', 'horizontal', 'top-left')),
          vertical: toSceneRect(overlaySnapRect('buddy', 'vertical', 'top-left'))
        },
        previous: {
          horizontal: toSceneRect(DEFAULT_OVERLAY_LAYOUT.buddy.horizontal),
          vertical: toSceneRect(DEFAULT_OVERLAY_LAYOUT.buddy.vertical)
        }
      }
    })
  })

  it("puts it back in one call with the result's previous", async () => {
    const { context, state } = arranged()
    const first = await executeAgentIntent(
      call('move_on_scene', { item: 'buddy', place: 'top-left' }),
      context
    )
    const previous = (first.result as { previous: unknown }).previous
    await executeAgentIntent(call('move_on_scene', { item: 'buddy', rects: previous }), context)
    expect(state().overlayLayout.buddy).toEqual(DEFAULT_OVERLAY_LAYOUT.buddy)
  })

  it("moves the banner to the bottom left with the inspector's snap, and says what it covers", async () => {
    const { arrange, context, state } = arranged()
    const sponsor = state().banners[0]!
    const outcome = await executeAgentIntent(
      call('move_on_scene', { item: 'banner:sponsor', place: 'bottom-left' }),
      context
    )
    expect(arrange.updateBanner).toHaveBeenCalledWith('sponsor', {
      horizontal: bannerSnapRect(sponsor, sponsor.horizontal, 'horizontal', 16 / 9, 'bottom-left'),
      vertical: bannerSnapRect(sponsor, sponsor.vertical, 'vertical', 9 / 16, 'bottom-left')
    })
    // The highlight card sits bottom left and shows on stream: it is covered.
    expect(outcome).toMatchObject({
      ok: true,
      message: 'Moved Sponsor to the bottom left. Now covers: Highlight.',
      result: { overlaps: [{ item: 'highlight', name: 'Highlight' }] }
    })
  })

  it('lists overlaps only for what an output draws, and never the full-canvas screen', () => {
    const view = snapshot({
      overlayLayout: {
        ...DEFAULT_OVERLAY_LAYOUT,
        buddy: {
          ...DEFAULT_OVERLAY_LAYOUT.buddy,
          ...{ horizontal: { x: 0.75, y: 0.55, w: 0.2, h: 0.2 } }
        }
      }
    })
    // Buddy (off both outputs by default) still finds the camera it sits on;
    // the hidden logo banner and the full-canvas screen are not news.
    expect(sceneOverlaps(view, 'buddy')).toEqual([{ item: 'camera', name: 'FaceTime HD Camera' }])
    // The camera does not list Buddy while no output shows Buddy.
    expect(sceneOverlaps(view, 'camera').map((entry) => entry.item)).not.toContain('buddy')
    // The vertical canvas counts only while a vertical stream draws it: there
    // Buddy's bottom-right square meets the card and the sponsor strip.
    expect(
      sceneOverlaps({ ...view, verticalStream: true }, 'buddy').map((entry) => entry.item)
    ).toEqual(['camera', 'highlight', 'banner:sponsor'])
  })

  it('keeps the camera in its inset scene for a corner, without a restart', async () => {
    const { arrange, context, state } = arranged()
    const outcome = await executeAgentIntent(
      call('move_on_scene', { item: 'camera', place: 'top-right' }),
      context
    )
    expect(arrange.applyCameraPreset).toHaveBeenCalledWith({ cameraCorner: 'top-right' })
    expect(arrange.setSourceTransform).not.toHaveBeenCalled()
    expect(state().layout).toMatchObject({
      layoutPreset: 'screen-camera',
      arrangementMode: 'preset'
    })
    expect(outcome).toMatchObject({
      ok: true,
      result: { item: 'camera', arrangement: 'preset', corner: 'top-right' }
    })
  })

  it('moves the camera to a corner while recording, and nothing else off a corner', async () => {
    const { arrange, context } = arranged(snapshot({ sessionActive: true }))
    expect(
      (
        await executeAgentIntent(
          call('move_on_scene', { item: 'camera', place: 'bottom-left' }),
          context
        )
      ).ok
    ).toBe(true)
    expect(arrange.applyCameraPreset).toHaveBeenCalledWith({ cameraCorner: 'bottom-left' })
    expect(
      await executeAgentIntent(call('move_on_scene', { item: 'camera', place: 'center' }), context)
    ).toEqual({ ok: false, message: SCENE_LAYOUT_COPY.sourceMoveLive })
  })

  it('enters freeform as the canvas does for any other camera move, then drags it', async () => {
    const { arrange, context, state } = arranged()
    const outcome = await executeAgentIntent(
      call('move_on_scene', { item: 'camera', place: 'center', size: 0.4 }),
      context
    )
    expect(arrange.applyCameraPreset).toHaveBeenCalledWith(
      freeformEntryPatch('horizontal', SCENE.sources)
    )
    expect(arrange.setSourceTransform).toHaveBeenCalledWith('source:camera', {
      x: 0.3,
      y: 0.3,
      width: 0.4,
      height: 0.4
    })
    expect(state().layout.arrangementMode).toBe('freeform')
    expect(outcome).toMatchObject({
      ok: true,
      result: {
        arrangement: 'freeform',
        previous: { horizontal: { x: 0.7, y: 0.7, width: 0.28125, height: 0.28125 } },
        rects: { horizontal: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 } }
      }
    })
  })

  it('says so on Windows, where a running session keeps its start-time overlays', async () => {
    const { context } = arranged(snapshot({ sessionActive: true, startTimeOverlays: true }))
    expect(
      await executeAgentIntent(
        call('move_on_scene', { item: 'captions', place: 'top-center' }),
        context
      )
    ).toMatchObject({ ok: true, message: SCENE_LAYOUT_COPY.windowsNextSession })
  })

  it("refuses what the canvas wouldn't do, in its words", async () => {
    const { context } = arranged()
    for (const [args, message] of [
      [{ item: 'buddy' }, SCENE_LAYOUT_COPY.moveEmpty],
      [{ item: 'buddy', place: 'full-frame' }, SCENE_LAYOUT_COPY.fullFrameBannersOnly],
      [
        { item: 'buddy', place: 'center', rect: { x: 0, y: 0, width: 0.2, height: 0.2 } },
        SCENE_LAYOUT_COPY.rectOrPlace
      ],
      [{ item: 'banner:gone', place: 'center' }, SCENE_LAYOUT_COPY.bannerMissing],
      [{ item: 'chat', place: 'center' }, SCENE_LAYOUT_COPY.noItem]
    ] as const) {
      expect(
        await executeAgentIntent(call('move_on_scene', args), context),
        JSON.stringify(args)
      ).toEqual({
        ok: false,
        message
      })
    }
    const offline = arranged(snapshot({ blockedReason: 'Videorc is reconnecting.' }))
    expect(
      await executeAgentIntent(
        call('move_on_scene', { item: 'buddy', place: 'center' }),
        offline.context
      )
    ).toEqual({ ok: false, message: 'Videorc is reconnecting.' })
    const screenOnly = arranged(snapshot({ scene: { ...SCENE, sources: [SCENE.sources[0]!] } }))
    expect(
      await executeAgentIntent(
        call('move_on_scene', { item: 'camera', place: 'top-left' }),
        screenOnly.context
      )
    ).toEqual({ ok: false, message: SCENE_LAYOUT_COPY.noCamera })
  })
})

describe('set_scene_item and get_scene_layout (plan 209 S11b)', () => {
  it("shapes the camera with the inspector's patch, and hides it idle only", async () => {
    const { arrange, context } = arranged()
    expect(
      await executeAgentIntent(
        call('set_scene_item', { item: 'camera', shape: 'rounded' }),
        context
      )
    ).toMatchObject({ ok: true, result: { shape: 'rounded' } })
    expect(arrange.applyLayoutPatch).toHaveBeenCalledWith({
      cameraShape: 'rounded',
      cameraAspect: 'square'
    })
    expect(
      await executeAgentIntent(call('set_scene_item', { item: 'camera', shown: false }), context)
    ).toMatchObject({ ok: true, message: 'FaceTime HD Camera is hidden.' })
    expect(arrange.setSourceVisible).toHaveBeenCalledWith('source:camera', false)
    const live = arranged(snapshot({ sessionActive: true }))
    expect(
      await executeAgentIntent(
        call('set_scene_item', { item: 'screen', shown: false }),
        live.context
      )
    ).toEqual({ ok: false, message: SCENE_VISIBILITY_LOCK_REASON })
    const sideBySide = arranged(
      snapshot({ layout: { ...snapshot().layout, layoutPreset: 'side-by-side' } })
    )
    expect(
      await executeAgentIntent(
        call('set_scene_item', { item: 'camera', shape: 'circle' }),
        sideBySide.context
      )
    ).toEqual({ ok: false, message: SCENE_LAYOUT_COPY.shapeNotHere })
  })

  it("flips the overlays' and banners' output switches", async () => {
    const { arrange, context, state } = arranged()
    expect(
      await executeAgentIntent(
        call('set_scene_item', { item: 'buddy', showOnStream: true, showInRecording: false }),
        context
      )
    ).toEqual({
      ok: true,
      message: 'Buddy shows on stream. Buddy stays out of the recording.',
      result: { item: 'buddy', name: 'Buddy', showOnStream: true, showInRecording: false }
    })
    expect(state().overlayLayout.buddy).toMatchObject({
      showOnStream: true,
      showInRecording: false
    })
    await executeAgentIntent(
      call('set_scene_item', { item: 'banner:sponsor', showInRecording: false }),
      context
    )
    expect(arrange.updateBanner).toHaveBeenCalledWith('sponsor', { showInRecording: false })
    for (const [args, message] of [
      [{ item: 'buddy', shown: true }, SCENE_LAYOUT_COPY.overlayShown],
      [{ item: 'banner:sponsor', shown: true }, SCENE_LAYOUT_COPY.bannerShown],
      [{ item: 'camera', showOnStream: false }, SCENE_LAYOUT_COPY.sourceSwitches],
      [{ item: 'buddy', shape: 'circle' }, SCENE_LAYOUT_COPY.shapeCameraOnly],
      [{ item: 'buddy' }, SCENE_LAYOUT_COPY.setEmpty]
    ] as const) {
      expect(await executeAgentIntent(call('set_scene_item', args), context)).toEqual({
        ok: false,
        message
      })
    }
  })

  it('lists every item with its names, switches and rects per orientation', async () => {
    const { context } = arranged()
    const outcome = await executeAgentIntent(call('get_scene_layout', {}), context)
    expect(outcome.ok).toBe(true)
    const result = outcome.result as {
      items: { item: string; rects: object }[]
      arrangement: string
    }
    expect(result.arrangement).toBe('preset')
    expect(result.items.map((item) => item.item)).toEqual([
      'camera',
      'screen',
      'highlight',
      'captions',
      'buddy',
      'banner:sponsor',
      'banner:logo'
    ])
    expect(result.items[0]).toMatchObject({
      name: 'FaceTime HD Camera',
      kind: 'camera',
      corner: 'bottom-right',
      shape: defaultCaptureConfig.layout.cameraShape,
      rects: { horizontal: { x: 0.7, y: 0.7, width: 0.28125, height: 0.28125 } }
    })
    expect(result.items[4]).toMatchObject({
      name: 'Buddy',
      showOnStream: false,
      rects: {
        horizontal: toSceneRect(DEFAULT_OVERLAY_LAYOUT.buddy.horizontal),
        vertical: toSceneRect(DEFAULT_OVERLAY_LAYOUT.buddy.vertical)
      }
    })
  })
})
