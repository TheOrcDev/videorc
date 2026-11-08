import type { Device, ResolveAppWindowResult } from './backend'
import {
  appWindowFailureCopy,
  resolveSceneWindow,
  type AppWindowFailure,
  type AppWindowResolution,
  type SceneWindowResolution
} from './scene-apps'
import type { SavedScene, SceneVisual, VisualSources } from './scene-presets'
import {
  rememberedSceneApps,
  type RememberedSceneApps,
  type ResolveAppWindow
} from './scene-window-state'

export {
  reconcileWorkingSceneSources,
  rememberedSceneApps,
  SCENE_WINDOW_APPS_KEY,
  sceneAppState,
  withoutSceneApp,
  type RememberedSceneApps,
  type ResolveAppWindow,
  type SceneAppState
} from './scene-window-state'

export type SavedSceneApplyResult =
  | { ok: true }
  | { ok: false; reason?: AppWindowFailure; message?: string }
/** How a scene apply was asked for (plan 210 S10). */
export type SavedSceneApplyOptions = {
  /** The window to prefer over the scene's own, as the follower's swap in place (D1, D10). */
  preferWindowId?: string
  /** `follow`: the follower's own apply, which never counts as the streamer's pick. */
  origin?: 'follow'
}

export function rememberSceneWindowApp(
  memory: RememberedSceneApps,
  sceneId: string,
  sources: VisualSources,
  devices: readonly Device[],
  scenes: readonly SavedScene[]
): RememberedSceneApps {
  const bundleId =
    sources.app?.bundleId ??
    devices.find((d) => d.kind === 'window' && d.id === sources.windowId)?.app?.bundleId
  const next = { ...memory }
  if (bundleId) {
    delete next[sceneId]
    Object.defineProperty(next, sceneId, { value: bundleId, enumerable: true, configurable: true })
  }
  return rememberedSceneApps(next, scenes)
}

/** The backend resolver's own floor for a normal window (D1). */
export const SCENE_APP_WINDOW_MIN_WIDTH = 400
export const SCENE_APP_WINDOW_MIN_HEIGHT = 300

/**
 * Plan 210 D5: the window an app scene shows, answered from the device list
 * the Studio holds. The resolver prefers the scene's remembered window (or
 * the follower's front window) whenever it is on screen, and the held list
 * names only on-screen windows, so a listed, available window under the
 * scene's app is the resolver's answer without its round trip (a fresh
 * SCShareableContent walk, 50 to 240 ms, most of the click-to-picture
 * budget). Anything the list cannot answer (window gone, app relaunched,
 * no remembered window) still asks the backend.
 */
export function heldAppWindow(
  devices: readonly Device[],
  bundleId: string,
  windowId: string | undefined
): Device | undefined {
  if (!windowId) return undefined
  return devices.find(
    (device) =>
      device.kind === 'window' &&
      device.id === windowId &&
      device.status === 'available' &&
      device.app?.bundleId === bundleId &&
      (device.width === undefined || device.width >= SCENE_APP_WINDOW_MIN_WIDTH) &&
      (device.height === undefined || device.height >= SCENE_APP_WINDOW_MIN_HEIGHT)
  )
}

export type ResolveSceneWindowOptions = {
  /** Ask the backend even when the held list answers: the retry after a refused switch. */
  forceResolve?: boolean
}

export async function resolveSceneWindowForApply(
  visual: SceneVisual,
  devices: readonly Device[],
  resolve: ResolveAppWindow,
  fallbackBundleId?: string,
  preferWindowId?: string,
  options?: ResolveSceneWindowOptions
): Promise<SceneWindowResolution> {
  const initial = resolveSceneWindow(visual, devices, fallbackBundleId)
  if (initial.kind !== 'resolve-app') return initial
  const preferred = preferWindowId ?? visual.sources.windowId
  const held = options?.forceResolve
    ? undefined
    : heldAppWindow(devices, initial.bundleId, preferred)
  const result: AppWindowResolution | ResolveAppWindowResult = held
    ? { windowId: held.id, title: held.windowTitle ?? '' }
    : await resolve({ bundleId: initial.bundleId, preferWindowId: preferred })
  const resolved = resolveSceneWindow(visual, devices, fallbackBundleId, result)
  return !visual.sources.app && resolved.kind === 'blocked' ? { kind: 'resolve-sources' } : resolved
}

/**
 * Plan 210 D5: a refused saved-scene switch gets one more try, resolved
 * over the backend, when the streamer's pick is still the latest: no newer
 * scene apply and no newer layout intent since the one this switch minted.
 * A held window gone since the list was read, or a capture restart that
 * superseded the switch's own start, must not refuse a running app's scene.
 */
export function savedSceneApplyRetryAllowed(input: {
  attempt: number
  generation: number
  latestGeneration: number
  intent: number
  latestIntent: number
}): boolean {
  return (
    input.attempt === 0 &&
    input.generation === input.latestGeneration &&
    input.intent === input.latestIntent
  )
}
export function sceneWindowRefusal(
  visual: SceneVisual,
  reason: AppWindowFailure
): SavedSceneApplyResult {
  return {
    ok: false,
    reason,
    message: appWindowFailureCopy(
      visual.sources.app?.name ?? visual.sources.windowName ?? 'The app',
      reason
    )
  }
}
