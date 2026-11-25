// Plan 260 S5.1a: the GPUI app's macOS bundle, unsigned, for local runs.
//
// The layout mirrors what the app looks for at run time:
// - Contents/MacOS/Videorc: the GPUI app. The backend (videorc-backend) and
//   Connect an agent's bridge (videorc-mcp) sit beside it, where `main.rs`
//   finds the backend ("packaged apps keep their backend beside the app") and
//   takes the bridge's folder from the backend's.
// - Contents/Resources: electron-builder's `extraResources` under the same
//   names (`apps/desktop/electron-builder.yml`), which
//   `videorc_app_core::bundled::packaged_resources_dir` recognises by
//   `background-assets/bundled`, and the bundled FFmpeg the backend is
//   pointed at (`VIDEORC_BUNDLED_FFMPEG_PATH`).
// - Info.plist: Electron's keys for the same bundle id, without Electron's own
//   (the asar integrity, its principal class and nib, its malloc setting).
//
// Signing is not here: the owner's lane signs, notarises and publishes. The
// entitlements a signed build gets are `apps/videorc/packaging/macos/`.

import path from 'node:path'

export const APP_NAME = 'Videorc'
export const BUNDLE_ID = 'dev.theorcdev.videorc'
export const EXECUTABLE = 'Videorc'
export const BACKEND = 'videorc-backend'
export const BRIDGE = 'videorc-mcp'
/**
 * The account sign-in callback's scheme (`videorc://account/callback`, L4's
 * #2100). Electron registers it at run time (`setAsDefaultProtocolClient`,
 * `OAUTH_CALLBACK_PROTOCOL`); a GPUI bundle declares it here, and AppKit
 * hands the URL to GPUI's `application:openURLs:`, which `main.rs` passes on
 * through `on_open_urls`.
 */
export const URL_SCHEME = 'videorc'
/** Electron's `LSMinimumSystemVersion`. */
export const MINIMUM_SYSTEM_VERSION = '12.0'

/**
 * The usage words a streamer reads in the permission prompts: Electron's
 * `mac.extendInfo` and the ones Electron adds itself, word for word, so the
 * prompts don't change at the crossover.
 */
export const USAGE_DESCRIPTIONS = {
  NSAudioCaptureUsageDescription: 'This app needs access to audio capture',
  NSBluetoothAlwaysUsageDescription: 'This app needs access to Bluetooth',
  NSBluetoothPeripheralUsageDescription: 'This app needs access to Bluetooth',
  NSCameraUsageDescription:
    'Videorc uses the camera for creator overlays when you select a camera source.',
  NSDocumentsFolderUsageDescription: 'Videorc can save recordings to a folder you choose.',
  NSDownloadsFolderUsageDescription: 'Videorc can save exports to a folder you choose.',
  NSMicrophoneUsageDescription:
    'Videorc uses the microphone when you select a microphone for recording or streaming.',
  NSScreenCaptureDescription:
    'Videorc captures your screen or selected windows only when you start a recording or stream.'
}

/** A release version as the bundle states it (`0.38.0`, `0.38.0-beta.1`). */
export function isBundleVersion(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)
}

/** The Info.plist values for `version`. */
export function infoPlistValues({ version, year = new Date().getUTCFullYear() }) {
  if (!isBundleVersion(version)) {
    throw new Error(`not a release version: ${JSON.stringify(version)}`)
  }
  return {
    CFBundleDevelopmentRegion: 'en',
    CFBundleDisplayName: APP_NAME,
    CFBundleExecutable: EXECUTABLE,
    CFBundleIconFile: 'icon.icns',
    CFBundleIdentifier: BUNDLE_ID,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: APP_NAME,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleURLTypes: [{ CFBundleURLName: BUNDLE_ID, CFBundleURLSchemes: [URL_SCHEME] }],
    CFBundleVersion: version,
    LSApplicationCategoryType: 'public.app-category.video',
    LSMinimumSystemVersion: MINIMUM_SYSTEM_VERSION,
    NSCameraUseContinuityCameraDeviceType: true,
    NSHighResolutionCapable: true,
    NSHumanReadableCopyright: `Copyright © ${year} TheOrcDev`,
    NSPrefersDisplaySafeAreaCompatibilityMode: false,
    NSPrincipalClass: 'NSApplication',
    NSQuitAlwaysKeepsWindows: false,
    NSRequiresAquaSystemAppearance: false,
    NSSupportsAutomaticGraphicsSwitching: true,
    ...USAGE_DESCRIPTIONS
  }
}

function escapeXml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function plistLines(value, indent) {
  if (value === true) return [`${indent}<true/>`]
  if (value === false) return [`${indent}<false/>`]
  if (typeof value === 'string') return [`${indent}<string>${escapeXml(value)}</string>`]
  if (Array.isArray(value)) {
    return [
      `${indent}<array>`,
      ...value.flatMap((item) => plistLines(item, `${indent}  `)),
      `${indent}</array>`
    ]
  }
  if (value !== null && typeof value === 'object') {
    return [`${indent}<dict>`, ...dictLines(value, `${indent}  `), `${indent}</dict>`]
  }
  throw new Error(`unsupported plist value: ${JSON.stringify(value)}`)
}

function dictLines(values, indent) {
  return Object.keys(values)
    .sort()
    .flatMap((key) => [`${indent}<key>${escapeXml(key)}</key>`, ...plistLines(values[key], indent)])
}

/** A property list (strings, booleans, arrays, dicts), keys sorted, as XML. */
export function plistXml(values) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...dictLines(values, '  '),
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}

/**
 * What goes into the bundle, as copies from the checkout and the binaries'
 * folder. Each entry: `from` (absolute), `to` (relative to `Contents/`),
 * `files` (names or patterns under `from`, for a folder), `required`.
 * Mirrors electron-builder's `extraResources` (shared and `mac:`), less
 * Electron's own native preview helper and addon.
 */
export function bundleCopies({ root, binaries, bridge, ffmpeg }) {
  const desktop = path.join(root, 'apps/desktop')
  return [
    { from: path.join(binaries, EXECUTABLE), to: `MacOS/${EXECUTABLE}`, required: true },
    { from: path.join(binaries, BACKEND), to: `MacOS/${BACKEND}`, required: true },
    { from: bridge, to: `MacOS/${BRIDGE}`, required: false },
    {
      from: path.join(desktop, 'build-resources/icon.icns'),
      to: 'Resources/icon.icns',
      required: true
    },
    {
      from: path.join(desktop, 'src/renderer/src/assets/videorc-logo.png'),
      to: 'Resources/videorc-logo.png',
      required: true
    },
    {
      from: path.join(desktop, 'src/renderer/src/assets/backgrounds'),
      to: 'Resources/background-assets/bundled',
      files: ['*.webp'],
      required: true
    },
    {
      from: path.join(desktop, 'resources/buddy'),
      to: 'Resources/buddy-assets/bundled',
      files: ['**'],
      exclude: ['.gitkeep', 'README.md'],
      required: true
    },
    {
      from: path.join(desktop, 'resources/sounds/starter'),
      to: 'Resources/sounds/starter',
      files: ['*.ogg', 'manifest.json', 'LICENSES.md'],
      required: true
    },
    {
      from: path.join(root, 'licenses/rnnoise-rs'),
      to: 'Resources/licenses/rnnoise-rs',
      files: ['LICENSE.txt', 'UPSTREAM-NOTICES.txt', 'SOURCE.txt'],
      required: true
    },
    {
      from: ffmpeg,
      to: 'Resources/ffmpeg',
      files: [
        'bin/ffmpeg',
        'bin/ffprobe',
        'NOTICE.txt',
        'SOURCE.txt',
        'BUILD-CONFIG.txt',
        'licenses/**',
        'source-patches/**'
      ],
      required: false
    }
  ]
}

/**
 * Whether `relative` (a path under a copy's `from`, `/`-separated) is taken:
 * `*` matches within one folder, `**` any depth, as electron-builder's
 * filters do for these patterns.
 */
export function matchesFilter(relative, patterns, exclude = []) {
  const name = relative.split('/').at(-1)
  if (exclude.includes(name) || exclude.includes(relative)) return false
  return patterns.some((pattern) => globToRegExp(pattern).test(relative))
}

function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*' && pattern[index + 1] === '*') {
      source += '.*'
      index += 1
    } else if (char === '*') {
      source += '[^/]*'
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}
