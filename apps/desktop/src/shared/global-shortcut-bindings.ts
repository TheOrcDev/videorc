import type { GlobalShortcutsConfig } from './backend'
import { sceneSlotPosition, type GlobalShortcutAction } from './global-shortcuts'

// The Settings side of global shortcuts: which config key each action writes.
// Kept out of shared/global-shortcuts, which the eager Studio chunk imports,
// so only Settings and the IPC contract carry it.

const ACTION_CONFIG_KEYS = {
  'screen-hide-toggle': 'screenHideToggle',
  'record-toggle': 'recordToggle',
  'stream-toggle': 'streamToggle',
  'mic-toggle': 'micToggle',
  'system-audio-toggle': 'systemAudioToggle',
  'clip-mark': 'clipMark',
  'clip-mark-long': 'clipMarkLong',
  'layout-next': 'layoutNext',
  'layout-previous': 'layoutPrevious'
} as const satisfies Record<
  Exclude<GlobalShortcutAction, `scene-slot-${number}` | `scene:${string}`>,
  Exclude<keyof GlobalShortcutsConfig, 'layouts' | 'scenes' | 'sceneSlots'>
>

/** A single-action key a GlobalShortcutsConfig may carry (besides
 * `layouts`, `scenes` and `sceneSlots`): the IPC schema admits exactly these. */
export function isGlobalShortcutConfigKey(key: string): boolean {
  return (Object.values(ACTION_CONFIG_KEYS) as string[]).includes(key)
}

/** The config with one action's binding replaced ('' releases it). */
export function withGlobalShortcut(
  config: GlobalShortcutsConfig | undefined,
  action: GlobalShortcutAction,
  accelerator: string
): GlobalShortcutsConfig {
  if (action.startsWith('scene:')) {
    return { ...config, scenes: { ...config?.scenes, [action.slice(6)]: accelerator } }
  }
  const position = sceneSlotPosition(action)
  if (position !== null) {
    return { ...config, sceneSlots: { ...config?.sceneSlots, [position]: accelerator } }
  }
  return {
    ...config,
    [ACTION_CONFIG_KEYS[action as keyof typeof ACTION_CONFIG_KEYS]]: accelerator
  }
}
