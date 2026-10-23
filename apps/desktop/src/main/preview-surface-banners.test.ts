import { describe, expect, it } from 'vitest'

import type {
  Banner,
  LayoutSettings,
  PreviewSurfaceSceneLayer,
  PreviewSurfaceSceneState
} from '../shared/backend'
import {
  fallbackPreviewSurfaceCanvas,
  previewSurfaceBannerLayers,
  previewSurfaceCanvasFromCompositor,
  previewSurfaceCanvasFromOutputs,
  previewSurfaceVisibleBanners,
  withPreviewSurfaceBanners
} from './preview-surface-banners'

function banner(overrides: Partial<Banner> = {}): Banner {
  const id = overrides.id ?? 'sponsor'
  return {
    id,
    name: 'Sponsor',
    imageFile: `${id}.png`,
    thumbnailFile: `${id}.thumb.png`,
    width: 2400,
    height: 400,
    hasAlpha: true,
    sortOrder: 0,
    shown: true,
    horizontal: { x: 0.2, y: 0.782222, w: 0.6, h: 0.177778 },
    vertical: { x: 0.071111, y: 0.699583, w: 0.857778, h: 0.080417 },
    showOnStream: true,
    showInRecording: true,
    opacity: 1,
    createdAt: '2026-10-20T18:00:00Z',
    updatedAt: '2026-10-20T18:00:00Z',
    ...overrides
  }
}

function layer(id: string, kind: PreviewSurfaceSceneLayer['kind']): PreviewSurfaceSceneLayer {
  return {
    id,
    name: id,
    kind,
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
    visible: true,
    fit: 'cover',
    mirror: false
  }
}

describe('proof surface banner layers (plan 186 S4)', () => {
  it('places a showing banner by the shared contained-rect maths, as canvas fractions', () => {
    const [placed] = previewSurfaceBannerLayers([banner({ opacity: 0.85 })], {
      width: 1920,
      height: 1080
    })
    // protocol-fixtures/banner-geometry.json "wide default 1080p": 384 845 1152 192.
    expect(placed).toStrictEqual({
      id: 'banner:sponsor',
      name: 'Sponsor',
      kind: 'banner',
      transform: {
        x: 384 / 1920,
        y: 845 / 1080,
        width: 1152 / 1920,
        height: 192 / 1080,
        cropLeft: 0,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0
      },
      visible: true,
      imageUrl: 'videorc-asset://banner/sponsor.png',
      fit: 'fill',
      mirror: false,
      opacity: 0.85
    })
  })

  it('takes the vertical rect on a portrait canvas', () => {
    const [placed] = previewSurfaceBannerLayers([banner()], { width: 1080, height: 1920 })
    // Fixture "vertical wide default": 77 1344 926 154.
    expect(placed.transform.x).toBe(77 / 1080)
    expect(placed.transform.y).toBe(1344 / 1920)
    expect(placed.transform.width).toBe(926 / 1080)
    expect(placed.transform.height).toBe(154 / 1920)
  })

  it('draws only showing banners with a switch on, in Assets order', () => {
    const banners = [
      banner({ id: 'c', sortOrder: 2 }),
      banner({ id: 'hidden', sortOrder: 0, shown: false }),
      banner({ id: 'a', sortOrder: 0 }),
      banner({ id: 'nowhere', sortOrder: 1, showOnStream: false, showInRecording: false }),
      banner({ id: 'b', sortOrder: 1, showOnStream: false })
    ]
    expect(previewSurfaceVisibleBanners(banners).map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(
      previewSurfaceBannerLayers(banners, { width: 1280, height: 720 }).map((item) => item.id)
    ).toEqual(['banner:a', 'banner:b', 'banner:c'])
    // The input order is untouched.
    expect(banners[0].id).toBe('c')
  })

  it('picks the preview output, then the recording output, then the compositor size', () => {
    expect(
      previewSurfaceCanvasFromOutputs([
        { id: 'output:recording', kind: 'recording', width: 3840, height: 2160, fps: 30 },
        { id: 'output:preview', kind: 'preview', width: 1280, height: 720, fps: 30 }
      ])
    ).toEqual({ width: 1280, height: 720 })
    expect(
      previewSurfaceCanvasFromOutputs([
        { id: 'output:recording', kind: 'recording', width: 1080, height: 1920, fps: 30 }
      ])
    ).toEqual({ width: 1080, height: 1920 })
    expect(previewSurfaceCanvasFromOutputs([])).toBeNull()
    expect(previewSurfaceCanvasFromOutputs(undefined)).toBeNull()
    expect(previewSurfaceCanvasFromCompositor({ width: 1920, height: 1080 })).toEqual({
      width: 1920,
      height: 1080
    })
    expect(previewSurfaceCanvasFromCompositor({ width: 0, height: 1080 })).toBeNull()
    expect(fallbackPreviewSurfaceCanvas({ layoutPreset: 'screen-camera' })).toEqual({
      width: 1280,
      height: 720
    })
    expect(fallbackPreviewSurfaceCanvas({ layoutPreset: 'vertical-split' })).toEqual({
      width: 720,
      height: 1280
    })
  })

  it('replaces only the banner layers and keeps them above the scene and takeover', () => {
    const scene: PreviewSurfaceSceneState = {
      revision: 7,
      layout: { layoutPreset: 'screen-camera' } as LayoutSettings,
      sources: [
        layer('background:a', 'background'),
        layer('source:base', 'screen'),
        layer('banner:old', 'banner'),
        layer('screen-image:brb', 'screen-image')
      ],
      bannerCanvas: { width: 1920, height: 1080 },
      updatedAt: 'now'
    }
    const next = withPreviewSurfaceBanners(scene, [banner({ id: 'new' })])
    expect(next.sources.map((item) => item.id)).toEqual([
      'background:a',
      'source:base',
      'screen-image:brb',
      'banner:new'
    ])
    expect(next.sources[3].transform.x).toBe(384 / 1920)
    expect(next.revision).toBe(7)
    const cleared = withPreviewSurfaceBanners(next, [])
    expect(cleared.sources.map((item) => item.id)).toEqual([
      'background:a',
      'source:base',
      'screen-image:brb'
    ])
    // A scene built before the canvas was known falls back to the preview box.
    const { bannerCanvas: _canvas, ...withoutCanvas } = scene
    expect(withPreviewSurfaceBanners(withoutCanvas, []).bannerCanvas).toEqual({
      width: 1280,
      height: 720
    })
  })
})
