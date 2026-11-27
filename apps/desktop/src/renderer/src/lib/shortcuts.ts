// ST4 (Settings rework): the single source of truth for keyboard shortcuts.
// Consumers: the Settings "Shortcuts" reference table, the app menu's mirror
// (shared/app-menu-items), the shortcut recorder's refusals, and any surface
// that renders key hints. Add a binding HERE first — a chord string hardcoded
// elsewhere is a bug. The page keys are the exception: their order and map
// live in shared/sidebar-pages, and the Navigation rows are built from it. Plan 174 S1.2: bindings are Electron
// accelerators, printed per platform by ShortcutKeys.

import {
  PAGE_KEYS,
  pageKeys,
  SIDEBAR_PAGE_LABELS,
  pageKeyAccelerator
} from '../../../shared/sidebar-pages'
import { WINDOW_NAMES } from '../../../shared/window-names'
import { RECORD_SHORTCUT_LABEL } from './go-live-copy'

export interface ShortcutEntry {
  id: string
  /**
   * The keys as Electron accelerators (`CmdOrCtrl+Shift+J`, `Backspace`), shown
   * through ShortcutKeys. Usually one; a pair of keys that share a row (↑ and
   * ↓) lists both.
   */
  accelerators: readonly [string, ...string[]]
  label: string
  group: 'Navigation' | 'Studio' | 'Windows' | 'Stream Manager' | 'Appearance'
}

/** One row per page with a key; a page without one (Sidekick today) has no row. */
const NAV_SHORTCUTS = PAGE_KEYS.map(({ key, page }) => ({
  id: `nav-${page}` as const,
  accelerators: [pageKeyAccelerator(key)] as const,
  label: SIDEBAR_PAGE_LABELS[page],
  group: 'Navigation' as const
}))

const SHORTCUT_LIST = [
  // Navigation: the page keys, in sidebar order, from shared/sidebar-pages
  // (the one home of the order and the key map, owner 2026-11-20).
  ...NAV_SHORTCUTS,
  // ⌘K is "Search" everywhere it is named (plan 174 A-13, docs/ui-copy.md).
  { id: 'search', accelerators: ['CmdOrCtrl+K'], label: 'Search', group: 'Navigation' },
  // The list behind the bell (plan 250, D10), from anywhere in the window.
  {
    id: 'notifications',
    accelerators: ['CmdOrCtrl+Shift+B'],
    label: 'Notifications',
    group: 'Navigation'
  },
  // The reference for every key on this list (plan 174 S3.21, A-12).
  {
    id: 'shortcuts-page',
    accelerators: ['CmdOrCtrl+/'],
    label: 'Settings → Shortcuts',
    group: 'Navigation'
  },

  // Space works on the Studio page only (plan 174 D1): Record, Stop
  // recording, or the End livestream question while on air.
  {
    id: 'record-toggle',
    accelerators: ['Space'],
    label: RECORD_SHORTCUT_LABEL,
    group: 'Studio'
  },
  // The Go Live dialog's primary (plan 174 S3.4, B-14), shown on its button.
  {
    id: 'go-live-confirm',
    accelerators: ['CmdOrCtrl+Enter'],
    label: 'Go live, in the Go Live dialog',
    group: 'Studio'
  },
  {
    id: 'preview-window',
    accelerators: ['CmdOrCtrl+P'],
    label: `Open ${WINDOW_NAMES.preview}`,
    group: 'Windows'
  },
  {
    id: 'notes-window',
    accelerators: ['CmdOrCtrl+Shift+N'],
    label: `Open ${WINDOW_NAMES.notes}`,
    group: 'Windows'
  },
  {
    id: 'comments-window',
    accelerators: ['CmdOrCtrl+Shift+J'],
    label: `Open ${WINDOW_NAMES.streamManager}`,
    group: 'Windows'
  },
  // Plain ⌘J shows the window from the main window (plan 174 S3.21, A-12);
  // inside it, the same key focuses Buddy (`cohost-focus`).
  {
    id: 'comments-window-show',
    accelerators: ['CmdOrCtrl+J'],
    label: `Show ${WINDOW_NAMES.streamManager}`,
    group: 'Windows'
  },
  {
    id: 'captions-window',
    accelerators: ['CmdOrCtrl+Shift+C'],
    label: `Open ${WINDOW_NAMES.captions}`,
    group: 'Windows'
  },

  // Buddy pane (Stream Manager). Inside the window plain (cmd)J focuses the
  // Buddy pane (from the main window it shows the window, above), and the
  // single-key actions apply to the selected row.
  {
    id: 'cohost-focus',
    accelerators: ['CmdOrCtrl+J'],
    label: 'Focus Sidekick',
    group: 'Stream Manager'
  },
  {
    id: 'cohost-move',
    accelerators: ['Up', 'Down'],
    label: 'Move between questions',
    group: 'Stream Manager'
  },
  { id: 'cohost-reply', accelerators: ['R'], label: 'Draft a reply', group: 'Stream Manager' },
  {
    id: 'cohost-highlight',
    accelerators: ['H'],
    label: 'Show the question on stream',
    group: 'Stream Manager'
  },
  { id: 'cohost-answered', accelerators: ['A'], label: 'Mark answered', group: 'Stream Manager' },
  { id: 'cohost-dismiss', accelerators: ['Backspace'], label: 'Dismiss', group: 'Stream Manager' },
  // Plan 174 F-27: the keys the pane's other cards and the Say box answer.
  {
    id: 'cohost-remove-flagged',
    accelerators: ['Shift+Backspace'],
    label: 'Remove the flagged message from chat',
    group: 'Stream Manager'
  },
  {
    id: 'buddy-card-send',
    accelerators: ['Enter'],
    label: "Send Sidekick's proposed post",
    group: 'Stream Manager'
  },
  {
    id: 'buddy-card-dismiss',
    accelerators: ['Escape', 'Backspace'],
    label: "Dismiss Sidekick's proposed post",
    group: 'Stream Manager'
  },
  {
    id: 'buddy-say',
    accelerators: ['Enter'],
    label: 'Say it on stream (the Say box)',
    group: 'Stream Manager'
  },
  {
    id: 'buddy-say-laugh',
    accelerators: ['CmdOrCtrl+Enter'],
    label: 'Say it laughing',
    group: 'Stream Manager'
  },

  // The chat list (plan 174 S3.16a, H-7): one tab stop with roving focus,
  // single-key row actions, and the two window chords the status bar hints.
  {
    id: 'chat-search',
    accelerators: ['CmdOrCtrl+F'],
    label: 'Search chat',
    group: 'Stream Manager'
  },
  {
    id: 'chat-composer',
    accelerators: ['CmdOrCtrl+L'],
    label: 'Write in chat',
    group: 'Stream Manager'
  },
  {
    id: 'chat-move',
    accelerators: ['Up', 'Down'],
    label: 'Move between messages',
    group: 'Stream Manager'
  },
  { id: 'chat-reply', accelerators: ['R'], label: 'Reply to the message', group: 'Stream Manager' },
  { id: 'chat-copy', accelerators: ['C'], label: 'Copy the message', group: 'Stream Manager' },
  {
    id: 'chat-remove',
    accelerators: ['Shift+Backspace'],
    label: 'Remove the message from chat',
    group: 'Stream Manager'
  },

  {
    id: 'theme-toggle',
    accelerators: ['D'],
    label: 'Toggle light / dark theme',
    group: 'Appearance'
  }
] as const satisfies readonly ShortcutEntry[]

export const SHORTCUTS: readonly ShortcutEntry[] = SHORTCUT_LIST

export type ShortcutId = (typeof SHORTCUT_LIST)[number]['id']

/** A registered shortcut's (first) accelerator, for ShortcutKeys and aria-keyshortcuts. */
export function shortcutAccelerator(id: ShortcutId): string {
  // Every id is a member of the list (the type says so), so the find holds.
  return SHORTCUT_LIST.find((entry) => entry.id === id)!.accelerators[0]
}

export function shortcutsFor(guestsShown: boolean): readonly ShortcutEntry[] {
  return [
    ...pageKeys(guestsShown).map(({ key, page }) => ({
      id: `nav-${page}`,
      accelerators: [pageKeyAccelerator(key)] as const,
      label: SIDEBAR_PAGE_LABELS[page],
      group: 'Navigation' as const
    })),
    ...SHORTCUTS.filter((entry) => !entry.id.startsWith('nav-'))
  ]
}

export function shortcutsByGroup(guestsShown = true): Map<ShortcutEntry['group'], ShortcutEntry[]> {
  const groups = new Map<ShortcutEntry['group'], ShortcutEntry[]>()
  for (const entry of shortcutsFor(guestsShown)) {
    const bucket = groups.get(entry.group) ?? []
    bucket.push(entry)
    groups.set(entry.group, bucket)
  }
  return groups
}

/** A workspace page's shortcut, by the "nav-<tab>" convention, or undefined. */
export function navShortcutAccelerator(tab: string, guestsShown = true): string | undefined {
  return shortcutsFor(guestsShown).find((candidate) => candidate.id === `nav-${tab}`)
    ?.accelerators[0]
}
