// What the macOS application menu lists (plan 174 S0.6, A-8), as plain data
// the main process can read. Main cannot import the renderer's workspace-nav
// or SHORTCUTS, so this mirrors them; workspace-nav-menu.test.ts holds them
// equal.

import { WINDOW_NAMES } from './window-names'

/** A key main forwards on `shortcut:navigate`: ⌘1–⌘9 open a page, ⌘, Settings. */
export type AppMenuPageKey = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | ','

export interface AppMenuPage {
  key: Exclude<AppMenuPageKey, ','>
  label: string
}

/**
 * The View menu's pages in sidebar order, one group per sidebar zone: Studio,
 * Setup, Livestream, then Library. The digits run down the sidebar (plan 235
 * D8).
 */
export const APP_MENU_PAGE_GROUPS: readonly (readonly AppMenuPage[])[] = [
  [{ key: '1', label: 'Studio' }],
  [
    { key: '2', label: 'Sources' },
    { key: '3', label: 'Scene' },
    { key: '4', label: 'Assets' },
    { key: '5', label: 'Captions' },
    { key: '6', label: 'Output' }
  ],
  [
    { key: '7', label: 'Destinations' },
    { key: '8', label: 'Sidekick' }
  ],
  [{ key: '9', label: 'Library' }]
]

export type AppMenuWindowId = 'preview' | 'notes' | 'stream-manager' | 'captions'

export interface AppMenuWindow {
  id: AppMenuWindowId
  label: string
  /** The chord the window's own shortcut already uses. */
  accelerator: string
}

/** The Window menu's windows. Each item opens its window, or closes it, like its shortcut. */
export const APP_MENU_WINDOWS: readonly AppMenuWindow[] = [
  { id: 'preview', label: WINDOW_NAMES.preview, accelerator: 'CmdOrCtrl+P' },
  { id: 'notes', label: WINDOW_NAMES.notes, accelerator: 'CmdOrCtrl+Shift+N' },
  { id: 'stream-manager', label: WINDOW_NAMES.streamManager, accelerator: 'CmdOrCtrl+Shift+J' },
  { id: 'captions', label: WINDOW_NAMES.captions, accelerator: 'CmdOrCtrl+Shift+C' }
]

/** Help → Release Notes: this version's page, as the packaged renderer's `releaseNotesUrl` builds it. */
export function appMenuReleaseNotesUrl(version: string): string {
  return `https://www.videorc.com/releases/${version}`
}
