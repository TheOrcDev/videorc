import type { Device, GlobalShortcutsConfig } from '@/lib/backend'
import { sceneGlyph } from '@/lib/scene-list'
import type { SavedScene } from '@/lib/scene-presets'
import { sceneShortcutBindings } from '@/lib/scene-shortcuts'
import type { SavedSceneApplyResult } from '@/lib/scene-window-resolution'
import type { GlobalShortcutAction } from '../../../shared/global-shortcuts'
import type { SceneHudIcon, SceneHudRequest } from '../../../shared/scene-hud'

/**
 * The key HUD (plan 231 D20), the Studio's half of the decision. Loaded
 * lazily, after a switch lands: never in the Studio's first paint.
 *
 * Where a switch came from. Only a key (a position key, a scene's own key,
 * Next or Previous) or a remote (the Stream Deck, the phone) can happen while
 * Videorc is behind another app; a click, Follow the app in front and an
 * agent never show the HUD.
 */
export type SceneSwitchSource = 'key' | 'remote' | 'click' | 'follow' | 'agent'

const HUD_SOURCES: ReadonlySet<SceneSwitchSource> = new Set(['key', 'remote'])

/** The scene's icon on the chip: the same app icon or glyph as its card. */
export function sceneHudIconFor(
  scene: Pick<SavedScene, 'visual'>,
  devices: readonly Device[]
): SceneHudIcon {
  return sceneGlyph(scene, devices)
}

/**
 * Pure. The key on the chip: the key that was pressed when it is this
 * scene's own (its position key or its custom key), else the scene's
 * position key, else its custom key, else none (a scene after the ninth with
 * no key of its own, switched from the Stream Deck).
 */
export function sceneHudKey(input: {
  pressed?: GlobalShortcutAction | null
  sceneId: string
  position: number
  config: GlobalShortcutsConfig
  platform: string | undefined
}): string | undefined {
  const bindings = sceneShortcutBindings(
    input.sceneId,
    input.position,
    input.config,
    input.platform
  )
  const pressed = input.pressed
    ? bindings.find((binding) => binding.action === input.pressed)
    : null
  return (pressed ?? bindings[0])?.accelerator
}

/**
 * Pure. The one message for main, or null: a key or a remote, the setting
 * on, Videorc's capture known to leave the HUD out (fail closed), and a
 * switch that landed or was refused. A switch a newer one took over says
 * nothing, so two keys in quick succession name only the last scene.
 * Main still checks that no Videorc window is in front.
 */
export function sceneHudRequestFor(input: {
  source: SceneSwitchSource
  enabled: boolean
  captureConfirmed: boolean
  outcome: SavedSceneApplyResult
  scene: { name: string; icon: SceneHudIcon } | null
  key?: string
}): SceneHudRequest | null {
  if (!HUD_SOURCES.has(input.source) || !input.enabled || !input.captureConfirmed) return null
  if (!input.scene || (!input.outcome.ok && input.outcome.superseded)) return null
  const refusal = input.outcome.ok
    ? undefined
    : input.outcome.message?.trim() || "That scene couldn't be applied"
  return {
    name: input.scene.name,
    icon: input.scene.icon,
    ...(input.key ? { key: input.key } : {}),
    ...(refusal ? { refusal } : {})
  }
}
