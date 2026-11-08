import { LAYOUT_PRESET_VALUES, type GlobalShortcutsConfig, type LayoutPreset } from './backend'

export const DEFAULT_SCREEN_HIDE_SHORTCUT = 'Control+Alt+H'

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
  ...LAYOUT_PRESET_VALUES.map((id) => `layout:${id}` as const)
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
  config: GlobalShortcutsConfig
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
    ...LAYOUT_PRESET_VALUES.map((id): [GlobalShortcutAction, string | undefined] => [
      `layout:${id}`,
      config.layouts?.[id]
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
export function globalShortcutLayout(action: GlobalShortcutAction): LayoutPreset | null {
  return action.startsWith('layout:') ? (action.slice(7) as LayoutPreset) : null
}

/** Walk canonical order, including when the current layout has become unavailable. */
export function nextEligibleLayout(
  current: LayoutPreset,
  direction: 1 | -1,
  eligible: readonly LayoutPreset[]
): LayoutPreset | null {
  const catalog = LAYOUT_PRESET_VALUES.filter(
    (id) => id.startsWith('vertical-') === current.startsWith('vertical-')
  )
  const index = catalog.indexOf(current as never)
  for (let step = 1; step < catalog.length; step++) {
    const candidate = catalog[(index + direction * step + catalog.length) % catalog.length]
    if (eligible.includes(candidate)) return candidate
  }
  return null
}
