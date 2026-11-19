import type { GlobalShortcutsConfig } from './backend'
import {
  SCENE_SLOT_ACTIONS,
  sceneSlotAccelerator,
  type GlobalShortcutAction,
  type SceneSlotPosition
} from '../../../shared/global-shortcuts'
import { sceneAtPosition } from './scenes'

/** Settings lists all nine positions, followed by custom keys that belong to a scene. */
export function sceneShortcutRows(
  scenes: readonly { id: string; name: string }[],
  config: GlobalShortcutsConfig,
  platform: string | undefined
): Array<{ action: GlobalShortcutAction; label: string; accelerator: string }> {
  return [
    ...SCENE_SLOT_ACTIONS.map((action, index) => ({
      action,
      label: `Scene ${index + 1} · ${sceneAtPosition(scenes, index + 1)?.name ?? 'no scene'}`,
      accelerator: sceneSlotAccelerator(config, (index + 1) as SceneSlotPosition, platform)
    })),
    ...scenes.flatMap(({ id, name }) => {
      const accelerator = config.scenes?.[id]
      return accelerator?.trim()
        ? [{ action: `scene:${id}` as const, label: name, accelerator }]
        : []
    })
  ]
}

/** A card's position key moves on reorder; its custom key stays with its id. */
export function sceneShortcutBindings(
  sceneId: string,
  position: number,
  config: GlobalShortcutsConfig,
  platform: string | undefined
): Array<{ action: GlobalShortcutAction; accelerator: string }> {
  const bindings: Array<{ action: GlobalShortcutAction; accelerator: string }> = []
  if (Number.isInteger(position) && position >= 1 && position <= 9) {
    const accelerator = sceneSlotAccelerator(config, position as SceneSlotPosition, platform)
    if (accelerator.trim()) bindings.push({ action: SCENE_SLOT_ACTIONS[position - 1], accelerator })
  }
  const custom = config.scenes?.[sceneId]
  if (custom?.trim()) bindings.push({ action: `scene:${sceneId}`, accelerator: custom })
  return bindings
}
