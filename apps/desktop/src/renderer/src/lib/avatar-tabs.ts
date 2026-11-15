import { STORAGE_KEYS } from '@/lib/capture'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

/**
 * The Avatar page's name everywhere a user reads it (plan 239, D1): the
 * sidebar row, the ⌘K group, shortcut labels and the window title. The
 * avatar is the character on the stream; Sidekick, the helper, keeps the
 * `ai` page. The code, wire and saved names of the character stay
 * `buddy`/`cohost` (plan 236 D1).
 */
export const AVATAR_TAB_LABEL = 'Avatar'

/**
 * The Avatar page's own tabs (plan 239), in strip order. Profile is who the
 * avatar is and how it looks: My avatars, name and personality, the look,
 * reactions and motion. Greetings is what it says when someone arrives.
 * Ids are stable: they are stored as the last-used tab.
 *
 * The shell imports this module, so it sits in the eager chunk: keep it to
 * ids, labels and the storage helpers (no icons, no components).
 */
export const AVATAR_TABS = [
  { id: 'profile', label: 'Profile' },
  { id: 'greetings', label: 'Greetings' }
] as const

export type AvatarTabId = (typeof AVATAR_TABS)[number]['id']

export const DEFAULT_AVATAR_TAB: AvatarTabId = 'profile'

export function isAvatarTabId(value: unknown): value is AvatarTabId {
  return AVATAR_TABS.some((tab) => tab.id === value)
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
 * The tab Avatar opens on: the last one used on this device, else Profile.
 * Storage that is missing, holds an unknown id, or throws falls back.
 */
export function readLastAvatarTab(
  storage: Pick<Storage, 'getItem'> | null = pageStorage()
): AvatarTabId {
  try {
    const stored = storage?.getItem(STORAGE_KEYS.avatarTab)
    return isAvatarTabId(stored) ? stored : DEFAULT_AVATAR_TAB
  } catch {
    return DEFAULT_AVATAR_TAB
  }
}

export function writeLastAvatarTab(
  tab: AvatarTabId,
  storage: Pick<Storage, 'setItem'> | null = pageStorage()
): void {
  try {
    storage?.setItem(STORAGE_KEYS.avatarTab, tab)
  } catch {
    // Not remembering the tab is harmless; Avatar opens on Profile next time.
  }
}

/** Opens the Avatar page on `tab` from outside React (a toast action, a lib). */
export function openAvatarTab(tab: AvatarTabId): void {
  openWorkspaceTab('avatar', tab)
}
