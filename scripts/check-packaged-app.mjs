#!/usr/bin/env node
// Plan 0002 (retest 152). Reads a packaged Videorc back and fails unless its
// Electron fuses keep Node out of the signed binary (no ELECTRON_RUN_AS_NODE,
// NODE_OPTIONS, --inspect or SIGUSR1 inspector; app code only from app.asar)
// and it is not a packaged test build.
//
//   pnpm check:packaged-app [--app <executable|Videorc.app>] [--allow-test-hooks]
//
// --allow-test-hooks accepts a VIDEORC_PACKAGED_TEST_HOOKS=1 build (lab and
// harness builds); the fuses must still be flipped.
//
// Plan 214 B5 (macOS): a Developer ID build must embed the Videorc Camera
// extension with both provisioning profiles; a half-embedded extension, or one
// inside an unsigned build, fails too. An unsigned or ad hoc build without it
// is only described (the dev packaging path keeps working until B0).
//
// Plan 214 C4 (Windows): the package must carry the Videorc Camera media
// source DLL and the setup exe in resources/ (signed by the release job; the
// release validator checks the signatures).
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses'

import {
  buildFlagsProblems,
  describeFuseWire,
  fuseWireProblems,
  readPackagedBuildFlags
} from './lib/packaged-app-hardening.mjs'
import { defaultPackagedAppExecutable } from './lib/packaged-smoke-paths.mjs'
import {
  appBundleRootForApp,
  appSignatureFromCodesignDisplay,
  cameraExtensionLayout,
  cameraExtensionLayoutProblems,
  describeCameraExtensionLayout
} from './lib/camera-extension-bundle-check.mjs'
import { loadCameraExtensionIdentifiers } from './lib/camera-extension-identifiers.mjs'
import {
  describeWindowsCameraLayout,
  windowsCameraLayout,
  windowsCameraLayoutProblems,
  windowsResourcesDirForApp
} from './lib/windows-camera-bundle-check.mjs'

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

const wire = await getCurrentFuseWire(appPath)
const flags = readPackagedBuildFlags(appPath)
const problems = [
  ...fuseWireProblems(wire, FuseV1Options),
  ...buildFlagsProblems(flags, { allowTestHooks })
]

let cameraExtension = 'not checked (macOS only)'
let windowsCamera = 'not checked (Windows only)'
if (process.platform === 'win32') {
  const layout = windowsCameraLayout(windowsResourcesDirForApp(appPath), { exists: existsSync })
  windowsCamera = describeWindowsCameraLayout(layout)
  problems.push(...windowsCameraLayoutProblems(layout))
}
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
}

console.log(
  JSON.stringify(
    {
      app: appPath,
      fuses: describeFuseWire(wire, FuseV1Options),
      buildFlags: flags,
      cameraExtension,
      windowsCamera
    },
    null,
    2
  )
)
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:packaged-app: ${problem}`)
  process.exit(1)
}
console.log(
  `check:packaged-app: fuses and build flags OK; Videorc Camera ${
    process.platform === 'win32' ? windowsCamera : cameraExtension
  }`
)
