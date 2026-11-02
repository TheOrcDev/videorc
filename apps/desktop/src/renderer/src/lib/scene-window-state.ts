import type {
  Device,
  ResolveAppWindowParams,
  ResolveAppWindowResult,
  SourceSelection
} from './backend'
import { reconcileSourceSelection } from './capture'
import {
  normalizeSceneApp,
  type SavedScene,
  type SceneVisual,
  type VisualSources
} from './scene-presets'

// Plan 210: what the Studio holds about app scenes' windows from launch: the
// device memory of each scene's app, each scene's app state for the list and
// the keys, and the working scene's sources at discovery. A saved scene's
// switch resolves its window in `scene-window-resolution.ts`, loaded once at
// connect, so the resolver stays out of the Studio's first paint.

export const SCENE_WINDOW_APPS_KEY = 'videorc.scene-window-apps.v1'
export type SceneAppState = 'ready' | 'not-running' | 'no-window' | 'minimized'
export type AppWindowFailure = 'app-not-running' | 'app-no-window' | 'app-minimized'
/** S2's refusals, in words: "Figma isn't open". Eager: the start reason says it too. */
export function appWindowFailureCopy(name: string, reason: AppWindowFailure): string {
  switch (reason) {
    case 'app-not-running':
      return `${name} isn't open`
    case 'app-no-window':
      return `${name} has no window open`
    case 'app-minimized':
      return `${name}'s window is minimized`
  }
}
export type RememberedSceneApps = Record<string, string>
export type ResolveAppWindow = (params: ResolveAppWindowParams) => Promise<ResolveAppWindowResult>

/** Separate, bounded device memory. Never migrate or rewrite a scene snapshot. */
export function rememberedSceneApps(
  raw: unknown,
  scenes: readonly Pick<SavedScene, 'id'>[]
): RememberedSceneApps {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const ids = new Set(scenes.map((s) => s.id))
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([id, bundleId]) => ids.has(id) && normalizeSceneApp({ bundleId }))
      .slice(-200)
  )
}

/** Discovery can prove a window exists; only the resolver can distinguish a missing app from minimized windows. */
export function sceneAppState(
  visual: SceneVisual,
  devices: readonly Device[],
  last?: SceneAppState
): SceneAppState | undefined {
  const app = visual.sources.app
  if (!app) return undefined
  if (last && last !== 'ready') return last
  if (
    devices.some(
      (d) => d.kind === 'window' && d.status === 'available' && d.app?.bundleId === app.bundleId
    )
  )
    return 'ready'
  return last && last !== 'ready' ? last : 'not-running'
}

/**
 * Used on first discovery at launch and every idle discovery refresh. For a
 * scene made for an app, `appState` is the resolver's answer: `ready` with
 * its window, or why there is none. Plan 210 D1: quitting and relaunching
 * the app never breaks the scene, so a refusal holds the screen at None
 * (never a whole display under the app's name) with the scene still on, and
 * the next refresh that finds the app's window applies it.
 */
export async function reconcileWorkingSceneSources(
  sources: SourceSelection & VisualSources,
  devices: Device[],
  resolve: ResolveAppWindow
): Promise<{ sources: SourceSelection & VisualSources; appState?: SceneAppState }> {
  if (!sources.app || devices.length === 0)
    return { sources: reconcileSourceSelection(sources, devices) }
  const result = await resolve({ bundleId: sources.app.bundleId, preferWindowId: sources.windowId })
  // Refusal waits with Screen None, without exact-title rebinding to another window.
  const next = result.ok
    ? {
        ...sources,
        windowId: result.windowId,
        windowName: result.title,
        screenId: undefined,
        screenName: undefined,
        screenUuid: undefined,
        captureOff: false,
        testPattern: false
      }
    : {
        ...sources,
        windowId: undefined,
        windowName: undefined,
        screenId: undefined,
        screenName: undefined,
        screenUuid: undefined,
        captureOff: true
      }
  const reconciled = reconcileSourceSelection(next, devices)
  // A successful resolver may be newer than devices.list. Preserve its authoritative window.
  return result.ok
    ? {
        sources: {
          ...reconciled,
          ...next,
          cameraId: reconciled.cameraId,
          cameraName: reconciled.cameraName,
          cameraOff: reconciled.cameraOff,
          wantedCameraId: reconciled.wantedCameraId,
          wantedCameraName: reconciled.wantedCameraName,
          microphoneId: reconciled.microphoneId,
          microphoneName: reconciled.microphoneName,
          microphoneOff: reconciled.microphoneOff
        },
        appState: 'ready'
      }
    : { sources: reconciled, appState: result.reason }
}

/** App identity belongs to renderer scene memory, never to protocol SourceSelection. */
export function withoutSceneApp<T extends SourceSelection>(sources: T): Omit<T, 'app'> {
  const next = { ...sources }
  delete (next as T & { app?: unknown }).app
  return next
}
