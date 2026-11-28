import { pageKeys } from '../../../shared/sidebar-pages'
// The main window's global chords (plan 174 S3.21, A-2, A-12), decided here
// so a test can press every key against an open dialog. The shell runs the
// action; main forwards ⌘1–⌘9, ⇧⌘L and ⌘, separately (Chromium swallows the
// digits; one route for every page key) and
// `navigationShortcutTab` gates those the same way.

import { type WorkspaceTab } from '@/components/workspace-nav'
import { isCommandKey } from '@/lib/platform'

export type ShellShortcutAction =
  | 'toggle-search'
  | 'close-search'
  | 'toggle-preview'
  | 'toggle-notes'
  | 'show-stream-manager'
  | 'toggle-stream-manager'
  | 'toggle-captions'
  | 'toggle-notifications'
  | 'open-shortcuts'

export interface ShellShortcutContext {
  platform: string | undefined
  /** `isModalOpen()` at the time of the press. */
  modalOpen: boolean
  searchOpen: boolean
  /** The list behind the bell is open (plan 250): its key closes it. */
  notificationsOpen?: boolean
  notesWindowEnabled: boolean
  commentsWindowEnabled: boolean
}

type ShellKey = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/**
 * What a keydown in the main window does, or null when it is not one of the
 * shell's chords. Under a dialog or a menu nothing runs except ⌘K closing
 * Search and ⇧⌘B closing Notifications (each is the open surface's own key),
 * so a chord never acts from under a question.
 */
export function shellShortcutAction(
  event: ShellKey,
  context: ShellShortcutContext
): ShellShortcutAction | null {
  if (!isCommandKey(event, context.platform) || event.altKey) return null
  const key = event.key.toLowerCase()
  if (context.modalOpen) {
    if (key === 'b' && event.shiftKey && context.notificationsOpen) return 'toggle-notifications'
    return key === 'k' && !event.shiftKey && context.searchOpen ? 'close-search' : null
  }
  if (event.shiftKey) {
    if (key === 'b') return 'toggle-notifications'
    if (key === 'n') return context.notesWindowEnabled ? 'toggle-notes' : null
    if (key === 'j') return context.commentsWindowEnabled ? 'toggle-stream-manager' : null
    if (key === 'c') return 'toggle-captions'
    return null
  }
  if (key === 'k') return 'toggle-search'
  if (key === 'p') return 'toggle-preview'
  // ⌘J shows Stream Manager (A-12); inside that window the same key focuses
  // Buddy, and ⇧⌘J toggles the window from either side.
  if (key === 'j') return context.commentsWindowEnabled ? 'show-stream-manager' : null
  if (key === '/') return 'open-shortcuts'
  return null
}

/**
 * The page a key main forwarded on `shortcut:navigate` opens ('1'–'9', 'L'
 * or ','), or null: an unknown key, or a dialog that owns the keyboard.
 */
export function navigationShortcutTab(
  key: string,
  modalOpen: boolean,
  guestsShown = true
): WorkspaceTab | null {
  if (modalOpen) return null
  return pageKeys(guestsShown).find((entry) => entry.key === key)?.page ?? null
}
