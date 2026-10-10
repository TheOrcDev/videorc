// The application menu (plan 174 S0.6, A-8). Without one, Electron installs
// its default menu: Reload, Force Reload and Toggle Developer Tools in the
// shipped app (⌘R reloads Videorc mid-recording), and on Windows a generic
// File, Edit, View bar under the native title bar.
//
// macOS gets a real menu bar. Its Edit menu is built from roles and is
// load-bearing: AppKit delivers ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z to a text field
// through the menu's key equivalents, so without it copy and paste stop
// working in every field. Windows and Linux get no menu bar once packaged:
// Chromium handles the editing keys itself there, and every app shortcut
// already lives in the renderer and main's before-input-event.
//
// The page and window items repeat chords the app already handles (⌘1–⌘9,
// ⌘,, ⌘P, ⇧⌘N, ⇧⌘J, ⇧⌘C); every other accelerator is a standard macOS one.
// The page and main's before-input-event see a chord before the menu does and
// preventDefault the ones they handle, so nothing fires twice: the menu acts
// on a click, and on a chord pressed where nothing else listens (the Preview
// and Captions windows).

import { Menu, type MenuItemConstructorOptions } from 'electron'

import {
  APP_MENU_PAGE_GROUPS,
  APP_MENU_WINDOWS,
  type AppMenuPageKey,
  type AppMenuWindowId
} from '../shared/app-menu-items'

export interface AppMenuActions {
  /** Brings the main window up on a page: the key ⌘1–⌘9 or ⌘, forwards. */
  showPage: (key: AppMenuPageKey) => void
  /** Opens the window, or closes it when it is open: what its shortcut does. */
  toggleWindow: (id: AppMenuWindowId) => void
  openReleaseNotes: () => void
}

export interface AppMenuOptions {
  platform: NodeJS.Platform
  /** `app.isPackaged`. Reload and the developer tools exist only in development. */
  isPackaged: boolean
  /** A window a developer kill switch turned off (VIDEORC_*_WINDOW=0) leaves the menu. */
  windowsEnabled: Readonly<Record<AppMenuWindowId, boolean>>
  actions: AppMenuActions
}

const separator = (): MenuItemConstructorOptions => ({ type: 'separator' })

function developmentItems(isPackaged: boolean): MenuItemConstructorOptions[] {
  return isPackaged
    ? []
    : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, separator()]
}

/**
 * The menu for this platform and build, or null for no menu at all. Pure, so
 * the shipped shape is tested: never Reload or the developer tools once
 * packaged, and always the Edit roles on macOS.
 */
export function appMenuTemplate(options: AppMenuOptions): MenuItemConstructorOptions[] | null {
  const { actions } = options
  const development = developmentItems(options.isPackaged)

  if (options.platform !== 'darwin') {
    // No menu bar once packaged; a developer keeps reload and the tools.
    return options.isPackaged
      ? null
      : [{ label: 'View', submenu: [...development, { role: 'togglefullscreen' }] }]
  }

  const pages = APP_MENU_PAGE_GROUPS.flatMap((group, index) => [
    ...(index > 0 ? [separator()] : []),
    ...group.map(
      (page): MenuItemConstructorOptions => ({
        label: page.label,
        accelerator: `CmdOrCtrl+${page.key}`,
        click: () => actions.showPage(page.key)
      })
    )
  ])
  const windows = APP_MENU_WINDOWS.filter((window) => options.windowsEnabled[window.id]).map(
    (window): MenuItemConstructorOptions => ({
      label: window.label,
      accelerator: window.accelerator,
      click: () => actions.toggleWindow(window.id)
    })
  )

  return [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        separator(),
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => actions.showPage(',') },
        separator(),
        { role: 'services' },
        separator(),
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        separator(),
        { role: 'quit' }
      ]
    },
    {
      role: 'editMenu',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        separator(),
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        separator(),
        { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
      ]
    },
    {
      label: 'View',
      submenu: [...pages, separator(), ...development, { role: 'togglefullscreen' }]
    },
    {
      role: 'windowMenu',
      submenu: [
        ...windows,
        separator(),
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        separator(),
        { role: 'front' }
      ]
    },
    {
      role: 'help',
      submenu: [{ label: 'Release Notes', click: () => actions.openReleaseNotes() }]
    }
  ]
}

/** Replaces Electron's default menu: this platform's menu, or none. */
export function installAppMenu(options: AppMenuOptions): void {
  const template = appMenuTemplate(options)
  Menu.setApplicationMenu(template ? Menu.buildFromTemplate(template) : null)
}
