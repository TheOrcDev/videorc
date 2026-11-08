// Buddy on the Electron proof surface (plan 205 S9, owner decision D6): the
// Windows idle preview and the Linux preview compose layers in main, so the
// Buddy becomes one frame-polled layer whose pixels the backend draws
// (`/preview/buddy/latest.bmp`: the pet's current cell and its bubble as a
// straight-alpha BMP covering the layer's rect). Each frame carries its rect
// in its headers; the proof page places the `<img>` from them, so the layer's
// initial transform is only the Buddy's saved rect until the first frame.
// Pure: main/index.ts owns the layout feed, the frame URL and the window.

import type {
  Banner,
  OverlayItemLayout,
  OverlayRect,
  PreviewSurfaceSceneLayer,
  PreviewSurfaceSceneState
} from '../shared/backend'
import { programShows, type OverlaySessionShape } from '../shared/preview-program'
import {
  PREVIEW_SURFACE_BANNER_LAYER_KIND,
  fallbackPreviewSurfaceCanvas,
  previewSurfaceBannerLayers,
  type PreviewSurfaceCanvas
} from './preview-surface-banners'

export const PREVIEW_SURFACE_BUDDY_LAYER_KIND = 'buddy'
/** One Buddy; the id matches the Scene editor's stage id for it. */
export const PREVIEW_SURFACE_BUDDY_LAYER_ID = 'overlay:buddy'

/**
 * Whether the proof surface draws the Buddy's layer on this platform. On
 * macOS the Preview is the native CAMetalLayer, where the compositor's
 * program leg draws the Buddy, and the proof surface is only its fallback;
 * polling the route there would build a third pet atlas that shrinks the
 * stream's and the recording's under their shared memory budget.
 */
export function previewSurfaceDrawsBuddyLayer(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin'
}

/** The Buddy's rect for a canvas: the vertical rect on a portrait canvas
 * (`OverlayOrientation::for_canvas`), the horizontal one otherwise. */
export function previewSurfaceBuddyRect(
  buddy: OverlayItemLayout,
  canvas: PreviewSurfaceCanvas
): OverlayRect {
  return canvas.height > canvas.width ? buddy.vertical : buddy.horizontal
}

/**
 * The Buddy's layer, when the program carries it (`programShows`: either
 * switch while nothing runs or under Clips, the running outputs' switches
 * otherwise) and the surface polls frames (`frameUrl`); null otherwise. It
 * goes last, above the banners (docs/banners.md z order: scene, takeover,
 * banners, captions, Buddy, highlight card).
 */
export function previewSurfaceBuddyLayer(
  buddy: OverlayItemLayout | null,
  shape: OverlaySessionShape | null,
  canvas: PreviewSurfaceCanvas,
  frameUrl: string | undefined
): PreviewSurfaceSceneLayer | null {
  if (!buddy || !frameUrl) return null
  if (!programShows(shape, buddy.showOnStream, buddy.showInRecording)) return null
  const rect = previewSurfaceBuddyRect(buddy, canvas)
  return {
    id: PREVIEW_SURFACE_BUDDY_LAYER_ID,
    name: 'Buddy',
    kind: PREVIEW_SURFACE_BUDDY_LAYER_KIND,
    transform: {
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      cropLeft: 0,
      cropTop: 0,
      cropRight: 0,
      cropBottom: 0
    },
    visible: true,
    frameUrl,
    // Every frame is exactly its rect, so the image fills it.
    fit: 'fill',
    mirror: false
  }
}

/** Whether a layer is one main places from the program: a banner or the Buddy. */
export function previewSurfaceLayerIsOverlay(layer: PreviewSurfaceSceneLayer): boolean {
  return (
    layer.kind === PREVIEW_SURFACE_BANNER_LAYER_KIND ||
    layer.kind === PREVIEW_SURFACE_BUDDY_LAYER_KIND
  )
}

/**
 * The scene with its program overlays re-placed for the current banners,
 * Buddy layout and program shape, against the canvas the scene was built on:
 * the banners in Assets order, then the Buddy above them. `frameUrl` builds
 * the Buddy route's URL for that canvas (undefined: no Buddy layer).
 */
export function withPreviewSurfaceOverlays(
  scene: PreviewSurfaceSceneState,
  banners: readonly Banner[],
  buddy: OverlayItemLayout | null,
  shape: OverlaySessionShape | null,
  frameUrl: (canvas: PreviewSurfaceCanvas) => string | undefined
): PreviewSurfaceSceneState {
  const canvas = scene.bannerCanvas ?? fallbackPreviewSurfaceCanvas(scene.layout)
  const buddyLayer = previewSurfaceBuddyLayer(buddy, shape, canvas, frameUrl(canvas))
  return {
    ...scene,
    bannerCanvas: canvas,
    sources: [
      ...scene.sources.filter((layer) => !previewSurfaceLayerIsOverlay(layer)),
      ...previewSurfaceBannerLayers(banners, canvas, shape),
      ...(buddyLayer ? [buddyLayer] : [])
    ]
  }
}
