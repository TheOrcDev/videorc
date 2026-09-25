import { STORAGE_KEYS } from '@/lib/capture'

/**
 * Settings' tabs (plan 064), in strip order. Ids are stable: they are stored
 * as the last-used tab and carried by deep links. Labels are copy.
 *
 * The shell imports this module, so it sits in the eager chunk: keep it to
 * ids, labels and the storage helpers (no icons, no components).
 */
export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'recording', label: 'Recording' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'remote', label: 'Remote' },
  { id: 'orcle', label: 'Orcle' },
  { id: 'about', label: 'About' }
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']

export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'general'

export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return SETTINGS_TABS.some((tab) => tab.id === value)
}

/**
 * The tab Settings opens on: the last one used on this device, else General.
 * The choice is a convenience, so storage that is missing, holds an unknown
 * id, or throws falls back instead of breaking Settings.
 */
export function readLastSettingsTab(
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage
): SettingsTabId {
  try {
    const stored = storage?.getItem(STORAGE_KEYS.settingsTab)
    return isSettingsTabId(stored) ? stored : DEFAULT_SETTINGS_TAB
  } catch {
    return DEFAULT_SETTINGS_TAB
  }
}

export function writeLastSettingsTab(
  tab: SettingsTabId,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage
): void {
  try {
    storage?.setItem(STORAGE_KEYS.settingsTab, tab)
  } catch {
    // Not remembering the tab is harmless; Settings opens on General next time.
  }
}
