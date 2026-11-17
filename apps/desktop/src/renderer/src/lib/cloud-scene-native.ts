import type { EffectiveSceneBackground, LayoutSettings, Scene, SceneSource } from '@/lib/backend'
import {
  defaultSceneGuests,
  parseCloudSceneExtension,
  sceneKey,
  type CloudScene,
  type CloudSceneExtension,
  type SceneItem,
  type SceneMask,
  type SceneOrientation
} from '../../../shared/cloud-scene'
import {
  effectiveCameraMaskShape,
  previewProofBackgroundStageMargin,
  previewProofLayerFit
} from '../../../shared/native-preview-proof-geometry'
import { sceneCameraOnStage, sceneStageRect } from '../../../shared/scene-picture-geometry'

/**
 * Plan 249 S12: a scene the native engine resolved (`cloud.scene.resolve`,
 * Rust `scene_from_capture_config`) as cloud roles. Geometry is the native
 * engine's own: frames and crops are copied, the background stage margin is
 * applied with the shared `sceneStageRect`, and fit, mask and mirror use the
 * same rules every native render path depicts (`native-preview-proof-geometry`).
 * Nothing here places a source itself.
 */
export type CloudSceneSkip = { sourceId: string; reason: 'test-pattern' | 'hidden' }
export type CloudSceneTranslation = {
  scene: CloudScene
  /** Sources the room cannot show, named, never silently dropped. */
  skipped: CloudSceneSkip[]
  needs: { camera: boolean; screen: boolean }
}

function maskOf(source: SceneSource, layout: LayoutSettings): SceneMask {
  if (source.kind !== 'camera') return { shape: 'rectangle' }
  const shape = effectiveCameraMaskShape(layout)
  if (shape === 'circle') return { shape: 'circle' }
  if (shape === 'rounded')
    return {
      shape: 'rounded',
      radius: Math.min(50, Math.max(0, layout.cameraCornerRadiusPct)) / 100
    }
  return { shape: 'rectangle' }
}

export function cloudSceneFromNative(input: {
  scene: Scene
  layout: LayoutSettings
  background: Pick<EffectiveSceneBackground, 'visibilityPercent'> | null | undefined
  orientation: SceneOrientation
  /** `SavedScene.cloud`; absent on a preset or an older saved scene. */
  extension?: unknown
}): CloudSceneTranslation {
  const { scene, layout } = input
  const margin = previewProofBackgroundStageMargin(input.background)
  const cameraOnStage = sceneCameraOnStage(scene.sources, layout)
  const items: SceneItem[] = []
  const skipped: CloudSceneSkip[] = []
  scene.sources.forEach((source, z) => {
    if (!source.visible) {
      skipped.push({ sourceId: source.id, reason: 'hidden' })
      return
    }
    if (source.kind === 'test-pattern') {
      // A diagnostic stand-in has no room track; the program never fakes one.
      skipped.push({ sourceId: source.id, reason: 'test-pattern' })
      return
    }
    const t = source.transform
    const rect = sceneStageRect(
      { x: t.x, y: t.y, width: t.width, height: t.height },
      source.kind,
      margin,
      cameraOnStage
    )
    const camera = source.kind === 'camera'
    items.push({
      role: camera ? 'host-camera' : 'screen',
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      crop: { l: t.cropLeft, t: t.cropTop, r: t.cropRight, b: t.cropBottom },
      fit: previewProofLayerFit(source, layout),
      mirror: camera && layout.cameraMirror,
      mask: maskOf(source, layout),
      z
    })
  })
  const extension: CloudSceneExtension | null = parseCloudSceneExtension(input.extension)
  const guests = extension?.guests ?? defaultSceneGuests(input.orientation)
  return {
    scene: { id: sceneKey(JSON.stringify([items, guests])), items, guests },
    skipped,
    needs: {
      camera: items.some((item) => item.role === 'host-camera'),
      screen: items.some((item) => item.role === 'screen')
    }
  }
}
