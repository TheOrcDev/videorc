#!/usr/bin/env node
// Plan 0002 (retest 152). Reads a packaged Videorc back and fails unless its
// Electron fuses keep Node out of the signed binary (no ELECTRON_RUN_AS_NODE,
// NODE_OPTIONS, --inspect or SIGUSR1 inspector; app code only from app.asar)
// and it is not a packaged test build.
//
//   pnpm check:packaged-app [--app <executable|Videorc.app|Videorc.AppImage>] [--allow-test-hooks]
//
// --allow-test-hooks accepts a VIDEORC_PACKAGED_TEST_HOOKS=1 build (lab and
// harness builds); the fuses must still be flipped.
//
// Plan 214 B5 (macOS, shape fixed by spike P0a): a Developer ID build must
// embed the Videorc Camera extension and the one app profile; an embedded
// extension must then show the P0a shape: exactly the app sandbox and the app
// group, a valid signature, SYSX, no profile of its own, the restricted keys
// on the main executable only, and exactly one embedded profile in the whole
// bundle. A half-embedded extension, or one inside an unsigned build, fails
// too. An unsigned or ad hoc build without it is only described (the dev
// packaging path keeps working without the profile).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses'

import {
  buildFlagsProblems,
  describeFuseWire,
  fuseWireProblems,
  readPackagedBuildFlags
} from './lib/packaged-app-hardening.mjs'
import {
  defaultPackagedAppExecutable,
  isLinuxAppImageExecutable,
  linuxAppImageCheckPayload
} from './lib/packaged-smoke-paths.mjs'
import {
  appBundleRootForApp,
  appSignatureFromCodesignDisplay,
  cameraExtensionLayout,
  cameraExtensionLayoutProblems,
  cameraExtensionSignedShapeProblems,
  describeCameraExtensionLayout,
  isCameraExtensionEmbedded
} from './lib/camera-extension-bundle-check.mjs'
import {
  entitlementKeysFromPlistXml,
  loadCameraExtensionIdentifiers
} from './lib/camera-extension-identifiers.mjs'
import {
  bareBinaryCheckTargets,
  findEmbeddedProfiles,
  nestedExecutableCheckTargets
} from './lib/macos-release-artifact-validation.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const appIndex = args.indexOf('--app')
const appPath =
  appIndex >= 0 && args[appIndex + 1]
    ? resolve(args[appIndex + 1])
    : process.env.VIDEORC_PACKAGED_APP_EXECUTABLE
      ? resolve(repoRoot, process.env.VIDEORC_PACKAGED_APP_EXECUTABLE)
      : defaultPackagedAppExecutable({ repoRoot })
const allowTestHooks = args.includes('--allow-test-hooks')

// An AppImage is read through the two files its runtime extracts.
function extractAppImagePayload(appImage) {
  const directory = mkdtempSync(join(tmpdir(), 'videorc-check-appimage-'))
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }))
  const payload = linuxAppImageCheckPayload(directory)
  for (const member of payload.members) {
    const extract = spawnSync(appImage, ['--appimage-extract', member], {
      cwd: directory,
      encoding: 'utf8'
    })
    if (extract.status !== 0 || !existsSync(join(directory, 'squashfs-root', member))) {
      const reason = extract.error?.message ?? (extract.stderr.trim() || `exit ${extract.status}`)
      console.error(`check:packaged-app: could not extract ${member} from ${appImage}: ${reason}`)
      process.exit(1)
    }
  }
  return payload.executable
}

const checkedPath = isLinuxAppImageExecutable(appPath) ? extractAppImagePayload(appPath) : appPath
const wire = await getCurrentFuseWire(checkedPath)
const flags = readPackagedBuildFlags(checkedPath)
const problems = [
  ...fuseWireProblems(wire, FuseV1Options),
  ...buildFlagsProblems(flags, { allowTestHooks })
]

let cameraExtension = 'not checked (macOS only)'
if (process.platform === 'darwin') {
  const identifiers = loadCameraExtensionIdentifiers(repoRoot)
  const appRoot = appBundleRootForApp(appPath)
  const display = spawnSync('codesign', ['-dv', '--verbose=4', appRoot], { encoding: 'utf8' })
  const signature = appSignatureFromCodesignDisplay(
    `${display.stdout ?? ''}\n${display.stderr ?? ''}`,
    { exitCode: display.status ?? 1 }
  )
  const layout = cameraExtensionLayout(appRoot, { identifiers, exists: existsSync })
  cameraExtension = describeCameraExtensionLayout(layout, signature, identifiers)
  problems.push(...cameraExtensionLayoutProblems(layout, { identifiers, signature }))
  if (isCameraExtensionEmbedded(layout)) {
    const entitlementKeys = (path) => {
      const shown = spawnSync('codesign', ['-d', '--entitlements', ':-', path], {
        encoding: 'utf8'
      })
      return entitlementKeysFromPlistXml(`${shown.stdout ?? ''}\n${shown.stderr ?? ''}`)
    }
    const packageType = spawnSync(
      'plutil',
      ['-extract', 'CFBundlePackageType', 'raw', '-o', '-', layout.paths.infoPlist],
      { encoding: 'utf8' }
    )
    const verify = spawnSync(
      'codesign',
      ['--verify', '--strict', '--verbose=2', layout.paths.extension],
      {
        encoding: 'utf8'
      }
    )
    problems.push(
      ...cameraExtensionSignedShapeProblems(
        {
          extensionEntitlementKeys: entitlementKeys(layout.paths.extension),
          extensionSignatureOk: verify.status === 0,
          packageType: packageType.status === 0 ? packageType.stdout.trim() : null,
          appEntitlementKeys: entitlementKeys(appRoot),
          nestedEntitlements: [
            ...bareBinaryCheckTargets(appRoot),
            ...nestedExecutableCheckTargets(appRoot)
          ]
            .filter((target) => existsSync(target.path))
            .map((target) => ({ label: target.label, keys: entitlementKeys(target.path) })),
          embeddedProfiles: findEmbeddedProfiles(appRoot)
        },
        { identifiers }
      )
    )
  }
}

console.log(
  JSON.stringify(
    {
      app: appPath,
      fuses: describeFuseWire(wire, FuseV1Options),
      buildFlags: flags,
      cameraExtension
    },
    null,
    2
  )
)
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:packaged-app: ${problem}`)
  process.exit(1)
}
console.log(`check:packaged-app: fuses and build flags OK; Videorc Camera ${cameraExtension}`)
