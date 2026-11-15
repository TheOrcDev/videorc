import type { Device } from './backend'
import { layoutPresetNeedsScreen } from './capture'
import { appWindowFailureCopy } from './scene-apps'
import {
  sceneSourceProblems,
  normalizeSceneAudio,
  type SavedScene,
  type SceneAudio,
  type SceneVisual
} from './scene-presets'
import type { SceneAppState } from './scene-window-resolution'
import type { Scene } from './scenes'

// Plan 231 D2, D8: one list of scenes, in library order (a new scene goes at
// the end, a drag or ⌥← ⌥→ on a card, ⌥↑ ⌥↓ on a row, moves one). A scene is
// always on stream. Studio's Scenes section (cards), the Scene page (rows),
// Next scene and Previous scene follow the same order.

// The library hook moves scenes too, from the Studio's eager chunk: the move
// lives in its own module so this one stays with the lazy scene UI.
export { movedScenes } from './scene-order'

/** The keys a row answers to move (WCAG 2.1.1: never only by dragging). */
export const MOVE_SCENE_UP_ACCELERATOR = 'Alt+Up'
export const MOVE_SCENE_DOWN_ACCELERATOR = 'Alt+Down'
/** The keys a card in Studio's grid answers to move (plan 231 D8). */
export const MOVE_SCENE_LEFT_ACCELERATOR = 'Alt+Left'
export const MOVE_SCENE_RIGHT_ACCELERATOR = 'Alt+Right'

/**
 * ⌥↑ or ⌥↓ alone on a focused row (⌥← or ⌥→ on a card in a row of cards):
 * the step, else null.
 */
export function sceneMoveKeyStep(
  event: {
    key: string
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
  },
  axis: 'vertical' | 'horizontal' = 'vertical'
): -1 | 1 | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null
  const [back, forward] =
    axis === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  return event.key === back ? -1 : event.key === forward ? 1 : null
}

function showsScreen(visual: SceneVisual): boolean {
  return (
    visual.layout.arrangementMode === 'freeform' ||
    layoutPresetNeedsScreen(visual.layout.layoutPreset)
  )
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

/**
 * Why a saved scene can't go on stream now, or null. An app that isn't
 * ready says so in S2's words ("Figma isn't open"). Every scene has a layout
 * for each orientation (plan 231 D4), so none waits for the take to end.
 * A scene made for an app never asks for its window to be resolved, so a
 * camera it needs and can't use is said here too; any other scene's missing
 * sources open Resolve scene sources instead.
 */
export function savedSceneBlockedReason(input: {
  scene: Pick<SavedScene, 'visual'>
  appState: SceneAppState | undefined
  devices: readonly Device[]
}): string | null {
  const app = input.scene.visual.sources.app
  if (app && input.appState && input.appState !== 'ready')
    return appWindowFailureCopy(app.name, `app-${input.appState}`)
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
 * Duplicate (plan 231 D6): "another one like this", both layouts, its screen,
 * background and audio, under "{name} 2". It goes at the end like every new
 * scene (D5), and its keys stay with the original.
 */
export function duplicatedScene(
  scene: Scene,
  scenes: readonly Pick<Scene, 'id' | 'name'>[],
  options: { id: string; now: string }
): Scene {
  return {
    ...structuredClone(scene),
    id: options.id,
    name: uniqueSceneName(scene.name, scenes),
    createdAt: options.now,
    updatedAt: options.now
  }
}

// The ⋯ menu's edits. Each is the streamer's own action, so each may change
// what the scene shows or hears; nothing else does (D3, D4).

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
