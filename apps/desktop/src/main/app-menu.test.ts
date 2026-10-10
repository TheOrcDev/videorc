import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  setApplicationMenu: vi.fn()
}))
vi.mock('electron', () => ({ Menu: electron }))

import type { MenuItemConstructorOptions } from 'electron'

import { appMenuTemplate, installAppMenu, type AppMenuOptions } from './app-menu'

// Plan 174 S0.6 (A-8): the menu Videorc ships instead of Electron's default.

const actions = {
  showPage: vi.fn(),
  toggleWindow: vi.fn(),
  openReleaseNotes: vi.fn()
}

function options(overrides: Partial<AppMenuOptions> = {}): AppMenuOptions {
  return {
    platform: 'darwin',
    isPackaged: true,
    windowsEnabled: { preview: true, notes: true, 'stream-manager': true, captions: true },
    actions,
    ...overrides
  }
}

function submenu(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  return Array.isArray(item?.submenu) ? item.submenu : []
}

/** Every item at every depth. */
function everyItem(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [item, ...everyItem(submenu(item))])
}

function topLevel(template: MenuItemConstructorOptions[], name: string) {
  return template.find((item) => item.role === name || item.label === name)
}

const click = (item: MenuItemConstructorOptions | undefined): void =>
  (item?.click as (() => void) | undefined)?.()

// The accelerators Electron gives the macOS roles this menu uses.
const ROLE_ACCELERATORS: Record<string, string> = {
  hide: 'Command+H',
  hideOthers: 'Command+Alt+H',
  quit: 'CommandOrControl+Q',
  undo: 'CommandOrControl+Z',
  redo: 'Shift+CommandOrControl+Z',
  cut: 'CommandOrControl+X',
  copy: 'CommandOrControl+C',
  paste: 'CommandOrControl+V',
  pasteAndMatchStyle: 'Cmd+Option+Shift+V',
  selectAll: 'CommandOrControl+A',
  reload: 'CmdOrCtrl+R',
  forceReload: 'Shift+CmdOrCtrl+R',
  toggleDevTools: 'Alt+Command+I',
  togglefullscreen: 'Control+Command+F',
  minimize: 'CommandOrControl+M',
  close: 'CommandOrControl+W'
}

/** One spelling per chord, so `Command+H` and `CmdOrCtrl+H` compare equal. */
function chord(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => {
      const lower = part.toLowerCase()
      if (['command', 'cmd', 'commandorcontrol', 'cmdorctrl'].includes(lower)) return 'Cmd'
      if (['option', 'alt'].includes(lower)) return 'Alt'
      if (['control', 'ctrl'].includes(lower)) return 'Ctrl'
      return part.length === 1 ? part.toUpperCase() : part
    })
    .sort()
    .join('+')
}

function accelerators(template: MenuItemConstructorOptions[]): string[] {
  return everyItem(template)
    .map((item) =>
      item.accelerator ? String(item.accelerator) : ROLE_ACCELERATORS[String(item.role)]
    )
    .filter((accelerator): accelerator is string => Boolean(accelerator))
    .map(chord)
}

beforeEach(() => vi.clearAllMocks())

describe('appMenuTemplate on macOS', () => {
  it('builds the Edit menu from roles, so ⌘C, ⌘V, ⌘A and ⌘Z reach every text field', () => {
    const edit = topLevel(appMenuTemplate(options())!, 'editMenu')
    expect(submenu(edit).map((item) => item.role ?? item.type ?? item.label)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll',
      'separator',
      'Speech'
    ])
  })

  it('ships no Reload and no developer tools in a packaged build', () => {
    const roles = everyItem(appMenuTemplate(options({ isPackaged: true }))!).map(
      (item) => item.role
    )
    for (const role of ['reload', 'forceReload', 'toggleDevTools']) {
      expect(roles).not.toContain(role)
    }
  })

  it('keeps Reload and the developer tools for development', () => {
    const view = topLevel(appMenuTemplate(options({ isPackaged: false }))!, 'View')
    const roles = submenu(view).map((item) => item.role)
    expect(roles).toEqual(expect.arrayContaining(['reload', 'forceReload', 'toggleDevTools']))
  })

  it('opens Settings… on ⌘, from the app menu, beside About, Hide and Quit', () => {
    const appMenu = submenu(topLevel(appMenuTemplate(options())!, 'appMenu'))
    expect(appMenu.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'about',
      'separator',
      'Settings…',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit'
    ])
    const settings = appMenu.find((item) => item.label === 'Settings…')
    expect(settings?.accelerator).toBe('CmdOrCtrl+,')
    click(settings)
    expect(actions.showPage).toHaveBeenCalledWith(',')
  })

  it('lists the pages in sidebar order on their ⌘ digits, Buddy right under Studio', () => {
    const view = submenu(topLevel(appMenuTemplate(options())!, 'View'))
    const pages = view.filter((item) => /^CmdOrCtrl\+\d$/.test(String(item.accelerator ?? '')))
    expect(pages.map((item) => `${item.label} ${item.accelerator}`)).toEqual([
      'Studio CmdOrCtrl+1',
      'Buddy CmdOrCtrl+9',
      'Sources CmdOrCtrl+2',
      'Scene CmdOrCtrl+3',
      'Assets CmdOrCtrl+4',
      'Livestream CmdOrCtrl+5',
      'Captions CmdOrCtrl+6',
      'Output CmdOrCtrl+7',
      'Library CmdOrCtrl+8'
    ])
    click(pages.find((item) => item.label === 'Livestream'))
    expect(actions.showPage).toHaveBeenCalledWith('5')
    expect(view.at(-1)?.role).toBe('togglefullscreen')
  })

  it('toggles each window on its shortcut and leaves out a window that is switched off', () => {
    const windowMenu = submenu(topLevel(appMenuTemplate(options())!, 'windowMenu'))
    const windows = windowMenu.filter((item) => item.label)
    expect(windows.map((item) => `${item.label} ${item.accelerator}`)).toEqual([
      'Preview CmdOrCtrl+P',
      'Notes CmdOrCtrl+Shift+N',
      'Stream Manager CmdOrCtrl+Shift+J',
      'Captions reader CmdOrCtrl+Shift+C'
    ])
    click(windows[0])
    expect(actions.toggleWindow).toHaveBeenCalledWith('preview')
    click(windows[2])
    expect(actions.toggleWindow).toHaveBeenCalledWith('stream-manager')
    expect(windowMenu.map((item) => item.role).filter(Boolean)).toEqual([
      'minimize',
      'zoom',
      'close',
      'front'
    ])

    const withoutNotes = submenu(
      topLevel(
        appMenuTemplate(
          options({
            windowsEnabled: { preview: true, notes: false, 'stream-manager': true, captions: true }
          })
        )!,
        'windowMenu'
      )
    )
    expect(withoutNotes.map((item) => item.label)).not.toContain('Notes')
  })

  it('opens the release notes from Help', () => {
    const help = submenu(topLevel(appMenuTemplate(options())!, 'help'))
    expect(help.map((item) => item.label)).toEqual(['Release Notes'])
    click(help[0])
    expect(actions.openReleaseNotes).toHaveBeenCalledTimes(1)
  })

  it('uses each chord once, and never one the app keeps for itself', () => {
    for (const isPackaged of [true, false]) {
      const chords = accelerators(appMenuTemplate(options({ isPackaged }))!)
      expect(new Set(chords).size).toBe(chords.length)
      // ⌘K search, ⌘J Buddy, ⌘F chat search, ⌘S save a clean cut, ⌘N a
      // greeting variant and ⌘↵ submit stay the renderer's alone.
      for (const own of ['Cmd+K', 'Cmd+J', 'Cmd+F', 'Cmd+S', 'Cmd+N', 'Cmd+Enter']) {
        expect(chords).not.toContain(chord(own))
      }
    }
  })
})

describe('appMenuTemplate on Windows and Linux', () => {
  it('shows no menu bar in a packaged build', () => {
    expect(appMenuTemplate(options({ platform: 'win32' }))).toBeNull()
    expect(appMenuTemplate(options({ platform: 'linux' }))).toBeNull()
  })

  it('gives development only Reload, the developer tools and full screen', () => {
    const template = appMenuTemplate(options({ platform: 'win32', isPackaged: false }))!
    expect(template.map((item) => item.label)).toEqual(['View'])
    expect(submenu(template[0]).map((item) => item.role ?? item.type)).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools',
      'separator',
      'togglefullscreen'
    ])
  })
})

describe('installAppMenu', () => {
  it('replaces the default menu with the built template on macOS', () => {
    installAppMenu(options())
    expect(electron.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(electron.setApplicationMenu).toHaveBeenCalledWith(
      electron.buildFromTemplate.mock.results[0]?.value
    )
  })

  it('removes the menu entirely where the template is empty', () => {
    installAppMenu(options({ platform: 'win32' }))
    expect(electron.buildFromTemplate).not.toHaveBeenCalled()
    expect(electron.setApplicationMenu).toHaveBeenCalledWith(null)
  })
})
