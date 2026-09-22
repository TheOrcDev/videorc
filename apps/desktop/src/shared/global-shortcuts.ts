import { LAYOUT_PRESET_VALUES, type GlobalShortcutsConfig, type LayoutPreset } from './backend'

export const GLOBAL_SHORTCUT_ACTIONS = [
  'record-toggle',
  'stream-toggle',
  'mic-toggle',
  'layout-next',
  'layout-previous',
  ...LAYOUT_PRESET_VALUES.map((id) => `layout:${id}` as const)
] as const
export type GlobalShortcutAction = (typeof GLOBAL_SHORTCUT_ACTIONS)[number]
export function isGlobalShortcutAction(value: unknown): value is GlobalShortcutAction {
  return typeof value === 'string' && (GLOBAL_SHORTCUT_ACTIONS as readonly string[]).includes(value)
}
export function globalShortcutEntries(
  config: GlobalShortcutsConfig
): Array<[GlobalShortcutAction, string | undefined]> {
  return [
    ['record-toggle', config.recordToggle],
    ['stream-toggle', config.streamToggle],
    ['mic-toggle', config.micToggle],
    ['layout-next', config.layoutNext],
    ['layout-previous', config.layoutPrevious],
    ...LAYOUT_PRESET_VALUES.map((id): [GlobalShortcutAction, string | undefined] => [
      `layout:${id}`,
      config.layouts?.[id]
    ])
  ]
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
