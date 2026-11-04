#!/usr/bin/env node
// Plan 214 B1. Builds the Videorc Camera system extension and assembles its
// bundle:
//
//   pnpm build:camera-extension [--debug] [--test] [--force] [--version <semver>]
//
// Without VIDEORC_MACOS_PROFILE_APP the build logs the one "Videorc Camera
// skipped" line and exits 0: a no-profile package embeds no extension, so it
// needs no Swift toolchain either (`pnpm package:desktop` on a Mac without
// Xcode stays today's build). --test (the Swift unit tests) and --force
// always build.
//
// 1. Fails if Identifiers.swift drifted from identifiers.json.
// 2. `swift build` (SwiftPM, arm64, deployment target 13.0 from Package.swift).
// 3. Assembles apps/desktop/build/camera-extension/dev.theorcdev.videorc.camera.systemextension
//    (Info.plist with the CMIOExtension keys and CFBundlePackageType SYSX,
//    Contents/MacOS/dev.theorcdev.videorc.camera: bundle and executable named
//    after the bundle identifier, the shape plan 214 P0a activated), writes the
//    extension entitlements beside it, and ad-hoc signs the bundle so
//    `codesign -d --entitlements` reads back what packaging will sign for real.
// 4. Verifies the Mach-O is arm64 with minos 13.0, that the signed bundle
//    carries exactly the app sandbox and the app group (never the application
//    or team identifier, never the restricted key: without a profile any of
//    those gets it killed at exec), and that it embeds no profile.
//
// Why SwiftPM and not xcodebuild: there is no .xcodeproj to keep in sync, the
// deployment target and architecture are explicit, and signing stays in the
// packaging scripts (electron-builder's hook and sign-macos-local-app.mjs),
// which never run xcodebuild with -allowProvisioningUpdates.
//
// --test also runs the pure Swift unit tests (`swift test`).
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CAMERA_EXTENSION_BUILD_DIR,
  CAMERA_EXTENSION_DIR,
  CAMERA_EXTENSION_SWIFT_IDENTIFIERS_PATH,
  cameraExtensionEntitlementProblems,
  cameraExtensionEntitlements,
  cameraExtensionExecutableName,
  cameraExtensionInfoPlist,
  entitlementKeysFromPlistXml,
  loadCameraExtensionIdentifiers,
  plistXml,
  swiftIdentifierDrift
} from './lib/camera-extension-identifiers.mjs'
import { cameraProfileDecision, cameraSkippedLogLine } from './lib/camera-extension-packaging.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const debug = args.includes('--debug')
const runTests = args.includes('--test')
const force = args.includes('--force')
const versionIndex = args.indexOf('--version')
const configuration = debug ? 'debug' : 'release'

if (process.platform !== 'darwin') {
  console.log(
    `build-camera-extension: skipped, the Camera Extension is macOS only (${process.platform}).`
  )
  process.exit(0)
}

if (!runTests && !force) {
  const decision = cameraProfileDecision(process.env)
  if (decision.mode === 'error') {
    console.error(`build-camera-extension: ${decision.reason}`)
    process.exit(1)
  }
  if (decision.mode === 'skip') {
    console.log(`build-camera-extension: ${cameraSkippedLogLine(decision.reason)}`)
    process.exit(0)
  }
}

const identifiers = loadCameraExtensionIdentifiers(repoRoot)
const drift = swiftIdentifierDrift(
  readFileSync(join(repoRoot, CAMERA_EXTENSION_SWIFT_IDENTIFIERS_PATH), 'utf8'),
  identifiers
)
if (drift.length > 0) {
  console.error('build-camera-extension: Identifiers.swift drifted from identifiers.json:')
  for (const line of drift) console.error(`  ${line}`)
  process.exit(1)
}

const swiftProbe = spawnSync('xcrun', ['--find', 'swift'], { encoding: 'utf8' })
if (swiftProbe.status !== 0) {
  console.error(
    'build-camera-extension: no Swift toolchain (xcrun --find swift failed). Install Xcode or the Command Line Tools.'
  )
  process.exit(1)
}

const version =
  versionIndex >= 0 && args[versionIndex + 1]
    ? args[versionIndex + 1]
    : JSON.parse(readFileSync(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8')).version

const packagePath = join(repoRoot, CAMERA_EXTENSION_DIR)
const buildDir = join(repoRoot, CAMERA_EXTENSION_BUILD_DIR)
const scratchPath = join(buildDir, '.build')
const bundlePath = join(buildDir, `${identifiers.extensionBundleId}.systemextension`)
const entitlementsPath = join(buildDir, `${identifiers.extensionBundleId}.entitlements`)
const executableName = cameraExtensionExecutableName(identifiers)
mkdirSync(buildDir, { recursive: true })

const swiftBuildArgs = [
  'swift',
  'build',
  '--package-path',
  packagePath,
  '--scratch-path',
  scratchPath,
  '--configuration',
  configuration,
  '--arch',
  'arm64',
  '--product',
  identifiers.extensionBundleName
]
run('xcrun', swiftBuildArgs)

if (runTests) {
  run('xcrun', ['swift', 'test', '--package-path', packagePath, '--scratch-path', scratchPath])
}

const binPath = run('xcrun', [...swiftBuildArgs, '--show-bin-path'], {
  capture: true
}).stdout.trim()
const executable = join(binPath, identifiers.extensionBundleName)
if (!existsSync(executable)) {
  console.error(`build-camera-extension: swift build produced no executable at ${executable}`)
  process.exit(1)
}

rmSync(bundlePath, { recursive: true, force: true })
mkdirSync(join(bundlePath, 'Contents', 'MacOS'), { recursive: true })
writeFileSync(
  join(bundlePath, 'Contents', 'Info.plist'),
  plistXml(cameraExtensionInfoPlist(identifiers, { version, buildVersion: version }))
)
writeFileSync(join(bundlePath, 'Contents', 'PkgInfo'), 'SYSX????')
cpSync(executable, join(bundlePath, 'Contents', 'MacOS', executableName))
writeFileSync(entitlementsPath, plistXml(cameraExtensionEntitlements(identifiers)))

const archs = run('lipo', ['-archs', executable], { capture: true }).stdout.trim()
if (archs !== 'arm64') {
  console.error(`build-camera-extension: expected an arm64-only executable, got "${archs}".`)
  process.exit(1)
}
const buildInfo = run('vtool', ['-show-build', executable], { capture: true }).stdout
const minos = /minos\s+(\S+)/.exec(buildInfo)?.[1]
if (minos !== identifiers.deploymentTarget) {
  console.error(
    `build-camera-extension: expected deployment target ${identifiers.deploymentTarget}, the Mach-O says minos ${minos ?? '(none)'}.`
  )
  process.exit(1)
}

// Ad hoc. Packaging re-signs it with Developer ID (no profile: it needs none).
run('codesign', [
  '--force',
  '--sign',
  '-',
  '--entitlements',
  entitlementsPath,
  '--options',
  'runtime',
  bundlePath
])
run('codesign', ['--verify', '--strict', '--verbose=2', bundlePath])

// Read back what was signed: exactly the two keys, nothing restricted, and no
// embedded profile. Packaging and the release validator repeat these checks.
const shown = run('codesign', ['-d', '--entitlements', ':-', bundlePath], { capture: true })
const entitlementProblems = cameraExtensionEntitlementProblems(
  entitlementKeysFromPlistXml(`${shown.stdout}\n${shown.stderr}`),
  identifiers
)
if (existsSync(join(bundlePath, 'Contents', 'embedded.provisionprofile'))) {
  entitlementProblems.push('the extension embeds a provisioning profile; it must embed none')
}
if (entitlementProblems.length > 0) {
  console.error('build-camera-extension: the signed extension is not the P0a shape:')
  for (const line of entitlementProblems) console.error(`  ${line}`)
  process.exit(1)
}

const bytes = statSync(join(bundlePath, 'Contents', 'MacOS', executableName)).size
console.log(
  `build-camera-extension: ${bundlePath} ready (${configuration}, ${identifiers.extensionBundleId} ${version}, arm64, minos ${minos}, ${bytes} bytes, entitlements: app sandbox + app group, no profile). Ad-hoc signed; packaging re-signs it with Developer ID.`
)

function run(command, commandArgs, { capture = false } = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit'
  })
  if (result.status !== 0) {
    const output = capture ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim() : ''
    console.error(
      `build-camera-extension: ${command} ${commandArgs.join(' ')} failed.${output ? `\n${output}` : ''}`
    )
    process.exit(result.status ?? 1)
  }
  return result
}
