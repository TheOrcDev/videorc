// ST4 (Settings rework): the single source of truth for keyboard shortcuts.
// Consumers: the workspace nav digit map (consistency-tested), the Settings
// "Shortcuts" reference table, and any surface that renders key hints. Add a
// binding HERE first — a chord string hardcoded elsewhere is a bug.

export interface ShortcutEntry {
  id: string
  /** Keys as displayed, in press order (⌘ modifiers split out for Kbd chips). */
  keys: string[]
  label: string
  group: 'Navigation' | 'Session' | 'Windows' | 'Appearance'
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  // Navigation — mirrors WORKSPACE_SHORTCUTS (vitest enforces consistency).
  { id: 'nav-studio', keys: ['⌘', '1'], label: 'Studio', group: 'Navigation' },
  { id: 'nav-sources', keys: ['⌘', '2'], label: 'Sources', group: 'Navigation' },
  { id: 'nav-layouts', keys: ['⌘', '3'], label: 'Scene', group: 'Navigation' },
  { id: 'nav-assets', keys: ['⌘', '4'], label: 'Assets', group: 'Navigation' },
  { id: 'nav-live', keys: ['⌘', '5'], label: 'Livestream', group: 'Navigation' },
  { id: 'nav-recording', keys: ['⌘', '6'], label: 'Output', group: 'Navigation' },
  { id: 'nav-library', keys: ['⌘', '7'], label: 'Library', group: 'Navigation' },
  { id: 'nav-ai', keys: ['⌘', '8'], label: 'Publish', group: 'Navigation' },
  { id: 'nav-settings', keys: ['⌘', '9'], label: 'Settings', group: 'Navigation' },
  { id: 'search', keys: ['⌘', 'K'], label: 'Search & commands', group: 'Navigation' },

  { id: 'record-toggle', keys: ['␣'], label: 'Start / stop the session', group: 'Session' },

  { id: 'preview-window', keys: ['⌘', 'P'], label: 'Open preview window', group: 'Windows' },
  { id: 'notes-window', keys: ['⌘', '⇧', 'N'], label: 'Open notes window', group: 'Windows' },
  { id: 'comments-window', keys: ['⌘', '⇧', 'J'], label: 'Open comments window', group: 'Windows' },

  { id: 'theme-toggle', keys: ['D'], label: 'Toggle light / dark theme', group: 'Appearance' }
] as const

export function shortcutsByGroup(): Map<ShortcutEntry['group'], ShortcutEntry[]> {
  const groups = new Map<ShortcutEntry['group'], ShortcutEntry[]>()
  for (const entry of SHORTCUTS) {
    const bucket = groups.get(entry.group) ?? []
    bucket.push(entry)
    groups.set(entry.group, bucket)
  }
  return groups
}

/** Navigation digit for a workspace tab id ("nav-<tab>" convention). */
export function navShortcutDigit(tab: string): string | undefined {
  const entry = SHORTCUTS.find((candidate) => candidate.id === `nav-${tab}`)
  const digit = entry?.keys.at(-1)
  return digit && /^[1-9]$/.test(digit) ? digit : undefined
}
