import type { Device, GlobalShortcutsConfig, LayoutPreset, LayoutSettings } from './backend'
import {
  defaultCaptureConfig,
  HORIZONTAL_LAYOUT_PRESETS,
  layoutPresetNeedsScreen,
  layoutPresetOrientation,
  simulcastLegLayout,
  VERTICAL_LAYOUT_PRESETS,
  type CaptureConfig
} from './capture'
import { layoutPresetLabel } from './layout-labels'
import {
  normalizeSceneApp,
  normalizeSceneAudio,
  normalizeSceneVisual,
  sceneNameError,
  type SavedScene,
  type SavedSceneBackground,
  type SceneAudio,
  type SceneOrientation,
  type ScenePresetLibrary,
  type SceneVisual,
  type VisualSources,
  type WorkingScene
} from './scene-presets'
import { canonicalJson } from './scene-visibility-identity'

// Plan 231: every scene shows its own screen. A scene is what it shows (an
// app's front window, a fixed window, a display, or nothing) plus how it is
// arranged in each orientation. The built-in layouts are a scene's Layout
// choice, never something to switch to (D2), and one scene works in 16:9 and
// in 9:16 (D4). The camera device is one for every scene and lives in
// `captureConfig.sources` only (D9).

export const SCENES_KEY = 'videorc.scenes.v2'

export type SceneShows =
  | { kind: 'app'; bundleId: string; name: string; follows: boolean }
  | { kind: 'window'; windowId: string; windowName?: string }
  /**
   * An empty `screenId` is the main display before the device list has named
   * it (a new user's defaults): `withMainDisplay` writes the real one.
   */
  | { kind: 'display'; screenId: string; screenName?: string; screenUuid?: string }
  /** Shows no screen (Camera only); D18. */
  | { kind: 'none' }
  /** Development builds. */
  | { kind: 'test-pattern' }

export type Scene = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  shows: SceneShows
  layouts: { horizontal: LayoutSettings; vertical: LayoutSettings }
  background: SavedSceneBackground | null
  /** Only when pinned with Save audio to scene (D10). */
  audio?: SceneAudio
}

/**
 * The custom keys stay in `GlobalShortcutsConfig.scenes[id]`; the position
 * keys are S4's `scene-slot-1` … `scene-slot-9`.
 */
export type SceneLibrary = { version: 2; scenes: Scene[]; onStreamId: string }

export type MainDisplay = Pick<Device, 'id' | 'name' | 'displayUuid'>

/** What the capture pickers hold, as a scene keeps it. */
export type ShowsSources = Required<Pick<VisualSources, 'captureOff' | 'testPattern'>> &
  Pick<VisualSources, 'screenId' | 'screenName' | 'screenUuid' | 'windowId' | 'windowName' | 'app'>

/** What a v1 scene's or the working setup's sources show. */
export function showsFromSources(sources: VisualSources): SceneShows {
  const app = normalizeSceneApp(sources.app)
  if (app) return { kind: 'app', ...app }
  if (sources.windowId)
    return {
      kind: 'window',
      windowId: sources.windowId,
      ...(sources.windowName ? { windowName: sources.windowName } : {})
    }
  if (sources.screenId || sources.screenName)
    return {
      kind: 'display',
      screenId: sources.screenId ?? '',
      ...(sources.screenName ? { screenName: sources.screenName } : {}),
      ...(sources.screenUuid ? { screenUuid: sources.screenUuid } : {})
    }
  if (sources.testPattern) return { kind: 'test-pattern' }
  if (sources.captureOff) return { kind: 'none' }
  // Nothing chosen yet is automatic selection in v1: the main display.
  return { kind: 'display', screenId: '' }
}

/**
 * The capture part of a source selection for what a scene shows. Every key is
 * written, so spreading it over a selection clears the previous screen. An
 * app's front window is resolved when the scene goes on stream.
 */
export function showsSources(shows: SceneShows): ShowsSources {
  const none: ShowsSources = {
    screenId: undefined,
    screenName: undefined,
    screenUuid: undefined,
    windowId: undefined,
    windowName: undefined,
    app: undefined,
    captureOff: false,
    testPattern: false
  }
  switch (shows.kind) {
    case 'app':
      return {
        ...none,
        app: { bundleId: shows.bundleId, name: shows.name, follows: shows.follows }
      }
    case 'window':
      return { ...none, windowId: shows.windowId, windowName: shows.windowName }
    case 'display':
      return {
        ...none,
        screenId: shows.screenId || undefined,
        screenName: shows.screenName,
        screenUuid: shows.screenUuid
      }
    case 'none':
      return { ...none, captureOff: true }
    case 'test-pattern':
      return { ...none, testPattern: true }
  }
}

/**
 * Whether two scenes show the same screen. A display's UUID decides when both
 * have one (plan 213 F1), else its id. Following is not part of it.
 */
export function sameShows(a: SceneShows, b: SceneShows): boolean {
  if (a.kind === 'app' && b.kind === 'app') return a.bundleId === b.bundleId
  if (a.kind === 'window' && b.kind === 'window') return a.windowId === b.windowId
  if (a.kind === 'display' && b.kind === 'display')
    return a.screenUuid && b.screenUuid
      ? a.screenUuid === b.screenUuid
      : a.screenId === b.screenId && (a.screenId !== '' || a.screenName === b.screenName)
  return a.kind === b.kind
}

function normalizeShows(raw: unknown): SceneShows {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid scene screen')
  const data = raw as Record<string, unknown>
  const optional = (key: string): string | undefined => {
    const value = data[key]
    if (value !== undefined && typeof value !== 'string') throw new Error('Invalid screen label')
    return value || undefined
  }
  switch (data.kind) {
    case 'app': {
      const app = normalizeSceneApp(data)
      if (!app) throw new Error('Invalid scene app')
      return { kind: 'app', ...app }
    }
    case 'window': {
      if (typeof data.windowId !== 'string' || !data.windowId) throw new Error('Invalid window')
      const windowName = optional('windowName')
      return { kind: 'window', windowId: data.windowId, ...(windowName ? { windowName } : {}) }
    }
    case 'display': {
      if (typeof data.screenId !== 'string') throw new Error('Invalid display')
      const screenName = optional('screenName')
      const screenUuid = optional('screenUuid')
      return {
        kind: 'display',
        screenId: data.screenId,
        ...(screenName ? { screenName } : {}),
        // As in v1: a UUID left over without its display is no pick.
        ...(screenUuid && (data.screenId || screenName) ? { screenUuid } : {})
      }
    }
    case 'none':
      return { kind: 'none' }
    case 'test-pattern':
      return { kind: 'test-pattern' }
    default:
      throw new Error('Unknown scene screen')
  }
}

/**
 * One stored scene, or a throw: a scene with a broken screen, a layout that
 * is not a built-in one, or a layout in the wrong orientation is rejected
 * whole. Invalid optional fields are dropped, never the scene.
 */
export function normalizeScene(raw: unknown): Scene {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid scene')
  const data = raw as Partial<Scene>
  if (
    typeof data.id !== 'string' ||
    !data.id ||
    data.id.length > 128 ||
    typeof data.name !== 'string' ||
    sceneNameError(data.name, []) ||
    typeof data.createdAt !== 'string' ||
    typeof data.updatedAt !== 'string' ||
    !data.layouts ||
    typeof data.layouts !== 'object'
  )
    throw new Error('Invalid scene')
  // The v1 visual check is the layout and background check: one rule for both.
  const visual = (layout: unknown, orientation: SceneOrientation): SceneVisual => {
    const normalized = normalizeSceneVisual({ layout, sources: {}, background: data.background })
    if (layoutPresetOrientation(normalized.layout.layoutPreset) !== orientation)
      throw new Error('Layout in the wrong orientation')
    return normalized
  }
  const horizontal = visual(data.layouts.horizontal, 'horizontal')
  const vertical = visual(data.layouts.vertical, 'vertical')
  const audio = normalizeSceneAudio(data.audio)
  return {
    id: data.id,
    name: data.name.trim(),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    shows: normalizeShows(data.shows),
    layouts: { horizontal: horizontal.layout, vertical: vertical.layout },
    background: horizontal.background,
    ...(audio ? { audio } : {})
  }
}

export const SCENES_UNKNOWN_VERSION_ERROR =
  'Update Videorc to open these scenes. Your saved data is preserved.'

/**
 * The stored v2 library. `library` is null when nothing is stored (migrate
 * from v1), when the version is one this build doesn't know (read-only: the
 * stored data must not be written over), or when no stored scene is usable.
 */
export function hydrateScenes(raw: unknown): {
  library: SceneLibrary | null
  readOnly: boolean
  error: string | null
} {
  if (raw == null) return { library: null, readOnly: false, error: null }
  const data = (typeof raw === 'object' ? raw : {}) as Partial<SceneLibrary>
  if (data.version !== 2)
    return { library: null, readOnly: true, error: SCENES_UNKNOWN_VERSION_ERROR }
  const entries: unknown[] = Array.isArray(data.scenes) ? data.scenes : []
  const scenes: Scene[] = []
  for (const entry of entries) {
    try {
      const scene = normalizeScene(entry)
      if (scenes.some(({ id }) => id === scene.id) || sceneNameError(scene.name, scenes)) continue
      scenes.push(scene)
    } catch {
      /* Reject only the malformed entry. */
    }
  }
  const error = scenes.length !== entries.length ? "Some invalid scenes couldn't be loaded." : null
  if (scenes.length === 0) return { library: null, readOnly: false, error }
  return {
    library: {
      version: 2,
      scenes,
      // A scene is always on stream: a lost id falls to the first scene.
      onStreamId: scenes.some(({ id }) => id === data.onStreamId) ? data.onStreamId! : scenes[0]!.id
    },
    readOnly: false,
    error
  }
}

// The pure reads the Studio, the keys and the remotes share.

/** The scene at a 1-based position: position 1 answers to the first scene key (D5). */
export function sceneAtPosition(scenes: readonly Scene[], position: number): Scene | undefined {
  return Number.isInteger(position) && position >= 1 ? scenes[position - 1] : undefined
}

/** A scene's 1-based position, or null when it is not in the list. */
export function scenePosition(scenes: readonly Pick<Scene, 'id'>[], id: string): number | null {
  const index = scenes.findIndex((scene) => scene.id === id)
  return index < 0 ? null : index + 1
}

/** The scene on stream. */
export function sceneOnStream(library: SceneLibrary): Scene {
  return library.scenes.find(({ id }) => id === library.onStreamId) ?? library.scenes[0]!
}

/** A scene's layout in a 16:9 or a 9:16 studio, or on that leg of a dual stream (D4). */
export function sceneLayout(
  scene: Pick<Scene, 'layouts'>,
  orientation: SceneOrientation
): LayoutSettings {
  return scene.layouts[orientation]
}

function layoutShowsScreen(layout: LayoutSettings): boolean {
  return layout.arrangementMode === 'freeform' || layoutPresetNeedsScreen(layout.layoutPreset)
}

/** What the scene puts on stream, in a few words: its screen, or its layout when that shows none. */
export function sceneShowsWords(
  scene: Pick<Scene, 'shows' | 'layouts'>,
  orientation: SceneOrientation
): string {
  const layout = sceneLayout(scene, orientation)
  if (!layoutShowsScreen(layout)) return layoutPresetLabel(layout.layoutPreset)
  const { shows } = scene
  switch (shows.kind) {
    case 'app':
      return `${shows.name} · front window`
    case 'window':
      return shows.windowName ? `Window · ${shows.windowName}` : 'Window'
    case 'display':
      return shows.screenName ?? 'Display'
    case 'test-pattern':
      return 'Test pattern'
    case 'none':
      return 'No screen'
  }
}

/**
 * The first scene whose layout in this orientation is `preset` (D14: where a
 * remote's legacy `layoutPreset` goes). A Freeform arrangement is not its
 * underlying layout.
 */
export function firstSceneWithLayout<S extends Pick<Scene, 'layouts'>>(
  scenes: readonly S[],
  orientation: SceneOrientation,
  preset: LayoutPreset
): S | undefined {
  return scenes.find((scene) => {
    const layout = sceneLayout(scene, orientation)
    return layout.layoutPreset === preset && layout.arrangementMode !== 'freeform'
  })
}

export const KEEP_ONE_SCENE_REASON = 'Keep at least one scene.'
export const DELETE_ON_STREAM_REASON = 'Switch to another scene first.'

/**
 * Whether a scene can be deleted (D16). The last scene never can. Off air,
 * deleting the scene on stream first switches to the scene before it
 * (`switchToId`; the one after, for the first scene). While recording or
 * live, the scene on stream can't be deleted.
 */
export function canDeleteScene(input: {
  scenes: readonly Pick<Scene, 'id'>[]
  id: string
  onStreamId: string
  sessionActive: boolean
}): { allowed: true; switchToId: string | null } | { allowed: false; reason: string | null } {
  const index = input.scenes.findIndex((scene) => scene.id === input.id)
  if (index < 0) return { allowed: false, reason: null }
  if (input.scenes.length <= 1) return { allowed: false, reason: KEEP_ONE_SCENE_REASON }
  if (input.id !== input.onStreamId) return { allowed: true, switchToId: null }
  if (input.sessionActive) return { allowed: false, reason: DELETE_ON_STREAM_REASON }
  return { allowed: true, switchToId: input.scenes[index > 0 ? index - 1 : 1]!.id }
}

/**
 * The library with the main display written into every scene that shows it
 * without knowing which it is. The same library when there is nothing to write.
 */
export function withMainDisplay(library: SceneLibrary, mainDisplay: MainDisplay): SceneLibrary {
  const waits = ({ shows }: Scene): boolean =>
    shows.kind === 'display' && !shows.screenId && !shows.screenName
  if (!mainDisplay.id || !library.scenes.some(waits)) return library
  return {
    ...library,
    scenes: library.scenes.map((scene) =>
      waits(scene) ? { ...scene, shows: displayShows(mainDisplay) } : scene
    )
  }
}

function displayShows(display: MainDisplay | null | undefined): SceneShows {
  return {
    kind: 'display',
    screenId: display?.id ?? '',
    ...(display?.name ? { screenName: display.name } : {}),
    ...(display?.displayUuid && display.id ? { screenUuid: display.displayUuid } : {})
  }
}

/** "Figma", then "Figma 2" while taken, within the 80-character limit (as `uniqueSceneName`). */
function uniqueName(base: string, scenes: readonly Pick<Scene, 'name'>[]): string {
  const taken = new Set(scenes.map((scene) => scene.name.toLocaleLowerCase()))
  const trimmed = base.trim().slice(0, 80) || 'Scene'
  let name = trimmed
  for (let n = 2; taken.has(name.toLocaleLowerCase()); n++) {
    const suffix = ` ${n}`
    name = trimmed.slice(0, 80 - suffix.length).trimEnd() + suffix
  }
  return name
}

function uniqueId(base: string, scenes: readonly Pick<Scene, 'id'>[]): string {
  let id = base
  for (let n = 2; scenes.some((scene) => scene.id === id); n++) id = `${base}-${n}`
  return id
}

// Migration (D15): nothing on stream changes on update.

export type SceneMigrationConfig = Pick<
  CaptureConfig,
  | 'sources'
  | 'layout'
  | 'layoutFramingMemory'
  | 'lastHorizontalPreset'
  | 'lastVerticalPreset'
  | 'simulcastFollowsProgram'
  | 'simulcastScreenFraming'
>

/** A 9:16 layout's 16:9 twin (D15): Camera only, Screen only, else Screen + camera. */
export function horizontalTwin(preset: LayoutPreset): LayoutPreset {
  if (preset === 'vertical-camera-only') return 'camera-only'
  if (preset === 'vertical-screen-only') return 'screen-only'
  return 'screen-camera'
}

/** The ids migration gives the scenes it makes: stable, so a second run names the same scenes. */
export const defaultSceneId = (preset: LayoutPreset): string => `default-${preset}`
export const WORKING_SCENE_ID = 'migrated-working'

/**
 * The v2 library for a v1 user, and their shortcuts with the layout keys
 * moved to scene keys (D15). Pure: the caller writes both.
 *
 * Order: the saved scenes in their order; the four default scenes with
 * today's screen, without one that equals a saved scene; the working setup
 * when it is none of them; then a scene for each 9:16 layout key that no
 * scene could take.
 *
 * The scene on stream is the one matching what was on, and its layout in the
 * studio's orientation and its background are the working ones exactly.
 */
export function migrateToScenes(
  v1Library: Pick<ScenePresetLibrary, 'scenes'> | null,
  workingScene: WorkingScene | null,
  captureConfig: SceneMigrationConfig,
  globalShortcuts: GlobalShortcutsConfig | undefined,
  now: string = new Date().toISOString()
): { library: SceneLibrary; globalShortcuts: GlobalShortcutsConfig } {
  const saved = v1Library?.scenes ?? []
  const working =
    workingScene?.visual ??
    normalizeSceneVisual({
      layout: captureConfig.layout,
      sources: captureConfig.sources,
      background: null
    })
  const workingLayout = working.layout
  const orientation = layoutPresetOrientation(workingLayout.layoutPreset)
  const today = showsFromSources(working.sources)
  // Only the saved scenes follow their app: a scene made here never competes
  // with them for "Follow the app in front".
  const todayUnfollowed: SceneShows = today.kind === 'app' ? { ...today, follows: false } : today
  const framing = (preset: LayoutPreset) => captureConfig.layoutFramingMemory?.layouts?.[preset]

  /** `base` as the plain built-in `preset`: what clicking that layout gives today. */
  const presetLayout = (
    base: LayoutSettings,
    preset: LayoutPreset,
    recalled?: Partial<LayoutSettings>
  ): LayoutSettings => ({
    ...base,
    ...recalled,
    layoutPreset: preset,
    cameraTransformMode: 'preset',
    cameraTransform: null,
    arrangementMode: 'preset',
    sourceTransformOverrides: {}
  })
  /**
   * What the vertical stream shows for a 16:9 layout today. In a 9:16 studio
   * no vertical leg runs, so the layout's own Fill or Fit stays.
   */
  const legLayout = (layout: LayoutSettings): LayoutSettings =>
    simulcastLegLayout({
      layout,
      lastVerticalPreset: captureConfig.lastVerticalPreset,
      simulcastFollowsProgram: captureConfig.simulcastFollowsProgram,
      simulcastScreenFraming:
        orientation === 'vertical'
          ? layout.verticalScreenFraming
          : captureConfig.simulcastScreenFraming
    })
  /** Both layouts of a scene from the one layout v1 kept. */
  const layoutsFrom = (layout: LayoutSettings): Scene['layouts'] =>
    layoutPresetOrientation(layout.layoutPreset) === 'vertical'
      ? { horizontal: presetLayout(layout, horizontalTwin(layout.layoutPreset)), vertical: layout }
      : { horizontal: layout, vertical: legLayout(layout) }

  // 1. The saved scenes, in their order. The camera device is dropped (D9).
  const scenes: Scene[] = saved.map(
    (scene: SavedScene): Scene => ({
      id: scene.id,
      name: scene.name,
      createdAt: scene.createdAt,
      updatedAt: scene.updatedAt,
      shows: showsFromSources(scene.visual.sources),
      layouts: layoutsFrom(scene.visual.layout),
      background: scene.visual.background,
      ...(scene.audio ? { audio: scene.audio } : {})
    })
  )
  const savedCount = scenes.length

  // 2. The four default scenes with today's screen and today's look.
  const plainBuiltin =
    !workingScene?.sceneId &&
    (workingScene?.origin ?? 'builtin') === 'builtin' &&
    workingLayout.arrangementMode !== 'freeform'
  const newUser = saved.length === 0 && !workingScene
  const defaults = new Map<LayoutPreset, Scene>()
  for (const preset of HORIZONTAL_LAYOUT_PRESETS) {
    const horizontal =
      plainBuiltin && preset === workingLayout.layoutPreset
        ? workingLayout
        : presetLayout(workingLayout, preset, framing(preset))
    const vertical = legLayout(horizontal)
    const taken = [...scenes, ...defaults.values()]
    defaults.set(preset, {
      id: uniqueId(defaultSceneId(preset), taken),
      name: uniqueName(layoutPresetLabel(preset), taken),
      createdAt: now,
      updatedAt: now,
      // D3: a new user's Camera only shows no screen.
      shows:
        newUser && preset === 'camera-only' && !layoutPresetNeedsScreen(vertical.layoutPreset)
          ? { kind: 'none' }
          : todayUnfollowed,
      layouts: { horizontal, vertical },
      background: working.background
    })
  }

  // The scene on stream: the one matching what was on.
  const sameLook = (scene: Scene): boolean =>
    canonicalJson(sceneLayout(scene, orientation)) === canonicalJson(workingLayout) &&
    canonicalJson(scene.background) === canonicalJson(working.background)
  const candidates = [...scenes, ...defaults.values()]
  let onStream: Scene | undefined
  const savedOn = workingScene?.sceneId
    ? scenes.find(({ id }) => id === workingScene.sceneId)
    : undefined
  if (savedOn) {
    onStream = savedOn
    // The working look is what is on stream: a look that drifted from its
    // saved scene before edits saved into scenes stays on stream.
    if (!sameLook(savedOn)) {
      savedOn.layouts =
        orientation === 'vertical'
          ? { ...savedOn.layouts, vertical: workingLayout }
          : layoutsFrom(workingLayout)
      savedOn.background = working.background
    }
  } else if (plainBuiltin && orientation === 'horizontal') {
    onStream = defaults.get(workingLayout.layoutPreset)
  } else if (plainBuiltin) {
    // A 9:16 studio on a built-in layout: the default that shows it, the one
    // the 16:9 toggle would land on first.
    const shows = [...defaults.values()].filter(
      (scene) => scene.layouts.vertical.layoutPreset === workingLayout.layoutPreset
    )
    onStream =
      shows.find(
        (scene) => scene.layouts.horizontal.layoutPreset === captureConfig.lastHorizontalPreset
      ) ?? shows[0]
    if (onStream) onStream.layouts = { ...onStream.layouts, vertical: workingLayout }
  } else {
    onStream = candidates.find((scene) => sameShows(scene.shows, today) && sameLook(scene))
  }

  // A default equal to a saved scene (same screen, same layouts) is left out,
  // unless that would change the stream or lose a layout key.
  const customKeys: Record<string, string> = {}
  for (const [id, key] of Object.entries(globalShortcuts?.scenes ?? {}))
    if (typeof key === 'string' && key) customKeys[id] = key
  const layoutKey = (preset: LayoutPreset): string | undefined => {
    const key = globalShortcuts?.layouts?.[preset]
    return typeof key === 'string' && key ? key : undefined
  }
  for (const preset of HORIZONTAL_LAYOUT_PRESETS) {
    const scene = defaults.get(preset)!
    const key = layoutKey(preset)
    const equal = scenes
      .slice(0, savedCount)
      .find(
        (entry) =>
          sameShows(entry.shows, scene.shows) &&
          entry.layouts.horizontal.layoutPreset === preset &&
          entry.layouts.horizontal.arrangementMode !== 'freeform' &&
          entry.layouts.vertical.layoutPreset === scene.layouts.vertical.layoutPreset &&
          entry.layouts.vertical.arrangementMode !== 'freeform' &&
          (onStream !== scene || sameLook(entry)) &&
          (!key || !customKeys[entry.id] || customKeys[entry.id] === key)
      )
    if (equal) {
      if (onStream === scene) onStream = equal
      // A 16:9 layout key goes to the scene standing in for its default.
      if (key) customKeys[equal.id] = key
      continue
    }
    scenes.push(scene)
    if (key && !customKeys[scene.id]) customKeys[scene.id] = key
  }

  // 3. The working setup, when it is none of them: a Freeform arrangement,
  // or a saved scene left by a Screen pick. Named after what it shows.
  if (!onStream) {
    onStream = {
      id: uniqueId(WORKING_SCENE_ID, scenes),
      name: uniqueName(migratedName(today, workingLayout), scenes),
      createdAt: now,
      updatedAt: now,
      shows: today,
      layouts: layoutsFrom(workingLayout),
      background: working.background
    }
    scenes.push(onStream)
  }

  // A 9:16 layout key goes to the first scene with that 9:16 layout that has
  // no key yet; a scene is added when there is none, so the key keeps working.
  for (const preset of VERTICAL_LAYOUT_PRESETS) {
    const key = layoutKey(preset)
    if (!key) continue
    let scene = scenes.find(
      (entry) =>
        !customKeys[entry.id] &&
        entry.layouts.vertical.layoutPreset === preset &&
        entry.layouts.vertical.arrangementMode !== 'freeform'
    )
    if (!scene) {
      const twin = horizontalTwin(preset)
      scene = {
        id: uniqueId(`layout-${preset}`, scenes),
        name: uniqueName(layoutPresetLabel(preset, { bothOrientations: true }), scenes),
        createdAt: now,
        updatedAt: now,
        shows: todayUnfollowed,
        layouts: {
          horizontal: presetLayout(workingLayout, twin, framing(twin)),
          vertical: {
            ...legLayout(workingLayout),
            ...framing(preset),
            layoutPreset: preset
          }
        },
        background: working.background
      }
      scenes.push(scene)
    }
    customKeys[scene.id] = key
  }

  const { layouts: _layouts, ...shortcuts } = globalShortcuts ?? {}
  return {
    library: { version: 2, scenes, onStreamId: onStream.id },
    globalShortcuts: { ...shortcuts, scenes: customKeys }
  }
}

/** The working setup's name: what it shows ("Figma", "Display 1"), or its layout when that shows no screen. */
function migratedName(shows: SceneShows, layout: LayoutSettings): string {
  if (!layoutShowsScreen(layout) || shows.kind === 'none')
    return layoutPresetLabel(layout.layoutPreset)
  switch (shows.kind) {
    case 'app':
      return shows.name
    case 'window':
      return shows.windowName ?? 'Window'
    case 'display':
      return shows.screenName ?? 'Display'
    case 'test-pattern':
      return 'Test pattern'
  }
}

/**
 * A new user's four scenes (D3): Screen + camera, Screen only and Side by
 * side show the main display, Camera only shows no screen. Each has its 16:9
 * layout and the 9:16 layout the vertical stream shows for it.
 */
export function defaultScenes(
  mainDisplay: MainDisplay | null | undefined,
  now: string = new Date().toISOString()
): Scene[] {
  return migrateToScenes(
    null,
    null,
    { ...defaultCaptureConfig, sources: showsSources(displayShows(mainDisplay)) },
    undefined,
    now
  ).library.scenes
}
