import { LAYOUT_PRESET_VALUES, type LayoutPreset } from '../../../shared/backend'
import type { SavedScene } from './scene-presets'
import type { SceneAppState } from './scene-window-resolution'

/** Library order, then canonical layouts. Unavailable entries retain their place. */
export function nextEligibleScene(input: {
  current: string
  direction: 1 | -1
  scenes: readonly SavedScene[]
  orientation: 'horizontal' | 'vertical'
  sessionActive: boolean
  appStates: Readonly<Record<string, SceneAppState | undefined>>
  unavailableSceneIds?: readonly string[]
  layouts: readonly LayoutPreset[]
}): string | null {
  const { scenes, orientation, sessionActive, appStates, layouts, current, direction } = input
  const catalog = [
    ...scenes.map(({ id }) => `scene:${id}`),
    ...LAYOUT_PRESET_VALUES.filter(
      (id) => id.startsWith('vertical-') === (orientation === 'vertical')
    ).map((id) => `layout:${id}`)
  ]
  const eligible = new Set([
    ...scenes
      .filter(
        (scene) =>
          !input.unavailableSceneIds?.includes(scene.id) &&
          (!sessionActive ||
            scene.visual.layout.layoutPreset.startsWith('vertical-') ===
              (orientation === 'vertical')) &&
          (!appStates[scene.id] || appStates[scene.id] === 'ready')
      )
      .map((scene) => `scene:${scene.id}`),
    ...layouts.map((id) => `layout:${id}`)
  ])
  const index = catalog.indexOf(current)
  for (let step = 1; step <= catalog.length; step++) {
    const candidate =
      catalog[
        ((index < 0 ? (direction === 1 ? -1 : 0) : index) + direction * step + catalog.length) %
          catalog.length
      ]
    if (candidate !== current && eligible.has(candidate)) return candidate
  }
  return null
}
