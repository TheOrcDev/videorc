// Banners on the Electron proof surface (plan 186 S4 step 4): the Windows idle
// preview and the Linux preview compose layers in main, so each showing banner
// becomes one image layer placed by the same contained-rect maths the
// compositors use (`bannerDrawRect`, pinned by the shared geometry fixture).
// Pure: main/index.ts owns the banner feed and the window.

import type {
  Banner,
  LayoutSettings,
  PreviewSurfaceSceneLayer,
  PreviewSurfaceSceneState,
  SceneOutput
} from '../shared/backend'
import { VERTICAL_LAYOUT_PRESETS } from '../shared/backend'
import { programShows, type OverlaySessionShape } from '../shared/preview-program'
import { bannerAssetUrl } from '../shared/banner-assets'
import { bannerDrawRect, bannerRectForCanvas } from '../shared/banner-geometry'

export interface PreviewSurfaceCanvas {
  width: number
  height: number
}

export const PREVIEW_SURFACE_BANNER_LAYER_KIND = 'banner'

/** The preview budget box the backend fits its preview output into. */
const DEFAULT_PREVIEW_CANVAS: PreviewSurfaceCanvas = { width: 1280, height: 720 }

/**
 * Showing banners carried by the program, in Assets order so a later
 * banner draws on top.
 */
export function previewSurfaceVisibleBanners(
  banners: readonly Banner[],
  shape: OverlaySessionShape | null
): Banner[] {
  return banners
    .filter(
      (banner) => banner.shown && programShows(shape, banner.showOnStream, banner.showInRecording)
    )
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

/** One image layer per visible banner, placed against `canvas` in pixels and
 * handed to the proof page as canvas fractions. */
export function previewSurfaceBannerLayers(
  banners: readonly Banner[],
  canvas: PreviewSurfaceCanvas,
  shape: OverlaySessionShape | null = null
): PreviewSurfaceSceneLayer[] {
  const width = Math.max(1, Math.round(canvas.width))
  const height = Math.max(1, Math.round(canvas.height))
  return previewSurfaceVisibleBanners(banners, shape).map((banner) => {
    const rect = bannerDrawRect(
      banner.width,
      banner.height,
      width,
      height,
      bannerRectForCanvas(banner, width, height)
    )
    return {
      id: `${PREVIEW_SURFACE_BANNER_LAYER_KIND}:${banner.id}`,
      name: banner.name,
      kind: PREVIEW_SURFACE_BANNER_LAYER_KIND,
      transform: {
        x: rect.x / width,
        y: rect.y / height,
        width: rect.w / width,
        height: rect.h / height,
        cropLeft: 0,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0
      },
      visible: true,
      imageUrl: bannerAssetUrl(banner.imageFile),
      // The transform already is the contained rect, rounded like the
      // compositors round it, so the image fills it exactly.
      fit: 'fill',
      mirror: false,
      opacity: Math.min(1, Math.max(0, banner.opacity))
    }
  })
}

function validCanvas(width: unknown, height: unknown): PreviewSurfaceCanvas | null {
  return typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : null
}

/** The canvas a renderer scene update draws on: its preview output, else the
 * recording output, else any output. */
export function previewSurfaceCanvasFromOutputs(
  outputs: readonly SceneOutput[] | undefined
): PreviewSurfaceCanvas | null {
  if (!outputs?.length) return null
  const output =
    outputs.find((candidate) => candidate.kind === 'preview') ??
    outputs.find((candidate) => candidate.kind === 'recording') ??
    outputs[0]
  return validCanvas(output.width, output.height)
}

/** The canvas the compositor reports, when it reports one. */
export function previewSurfaceCanvasFromCompositor(status: {
  width?: number
  height?: number
}): PreviewSurfaceCanvas | null {
  return validCanvas(status.width, status.height)
}

/** With no scene output and no compositor size yet: the preview budget box in
 * the layout's orientation. */
export function fallbackPreviewSurfaceCanvas(
  layout: Pick<LayoutSettings, 'layoutPreset'> | undefined
): PreviewSurfaceCanvas {
  return layout && (VERTICAL_LAYOUT_PRESETS as readonly string[]).includes(layout.layoutPreset)
    ? { width: DEFAULT_PREVIEW_CANVAS.height, height: DEFAULT_PREVIEW_CANVAS.width }
    : DEFAULT_PREVIEW_CANVAS
}

/**
 * The scene with its banner layers replaced for a new banner list, against
 * the canvas the scene was built on. Banners always sit last: above the
 * scene and the takeover (plan 186 D5).
 */
export function withPreviewSurfaceBanners(
  scene: PreviewSurfaceSceneState,
  banners: readonly Banner[],
  shape: OverlaySessionShape | null = null
): PreviewSurfaceSceneState {
  const canvas = scene.bannerCanvas ?? fallbackPreviewSurfaceCanvas(scene.layout)
  return {
    ...scene,
    bannerCanvas: canvas,
    sources: [
      ...scene.sources.filter((layer) => layer.kind !== PREVIEW_SURFACE_BANNER_LAYER_KIND),
      ...previewSurfaceBannerLayers(banners, canvas, shape)
    ]
  }
}
