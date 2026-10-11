// ST4 (Settings rework): the single source of truth for keyboard shortcuts.
// Consumers: the workspace nav digit map (consistency-tested), the Settings
// "Shortcuts" reference table, the app menu's mirror (shared/app-menu-items),
// and any surface that renders key hints. Add a binding HERE first — a chord
// string hardcoded elsewhere is a bug. Plan 174 S1.2: bindings are Electron
// accelerators, printed per platform by ShortcutKeys.

import { parseAccelerator } from '../../../shared/accelerator-format'
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

const SHORTCUT_LIST = [
  // Navigation — mirrors WORKSPACE_SHORTCUTS (vitest enforces consistency).
  { id: 'nav-studio', accelerators: ['CmdOrCtrl+1'], label: 'Studio', group: 'Navigation' },
  { id: 'nav-sources', accelerators: ['CmdOrCtrl+2'], label: 'Sources', group: 'Navigation' },
  { id: 'nav-layouts', accelerators: ['CmdOrCtrl+3'], label: 'Scene', group: 'Navigation' },
  { id: 'nav-assets', accelerators: ['CmdOrCtrl+4'], label: 'Assets', group: 'Navigation' },
  { id: 'nav-live', accelerators: ['CmdOrCtrl+5'], label: 'Livestream', group: 'Navigation' },
  { id: 'nav-captions', accelerators: ['CmdOrCtrl+6'], label: 'Captions', group: 'Navigation' },
  { id: 'nav-recording', accelerators: ['CmdOrCtrl+7'], label: 'Output', group: 'Navigation' },
  { id: 'nav-library', accelerators: ['CmdOrCtrl+8'], label: 'Library', group: 'Navigation' },
  { id: 'nav-ai', accelerators: ['CmdOrCtrl+9'], label: 'Buddy', group: 'Navigation' },
  { id: 'nav-settings', accelerators: ['CmdOrCtrl+,'], label: 'Settings', group: 'Navigation' },
  // ⌘K is "Search" everywhere it is named (plan 174 A-13, docs/ui-copy.md).
  { id: 'search', accelerators: ['CmdOrCtrl+K'], label: 'Search', group: 'Navigation' },
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
    label: 'Focus Buddy',
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
    label: "Send Buddy's proposed post",
    group: 'Stream Manager'
  },
  {
    id: 'buddy-card-dismiss',
    accelerators: ['Escape', 'Backspace'],
    label: "Dismiss Buddy's proposed post",
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

export function shortcutsByGroup(): Map<ShortcutEntry['group'], ShortcutEntry[]> {
  const groups = new Map<ShortcutEntry['group'], ShortcutEntry[]>()
  for (const entry of SHORTCUTS) {
    const bucket = groups.get(entry.group) ?? []
    bucket.push(entry)
    groups.set(entry.group, bucket)
  }
  return groups
}

/** Navigation key for a workspace tab id ("nav-<tab>" convention). */
export function navShortcutDigit(tab: string): string | undefined {
  const entry = SHORTCUTS.find((candidate) => candidate.id === `nav-${tab}`)
  const digit = entry ? parseAccelerator(entry.accelerators[0], 'darwin')?.key : undefined
  return digit && (/^[1-9]$/.test(digit) || digit === ',') ? digit : undefined
}
