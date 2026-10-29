import type { Device } from './backend'
import {
  normalizeSceneVisual,
  visualSources,
  type SavedScene,
  type SceneOrientation,
  type SceneVisual,
  type VisualSources
} from './scene-presets'

// Plan 210: what app scenes need beyond the saved scene's shape. Only the
// Scene page (New scene…, the list), a saved scene's switch and the follower
// read these, all lazy, so they stay out of the Studio's first paint.

export type AppWindowFailure = 'app-not-running' | 'app-no-window' | 'app-minimized'
export type AppWindowResolution =
  | { windowId: string; title: string }
  | { reason: 'not-running' | 'no-window' | 'minimized' }
export type SceneWindowResolution =
  | { kind: 'ready'; sources: VisualSources }
  | { kind: 'resolve-app'; bundleId: string }
  | { kind: 'blocked'; reason: AppWindowFailure }
  | { kind: 'resolve-sources' }

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

/** Resolve before strict preflight; the returned projection never rewrites a snapshot.
 * An old fixed-window scene can pass remembered device ownership as fallbackBundleId.
 * App scenes resolve anew: from the held device list when it lists the remembered
 * window under the scene's app (plan 210 D5, `heldAppWindow`), else over the backend.
 */
export function resolveSceneWindow(
  visual: SceneVisual,
  devices: readonly Device[],
  fallbackBundleId?: string,
  resolution?: AppWindowResolution
): SceneWindowResolution {
  const sources = visualSources(visual.sources)
  const bundleId = sources.app?.bundleId ?? fallbackBundleId
  const exact = devices.some(
    (d) => d.kind === 'window' && d.id === sources.windowId && d.status === 'available'
  )
  if (!sources.app && (!sources.windowId || exact)) return { kind: 'ready', sources }
  if (!bundleId) return { kind: 'resolve-sources' }
  if (!resolution) return { kind: 'resolve-app', bundleId }
  if ('reason' in resolution) return { kind: 'blocked', reason: `app-${resolution.reason}` }
  return {
    kind: 'ready',
    sources: {
      ...sources,
      screenId: undefined,
      screenName: undefined,
      captureOff: false,
      testPattern: false,
      windowId: resolution.windowId,
      windowName: resolution.title
    }
  }
}

export type SceneAppChoice = {
  bundleId: string
  name: string
  frontWindowId?: string
  frontWindowName?: string
}
export type ScenesForAppsOptions = { id: () => string; now: () => string }
export function scenesForApps(
  apps: readonly SceneAppChoice[],
  look: SceneVisual,
  existingScenes: readonly SavedScene[],
  options: ScenesForAppsOptions = {
    id: () => crypto.randomUUID(),
    now: () => new Date().toISOString()
  }
): SavedScene[] {
  const names = new Set(existingScenes.map((s) => s.name.toLocaleLowerCase()))
  return apps.map((app) => {
    const base = app.name.trim().slice(0, 80) || app.bundleId.slice(0, 80)
    let name = base
    for (let n = 2; names.has(name.toLocaleLowerCase()); n++) {
      const suffix = ` ${n}`
      name = base.slice(0, 80 - suffix.length).trimEnd() + suffix
    }
    names.add(name.toLocaleLowerCase())
    const now = options.now()
    return {
      id: options.id(),
      name,
      createdAt: now,
      updatedAt: now,
      visual: normalizeSceneVisual({
        ...look,
        sources: {
          ...look.sources,
          screenId: undefined,
          screenName: undefined,
          windowId: app.frontWindowId,
          windowName: app.frontWindowName,
          captureOff: false,
          testPattern: false,
          app: { bundleId: app.bundleId, name: app.name, follows: true }
        }
      })
    }
  })
}

export function sceneForFrontApp(
  scenes: readonly SavedScene[],
  front: { bundleId: string },
  lastUsedAt: Readonly<Record<string, number>>,
  orientation: SceneOrientation
): SavedScene | undefined {
  let best: SavedScene | undefined
  for (const scene of scenes) {
    const app = scene.visual.sources.app
    if (
      app?.bundleId.toLowerCase() !== front.bundleId.toLowerCase() ||
      !app.follows ||
      scene.visual.layout.layoutPreset.startsWith('vertical-') !== (orientation === 'vertical')
    )
      continue
    if (!best || (lastUsedAt[scene.id] ?? 0) > (lastUsedAt[best.id] ?? 0)) best = scene
  }
  return best
}
