import type { Device, EffectiveSceneBackground, LayoutSettings, SourceSelection } from './backend'
import {
  defaultCaptureConfig,
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  normalizeLayoutSettings
} from './capture'
import { BUILTIN_LAYOUTS } from './layout-framing-memory'
import { BUNDLED_BACKGROUND_MANIFEST } from '../../../shared/background-import'

export const SCENE_LIBRARY_KEY = 'videorc.scene-presets.v1'
export const WORKING_SCENE_KEY = 'videorc.working-scene.v1'
export type VisualSources = Pick<
  SourceSelection,
  'cameraId' | 'cameraName' | 'screenId' | 'screenName' | 'windowId' | 'windowName' | 'testPattern'
>
export type SavedSceneBackground = Omit<EffectiveSceneBackground, 'managedAssetPath'> & {
  fileName?: string
}
export type SceneVisual = {
  layout: LayoutSettings
  sources: VisualSources
  background: SavedSceneBackground | null
}
export type SavedScene = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  visual: SceneVisual
}
export type ScenePresetLibrary = { version: 1; scenes: SavedScene[] }
export type WorkingScene = {
  version: 1
  origin?: 'builtin' | 'saved'
  sceneId: string | null
  visual: SceneVisual
}

export function visualSources(sources: VisualSources): VisualSources {
  return {
    cameraId: sources.cameraId,
    cameraName: sources.cameraName,
    screenId: sources.screenId,
    screenName: sources.screenName,
    windowId: sources.windowId,
    windowName: sources.windowName,
    testPattern: sources.testPattern === true
  }
}
export function snapshotBackground(
  background: EffectiveSceneBackground | null | undefined
): SavedSceneBackground | null {
  if (!background) return null
  const { managedAssetPath, ...style } = background
  const bundled = BUNDLED_BACKGROUND_MANIFEST.some((entry) => entry.id === style.assetId)
  return {
    ...style,
    ...(!bundled
      ? { fileName: decodeURIComponent(managedAssetPath.split(/[\\/]/).pop() ?? '') }
      : {})
  }
}
export function normalizeSavedBackground(raw: unknown): SavedSceneBackground | null {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object') throw new Error('Invalid saved background')
  const data = raw as SavedSceneBackground
  if (typeof data.assetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.assetId))
    throw new Error('Invalid background identity')
  const builtin = BUNDLED_BACKGROUND_MANIFEST.some((entry) => entry.id === data.assetId)
  if (
    !builtin &&
    (typeof data.fileName !== 'string' ||
      !['png', 'jpg', 'jpeg', 'webp'].some((ext) => data.fileName === `${data.assetId}.${ext}`))
  )
    throw new Error('Invalid managed background descriptor')
  const clamp = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : fallback
  return {
    assetId: data.assetId,
    ...(!builtin ? { fileName: data.fileName } : {}),
    fit: data.fit === 'fit' || data.fit === 'stretch' ? data.fit : 'fill',
    scale: clamp(data.scale, 100, 50, 200),
    offsetX: clamp(data.offsetX, 0, -100, 100),
    offsetY: clamp(data.offsetY, 0, -100, 100),
    blurPx: clamp(data.blurPx, 0, 0, 40),
    dimPercent: clamp(data.dimPercent, 0, 0, 80),
    saturationPercent: clamp(data.saturationPercent, 100, 0, 150),
    vignettePercent: clamp(data.vignettePercent, 0, 0, 100),
    visibilityPercent: clamp(data.visibilityPercent, 20, 0, 40)
  }
}
export function resolveSavedBackground(
  background: SavedSceneBackground | null
): EffectiveSceneBackground | null {
  if (!background) return null
  const { fileName, ...style } = normalizeSavedBackground(background)!
  const name =
    BUNDLED_BACKGROUND_MANIFEST.find((entry) => entry.id === style.assetId)?.fileName ?? fileName!
  // The existing managed-asset protocol and backend capability registry resolve
  // this filename inside app-owned roots. Persisted arbitrary paths never survive.
  return { ...style, managedAssetPath: `videorc-asset://background/${encodeURIComponent(name)}` }
}
export function normalizeSceneVisual(raw: unknown): SceneVisual {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid visual snapshot')
  const data = raw as SceneVisual
  if (
    !data.layout ||
    !BUILTIN_LAYOUTS.some(({ id }) => id === data.layout.layoutPreset) ||
    !data.sources ||
    typeof data.sources !== 'object'
  )
    throw new Error('Invalid scene layout or sources')
  for (const key of ['cameraId', 'screenId', 'windowId'] as const) {
    if (
      data.sources[key] !== undefined &&
      (typeof data.sources[key] !== 'string' || data.sources[key]!.length === 0)
    )
      throw new Error('Invalid source identity')
  }
  for (const key of ['cameraName', 'screenName', 'windowName'] as const) {
    if (data.sources[key] !== undefined && typeof data.sources[key] !== 'string')
      throw new Error('Invalid source label')
  }
  const allowedLayout = Object.fromEntries(
    Object.keys(defaultCaptureConfig.layout).map((key) => [
      key,
      data.layout[key as keyof LayoutSettings]
    ])
  )
  const layout = structuredClone(normalizeLayoutSettings(allowedLayout))
  layout.sourceTransformOverrides = Object.fromEntries(
    Object.entries(layout.sourceTransformOverrides).sort(([a], [b]) => a.localeCompare(b))
  )
  return {
    layout,
    sources: visualSources(data.sources),
    background: normalizeSavedBackground(data.background)
  }
}
export function sceneNameError(
  name: string,
  scenes: readonly SavedScene[],
  exceptId?: string
): string | null {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 80) return 'Use a name between 1 and 80 characters.'
  return scenes.some(
    (scene) =>
      scene.id !== exceptId && scene.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase()
  )
    ? 'A scene with this name already exists.'
    : null
}
export function hydrateSceneLibrary(raw: unknown): {
  library: ScenePresetLibrary
  readOnly: boolean
  error: string | null
} {
  const empty: ScenePresetLibrary = { version: 1, scenes: [] }
  if (raw == null) return { library: empty, readOnly: false, error: null }
  const data = raw as Partial<ScenePresetLibrary>
  if (data.version !== 1)
    return {
      library: empty,
      readOnly: true,
      error: 'Update Videorc to open these scenes. Your saved data is preserved.'
    }
  const scenes: SavedScene[] = []
  for (const entry of Array.isArray(data.scenes) ? data.scenes : []) {
    try {
      if (
        !entry ||
        typeof entry.id !== 'string' ||
        !entry.id ||
        scenes.some((scene) => scene.id === entry.id) ||
        typeof entry.name !== 'string' ||
        sceneNameError(entry.name, scenes) ||
        typeof entry.createdAt !== 'string' ||
        typeof entry.updatedAt !== 'string'
      )
        continue
      scenes.push({
        id: entry.id,
        name: entry.name.trim(),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        visual: normalizeSceneVisual(entry.visual)
      })
    } catch {
      /* Reject only the malformed entry. */
    }
  }
  return {
    library: { version: 1, scenes },
    readOnly: false,
    error:
      scenes.length !== (Array.isArray(data.scenes) ? data.scenes.length : 0)
        ? 'Some invalid saved scenes could not be loaded.'
        : null
  }
}
export function hydrateWorkingScene(raw: unknown): WorkingScene | null {
  try {
    const data = raw as WorkingScene
    if (data?.version !== 1 || (data.sceneId !== null && typeof data.sceneId !== 'string'))
      return null
    return {
      version: 1,
      origin: data.origin === 'saved' || data.sceneId ? 'saved' : 'builtin',
      sceneId: data.sceneId,
      visual: normalizeSceneVisual(data.visual)
    }
  } catch {
    return null
  }
}
export function sameSceneVisual(a: SceneVisual, b: SceneVisual): boolean {
  return JSON.stringify(normalizeSceneVisual(a)) === JSON.stringify(normalizeSceneVisual(b))
}
export function sceneSourceProblems(visual: SceneVisual, devices: readonly Device[]): string[] {
  const problems: string[] = []
  const requireSource = (id: string | undefined, kind: Device['kind'], label: string): void => {
    if (
      !id ||
      !devices.some(
        (device) => device.id === id && device.kind === kind && device.status === 'available'
      )
    )
      problems.push(`${label} unavailable. Choose a replacement.`)
  }
  if (
    visual.layout.arrangementMode === 'freeform'
      ? Boolean(visual.sources.cameraId)
      : layoutPresetNeedsCamera(visual.layout.layoutPreset)
  )
    requireSource(visual.sources.cameraId, 'camera', 'Camera')
  const baseId = visual.sources.windowId ?? visual.sources.screenId
  if (
    (visual.layout.arrangementMode === 'freeform' ||
      layoutPresetNeedsScreen(visual.layout.layoutPreset)) &&
    (!visual.sources.testPattern || baseId)
  ) {
    requireSource(baseId, visual.sources.windowId ? 'window' : 'screen', 'Screen or window')
  }
  return problems
}
