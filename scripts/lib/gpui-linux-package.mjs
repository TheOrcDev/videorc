// Plan 260 S5.1c: the GPUI app's Linux package, unsigned, for local runs.
//
// The layout mirrors what the app looks for at run time on Linux:
// - `Videorc/` root: the GPUI app. The backend (`videorc-backend`) and
//   Connect an agent's bridge (`videorc-mcp`) sit beside it, where `main.rs`
//   finds the backend ("packaged apps keep their backend beside the app") and
//   takes the bridge's folder from the backend's.
// - `resources/`: electron-builder's `extraResources` under the same names
//   (`apps/desktop/electron-builder.yml`), which
//   `videorc_app_core::bundled::packaged_resources_dir` recognises by
//   `background-assets/bundled`, and the bundled FFmpeg the backend is
//   pointed at (`VIDEORC_BUNDLED_FFMPEG_PATH`).
// - `videorc.desktop` + `AppRun` + `videorc.png`: AppImage-shaped so L5 can
//   wrap the tree with appimagetool on ogre later. Signing / publishing /
//   AppImage runtime pick are the owner's; this script only builds the tree.
//
// Assembling is host-agnostic (macOS can pack when given Linux ELF binaries).
// Launch proof needs Linux (ogre / CI).

import fs from 'node:fs'
import path from 'node:path'

import { matchesFilter } from './gpui-macos-bundle.mjs'

export { matchesFilter }

export const APP_NAME = 'Videorc'
export const PACKAGE_DIR = 'Videorc'
export const EXECUTABLE = 'Videorc'
export const BACKEND = 'videorc-backend'
export const BRIDGE = 'videorc-mcp'
export const DESKTOP_FILE = 'videorc.desktop'
export const DESKTOP_ICON_FILE = 'videorc.png'
export const APP_RUN = 'AppRun'
/** Electron's `mimeTypes` / the core's `URL_MIME_TYPE`. */
export const URL_MIME_TYPE = 'x-scheme-handler/videorc'
/** The core's managed-entry marker (`X-Videorc-Managed`). */
export const MANAGED_KEY = 'X-Videorc-Managed'
export const URL_SCHEME = 'videorc'

/** A release version as the package states it (`0.38.0`, `0.38.0-beta.1`). */
export function isPackageVersion(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
}

/** ELF magic (`\\x7fELF`). Refuses Mach-O / PE so a Mac build can't pack itself. */
export function isElf(file) {
  const handle = fs.openSync(file, 'r')
  try {
    const magic = Buffer.alloc(4)
    fs.readSync(handle, magic, 0, 4, 0)
    return magic[0] === 0x7f && magic[1] === 0x45 && magic[2] === 0x4c && magic[3] === 0x46
  } finally {
    fs.closeSync(handle)
  }
}

/**
 * What goes into the package, as copies from the checkout and the binaries'
 * folder. Each entry: `from` (absolute), `to` (relative to the package root),
 * `files` (names or patterns under `from`, for a folder), `required`.
 * Same resource names as S5.1a's macOS bundle and electron-builder's Linux
 * `extraResources`, under `resources/` beside the executable.
 */
export function packageCopies({ root, binaries, bridge, ffmpeg }) {
  const desktop = path.join(root, 'apps/desktop')
  return [
    { from: path.join(binaries, EXECUTABLE), to: EXECUTABLE, required: true },
    { from: path.join(binaries, BACKEND), to: BACKEND, required: true },
    { from: bridge, to: BRIDGE, required: false },
    {
      from: path.join(desktop, 'src/renderer/src/assets/videorc-logo.png'),
      to: 'resources/videorc-logo.png',
      required: true
    },
    {
      from: path.join(desktop, 'src/renderer/src/assets/videorc-logo.png'),
      to: DESKTOP_ICON_FILE,
      required: true
    },
    {
      from: path.join(desktop, 'src/renderer/src/assets/backgrounds'),
      to: 'resources/background-assets/bundled',
      files: ['*.webp'],
      required: true
    },
    {
      from: path.join(desktop, 'resources/buddy'),
      to: 'resources/buddy-assets/bundled',
      files: ['**'],
      exclude: ['.gitkeep', 'README.md'],
      required: true
    },
    {
      from: path.join(desktop, 'resources/sounds/starter'),
      to: 'resources/sounds/starter',
      files: ['*.ogg', 'manifest.json', 'LICENSES.md'],
      required: true
    },
    {
      from: path.join(root, 'licenses/rnnoise-rs'),
      to: 'resources/licenses/rnnoise-rs',
      files: ['LICENSE.txt', 'UPSTREAM-NOTICES.txt', 'SOURCE.txt'],
      required: true
    },
    {
      from: ffmpeg,
      to: 'resources/ffmpeg',
      files: [
        'bin/ffmpeg',
        'bin/ffprobe',
        'NOTICE.txt',
        'SOURCE.txt',
        'BUILD-CONFIG.txt',
        'LICENSE.txt',
        'licenses/**',
        'source-patches/**'
      ],
      required: false
    }
  ]
}

/**
 * The `.desktop` entry shipped inside the package tree. `Exec`/`TryExec` use
 * the binary name (AppImage / AppDir relative form). The app rewrites the
 * user's `~/.local/share/applications/videorc.desktop` on AppImage launch
 * to point at the mounted AppImage path (`desktop_entry::build_desktop_entry`).
 */
export function desktopEntryText({ version }) {
  if (!isPackageVersion(version)) {
    throw new Error(`not a release version: ${JSON.stringify(version)}`)
  }
  return [
    '[Desktop Entry]',
    'Name=Videorc',
    'Comment=Videorc desktop app.',
    `Exec=${EXECUTABLE} %U`,
    `TryExec=${EXECUTABLE}`,
    'Terminal=false',
    'Type=Application',
    'Icon=videorc',
    'StartupWMClass=Videorc',
    'Categories=AudioVideo;Video;',
    `MimeType=${URL_MIME_TYPE};`,
    `X-AppImage-Version=${version}`,
    `${MANAGED_KEY}=true`,
    ''
  ].join('\n')
}

/**
 * AppRun for an AppDir / future AppImage wrap: runs `Videorc` beside itself,
 * forwarding argv. No Electron `--no-sandbox` (GPUI has no chrome-sandbox).
 */
export function appRunScript() {
  return [
    '#!/bin/sh',
    // Plan 260 S5.1c: unsigned local package / AppDir entry.
    'HERE="$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")"',
    `exec "$HERE/${EXECUTABLE}" "$@"`
  ].join('\n') + '\n'
}
