// Linux AppImage registration for `videorc://` links.
//
// Electron's setAsDefaultProtocolClient on Linux shells out to
// `xdg-settings set default-url-scheme-handler`, which needs an installed
// desktop entry named by CHROME_DESKTOP. An AppImage installs none, so every
// launch logged `xdg-settings: invalid application name` and nothing handled
// x-scheme-handler/videorc: `videorc://buddy` (plan 170 D18) and the X
// app-protocol fallback could not open Videorc. Instead the packaged AppImage
// writes its own user entry, ~/.local/share/applications/videorc.desktop,
// pointing at the AppImage file, and registers it with `xdg-mime`.
//
// An entry without the X-Videorc-Managed marker belongs to the user or to an
// integration tool (AppImageLauncher, Gear Lever) and is never overwritten.
//
// Pure and electron-free so it is unit-testable; index.ts does the IO.

import { posix } from 'node:path'

// These are always Linux paths, including when tested on another host.
const { join } = posix

export const VIDEORC_DESKTOP_FILE_NAME = 'videorc.desktop'
export const VIDEORC_URL_MIME_TYPE = 'x-scheme-handler/videorc'
export const VIDEORC_DESKTOP_ICON_NAME = 'videorc'
export const VIDEORC_MANAGED_KEY = 'X-Videorc-Managed'

// The AppImage file to register, or null when this run must not touch the
// desktop (macOS, Windows, dev, an extracted or unpackaged Linux build).
export function linuxAppImageToRegister(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  appImage: string | undefined
): string | null {
  if (platform !== 'linux' || !isPackaged || !appImage || !appImage.startsWith('/')) {
    return null
  }
  return appImage
}

export interface LinuxDesktopEntryPaths {
  desktopFile: string
  applicationsDir: string
  iconDir: string
  iconFile: string
}

// XDG_DATA_HOME wins when it is an absolute path (the spec ignores relative
// values); otherwise ~/.local/share.
export function linuxDesktopEntryPaths(
  homeDir: string,
  xdgDataHome: string | undefined,
  iconSize: number
): LinuxDesktopEntryPaths {
  const dataHome =
    xdgDataHome && xdgDataHome.startsWith('/') ? xdgDataHome : join(homeDir, '.local', 'share')
  const applicationsDir = join(dataHome, 'applications')
  const iconDir = join(dataHome, 'icons', 'hicolor', `${iconSize}x${iconSize}`, 'apps')
  return {
    desktopFile: join(applicationsDir, VIDEORC_DESKTOP_FILE_NAME),
    applicationsDir,
    iconDir,
    iconFile: join(iconDir, `${VIDEORC_DESKTOP_ICON_NAME}.png`)
  }
}

// One Exec argument per the Desktop Entry spec ("The Exec key"). An argument
// with a reserved character is double-quoted, with `"`, `` ` ``, `$` and `\`
// backslash-escaped inside; a plain path stays bare, because the xdg-open
// generic launcher (xdg-utils 1.2, used on Hyprland, Sway and other bare
// window managers) splits Exec on spaces and does not strip quotes. `%` is
// written `%%`, and then the whole value gets the string-value escaping, which
// doubles every backslash again. Null for a path the format cannot carry.
export function quoteDesktopExecArgument(value: string): string | null {
  if (!isRepresentablePath(value)) {
    return null
  }
  const needsQuotes = /[\s"'\\><~|&;$*?#()`]/.test(value)
  const argument = needsQuotes ? `"${value.replace(/["`$\\]/g, '\\$&')}"` : value
  return escapeDesktopString(argument.replace(/%/g, '%%'))
}

// A plain string value (TryExec): only the backslash is escaped.
export function escapeDesktopString(value: string): string {
  return value.replace(/\\/g, '\\\\')
}

function isRepresentablePath(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value)
}

// The same launch flags as the entry electron-builder bundles in the AppImage
// (`AppRun --no-sandbox %U`): the AppImage's chrome-sandbox cannot be setuid.
export function buildVideorcDesktopEntry(appImagePath: string): string | null {
  const exec = quoteDesktopExecArgument(appImagePath)
  if (!exec) {
    return null
  }
  return [
    '[Desktop Entry]',
    'Name=Videorc',
    'Comment=Videorc desktop app.',
    `Exec=${exec} --no-sandbox %U`,
    `TryExec=${escapeDesktopString(appImagePath)}`,
    'Terminal=false',
    'Type=Application',
    `Icon=${VIDEORC_DESKTOP_ICON_NAME}`,
    'StartupWMClass=Videorc',
    'Categories=AudioVideo;Video;',
    `MimeType=${VIDEORC_URL_MIME_TYPE};`,
    `${VIDEORC_MANAGED_KEY}=true`,
    ''
  ].join('\n')
}

export type DesktopEntryDecision =
  | { action: 'write'; reason: 'missing' | 'stale' }
  | { action: 'keep'; reason: 'current' | 'unmanaged' }

// `existing` is the current file text, or null when there is none.
export function decideVideorcDesktopEntry(
  existing: string | null,
  desired: string
): DesktopEntryDecision {
  if (existing === null) {
    return { action: 'write', reason: 'missing' }
  }
  if (!isVideorcManagedEntry(existing)) {
    return { action: 'keep', reason: 'unmanaged' }
  }
  return normalizeEntry(existing) === normalizeEntry(desired)
    ? { action: 'keep', reason: 'current' }
    : { action: 'write', reason: 'stale' }
}

export function isVideorcManagedEntry(text: string): boolean {
  return desktopEntryValue(text, VIDEORC_MANAGED_KEY)?.toLowerCase() === 'true'
}

// A key's value from the [Desktop Entry] group (not from Desktop Action groups).
export function desktopEntryValue(text: string, key: string): string | null {
  let inMainGroup = false
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inMainGroup = line === '[Desktop Entry]'
      continue
    }
    if (!inMainGroup || line.startsWith('#')) {
      continue
    }
    const separator = line.indexOf('=')
    if (separator > 0 && line.slice(0, separator).trim() === key) {
      return line.slice(separator + 1).trim()
    }
  }
  return null
}

function normalizeEntry(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}
