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
import { resolve } from 'node:path'

import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses'

import {
  buildFlagsProblems,
  describeFuseWire,
  fuseWireProblems,
  readPackagedBuildFlags
} from './lib/packaged-app-hardening.mjs'
import { defaultPackagedAppExecutable } from './lib/packaged-smoke-paths.mjs'

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

console.log(
  JSON.stringify(
    { app: appPath, fuses: describeFuseWire(wire, FuseV1Options), buildFlags: flags },
    null,
    2
  )
)
if (problems.length > 0) {
  for (const problem of problems) console.error(`check:packaged-app: ${problem}`)
  process.exit(1)
}
console.log('check:packaged-app: fuses and build flags OK')
