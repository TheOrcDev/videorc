import type { GlobalShortcutsConfig, LayoutPreset, LayoutSettings } from './backend'
import {
  defaultCaptureConfig,
  HORIZONTAL_LAYOUT_PRESETS,
  layoutPresetNeedsScreen,
  layoutPresetOrientation,
  loadCaptureConfig,
  loadJson,
  STORAGE_KEYS,
  VERTICAL_LAYOUT_PRESETS,
  type CaptureConfig,
  type SettingsState
} from './capture'
import { layoutPresetLabel } from './layout-labels'
import { currentPlatform } from './platform'
import {
  hydrateSceneLibrary,
  hydrateWorkingScene,
  normalizeSceneVisual,
  SCENE_LIBRARY_KEY,
  WORKING_SCENE_KEY,
  type SavedScene,
  type ScenePresetLibrary,
  type WorkingScene
} from './scene-presets'
import { canonicalJson } from './scene-visibility-identity'
import { normalizeAccelerator } from '../../../shared/accelerator'
import { displayShows } from './scenes-store'
import {
  SCENE_SLOT_ACTIONS,
  sceneSlotAccelerator,
  type SceneSlotPosition
} from '../../../shared/global-shortcuts'
import {
  layoutShowsScreen,
  sameShows,
  sceneLayout,
  showsFromSources,
  showsSources,
  type MainDisplay,
  type Scene,
  type SceneLibrary,
  type SceneShows
} from './scenes'

// Plan 231 D15: the scene library for a profile that has none yet, made from
// its v1 saved scenes, its working setup and its layout keys. It runs once
// per profile, so it is its own chunk: the Studio loads it only on the launch
// that migrates (`prepareScenes`, hooks/use-scenes.ts).

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
  now: string = new Date().toISOString(),
  platform?: string
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
  const legLayout = (layout: LayoutSettings): LayoutSettings => ({
    ...presetLayout(
      layout,
      captureConfig.simulcastFollowsProgram && layout.layoutPreset === 'camera-only'
        ? 'vertical-camera-only'
        : captureConfig.simulcastFollowsProgram && layout.layoutPreset === 'screen-only'
          ? 'vertical-screen-only'
          : captureConfig.lastVerticalPreset
    ),
    verticalScreenFraming:
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
      ...(scene.audio ? { audio: scene.audio } : {}),
      // Plan 249 S12: the room's guest roles survive the move to v2.
      ...(scene.cloud ? { cloud: scene.cloud } : {})
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
  const sceneSlots = settleSlotKeys(scenes, customKeys, shortcuts, platform)
  return {
    library: { version: 2, scenes, onStreamId: onStream.id },
    globalShortcuts: {
      ...shortcuts,
      scenes: customKeys,
      ...(sceneSlots ? { sceneSlots } : {})
    }
  }
}

/**
 * A key moved here (a layout key, a v1 scene key) can be a position key's
 * default (D5: ⌃⌥N on macOS, Ctrl+Alt+Shift+N elsewhere). Both would ask the
 * OS for the same keys and the second would fail. The scene at that position
 * needs no key of its own, so it drops it; any other scene keeps the key the
 * streamer set (nothing changes on update, D15), and that position's default
 * is released: Settings → Shortcuts can give Scene N another key. Mutates
 * `customKeys`; returns the position keys to store, or null for none.
 */
function settleSlotKeys(
  scenes: readonly Pick<Scene, 'id'>[],
  customKeys: Record<string, string>,
  shortcuts: GlobalShortcutsConfig,
  platform: string | undefined
): GlobalShortcutsConfig['sceneSlots'] | null {
  const sceneSlots: NonNullable<GlobalShortcutsConfig['sceneSlots']> = {
    ...shortcuts.sceneSlots
  }
  let changed = false
  for (const position of SCENE_SLOT_ACTIONS.map((_, index) => (index + 1) as SceneSlotPosition)) {
    if (shortcuts.sceneSlots?.[position] !== undefined) continue
    const slotKey = normalizeAccelerator(sceneSlotAccelerator({}, position, platform), platform)
    for (const [id, key] of Object.entries(customKeys)) {
      if (normalizeAccelerator(key, platform) !== slotKey) continue
      if (scenes[position - 1]?.id === id) {
        delete customKeys[id]
      } else {
        sceneSlots[position] = ''
        changed = true
      }
    }
  }
  return changed ? sceneSlots : null
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

/** The platform the position keys default for (D5); unknown reads as not macOS. */
function hostPlatform(): string | undefined {
  try {
    return currentPlatform()
  } catch {
    return undefined
  }
}

function read(key: string): unknown {
  try {
    return loadJson<unknown>(key, null)
  } catch {
    return null
  }
}

/**
 * The migration of what this profile has stored: its v1 library (left alone
 * when `readOnly`, a v2 version this build doesn't know), its working setup,
 * its capture config and its shortcuts. Reads only.
 */
export function migrateStoredScenes(options: {
  readOnly: boolean
}): ReturnType<typeof migrateToScenes> {
  try {
    const settings = read(STORAGE_KEYS.settings) as Partial<SettingsState> | null
    return migrateToScenes(
      options.readOnly ? null : hydrateSceneLibrary(read(SCENE_LIBRARY_KEY)).library,
      hydrateWorkingScene(read(WORKING_SCENE_KEY)),
      loadCaptureConfig(),
      settings?.globalShortcuts,
      undefined,
      hostPlatform()
    )
  } catch {
    return migrateToScenes(null, null, defaultCaptureConfig, undefined)
  }
}
