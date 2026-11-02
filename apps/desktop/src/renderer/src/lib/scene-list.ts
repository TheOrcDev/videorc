import type { Device, LayoutPreset, LayoutSettings } from './backend'
import { layoutPresetNeedsScreen, layoutPresetOrientation } from './capture'
import { layoutPresetLabel } from './layout-labels'
import { appWindowFailureCopy } from './scene-apps'
import {
  sceneSourceProblems,
  normalizeSceneAudio,
  normalizeSceneVisual,
  type SavedScene,
  type SceneAudio,
  type SceneVisual
} from './scene-presets'
import type { SceneAppState } from './scene-window-resolution'

// Plan 210 D6: the Scene page leads with one list. Saved scenes come first,
// in library order (New scene… puts its scenes at the top, a drag or ⌥↑ ⌥↓
// moves one), then the current orientation's built-in layouts. Studio's
// gallery, Next scene and Previous scene follow the same order.

/** What the list marks as on stream. */
export type SceneListActive =
  | { kind: 'saved'; id: string }
  | { kind: 'layout'; preset: LayoutPreset }
  | { kind: 'unsaved' }

/**
 * A saved scene when one is on; a built-in layout when its plain arrangement
 * is on; otherwise "Unsaved scene": a saved scene left by choosing another
 * screen or window (D3), a deleted one's look, or a Freeform arrangement.
 */
export function sceneListActive(input: {
  activeSavedSceneId: string | null
  origin: 'builtin' | 'saved'
  layout: Pick<LayoutSettings, 'layoutPreset' | 'arrangementMode'>
}): SceneListActive {
  if (input.activeSavedSceneId) return { kind: 'saved', id: input.activeSavedSceneId }
  if (input.origin === 'builtin' && input.layout.arrangementMode !== 'freeform')
    return { kind: 'layout', preset: input.layout.layoutPreset }
  return { kind: 'unsaved' }
}

// The library hook moves scenes too, from the Studio's eager chunk: the move
// lives in its own module so this one stays with the lazy scene UI.
export { movedScenes } from './scene-order'

/** The keys a row answers to move (WCAG 2.1.1: never only by dragging). */
export const MOVE_SCENE_UP_ACCELERATOR = 'Alt+Up'
export const MOVE_SCENE_DOWN_ACCELERATOR = 'Alt+Down'

/** ⌥↑ or ⌥↓ alone on a focused row: the step, else null. */
export function sceneMoveKeyStep(event: {
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}): -1 | 1 | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  return event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : null
}

function showsScreen(visual: SceneVisual): boolean {
  return (
    visual.layout.arrangementMode === 'freeform' ||
    layoutPresetNeedsScreen(visual.layout.layoutPreset)
  )
}

/** The row's second line: what the scene puts on stream, in a few words. */
export function sceneShows(scene: Pick<SavedScene, 'visual'>): string {
  const { sources, layout } = scene.visual
  if (!showsScreen(scene.visual)) return layoutPresetLabel(layout.layoutPreset)
  if (sources.app) return `${sources.app.name} · front window`
  if (sources.windowId) return sources.windowName ? `Window · ${sources.windowName}` : 'Window'
  if (sources.screenId) return sources.screenName ?? 'Display'
  if (sources.testPattern) return 'Test pattern'
  return 'No screen'
}

/** The row's icon: the app's own, or a glyph for what the scene shows. */
export type SceneGlyph =
  | { kind: 'app'; bundleId: string }
  | { kind: 'window' }
  | { kind: 'display' }
  | { kind: 'camera' }

/** A fixed window shows its app's icon when the device list knows the app. */
export function sceneGlyph(
  scene: Pick<SavedScene, 'visual'>,
  devices: readonly Device[]
): SceneGlyph {
  const { sources } = scene.visual
  if (!showsScreen(scene.visual)) return { kind: 'camera' }
  if (sources.app) return { kind: 'app', bundleId: sources.app.bundleId }
  if (sources.windowId) {
    const bundleId = devices.find((device) => device.id === sources.windowId)?.app?.bundleId
    return bundleId ? { kind: 'app', bundleId } : { kind: 'window' }
  }
  return { kind: 'display' }
}

export const ORIENTATION_SWITCH_LOCK_REASON =
  'Stop the recording or stream before switching orientation.'

/**
 * Why a saved scene can't go on stream now, or null. An app that isn't
 * ready says so in S2's words ("Figma isn't open"), and a scene of the other
 * orientation waits for the take to end (the canvas is fixed while it runs).
 * A scene made for an app never asks for its window to be resolved, so a
 * camera it needs and can't use is said here too; any other scene's missing
 * sources open Resolve scene sources instead.
 */
export function savedSceneBlockedReason(input: {
  scene: Pick<SavedScene, 'visual'>
  appState: SceneAppState | undefined
  sessionActive: boolean
  orientation: 'horizontal' | 'vertical'
  devices: readonly Device[]
}): string | null {
  const app = input.scene.visual.sources.app
  if (app && input.appState && input.appState !== 'ready')
    return appWindowFailureCopy(app.name, `app-${input.appState}`)
  if (
    input.sessionActive &&
    layoutPresetOrientation(input.scene.visual.layout.layoutPreset) !== input.orientation
  )
    return ORIENTATION_SWITCH_LOCK_REASON
  // For an app's scene, the problems are its camera's alone (S2 resolves the app).
  if (app) return sceneSourceProblems(input.scene.visual, input.devices)[0] ?? null
  return null
}

/** "Figma", then "Figma 2" while taken, within the 80-character limit. */
export function uniqueSceneName(
  base: string,
  scenes: readonly Pick<SavedScene, 'id' | 'name'>[],
  exceptId?: string
): string {
  const taken = new Set(
    scenes.filter((scene) => scene.id !== exceptId).map((scene) => scene.name.toLocaleLowerCase())
  )
  const trimmed = base.trim().slice(0, 80) || 'Scene'
  let name = trimmed
  for (let n = 2; taken.has(name.toLocaleLowerCase()); n++) {
    const suffix = ` ${n}`
    name = trimmed.slice(0, 80 - suffix.length).trimEnd() + suffix
  }
  return name
}

/**
 * Save scene…'s starting name (plan 210 §4: the field used to start empty):
 * the app or display the scene shows, else its layout, made unique.
 */
export function suggestedSceneName(
  visual: SceneVisual,
  devices: readonly Device[],
  scenes: readonly Pick<SavedScene, 'id' | 'name'>[]
): string {
  const { sources } = visual
  const window = sources.windowId
    ? devices.find((device) => device.id === sources.windowId)
    : undefined
  const base = !showsScreen(visual)
    ? layoutPresetLabel(visual.layout.layoutPreset)
    : (sources.app?.name ??
      window?.app?.name ??
      sources.windowName ??
      sources.screenName ??
      layoutPresetLabel(visual.layout.layoutPreset))
  return uniqueSceneName(base, scenes)
}

/**
 * Duplicate: the same look, sources and audio under "{name} 2", placed right
 * after the original. Its key stays with the original.
 */
export function duplicatedScene(
  scene: SavedScene,
  scenes: readonly SavedScene[],
  options: { id: string; now: string }
): SavedScene {
  return {
    ...structuredClone(scene),
    id: options.id,
    name: uniqueSceneName(scene.name, scenes),
    createdAt: options.now,
    updatedAt: options.now,
    visual: normalizeSceneVisual(scene.visual)
  }
}

/**
 * Why "Save scene…" can't run, or null (plan 210 §8: it was disabled without
 * saying why). Offline wins: nothing commits without Videorc.
 */
export function saveSceneBlockedReason(input: {
  readOnly: boolean
  connected: boolean
  canSave: boolean
}): string | null {
  if (input.canSave) return null
  if (input.readOnly) return 'Update Videorc to save scenes. Your saved scenes are kept.'
  if (!input.connected) return 'Videorc is reconnecting. Try again in a moment.'
  return 'Wait for the scene to finish changing.'
}

// The ⋯ menu's edits. Each is the streamer's own action, so each may change
// what the scene shows or hears; nothing else does (D3, D4).

/**
 * Change app…: the scene shows another app's front window, and keeps its
 * look, audio and following. A name that was the old app's ("Figma",
 * "Figma 2") becomes the new app's; a name the streamer typed stays.
 */
export function sceneWithApp(
  scene: SavedScene,
  app: { bundleId: string; name: string; frontWindowId?: string; frontWindowTitle?: string },
  scenes: readonly SavedScene[],
  now: string
): SavedScene {
  const previous = scene.visual.sources.app
  const namedAfterApp =
    previous &&
    new RegExp(`^${previous.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\d+)?$`, 'i').test(
      scene.name
    )
  return {
    ...scene,
    name: namedAfterApp ? uniqueSceneName(app.name, scenes, scene.id) : scene.name,
    updatedAt: now,
    visual: normalizeSceneVisual({
      ...scene.visual,
      sources: {
        ...scene.visual.sources,
        screenId: undefined,
        screenName: undefined,
        screenUuid: undefined,
        windowId: app.frontWindowId,
        windowName: app.frontWindowTitle,
        captureOff: false,
        testPattern: false,
        app: { bundleId: app.bundleId, name: app.name, follows: previous?.follows ?? true }
      }
    })
  }
}

/** Stop following / Follow the app (D10): only scenes made for an app follow. */
export function sceneWithFollow(scene: SavedScene, follows: boolean, now: string): SavedScene {
  const app = scene.visual.sources.app
  if (!app || app.follows === follows) return scene
  return {
    ...scene,
    updatedAt: now,
    visual: { ...scene.visual, sources: { ...scene.visual.sources, app: { ...app, follows } } }
  }
}

/** Save audio to scene (D4): the microphone and System audio it switches to from now on. */
export function sceneWithAudio(scene: SavedScene, audio: SceneAudio, now: string): SavedScene {
  return { ...scene, audio: normalizeSceneAudio(audio)!, updatedAt: now }
}
