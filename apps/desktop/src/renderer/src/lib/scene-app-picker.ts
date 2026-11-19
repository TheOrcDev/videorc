import type { AppPreview, Device, LayoutPreset, LayoutSettings } from './backend'
import {
  capturePickerDevices,
  isSystemSessionWindowDevice,
  layoutPresetNeedsCamera,
  layoutPresetOrientation
} from './capture'
import { plural } from './format'
import { uniqueSceneName } from './scene-list'
import { displayShows, layoutShowsScreen, sameShows, type Scene, type SceneShows } from './scenes'

// Plan 231 D6: one picker for what a scene shows. Add scene… offers the open
// apps (macOS: icon, a picture of the front window, "Chrome · 3 windows"),
// the displays and Camera only; several can be chosen, and each becomes a
// scene in the look of the scene on stream, at the end of the list, without
// touching what's on stream. Change screen… is the same picker for one
// scene, with "A specific window" under Apps (plan 210's fixed window) and
// "No screen". Windows and Linux offer the displays and Camera only.

/** One app the picker offers. */
export type AppChoice = {
  bundleId: string
  name: string
  windowCount: number
  frontWindowId?: string
  frontWindowTitle?: string
  /** A small JPEG of the front window (plan 210 S4, macOS 14 and up). */
  picture?: string
  width?: number
  height?: number
}

/** A display the picker offers, with its still once the scene pictures have one (D7, S5). */
export type DisplayChoice = { device: Device; picture?: string }

/** One thing a scene can show, as the picker offers it. */
export type ScreenPick =
  | { kind: 'app'; app: AppChoice }
  /** A fixed window (Change screen… → A specific window). */
  | { kind: 'window'; device: Device }
  | { kind: 'display'; device: Device }
  /** Camera only in Add scene…, No screen in Change screen… (D18). */
  | { kind: 'none' }

/** What a scene that shows no screen is called when it's named after what it shows. */
export const NO_SCREEN_SCENE_NAME = 'Camera only'

/** D1's floor: palettes and popups under 400 × 300 aren't an app's window. */
const MIN_WINDOW_WIDTH = 400
const MIN_WINDOW_HEIGHT = 300

/**
 * macOS's own surfaces own screen-sized windows that are never an app you
 * show (the Dock draws the desktop's edges, the others its overlays).
 */
const SYSTEM_BUNDLE_IDS = new Set([
  'com.apple.dock',
  'com.apple.windowmanager',
  'com.apple.controlcenter',
  'com.apple.notificationcenterui',
  'com.apple.spotlight',
  'com.apple.wallpaper.agent',
  'com.apple.loginwindow',
  'com.apple.screencaptureui'
])

function offered(bundleId: string, self: ReadonlySet<string>): boolean {
  const key = bundleId.toLowerCase()
  return !self.has(key) && !SYSTEM_BUNDLE_IDS.has(key)
}

/** A front window's title, unless it only repeats the app's name. */
function windowTitle(title: string | undefined, name: string): string | undefined {
  const trimmed = title?.trim()
  return trimmed && trimmed.toLocaleLowerCase() !== name.trim().toLocaleLowerCase()
    ? trimmed
    : undefined
}

function isAppWindow(device: Device): boolean {
  return (
    device.kind === 'window' &&
    device.status === 'available' &&
    Boolean(device.app?.bundleId) &&
    !isSystemSessionWindowDevice(device) &&
    (device.width === undefined || device.width >= MIN_WINDOW_WIDTH) &&
    (device.height === undefined || device.height >= MIN_WINDOW_HEIGHT)
  )
}

const byText = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: 'base' })

/**
 * Before the app pictures come (or when they fail), the device list is the
 * picker: window sources grouped by their app, counted, the first one
 * standing in for the front window. Videorc's own app (and so its Notes
 * window) is never offered.
 */
export function appChoicesFromDevices(
  devices: readonly Device[],
  selfBundleIds: readonly string[] = []
): AppChoice[] {
  const self = new Set(selfBundleIds.map((id) => id.toLowerCase()))
  const apps = new Map<string, AppChoice>()
  for (const device of devices) {
    if (!isAppWindow(device)) continue
    const app = device.app!
    const key = app.bundleId.toLowerCase()
    if (!offered(app.bundleId, self)) continue
    const existing = apps.get(key)
    if (existing) {
      existing.windowCount += 1
      continue
    }
    apps.set(key, {
      bundleId: app.bundleId,
      name: app.name,
      windowCount: 1,
      frontWindowId: device.id,
      frontWindowTitle: windowTitle(device.windowTitle, app.name)
    })
  }
  return [...apps.values()].sort((a, b) => byText(a.name, b.name))
}

/** The app pictures' answer, without Videorc itself and without apps that have no window. */
export function appChoicesFromPreviews(
  previews: readonly AppPreview[],
  selfBundleIds: readonly string[] = []
): AppChoice[] {
  const self = new Set(selfBundleIds.map((id) => id.toLowerCase()))
  const seen = new Set<string>()
  const apps: AppChoice[] = []
  for (const preview of previews) {
    const key = preview.bundleId.toLowerCase()
    if (!offered(preview.bundleId, self) || seen.has(key) || preview.windowCount < 1) continue
    seen.add(key)
    apps.push({
      bundleId: preview.bundleId,
      name: preview.name,
      windowCount: preview.windowCount,
      frontWindowId: preview.frontWindowId,
      frontWindowTitle: windowTitle(preview.frontWindowTitle, preview.name),
      picture: preview.picture,
      width: preview.width,
      height: preview.height
    })
  }
  return apps.sort((a, b) => byText(a.name, b.name))
}

/**
 * The displays a scene can show: on macOS the screens (windows are apps, or
 * "A specific window"); on Windows and Linux what Sources offers there, the
 * displays or the Linux portal's one source.
 */
export function displayChoices(
  devices: readonly Device[],
  platform: string | undefined
): DisplayChoice[] {
  const available = capturePickerDevices([...devices]).filter(
    (device) => device.status === 'available'
  )
  return (
    platform === 'darwin' ? available.filter((device) => device.kind === 'screen') : available
  ).map((device) => ({ device }))
}

/** "A specific window": every app window, by app then title, never Videorc's own. */
export function windowChoices(
  devices: readonly Device[],
  selfBundleIds: readonly string[] = []
): Device[] {
  const self = new Set(selfBundleIds.map((id) => id.toLowerCase()))
  return devices
    .filter((device) => isAppWindow(device) && offered(device.app!.bundleId, self))
    .sort((a, b) => byText(a.app!.name, b.app!.name) || byText(windowLabel(a), windowLabel(b)))
}

/** A window's own words: its title, else its source name. */
export function windowLabel(device: Pick<Device, 'name' | 'windowTitle'>): string {
  return device.windowTitle?.trim() || device.name
}

/** Whether a search matches any of a choice's words. */
export function matchesSearch(words: readonly (string | undefined)[], query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || words.some((word) => (word ?? '').toLocaleLowerCase().includes(needle))
}

/** The search matches an app's name or its front window's title. */
export function searchAppChoices(choices: readonly AppChoice[], query: string): AppChoice[] {
  return choices.filter((choice) => matchesSearch([choice.name, choice.frontWindowTitle], query))
}

/** The primary button: "Add scene", or "Add 3 scenes". */
export function addScenesLabel(count: number): string {
  return count > 1 ? `Add ${plural(count, 'scene')}` : 'Add scene'
}

/** "3 windows" under an app with several; nothing for one. */
export function windowCountLabel(count: number): string | null {
  return count > 1 ? plural(count, 'window') : null
}

/** One key per choice, for the selection. */
export function pickKey(pick: ScreenPick): string {
  switch (pick.kind) {
    case 'app':
      return `app:${pick.app.bundleId.toLowerCase()}`
    case 'window':
      return `window:${pick.device.id}`
    case 'display':
      return `display:${pick.device.id}`
    case 'none':
      return 'none'
  }
}

/** What a scene made from the pick shows. A new app scene follows its app (plan 210 D10). */
export function pickShows(pick: ScreenPick, follows = true): SceneShows {
  switch (pick.kind) {
    case 'app':
      return { kind: 'app', bundleId: pick.app.bundleId, name: pick.app.name, follows }
    case 'window':
      return { kind: 'window', windowId: pick.device.id, windowName: pick.device.name }
    case 'display':
      return displayShows(pick.device)
    case 'none':
      return { kind: 'none' }
  }
}

/** The name a scene made from the pick takes: what it shows. */
export function pickName(pick: ScreenPick): string {
  switch (pick.kind) {
    case 'app':
      return pick.app.name
    case 'window':
      return pick.device.app?.name ?? windowLabel(pick.device)
    case 'display':
      return pick.device.name
    case 'none':
      return NO_SCREEN_SCENE_NAME
  }
}

/** Whether a scene already shows what the pick shows (Change screen… has nothing to do). */
export function showsPick(shows: SceneShows, pick: ScreenPick): boolean {
  return sameShows(shows, pickShows(pick))
}

/** The name of what a scene shows, when a scene named after it reads so. */
function showsName(shows: SceneShows): string | undefined {
  switch (shows.kind) {
    case 'app':
      return shows.name
    case 'window':
      return shows.windowName
    case 'display':
      return shows.screenName
    // "Camera only" is a layout's name (a default scene, D3): the scene keeps it.
    case 'none':
    case 'test-pattern':
      return undefined
  }
}

/** "Figma", "Figma 2": a name that is what the scene shows, not one the streamer typed. */
function namedAfter(name: string, base: string | undefined): boolean {
  if (!base) return false
  const escaped = base.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}( \\d+)?$`, 'i').test(name.trim())
}

function screenLayoutFor(preset: LayoutPreset, cameraOn: boolean): LayoutPreset {
  const camera = cameraOn && layoutPresetNeedsCamera(preset)
  if (layoutPresetOrientation(preset) === 'vertical')
    return camera ? 'vertical-screen-camera' : 'vertical-screen-only'
  return camera ? 'screen-camera' : 'screen-only'
}

/**
 * A layout made to show a screen: a scene made for an app that kept the
 * look of Camera only would never show the app. A camera layout with the
 * camera off becomes its screen-only twin, so every new scene can go on
 * stream. The orientation never changes.
 */
export function layoutShowingScreen(layout: LayoutSettings, cameraOn: boolean): LayoutSettings {
  const fits =
    layoutShowsScreen(layout) && (cameraOn || !layoutPresetNeedsCamera(layout.layoutPreset))
  const layoutPreset = fits ? layout.layoutPreset : screenLayoutFor(layout.layoutPreset, cameraOn)
  return {
    ...layout,
    layoutPreset,
    ...(layoutPreset !== layout.layoutPreset
      ? { arrangementMode: 'preset' as const, sourceTransformOverrides: {} }
      : {}),
    sourceVisibility: { camera: layout.sourceVisibility?.camera ?? true, capture: true }
  }
}

/** A layout that shows no screen: Camera only in its orientation (D18, D19). */
export function layoutShowingNoScreen(layout: LayoutSettings): LayoutSettings {
  if (!layoutShowsScreen(layout)) return layout
  return {
    ...layout,
    layoutPreset:
      layoutPresetOrientation(layout.layoutPreset) === 'vertical'
        ? 'vertical-camera-only'
        : 'camera-only',
    arrangementMode: 'preset',
    sourceTransformOverrides: {},
    sourceVisibility: { camera: true, capture: layout.sourceVisibility?.capture ?? true }
  }
}

/**
 * Add scene…'s scenes (D6). Each is named after what it shows ("Figma",
 * then "Figma 2" and "Figma 3"), takes the look of the scene on stream (both
 * layouts with the camera's spot and shape, and the background) made to
 * show its screen, or Camera only, and keeps no audio (D10). An app's front
 * window is where its scene looks first (`windowHints`, plan 210 D5).
 */
export function newScenes(
  picks: readonly ScreenPick[],
  template: Pick<Scene, 'layouts' | 'background'>,
  existing: readonly Pick<Scene, 'id' | 'name'>[],
  options: { cameraOn: boolean; id: () => string; now: () => string }
): { scenes: Scene[]; windowHints: Record<string, string> } {
  const taken: Pick<Scene, 'id' | 'name'>[] = [...existing]
  const windowHints: Record<string, string> = {}
  const scenes = picks.map((pick): Scene => {
    const id = options.id()
    const now = options.now()
    const name = uniqueSceneName(pickName(pick), taken)
    taken.push({ id, name })
    if (pick.kind === 'app' && pick.app.frontWindowId) windowHints[id] = pick.app.frontWindowId
    const look = (layout: LayoutSettings): LayoutSettings =>
      pick.kind === 'none'
        ? layoutShowingNoScreen(layout)
        : layoutShowingScreen(layout, options.cameraOn)
    return {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      shows: pickShows(pick),
      layouts: {
        horizontal: look(template.layouts.horizontal),
        vertical: look(template.layouts.vertical)
      },
      background: template.background ? structuredClone(template.background) : null
    }
  })
  return { scenes, windowHints }
}

/**
 * Change screen… (D6): the scene shows what was picked, and keeps its look,
 * keys and audio. An app keeps the scene's following. No screen puts the
 * scene's layouts on Camera only, so a scene that shows no screen never has
 * a layout that needs one (D19). A name that was what the scene showed
 * ("Figma", "Display 1") becomes the new one's; a name the streamer typed
 * stays.
 */
export function sceneShowingPick(
  scene: Scene,
  pick: ScreenPick,
  scenes: readonly Pick<Scene, 'id' | 'name'>[],
  now: string
): Scene {
  const follows = scene.shows.kind === 'app' ? scene.shows.follows : true
  return {
    ...scene,
    name: namedAfter(scene.name, showsName(scene.shows))
      ? uniqueSceneName(pickName(pick), scenes, scene.id)
      : scene.name,
    updatedAt: now,
    shows: pickShows(pick, follows),
    layouts:
      pick.kind === 'none'
        ? {
            horizontal: layoutShowingNoScreen(scene.layouts.horizontal),
            vertical: layoutShowingNoScreen(scene.layouts.vertical)
          }
        : scene.layouts
  }
}
