import type { GlobalShortcutsConfig } from './backend'
import { globalShortcutLayout, type GlobalShortcutAction } from './global-shortcuts'

// The Settings side of global shortcuts: which config key each action writes.
// Kept out of shared/global-shortcuts, which the eager Studio chunk imports,
// so only Settings and the IPC contract carry it.

const ACTION_CONFIG_KEYS = {
  'record-toggle': 'recordToggle',
  'stream-toggle': 'streamToggle',
  'mic-toggle': 'micToggle',
  'system-audio-toggle': 'systemAudioToggle',
  'clip-mark': 'clipMark',
  'layout-next': 'layoutNext',
  'layout-previous': 'layoutPrevious'
} as const satisfies Record<
  Exclude<GlobalShortcutAction, `layout:${string}`>,
  Exclude<keyof GlobalShortcutsConfig, 'layouts'>
>

/** A single-action key a GlobalShortcutsConfig may carry (besides
 * `layouts`): the IPC schema admits exactly these. */
export function isGlobalShortcutConfigKey(key: string): boolean {
  return (Object.values(ACTION_CONFIG_KEYS) as string[]).includes(key)
}

/** The config with one action's binding replaced ('' releases it). */
export function withGlobalShortcut(
  config: GlobalShortcutsConfig | undefined,
  action: GlobalShortcutAction,
  accelerator: string
): GlobalShortcutsConfig {
  const layout = globalShortcutLayout(action)
  if (layout) {
    return { ...config, layouts: { ...config?.layouts, [layout]: accelerator } }
  }
  return {
    ...config,
    [ACTION_CONFIG_KEYS[action as keyof typeof ACTION_CONFIG_KEYS]]: accelerator
  }
}
