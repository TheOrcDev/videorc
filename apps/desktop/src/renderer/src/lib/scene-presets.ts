import type {
  AudioSettings,
  Device,
  EffectiveSceneBackground,
  LayoutSettings,
  Scene,
  SourceSelection
} from './backend'
import {
  defaultCaptureConfig,
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  normalizeLayoutSettings,
  normalizeSourceVisibility
} from './capture'
import { BUILTIN_LAYOUTS } from './layout-framing-memory'
import { BUNDLED_BACKGROUND_MANIFEST } from '../../../shared/background-import'
import { parseLivePosterAssetId } from '../../../shared/live-background-ids'

export const SCENE_LIBRARY_KEY = 'videorc.scene-presets.v1'
export const WORKING_SCENE_KEY = 'videorc.working-scene.v1'
export type VisualSources = Pick<
  SourceSelection,
  | 'cameraId'
  | 'cameraName'
  | 'cameraOff'
  | 'captureOff'
  | 'screenId'
  | 'screenName'
  | 'windowId'
  | 'windowName'
  | 'testPattern'
>
export type SavedSceneBackground = Omit<EffectiveSceneBackground, 'managedAssetPath'> & {
  fileName?: string
}
export type SceneVisual = {
  layout: LayoutSettings
  sources: VisualSources
  background: SavedSceneBackground | null
}
/**
 * What a saved scene hears (owner, 2026-10-27): its microphone, None
 * included, and System audio On or Off. Levels and mute stay with the mixer,
 * like recording and streaming settings.
 */
export type SceneAudio = Pick<SourceSelection, 'microphoneId' | 'microphoneName'> & {
  microphoneOff: boolean
  systemAudioEnabled: boolean
}
export type SceneMicrophone = Pick<
  SourceSelection,
  'microphoneId' | 'microphoneName' | 'microphoneOff'
>
export type SavedScene = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  visual: SceneVisual
  /** Absent on a scene saved before scenes kept audio: applying it leaves audio as it is. */
  audio?: SceneAudio
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
    // Match capture reconciliation: a selected ID wins over a stale Off flag.
    // Legacy absent flags remain automatic selection, never inferred Off.
    // Always project a boolean so apply/checkpoint restore clears prior Off.
    cameraOff: sources.cameraOff === true && !sources.cameraId,
    // Plan 0002 (release test 146): the same projection for a screen set to None.
    captureOff: sources.captureOff === true && !sources.screenId && !sources.windowId,
    screenId: sources.screenId,
    screenName: sources.screenName,
    windowId: sources.windowId,
    windowName: sources.windowName,
    testPattern: sources.testPattern === true
  }
}
export function sceneAudio(
  sources: SceneMicrophone,
  audio: Pick<AudioSettings, 'systemAudioEnabled'>
): SceneAudio {
  return {
    microphoneId: sources.microphoneId,
    microphoneName: sources.microphoneName,
    // Like cameraOff: a chosen microphone wins over a stale None.
    microphoneOff: sources.microphoneOff === true && !sources.microphoneId,
    systemAudioEnabled: audio.systemAudioEnabled === true
  }
}
export function normalizeSceneAudio(raw: unknown): SceneAudio | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object') throw new Error('Invalid scene audio')
  const data = raw as SceneAudio
  if (
    data.microphoneId !== undefined &&
    (typeof data.microphoneId !== 'string' || data.microphoneId.length === 0)
  )
    throw new Error('Invalid microphone identity')
  if (data.microphoneName !== undefined && typeof data.microphoneName !== 'string')
    throw new Error('Invalid microphone label')
  if (typeof data.microphoneOff !== 'boolean' || typeof data.systemAudioEnabled !== 'boolean')
    throw new Error('Invalid scene audio')
  return sceneAudio(data, data)
}
/**
 * Whether the working audio is what the saved scene keeps. A scene saved
 * before scenes kept audio, or with no microphone ever chosen, holds no
 * opinion on that part.
 */
export function sameSceneAudio(saved: SceneAudio | undefined, working: SceneAudio): boolean {
  if (!saved) return true
  const microphoneChosen = Boolean(saved.microphoneId) || saved.microphoneOff
  return (
    saved.systemAudioEnabled === working.systemAudioEnabled &&
    (!microphoneChosen ||
      (saved.microphoneId === working.microphoneId &&
        saved.microphoneOff === working.microphoneOff))
  )
}
/**
 * The microphone a saved scene switches to: None, or its microphone while
 * it is listed as available. Null keeps the current one: nothing was chosen,
 * or the chosen one is gone (it can come back).
 */
export function sceneMicrophone(
  audio: SceneAudio,
  devices: readonly Device[]
): SceneMicrophone | null {
  if (audio.microphoneOff)
    return { microphoneId: undefined, microphoneName: undefined, microphoneOff: true }
  if (
    !audio.microphoneId ||
    !devices.some(
      (device) =>
        device.id === audio.microphoneId &&
        device.kind === 'microphone' &&
        device.status === 'available'
    )
  )
    return null
  return {
    microphoneId: audio.microphoneId,
    microphoneName: audio.microphoneName,
    microphoneOff: false
  }
}
export function snapshotBackground(
  background: EffectiveSceneBackground | null | undefined
): SavedSceneBackground | null {
  if (!background) return null
  const { managedAssetPath, ...style } = background
  const bundled =
    BUNDLED_BACKGROUND_MANIFEST.some((entry) => entry.id === style.assetId) ||
    parseLivePosterAssetId(style.assetId) !== null
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
  // Plan 190: a live background's poster is bundled; its shader rides along.
  const livePoster = parseLivePosterAssetId(data.assetId)
  const builtin =
    BUNDLED_BACKGROUND_MANIFEST.some((entry) => entry.id === data.assetId) || livePoster !== null
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
    visibilityPercent: clamp(data.visibilityPercent, 20, 0, 40),
    // The poster names the background and look; a stored spec adds the motion.
    ...(livePoster && {
      live: { ...livePoster, motion: data.live?.motion === 'normal' ? 'normal' : 'calm' }
    })
  }
}
export function resolveSavedBackground(
  background: SavedSceneBackground | null
): EffectiveSceneBackground | null {
  if (!background) return null
  const { fileName, ...style } = normalizeSavedBackground(background)!
  const livePoster = parseLivePosterAssetId(style.assetId)
  const name =
    BUNDLED_BACKGROUND_MANIFEST.find((entry) => entry.id === style.assetId)?.fileName ??
    (livePoster ? `${style.assetId}.webp` : fileName!)
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
  const visibility = data.layout.sourceVisibility
  if (
    visibility !== undefined &&
    (!visibility ||
      typeof visibility !== 'object' ||
      Array.isArray(visibility) ||
      Object.entries(visibility).some(
        ([role, value]) => !['camera', 'capture'].includes(role) || typeof value !== 'boolean'
      ))
  )
    throw new Error('Invalid source visibility')
  if (data.sources.cameraOff !== undefined && typeof data.sources.cameraOff !== 'boolean')
    throw new Error('Invalid camera Off intent')
  if (data.sources.captureOff !== undefined && typeof data.sources.captureOff !== 'boolean')
    throw new Error('Invalid screen None intent')
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
      const audio = normalizeSceneAudio(entry.audio)
      scenes.push({
        id: entry.id,
        name: entry.name.trim(),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        visual: normalizeSceneVisual(entry.visual),
        ...(audio ? { audio } : {})
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
        ? "Some invalid saved scenes couldn't be loaded."
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
/** A source a scene needs that isn't usable now: turned off, or chosen but gone. */
export type SceneSourceGap = {
  source: 'camera' | 'screen'
  state: 'off' | 'unavailable'
}

/**
 * The sources a scene needs that can't be used now (plan 174 S3.3, B-20): the
 * camera when its layout shows one, the screen or window when its layout
 * shows one (a test pattern stands in for no screen). Freeform needs what it
 * has. `off` is nothing chosen; `unavailable` is chosen but not listed as
 * available.
 */
export function sceneSourceGaps(visual: SceneVisual, devices: readonly Device[]): SceneSourceGap[] {
  const gaps: SceneSourceGap[] = []
  const check = (
    id: string | undefined,
    kind: Device['kind'],
    source: SceneSourceGap['source']
  ) => {
    if (!id) gaps.push({ source, state: 'off' })
    else if (
      !devices.some(
        (device) => device.id === id && device.kind === kind && device.status === 'available'
      )
    )
      gaps.push({ source, state: 'unavailable' })
  }
  if (
    visual.layout.arrangementMode === 'freeform'
      ? Boolean(visual.sources.cameraId)
      : layoutPresetNeedsCamera(visual.layout.layoutPreset)
  )
    check(visual.sources.cameraId, 'camera', 'camera')
  const baseId = visual.sources.windowId ?? visual.sources.screenId
  if (
    (visual.layout.arrangementMode === 'freeform' ||
      layoutPresetNeedsScreen(visual.layout.layoutPreset)) &&
    (!visual.sources.testPattern || baseId)
  ) {
    check(baseId, visual.sources.windowId ? 'window' : 'screen', 'screen')
  }
  return gaps
}

/**
 * Which sources the scene shows that the streamer turned off on purpose
 * (Screen None, Camera Off). A start would wait for frames that never come
 * (retest 150): the backend refused it with "preview source(s) produced no
 * frames". A chosen-but-missing source is not this: it can come back.
 */
export function sceneSourcesTurnedOff(
  visual: SceneVisual,
  devices: readonly Device[]
): { screen: boolean; camera: boolean } {
  const gaps = sceneSourceGaps(visual, devices)
  const off = (source: SceneSourceGap['source']) =>
    gaps.some((gap) => gap.source === source && gap.state === 'off')
  return {
    screen: visual.sources.captureOff === true && off('screen'),
    camera: visual.sources.cameraOff === true && off('camera')
  }
}

/**
 * Whether a Studio gallery card is the scene on air: its preset, with no saved
 * scene applied and the layout not in Freeform (Freeform keeps the last
 * preset's name underneath, but arranges sources its own way; the Scene page
 * already shows Freeform as the choice).
 */
export function galleryPresetIsActive(
  layout: Pick<SceneVisual['layout'], 'layoutPreset' | 'arrangementMode'>,
  presetId: string,
  activeSavedSceneId: string | null | undefined
): boolean {
  return (
    !activeSavedSceneId && layout.arrangementMode !== 'freeform' && layout.layoutPreset === presetId
  )
}

export function sceneSourceProblems(visual: SceneVisual, devices: readonly Device[]): string[] {
  // A source turned off on purpose (Screen None, Camera Off) is not
  // "unavailable", and there is nothing to replace (retest 150).
  return sceneSourceGaps(visual, devices).map(({ source, state }) =>
    source === 'camera'
      ? state === 'off'
        ? 'Camera is off. Turn it on in Sources to use this scene.'
        : 'Camera unavailable. Choose a replacement in Sources.'
      : state === 'off'
        ? 'No screen is chosen. Choose one in Sources to use this scene.'
        : 'Screen or window unavailable. Choose a replacement in Sources.'
  )
}

/**
 * Where a Studio orientation switch lands (retest 150): the scene last used in
 * that orientation when the current sources can show it, otherwise the first
 * of that orientation's scenes they can (Screen None lands on Camera only),
 * otherwise the remembered one, whose refusal then says what is missing.
 */
export function orientationSwitchPreset<P extends string>(
  remembered: P,
  candidates: readonly P[],
  usable: (preset: P) => boolean
): P {
  if (usable(remembered)) return remembered
  return candidates.find(usable) ?? remembered
}

const SCENE_LIST = new Intl.ListFormat('en-US', { style: 'long', type: 'conjunction' })

/**
 * The one line under a scene gallery that says why some scenes can't be
 * chosen (plan 174 S3.3, B-20), instead of a per-card title that said
 * "unavailable. Choose a replacement." even when the camera was simply Off.
 * One sentence per missing source, naming the scenes it blocks. Null when
 * every scene can be chosen.
 */
export function sceneGalleryReason(
  blocked: readonly { label: string; gaps: readonly SceneSourceGap[] }[]
): string | null {
  const sentences: string[] = []
  for (const source of ['camera', 'screen'] as const) {
    const scenes = blocked.filter((scene) => scene.gaps.some((gap) => gap.source === source))
    if (scenes.length === 0) continue
    const labels = SCENE_LIST.format([...new Set(scenes.map((scene) => scene.label))])
    const off = scenes.some((scene) =>
      scene.gaps.some((gap) => gap.source === source && gap.state === 'off')
    )
    sentences.push(
      source === 'camera'
        ? off
          ? `Camera is off. Choose one in Sources to use ${labels}.`
          : `Your camera isn't available. Choose another in Sources to use ${labels}.`
        : off
          ? `No screen is chosen. Choose one in Sources to use ${labels}.`
          : `Your screen isn't available. Choose another in Sources to use ${labels}.`
    )
  }
  return sentences.length > 0 ? sentences.join(' ') : null
}

/** Acknowledged roles only; never infer visibility from absence or device IDs. */
export function sourceVisibilityFromScene(
  scene: Scene,
  current: LayoutSettings['sourceVisibility']
) {
  const visibility = normalizeSourceVisibility(current)
  for (const source of scene.sources) {
    if (source.kind === 'camera') visibility.camera = source.visible
    if (source.kind === 'screen' || source.kind === 'window' || source.kind === 'test-pattern')
      visibility.capture = source.visible
  }
  return visibility
}
