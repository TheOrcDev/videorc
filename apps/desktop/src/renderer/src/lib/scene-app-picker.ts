import type { AppPreview, Device, LayoutPreset } from './backend'
import {
  capturePickerDevices,
  isSystemSessionWindowDevice,
  layoutPresetNeedsCamera,
  layoutPresetNeedsScreen,
  layoutPresetOrientation
} from './capture'
import { plural } from './format'
import {
  normalizeSceneVisual,
  scenesForApps,
  type SavedScene,
  type ScenesForAppsOptions,
  type SceneVisual
} from './scene-presets'
import { uniqueSceneName } from './scene-list'

// Plan 210 D2: New scene… lists the open apps, each with a picture of its
// front window and its icon. Several can be chosen; each becomes a scene in
// the current look, named after its app, with no audio (D4) and following
// its app (D10). The scene on stream is never touched.

/** One app the picker offers. */
export type AppChoice = {
  bundleId: string
  name: string
  windowCount: number
  frontWindowId?: string
  frontWindowTitle?: string
  /** A small JPEG of the front window (S4, macOS 14 and up). */
  picture?: string
  width?: number
  height?: number
}

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

function byName(a: AppChoice, b: AppChoice): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

/**
 * Before S4's pictures (or when they fail), the device list is the picker:
 * window sources grouped by their app, counted, the first one standing in
 * for the front window. Videorc's own app (and so its Notes window) is never
 * offered.
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
  return [...apps.values()].sort(byName)
}

/** S4's answer, without Videorc itself and without apps that have no window. */
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
  return apps.sort(byName)
}

/** The search field matches the app's name or its front window's title. */
export function searchAppChoices(choices: readonly AppChoice[], query: string): AppChoice[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...choices]
  return choices.filter(
    (choice) =>
      choice.name.toLocaleLowerCase().includes(needle) ||
      (choice.frontWindowTitle ?? '').toLocaleLowerCase().includes(needle)
  )
}

/** The primary button: "Add scene", or "Add 2 scenes". */
export function addScenesLabel(count: number): string {
  return count > 1 ? `Add ${count} scenes` : 'Add scene'
}

/** "3 windows" under an app with several; nothing for one. */
export function windowCountLabel(count: number): string | null {
  return count > 1 ? plural(count, 'window') : null
}

function screenLayoutFor(preset: LayoutPreset, cameraOn: boolean): LayoutPreset {
  const camera = cameraOn && layoutPresetNeedsCamera(preset)
  if (layoutPresetOrientation(preset) === 'vertical')
    return camera ? 'vertical-screen-camera' : 'vertical-screen-only'
  return camera ? 'screen-camera' : 'screen-only'
}

/**
 * The current look, made to show a screen: a scene made for an app that
 * showed no screen (the Studio on Camera only, or its screen hidden) would
 * never show the app. A camera layout with the camera off becomes its
 * screen-only twin, so every new scene can go on stream. The orientation
 * never changes, so new scenes follow the Studio's.
 */
export function lookForAppScenes(look: SceneVisual): SceneVisual {
  const { layout } = look
  const freeform = layout.arrangementMode === 'freeform'
  const cameraOn = Boolean(look.sources.cameraId) && look.sources.cameraOff !== true
  const fits =
    freeform ||
    (layoutPresetNeedsScreen(layout.layoutPreset) &&
      (cameraOn || !layoutPresetNeedsCamera(layout.layoutPreset)))
  const layoutPreset = fits ? layout.layoutPreset : screenLayoutFor(layout.layoutPreset, cameraOn)
  return normalizeSceneVisual({
    ...look,
    layout: {
      ...layout,
      layoutPreset,
      ...(layoutPreset !== layout.layoutPreset
        ? { arrangementMode: 'preset' as const, sourceTransformOverrides: {} }
        : {}),
      sourceVisibility: { ...layout.sourceVisibility, capture: true }
    }
  })
}

/** The scenes "Add N scenes" makes, through S2's `scenesForApps`. */
export function newAppScenes(
  choices: readonly AppChoice[],
  look: SceneVisual,
  existing: readonly SavedScene[],
  options?: ScenesForAppsOptions
): SavedScene[] {
  return scenesForApps(
    choices.map((choice) => ({
      bundleId: choice.bundleId,
      name: choice.name,
      frontWindowId: choice.frontWindowId,
      frontWindowName: choice.frontWindowTitle
    })),
    lookForAppScenes(look),
    existing,
    options
  )
}

/**
 * Windows and Linux (D12): what Sources offers there, the displays or the
 * Linux portal's one source, one of which becomes a scene.
 */
export function captureChoices(devices: readonly Device[]): Device[] {
  return capturePickerDevices([...devices]).filter((device) => device.status === 'available')
}

/** A scene for one display (or the portal's source), named after it, with no audio. */
export function newCaptureScene(
  device: Pick<Device, 'id' | 'name' | 'kind'>,
  look: SceneVisual,
  existing: readonly SavedScene[],
  options: { id: string; now: string }
): SavedScene {
  const base = lookForAppScenes(look)
  const window = device.kind === 'window'
  return {
    id: options.id,
    name: uniqueSceneName(device.name, existing),
    createdAt: options.now,
    updatedAt: options.now,
    visual: normalizeSceneVisual({
      ...base,
      sources: {
        ...base.sources,
        screenId: window ? undefined : device.id,
        screenName: window ? undefined : device.name,
        windowId: window ? device.id : undefined,
        windowName: window ? device.name : undefined,
        captureOff: false,
        testPattern: false,
        app: undefined
      }
    })
  }
}
