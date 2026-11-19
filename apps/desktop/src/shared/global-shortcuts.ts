import type { GlobalShortcutsConfig } from './backend'

export const DEFAULT_SCREEN_HIDE_SHORTCUT = 'Control+Alt+H'

export const SCENE_SLOT_ACTIONS = [
  'scene-slot-1',
  'scene-slot-2',
  'scene-slot-3',
  'scene-slot-4',
  'scene-slot-5',
  'scene-slot-6',
  'scene-slot-7',
  'scene-slot-8',
  'scene-slot-9'
] as const
export type SceneSlotAction = (typeof SCENE_SLOT_ACTIONS)[number]
export type SceneSlotPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

export function sceneSlotPosition(action: GlobalShortcutAction): SceneSlotPosition | null {
  return action.startsWith('scene-slot-') ? (Number(action.slice(11)) as SceneSlotPosition) : null
}

/** Undefined uses the platform default; an empty string releases the key. */
export function sceneSlotAccelerator(
  config: GlobalShortcutsConfig,
  position: SceneSlotPosition,
  platform: string | undefined
): string {
  return (
    config.sceneSlots?.[position] ??
    `Control+Alt+${platform === 'darwin' ? '' : 'Shift+'}${position}`
  )
}

export const GLOBAL_SHORTCUT_ACTIONS = [
  'screen-hide-toggle',
  'record-toggle',
  'stream-toggle',
  'mic-toggle',
  'system-audio-toggle',
  'clip-mark',
  'clip-mark-long',
  'layout-next',
  'layout-previous',
  ...SCENE_SLOT_ACTIONS
] as const
export type GlobalShortcutAction = (typeof GLOBAL_SHORTCUT_ACTIONS)[number] | `scene:${string}`
export function isGlobalShortcutAction(value: unknown): value is GlobalShortcutAction {
  return (
    typeof value === 'string' &&
    ((GLOBAL_SHORTCUT_ACTIONS as readonly string[]).includes(value) ||
      (value.startsWith('scene:') &&
        value.slice(6).trim().length > 0 &&
        value.slice(6).length <= 128))
  )
}
export function globalShortcutEntries(
  config: GlobalShortcutsConfig,
  platform?: string
): Array<[GlobalShortcutAction, string | undefined]> {
  return [
    ...Object.entries(config.scenes ?? {}).map(([id, key]): [GlobalShortcutAction, string] => [
      `scene:${id}`,
      key
    ]),
    ['screen-hide-toggle', config.screenHideToggle ?? DEFAULT_SCREEN_HIDE_SHORTCUT],
    ['record-toggle', config.recordToggle],
    ['stream-toggle', config.streamToggle],
    ['mic-toggle', config.micToggle],
    ['system-audio-toggle', config.systemAudioToggle],
    ['clip-mark', config.clipMark],
    ['clip-mark-long', config.clipMarkLong],
    ['layout-next', config.layoutNext],
    ['layout-previous', config.layoutPrevious],
    ...SCENE_SLOT_ACTIONS.map((action, index): [GlobalShortcutAction, string] => [
      action,
      sceneSlotAccelerator(config, (index + 1) as SceneSlotPosition, platform)
    ])
  ]
}
/**
 * Deletion releases the OS chord; renaming never changes an id's binding.
 * Here, not in `global-shortcut-bindings.ts`, so the Studio's scene delete
 * keeps that Settings-only module out of the eager chunk.
 */
export function withoutSceneShortcut(
  config: GlobalShortcutsConfig | undefined,
  id: string
): GlobalShortcutsConfig {
  const scenes = { ...config?.scenes }
  delete scenes[id]
  return { ...config, scenes }
}
