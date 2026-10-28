import type {
  Device,
  ResolveAppWindowParams,
  ResolveAppWindowResult,
  SourceSelection
} from './backend'
import { reconcileSourceSelection } from './capture'
import {
  appWindowFailureCopy,
  normalizeSceneApp,
  resolveSceneWindow,
  type AppWindowFailure,
  type SavedScene,
  type SceneVisual,
  type SceneWindowResolution,
  type VisualSources
} from './scene-presets'

export const SCENE_WINDOW_APPS_KEY = 'videorc.scene-window-apps.v1'
export type SceneAppState = 'ready' | 'not-running' | 'no-window' | 'minimized'
export type SavedSceneApplyResult =
  | { ok: true }
  | { ok: false; reason?: AppWindowFailure; message?: string }
export type ResolveAppWindow = (params: ResolveAppWindowParams) => Promise<ResolveAppWindowResult>
export type RememberedSceneApps = Record<string, string>

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

export async function resolveSceneWindowForApply(
  visual: SceneVisual,
  devices: readonly Device[],
  resolve: ResolveAppWindow,
  fallbackBundleId?: string
): Promise<SceneWindowResolution> {
  const initial = resolveSceneWindow(visual, devices, fallbackBundleId)
  if (initial.kind !== 'resolve-app') return initial
  const result = await resolve({
    bundleId: initial.bundleId,
    preferWindowId: visual.sources.windowId
  })
  const resolved = resolveSceneWindow(visual, devices, fallbackBundleId, result)
  return !visual.sources.app && resolved.kind === 'blocked' ? { kind: 'resolve-sources' } : resolved
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
