// Signs a locally packaged Videorc.app (`pnpm package:desktop:signed-local`)
// with the keychain Developer ID identity, the way the release build is signed
// and the way plan 214 P0a proved on real hardware: inside out, never --deep.
//
//   pnpm sign:desktop:local [--app <path/to/Videorc.app>]
//
// 1. every nested code object (the bare tools in Contents/Resources, Electron's
//    dylibs and crashpad handler, ShipIt, the frameworks, the helper apps) with
//    entitlements.mac.inherit.plist: today's five keys and nothing more;
// 2. the Videorc Camera extension with its own two keys (app sandbox, app
//    group), when VIDEORC_MACOS_PROFILE_APP is set;
// 3. the app last, with Contents/embedded.provisionprofile already in place and
//    the app plist (the five keys plus the restricted system-extension key and
//    the app group when the profile is set).
//
// Without the profile the app is signed exactly as before the camera, and one
// log line says so. --deep is never used: with one plist it pushed the
// restricted key into the helpers, and a bare binary carrying it dies at exec.
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import {
  BASE_APP_ENTITLEMENTS_PATH,
  INHERIT_ENTITLEMENTS_PATH,
  collectNestedCodePaths,
  embedCameraExtension,
  localSignPlan,
  pickSigningIdentity
} from './lib/camera-extension-packaging.mjs'

const root = resolve(new URL('..', import.meta.url).pathname)
const args = process.argv.slice(2)
const appIndex = args.indexOf('--app')
const appPath =
  appIndex >= 0 && args[appIndex + 1]
    ? resolve(args[appIndex + 1])
    : resolve(root, 'apps/desktop/release/mac-arm64/Videorc.app')
const baseEntitlements = resolve(root, BASE_APP_ENTITLEMENTS_PATH)
const inheritEntitlements = resolve(root, INHERIT_ENTITLEMENTS_PATH)
const identityName =
  process.env.VIDEORC_MACOS_SIGN_IDENTITY ?? 'Developer ID Application: Uros Miric (C2PA37RB58)'

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit'
  })
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${commandArgs.join(' ')} failed.${output ? `\n${output}` : ''}`)
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
const picked = pickSigningIdentity(identityList, { preferred: identityName })
if (!picked) {
  throw new Error(
    `Signing identity not found: ${identityName}\nSet VIDEORC_MACOS_SIGN_IDENTITY or install the local Developer ID certificate.`
  )
}
// The hash: codesign accepts it, and it is the certificate's SHA-1, which the
// profile check compares against the profile's DeveloperCertificates.
const identity = picked.hash

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

const nestedCodePaths = collectNestedCodePaths(appPath)
for (const toolPath of toolPaths) {
  if (!nestedCodePaths.some((entry) => entry.path === toolPath)) {
    throw new Error(`Bundled executable is not a Mach-O the signer would walk: ${toolPath}`)
  }
}
const plan = localSignPlan({
  appPath,
  identity,
  nestedCodePaths,
  appEntitlementsPath: camera.appEntitlementsPath,
  inheritEntitlementsPath: inheritEntitlements,
  extensionPath: camera.embedded ? camera.extensionPath : null,
  extensionEntitlementsPath: camera.embedded ? camera.extensionEntitlementsPath : null
})
console.log(
  `sign-macos-local-app: signing ${plan.length} code objects inside out as ${picked.name}`
)
for (const step of plan) {
  run('codesign', step.args)
}

run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])

console.log(
  `sign-macos-local-app: signed ${appPath}${camera.embedded ? ' with the Videorc Camera extension' : ' (no Videorc Camera extension)'}`
)
