import { STORAGE_KEYS } from '@/lib/capture'

/**
 * The page's name everywhere a user reads it (plan 164, D1): the sidebar
 * entry, the ⌘K group, shortcut labels and window copy. Code and RPC names
 * stay `cohost`; saved values keep `orcle` (plan 170 D22), like the
 * remembered tab's storage key.
 */
export const BUDDY_TAB_LABEL = 'Buddy'

/**
 * The Buddy tab's own tabs (plan 150, renamed in plan 164), in strip order,
 * built like Settings' (plan 064). Each answers one question: who is my Buddy
 * and is it on (Buddy, formerly Live: the creation screen), how does it reply
 * and moderate (Chat), what can I say to it (Voice), what happened on my
 * streams (Reports), and edit my recordings (Clean cut). Ids are stable: they
 * are stored as the last-used tab and carried by deep links, so the first tab
 * keeps its `live` id. Labels are copy.
 *
 * The shell imports this module, so it sits in the eager chunk: keep it to
 * ids, labels and the storage helpers (no icons, no components).
 */
export const BUDDY_TABS = [
  { id: 'live', label: BUDDY_TAB_LABEL },
  { id: 'chat', label: 'Chat' },
  { id: 'voice', label: 'Voice' },
  { id: 'reports', label: 'Reports' },
  { id: 'clean-cut', label: 'Clean cut' }
] as const

export type BuddyTabId = (typeof BUDDY_TABS)[number]['id']

export const DEFAULT_BUDDY_TAB: BuddyTabId = 'live'

export function isBuddyTabId(value: unknown): value is BuddyTabId {
  return BUDDY_TABS.some((tab) => tab.id === value)
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
 * The tab Buddy opens on: the last one used on this device, else Live. The
 * choice is a convenience, so storage that is missing, holds an unknown id,
 * or throws falls back instead of breaking the page.
 */
export function readLastBuddyTab(
  storage: Pick<Storage, 'getItem'> | null = pageStorage()
): BuddyTabId {
  try {
    const stored = storage?.getItem(STORAGE_KEYS.buddyTab)
    return isBuddyTabId(stored) ? stored : DEFAULT_BUDDY_TAB
  } catch {
    return DEFAULT_BUDDY_TAB
  }
}

export function writeLastBuddyTab(
  tab: BuddyTabId,
  storage: Pick<Storage, 'setItem'> | null = pageStorage()
): void {
  try {
    storage?.setItem(STORAGE_KEYS.buddyTab, tab)
  } catch {
    // Not remembering the tab is harmless; Buddy opens on Live next time.
  }
}

/**
 * Opens the Buddy page on `tab` from outside React (a toast action, a lib).
 * The shell handles it on the event every page is opened with from outside
 * React. The workspace id of the Buddy page is `ai`.
 */
export function openBuddyTab(tab: BuddyTabId): void {
  window.dispatchEvent(
    new CustomEvent('videorc:navigate-workspace', { detail: { tab: 'ai', buddyTab: tab } })
  )
}
