import { STORAGE_KEYS } from '@/lib/capture'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

/**
 * Settings' tabs (plan 064), in strip order. Ids are stable: they are stored
 * as the last-used tab and carried by deep links. Labels are copy.
 *
 * The shell imports this module, so it sits in the eager chunk: keep it to
 * ids, labels and the storage helpers (no icons, no components).
 *
 * Buddy's settings moved to the Buddy tab (plan 119), so every setting keeps
 * one home. Older apps saved `orcle` here (its old tab id, kept by plan 170
 * D22): it is no longer a tab id and reads as General.
 */
export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'remote', label: 'Remote' },
  { id: 'about', label: 'About' }
] as const

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id']

export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'general'

export function isSettingsTabId(value: unknown): value is SettingsTabId {
  return SETTINGS_TABS.some((tab) => tab.id === value)
}

/**
 * Tab ids older apps remembered or linked to, and the tab that replaced each.
 * Settings → Recording is gone (plan 174 S3.6, D5): the recordings folder and
 * Keep original recording live on the Output page, Keep microphone ready in
 * Sources → Microphone, and the FFmpeg line in Health.
 */
const RETIRED_SETTINGS_TABS: Readonly<Record<string, SettingsTabId>> = {
  recording: 'general'
}

/**
 * A stored or linked tab id as today's tab: a current id as is, a retired one
 * as the tab that replaced it, anything else as null.
 */
export function migrateSettingsTabId(value: unknown): SettingsTabId | null {
  if (isSettingsTabId(value)) return value
  if (typeof value === 'string' && Object.hasOwn(RETIRED_SETTINGS_TABS, value)) {
    return RETIRED_SETTINGS_TABS[value] ?? null
  }
  return null
}

/** The page's localStorage, or null where reading the property itself throws. */
function pageStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * The tab Settings opens on: the last one used on this device (a retired tab
 * as its replacement), else General. The choice is a convenience, so storage
 * that is missing, holds an unknown id, or throws falls back instead of
 * breaking Settings.
 */
export function readLastSettingsTab(
  storage: Pick<Storage, 'getItem'> | null = pageStorage()
): SettingsTabId {
  try {
    return migrateSettingsTabId(storage?.getItem(STORAGE_KEYS.settingsTab)) ?? DEFAULT_SETTINGS_TAB
  } catch {
    return DEFAULT_SETTINGS_TAB
  }
}

/**
 * Opens Settings on `tab` from outside React (a toast action, a lib), through
 * the typed workspace navigation every page is opened with from outside React.
 */
export function openSettingsTab(tab: SettingsTabId): void {
  openWorkspaceTab('settings', tab)
}

export function writeLastSettingsTab(
  tab: SettingsTabId,
  storage: Pick<Storage, 'setItem'> | null = pageStorage()
): void {
  try {
    storage?.setItem(STORAGE_KEYS.settingsTab, tab)
  } catch {
    // Not remembering the tab is harmless; Settings opens on General next time.
  }
}
