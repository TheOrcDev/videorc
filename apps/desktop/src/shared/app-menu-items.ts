// What the macOS application menu lists (plan 174 S0.6, A-8), as plain data
// the main process can read. The pages and their keys come from
// shared/sidebar-pages, the one home of the sidebar's order and key map; the
// windows mirror SHORTCUTS, and workspace-nav-menu.test.ts holds them equal.

import { SIDEBAR_LAYOUT, SIDEBAR_PAGE_LABELS, pageKeyFor, type PageKey } from './sidebar-pages'
import { WINDOW_NAMES } from './window-names'

export interface AppMenuPage {
  key: Exclude<PageKey, ','>
  label: string
}

/**
 * The View menu's pages in sidebar order, one group per sidebar block, built
 * from shared/sidebar-pages: every page with a key except Settings, which is
 * the app menu's Settings… item. A hidden page or a page without a key is
 * left out.
 */
export function appMenuPageGroups(guestsShown: boolean): readonly (readonly AppMenuPage[])[] {
  return SIDEBAR_LAYOUT.map((zone) =>
    zone.pages.flatMap((page): AppMenuPage[] => {
      const key = pageKeyFor(page, guestsShown)
      return key && key !== ',' ? [{ key, label: SIDEBAR_PAGE_LABELS[page] }] : []
    })
  ).filter((group) => group.length > 0)
}

/** Full inventory for parity tests. Runtime menus use appMenuPageGroups. */
export const APP_MENU_PAGE_GROUPS = appMenuPageGroups(true)

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
