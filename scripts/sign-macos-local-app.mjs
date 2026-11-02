// Signs a locally packaged Videorc.app (`pnpm package:desktop:signed-local`)
// with the keychain Developer ID identity, the way the release build is signed:
// the bare binaries in Contents/Resources and Electron's helpers with the
// inherit entitlements, the app with its own.
//
// Plan 214 B2: when VIDEORC_MACOS_PROFILE_APP and VIDEORC_MACOS_PROFILE_CAMERA
// are set, the Videorc Camera extension is embedded and signed first (its own
// profile and entitlements), the app profile is embedded, and the app's
// entitlements gain the restricted keys. Without them the app is signed exactly
// as before the camera, and one log line says so.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import {
  BASE_APP_ENTITLEMENTS_PATH,
  INHERIT_ENTITLEMENTS_PATH,
  embedCameraExtension,
  localSignPlan
} from './lib/camera-extension-packaging.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const appPath = resolve(root, 'apps/desktop/release/mac-arm64/Videorc.app')
const baseEntitlements = resolve(root, BASE_APP_ENTITLEMENTS_PATH)
const inheritEntitlements = resolve(root, INHERIT_ENTITLEMENTS_PATH)
const identity =
  process.env.VIDEORC_MACOS_SIGN_IDENTITY ?? 'Developer ID Application: Uros Miric (C2PA37RB58)'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit'
  })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed.${output ? `\n${output}` : ''}`)
  }
  return result
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing: ${path}`)
  }
}

assertExists(appPath, 'Packaged Videorc.app')
assertExists(baseEntitlements, 'macOS app entitlements')
assertExists(inheritEntitlements, 'macOS inherit entitlements')

const identityList = run('security', ['find-identity', '-v', '-p', 'codesigning'], {
  capture: true
}).stdout
if (!identityList.includes(identity)) {
  throw new Error(
    `Signing identity not found: ${identity}\nSet VIDEORC_MACOS_SIGN_IDENTITY or install the local Developer ID certificate.`
  )
}

const toolPaths = [
  join(appPath, 'Contents/Resources/videorc-backend'),
  join(appPath, 'Contents/Resources/native_preview_host_helper'),
  // Plan 209 S4: the stdio bridge agent apps run, signed like the helper.
  join(appPath, 'Contents/Resources/videorc-mcp'),
  join(appPath, 'Contents/Resources/videorc_native_preview.node'),
  join(appPath, 'Contents/Resources/ffmpeg/bin/ffmpeg'),
  join(appPath, 'Contents/Resources/ffmpeg/bin/ffprobe')
]
for (const toolPath of toolPaths) {
  assertExists(toolPath, 'Bundled executable')
}

const infoPlist = join(appPath, 'Contents/Info.plist')
const version = run(
  'plutil',
  ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlist],
  {
    capture: true
  }
).stdout.trim()
const buildVersion = run('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', infoPlist], {
  capture: true
}).stdout.trim()

// `pnpm package` packs unsigned (mac.identity=null), so the electron-builder
// hook embedded nothing; this is the embed step for the local signed build.
const camera = await embedCameraExtension({
  appPath,
  repoRoot: root,
  env: process.env,
  version,
  buildVersion,
  identity,
  log: (line) => console.log(`sign-macos-local-app: ${line}`)
})

const plan = localSignPlan({
  appPath,
  identity,
  toolPaths,
  appEntitlementsPath: camera.appEntitlementsPath,
  inheritEntitlementsPath: inheritEntitlements,
  extensionPath: camera.embedded ? camera.extensionPath : null,
  extensionEntitlementsPath: camera.embedded ? camera.extensionEntitlementsPath : null
})
for (const step of plan) {
  run('codesign', step.args)
}

run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])

console.log(
  `sign-macos-local-app: signed ${appPath}${camera.embedded ? ' with the Videorc Camera extension' : ' (no Videorc Camera extension)'}`
)
