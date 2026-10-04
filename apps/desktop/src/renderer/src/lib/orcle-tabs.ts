import { STORAGE_KEYS } from '@/lib/capture'

/**
 * The Orcle tab's own tabs (plan 150), in strip order, built like Settings'
 * (plan 064). Each answers one question: is Orcle on (Live), how does it
 * reply and moderate (Chat), what can I say to it (Voice), what happened on
 * my streams (Reports), and edit my recordings (Clean cut). Ids are stable:
 * they are stored as the last-used tab and carried by deep links. Labels are
 * copy.
 *
 * The shell imports this module, so it sits in the eager chunk: keep it to
 * ids, labels and the storage helpers (no icons, no components).
 */
export const ORCLE_TABS = [
  { id: 'live', label: 'Live' },
  { id: 'chat', label: 'Chat' },
  { id: 'voice', label: 'Voice' },
  { id: 'reports', label: 'Reports' },
  { id: 'clean-cut', label: 'Clean cut' }
] as const

export type OrcleTabId = (typeof ORCLE_TABS)[number]['id']

export const DEFAULT_ORCLE_TAB: OrcleTabId = 'live'

export function isOrcleTabId(value: unknown): value is OrcleTabId {
  return ORCLE_TABS.some((tab) => tab.id === value)
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
 * The tab Orcle opens on: the last one used on this device, else Live. The
 * choice is a convenience, so storage that is missing, holds an unknown id,
 * or throws falls back instead of breaking the page.
 */
export function readLastOrcleTab(
  storage: Pick<Storage, 'getItem'> | null = pageStorage()
): OrcleTabId {
  try {
    const stored = storage?.getItem(STORAGE_KEYS.orcleTab)
    return isOrcleTabId(stored) ? stored : DEFAULT_ORCLE_TAB
  } catch {
    return DEFAULT_ORCLE_TAB
  }
}

export function writeLastOrcleTab(
  tab: OrcleTabId,
  storage: Pick<Storage, 'setItem'> | null = pageStorage()
): void {
  try {
    storage?.setItem(STORAGE_KEYS.orcleTab, tab)
  } catch {
    // Not remembering the tab is harmless; Orcle opens on Live next time.
  }
}

/**
 * Opens the Orcle page on `tab` from outside React (a toast action, a lib).
 * The shell handles it on the event every page is opened with from outside
 * React. The workspace id of the Orcle page is `ai`.
 */
export function openOrcleTab(tab: OrcleTabId): void {
  window.dispatchEvent(
    new CustomEvent('videorc:navigate-workspace', { detail: { tab: 'ai', orcleTab: tab } })
  )
}
