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

/** Used on first discovery at launch and every idle discovery refresh. */
export async function reconcileWorkingSceneSources(
  sources: SourceSelection & VisualSources,
  devices: Device[],
  resolve: ResolveAppWindow
): Promise<SourceSelection & VisualSources> {
  if (!sources.app || devices.length === 0) return reconcileSourceSelection(sources, devices)
  const result = await resolve({ bundleId: sources.app.bundleId, preferWindowId: sources.windowId })
  // Refusal keeps today's display fallback, without exact-title rebinding to another window.
  const next = result.ok
    ? {
        ...sources,
        windowId: result.windowId,
        windowName: result.title,
        screenId: undefined,
        screenName: undefined,
        captureOff: false,
        testPattern: false
      }
    : { ...sources, windowId: undefined, windowName: undefined }
  const reconciled = reconcileSourceSelection(next, devices)
  // A successful resolver may be newer than devices.list. Preserve its authoritative window.
  return result.ok
    ? {
        ...reconciled,
        ...next,
        cameraId: reconciled.cameraId,
        cameraName: reconciled.cameraName,
        cameraOff: reconciled.cameraOff,
        microphoneId: reconciled.microphoneId,
        microphoneName: reconciled.microphoneName,
        microphoneOff: reconciled.microphoneOff
      }
    : reconciled
}

/** App identity belongs to renderer scene memory, never to protocol SourceSelection. */
export function withoutSceneApp<T extends SourceSelection>(sources: T): Omit<T, 'app'> {
  const next = { ...sources }
  delete (next as T & { app?: unknown }).app
  return next
}
