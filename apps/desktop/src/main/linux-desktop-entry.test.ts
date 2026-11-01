import { describe, expect, it } from 'vitest'

import {
  buildVideorcDesktopEntry,
  decideVideorcDesktopEntry,
  desktopEntryValue,
  isVideorcManagedEntry,
  linuxAppImageToRegister,
  linuxChromeDesktop,
  linuxDesktopEntryPaths,
  quoteDesktopExecArgument,
  VIDEORC_DESKTOP_FILE_NAME
} from './linux-desktop-entry'

const APPIMAGE = '/home/ana/Applications/Videorc-0.15.1-linux-x64.AppImage'

function entryFor(path: string): string {
  const text = buildVideorcDesktopEntry(path)
  if (!text) throw new Error(`no entry for ${path}`)
  return text
}

describe('linuxChromeDesktop', () => {
  it('names the videorc.desktop entry on Linux, so the Wayland app_id is "videorc"', () => {
    expect(linuxChromeDesktop('linux')).toBe(VIDEORC_DESKTOP_FILE_NAME)
    expect(VIDEORC_DESKTOP_FILE_NAME).toBe('videorc.desktop')
    // Electron's default comes from the package name and matches no entry.
    expect(linuxChromeDesktop('linux')).not.toBe('@videorc/desktop.desktop')
  })

  it('leaves macOS and Windows alone', () => {
    expect(linuxChromeDesktop('darwin')).toBeNull()
    expect(linuxChromeDesktop('win32')).toBeNull()
  })
})

describe('linuxAppImageToRegister', () => {
  it('registers only a packaged Linux AppImage run', () => {
    expect(linuxAppImageToRegister('linux', true, APPIMAGE)).toBe(APPIMAGE)
    expect(linuxAppImageToRegister('linux', false, APPIMAGE)).toBeNull()
    expect(linuxAppImageToRegister('linux', true, undefined)).toBeNull()
    expect(linuxAppImageToRegister('linux', true, '')).toBeNull()
    expect(linuxAppImageToRegister('linux', true, 'Videorc.AppImage')).toBeNull()
    expect(linuxAppImageToRegister('darwin', true, APPIMAGE)).toBeNull()
    expect(linuxAppImageToRegister('win32', true, APPIMAGE)).toBeNull()
  })
})

describe('linuxDesktopEntryPaths', () => {
  it('defaults to ~/.local/share', () => {
    expect(linuxDesktopEntryPaths('/home/ana', undefined, 512)).toEqual({
      desktopFile: '/home/ana/.local/share/applications/videorc.desktop',
      applicationsDir: '/home/ana/.local/share/applications',
      iconDir: '/home/ana/.local/share/icons/hicolor/512x512/apps',
      iconFile: '/home/ana/.local/share/icons/hicolor/512x512/apps/videorc.png'
    })
  })

  it('respects an absolute XDG_DATA_HOME and ignores a relative one', () => {
    expect(linuxDesktopEntryPaths('/home/ana', '/data/xdg', 256).desktopFile).toBe(
      '/data/xdg/applications/videorc.desktop'
    )
    expect(linuxDesktopEntryPaths('/home/ana', '/data/xdg', 256).iconFile).toBe(
      '/data/xdg/icons/hicolor/256x256/apps/videorc.png'
    )
    expect(linuxDesktopEntryPaths('/home/ana', 'rel/xdg', 512).desktopFile).toBe(
      '/home/ana/.local/share/applications/videorc.desktop'
    )
    expect(linuxDesktopEntryPaths('/home/ana', '', 512).desktopFile).toBe(
      '/home/ana/.local/share/applications/videorc.desktop'
    )
  })
})

describe('quoteDesktopExecArgument', () => {
  it('leaves a plain path bare and quotes one with spaces', () => {
    // Bare: the xdg-open generic launcher does not strip quotes.
    expect(quoteDesktopExecArgument('/opt/Videorc-0.15.1.AppImage')).toBe(
      '/opt/Videorc-0.15.1.AppImage'
    )
    expect(quoteDesktopExecArgument('/home/ana/My Apps/Videorc.AppImage')).toBe(
      '"/home/ana/My Apps/Videorc.AppImage"'
    )
  })

  it('escapes the reserved characters, field-code percent and backslashes', () => {
    expect(quoteDesktopExecArgument('/a"b')).toBe('"/a\\\\"b"')
    expect(quoteDesktopExecArgument('/a$b')).toBe('"/a\\\\$b"')
    expect(quoteDesktopExecArgument('/a`b')).toBe('"/a\\\\`b"')
    // A literal backslash: quoting doubles it, string escaping doubles it again.
    expect(quoteDesktopExecArgument('/a\\b')).toBe('"/a\\\\\\\\b"')
    expect(quoteDesktopExecArgument('/100%/Videorc')).toBe('/100%%/Videorc')
    expect(quoteDesktopExecArgument("/ana's/V")).toBe('"/ana\'s/V"')
  })

  it('refuses a path the format cannot carry', () => {
    expect(quoteDesktopExecArgument('')).toBeNull()
    expect(quoteDesktopExecArgument('/a\nb')).toBeNull()
    expect(quoteDesktopExecArgument('/a\tb')).toBeNull()
  })
})

describe('buildVideorcDesktopEntry', () => {
  it('writes a managed entry that handles videorc:// links', () => {
    expect(entryFor(APPIMAGE)).toBe(
      [
        '[Desktop Entry]',
        'Name=Videorc',
        'Comment=Videorc desktop app.',
        `Exec=${APPIMAGE} --no-sandbox %U`,
        `TryExec=${APPIMAGE}`,
        'Terminal=false',
        'Type=Application',
        'Icon=videorc',
        'StartupWMClass=Videorc',
        'Categories=AudioVideo;Video;',
        'MimeType=x-scheme-handler/videorc;',
        'X-Videorc-Managed=true',
        ''
      ].join('\n')
    )
  })

  it('quotes a path with spaces and refuses an unrepresentable one', () => {
    expect(desktopEntryValue(entryFor('/home/ana/My Apps/V.AppImage'), 'Exec')).toBe(
      '"/home/ana/My Apps/V.AppImage" --no-sandbox %U'
    )
    // TryExec is a plain string: never quoted, only backslashes escaped.
    expect(desktopEntryValue(entryFor('/home/ana/My Apps/V.AppImage'), 'TryExec')).toBe(
      '/home/ana/My Apps/V.AppImage'
    )
    expect(desktopEntryValue(entryFor('/a\\b'), 'TryExec')).toBe('/a\\\\b')
    expect(buildVideorcDesktopEntry('/a\nb')).toBeNull()
  })
})

describe('decideVideorcDesktopEntry', () => {
  const desired = entryFor(APPIMAGE)

  it('writes a missing entry', () => {
    expect(decideVideorcDesktopEntry(null, desired)).toEqual({ action: 'write', reason: 'missing' })
  })

  it('keeps a managed entry for the same AppImage (line endings and trailing space ignored)', () => {
    expect(decideVideorcDesktopEntry(desired, desired)).toEqual({
      action: 'keep',
      reason: 'current'
    })
    expect(decideVideorcDesktopEntry(`${desired.replace(/\n/g, '\r\n')}\n\n`, desired)).toEqual({
      action: 'keep',
      reason: 'current'
    })
  })

  it('rewrites a managed entry that points at another AppImage', () => {
    const old = entryFor('/home/ana/Downloads/Videorc-0.14.0-linux-x64.AppImage')
    expect(decideVideorcDesktopEntry(old, desired)).toEqual({ action: 'write', reason: 'stale' })
  })

  it('never touches an entry it did not write', () => {
    const appImageLauncher = [
      '[Desktop Entry]',
      'Name=Videorc',
      'Exec=/home/ana/Applications/videorc_abc.AppImage %U',
      'Type=Application',
      'X-AppImage-Version=0.15.1',
      ''
    ].join('\n')
    expect(decideVideorcDesktopEntry(appImageLauncher, desired)).toEqual({
      action: 'keep',
      reason: 'unmanaged'
    })
    expect(decideVideorcDesktopEntry('', desired)).toEqual({ action: 'keep', reason: 'unmanaged' })
    expect(
      decideVideorcDesktopEntry(
        appImageLauncher.replace('Type=', 'X-Videorc-Managed=false\nType='),
        desired
      )
    ).toEqual({ action: 'keep', reason: 'unmanaged' })
  })
})

describe('desktopEntryValue', () => {
  it('reads only the [Desktop Entry] group', () => {
    const text = [
      '# X-Videorc-Managed=true',
      '[Desktop Entry]',
      'Name = Videorc',
      '[Desktop Action new]',
      'X-Videorc-Managed=true',
      ''
    ].join('\n')
    expect(desktopEntryValue(text, 'Name')).toBe('Videorc')
    expect(isVideorcManagedEntry(text)).toBe(false)
  })
})
