// ST4 (Settings rework): the single source of truth for keyboard shortcuts.
// Consumers: the workspace nav digit map (consistency-tested), the Settings
// "Shortcuts" reference table, the app menu's mirror (shared/app-menu-items),
// and any surface that renders key hints. Add a binding HERE first — a chord
// string hardcoded elsewhere is a bug. Plan 174 S1.2: bindings are Electron
// accelerators, printed per platform by ShortcutKeys.

import { parseAccelerator } from '../../../shared/accelerator-format'

export interface ShortcutEntry {
  id: string
  /**
   * The keys as Electron accelerators (`CmdOrCtrl+Shift+J`, `Backspace`), shown
   * through ShortcutKeys. Usually one; a pair of keys that share a row (↑ and
   * ↓) lists both.
   */
  accelerators: readonly [string, ...string[]]
  label: string
  group: 'Navigation' | 'Session' | 'Windows' | 'Chat' | 'Appearance'
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
  {
    id: 'search',
    accelerators: ['CmdOrCtrl+K'],
    label: 'Search & commands',
    group: 'Navigation'
  },

  {
    id: 'record-toggle',
    accelerators: ['Space'],
    label: 'Start / stop the session',
    group: 'Session'
  },
  {
    id: 'preview-window',
    accelerators: ['CmdOrCtrl+P'],
    label: 'Open preview window',
    group: 'Windows'
  },
  {
    id: 'notes-window',
    accelerators: ['CmdOrCtrl+Shift+N'],
    label: 'Open notes window',
    group: 'Windows'
  },
  {
    id: 'comments-window',
    accelerators: ['CmdOrCtrl+Shift+J'],
    label: 'Open Stream Manager',
    group: 'Windows'
  },
  {
    id: 'captions-window',
    accelerators: ['CmdOrCtrl+Shift+C'],
    label: 'Open captions reader',
    group: 'Windows'
  },

  // Co-host pane (Comments window). Plain (cmd)J toggles the Comments window
  // from the main window; inside the window it focuses the co-host pane, and
  // the single-key actions apply to the selected row.
  { id: 'cohost-focus', accelerators: ['CmdOrCtrl+J'], label: 'Focus Buddy', group: 'Chat' },
  {
    id: 'cohost-move',
    accelerators: ['Up', 'Down'],
    label: 'Move between questions',
    group: 'Chat'
  },
  { id: 'cohost-reply', accelerators: ['R'], label: 'Draft a reply', group: 'Chat' },
  {
    id: 'cohost-highlight',
    accelerators: ['H'],
    label: 'Show the question on stream',
    group: 'Chat'
  },
  { id: 'cohost-answered', accelerators: ['A'], label: 'Mark answered', group: 'Chat' },
  { id: 'cohost-dismiss', accelerators: ['Backspace'], label: 'Dismiss', group: 'Chat' },

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
