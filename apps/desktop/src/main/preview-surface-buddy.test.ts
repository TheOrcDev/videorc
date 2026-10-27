import { describe, expect, it } from 'vitest'

import type {
  Banner,
  LayoutSettings,
  OverlayItemLayout,
  PreviewSurfaceSceneLayer,
  PreviewSurfaceSceneState
} from '../shared/backend'
import type { OverlaySessionShape } from '../shared/preview-program'
import {
  PREVIEW_SURFACE_BUDDY_LAYER_ID,
  previewSurfaceBuddyLayer,
  withPreviewSurfaceOverlays
} from './preview-surface-buddy'

const CANVAS = { width: 1280, height: 720 }
const FRAME_URL = 'http://127.0.0.1:1/preview/buddy/latest.bmp?token=t'
const RECORD: OverlaySessionShape = { recordEnabled: true, streamEnabled: false, auxLeg: 'none' }
const STREAM: OverlaySessionShape = { recordEnabled: false, streamEnabled: true, auxLeg: 'none' }

function buddy(showOnStream: boolean, showInRecording: boolean): OverlayItemLayout {
  return {
    horizontal: { x: 0.8, y: 0.7, w: 0.15, h: 0.25 },
    vertical: { x: 0.6, y: 0.8, w: 0.3, h: 0.15 },
    showOnStream,
    showInRecording
  }
}

function banner(id: string): Banner {
  return {
    id,
    name: id,
    imageFile: `${id}.png`,
    thumbnailFile: `${id}.thumb.png`,
    width: 512,
    height: 512,
    hasAlpha: true,
    sortOrder: 0,
    shown: true,
    horizontal: { x: 0.05, y: 0.05, w: 0.2, h: 0.2 },
    vertical: { x: 0.05, y: 0.05, w: 0.2, h: 0.2 },
    showOnStream: true,
    showInRecording: true,
    opacity: 1,
    createdAt: '2026-10-27T12:00:00Z',
    updatedAt: '2026-10-27T12:00:00Z'
  }
}

function source(id: string): PreviewSurfaceSceneLayer {
  return {
    id,
    name: id,
    kind: 'camera',
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

function scene(sources: PreviewSurfaceSceneLayer[]): PreviewSurfaceSceneState {
  return {
    revision: 1,
    layout: { layoutPreset: 'camera-only' } as LayoutSettings,
    bannerCanvas: CANVAS,
    sources
  } as PreviewSurfaceSceneState
}

describe('the proof surface Buddy layer (plan 205 S9)', () => {
  it('follows the program: either switch at idle, the running outputs otherwise', () => {
    expect(previewSurfaceBuddyLayer(buddy(true, false), null, CANVAS, FRAME_URL)).not.toBeNull()
    expect(previewSurfaceBuddyLayer(buddy(false, false), null, CANVAS, FRAME_URL)).toBeNull()
    expect(previewSurfaceBuddyLayer(buddy(true, false), RECORD, CANVAS, FRAME_URL)).toBeNull()
    expect(previewSurfaceBuddyLayer(buddy(true, false), STREAM, CANVAS, FRAME_URL)).not.toBeNull()
    expect(previewSurfaceBuddyLayer(null, null, CANVAS, FRAME_URL)).toBeNull()
    // No frame URL (polling off): nothing to draw.
    expect(previewSurfaceBuddyLayer(buddy(true, true), null, CANVAS, undefined)).toBeNull()
  })

  it('starts at the saved rect for the canvas orientation and polls its frame', () => {
    const landscape = previewSurfaceBuddyLayer(buddy(true, true), null, CANVAS, FRAME_URL)!
    expect(landscape.id).toBe(PREVIEW_SURFACE_BUDDY_LAYER_ID)
    expect(landscape.kind).toBe('buddy')
    expect(landscape.frameUrl).toBe(FRAME_URL)
    expect(landscape.transform).toMatchObject({ x: 0.8, y: 0.7, width: 0.15, height: 0.25 })
    const portrait = previewSurfaceBuddyLayer(
      buddy(true, true),
      null,
      { width: 720, height: 1280 },
      FRAME_URL
    )!
    expect(portrait.transform).toMatchObject({ x: 0.6, y: 0.8, width: 0.3, height: 0.15 })
  })

  it('re-places the banners and then the Buddy above every scene layer', () => {
    const placed = withPreviewSurfaceOverlays(
      scene([source('camera'), source('stale-buddy')]),
      [banner('a'), banner('b')],
      buddy(true, false),
      null,
      () => FRAME_URL
    )
    expect(placed.sources.map((layer) => layer.id)).toStrictEqual([
      'camera',
      'stale-buddy',
      'banner:a',
      'banner:b',
      PREVIEW_SURFACE_BUDDY_LAYER_ID
    ])
    // A record-only session drops the stream-only Buddy, and the old layer.
    const recording = withPreviewSurfaceOverlays(
      placed,
      [banner('a')],
      buddy(true, false),
      RECORD,
      () => FRAME_URL
    )
    expect(recording.sources.map((layer) => layer.id)).toStrictEqual([
      'camera',
      'stale-buddy',
      'banner:a'
    ])
  })
})
