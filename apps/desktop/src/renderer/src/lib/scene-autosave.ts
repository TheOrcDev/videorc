import type { SourceSelection } from './backend'
import {
  normalizeSceneVisual,
  sameSceneVisual,
  type SavedScene,
  type SceneVisual,
  type VisualSources
} from './scene-presets'

// Plan 210 D3: a saved scene keeps the edits made while it is on. The layout,
// placement, camera, shape and background save into it as each commit lands,
// and undo is one more commit. What the scene shows (its screen, window or
// app) and what it hears never change this way: choosing another screen or
// window leaves the scene, and audio changes only from the scene's ⋯ menu.

/**
 * The saved scene a confirmed commit writes, or null when it writes none.
 *
 * - Only a commit made while the scene was already on writes: the commit that
 *   puts a scene on stream (a click, a key, an undo back into it) is a switch,
 *   not an edit, so it never carries the outgoing scene's picture into it.
 * - A built-in layout is never a saved scene (no id), so it never saves.
 * - The scene keeps its own sources and audio; only the look is written.
 * - Nothing is written when the look is what the scene already keeps.
 */
export function sceneAutosave(input: {
  /** The saved scene the working scene was on before this commit. */
  previousSceneId: string | null
  /** The saved scene it is on now. */
  sceneId: string | null
  scenes: readonly SavedScene[]
  /** The committed working look. */
  visual: SceneVisual
  now: string
}): SavedScene | null {
  const { sceneId } = input
  if (!sceneId || input.previousSceneId !== sceneId) return null
  const saved = input.scenes.find((scene) => scene.id === sceneId)
  if (!saved) return null
  const visual = normalizeSceneVisual({ ...input.visual, sources: saved.visual.sources })
  if (sameSceneVisual(visual, saved.visual)) return null
  return { ...saved, visual, updatedAt: input.now }
}

type CaptureChoice = Pick<SourceSelection, 'screenId' | 'windowId' | 'captureOff' | 'testPattern'>

function captureIdentity(sources: CaptureChoice): string {
  if (sources.windowId) return `window:${sources.windowId}`
  if (sources.screenId) return `screen:${sources.screenId}`
  if (sources.testPattern) return 'test-pattern'
  return sources.captureOff ? 'off' : 'none'
}

/**
 * Whether choosing a screen or window in a picker leaves the saved scene on
 * stream (D3). Another screen or window always does, so no saved scene is
 * ever rewritten by a pick. A scene made for an app shows whichever window
 * is the app's front one, so any pick turns it into something else and
 * leaves it; its app changes from its ⋯ menu ("Change app…").
 */
export function capturePickLeavesScene(
  current: CaptureChoice & Pick<VisualSources, 'app'>,
  picked: CaptureChoice
): boolean {
  return Boolean(current.app) || captureIdentity(current) !== captureIdentity(picked)
}
