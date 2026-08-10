#!/usr/bin/env node

// Runs the pinned NSIS packaging path against the already-packed win-unpacked
// directory, then removes the throwaway installer it produces.
//
// Two reasons this exists, and they pull in different directions:
//
// 1. In the protected signing job it must run BEFORE Azure login, so every
//    electron-builder download (nsis, nsis-resources, winCodeSign) happens
//    while no credentials are in the environment.
// 2. NSIS packaging COPIES resources/elevate.exe into win-unpacked. That
//    mutates the tree the unsigned staging manifest hashes, so the prewarm has
//    to run in the unsigned job too — before the manifest is written — or the
//    protected job's own guard correctly refuses the changed payload.
//
// Running it in both places keeps the guarantee intact: the manifest covers
// elevate.exe, and the second run is a no-op the guard still verifies. Do NOT
// "fix" a count mismatch by exempting files from the manifest — that hole is
// exactly what stops a protected job signing bytes the unprivileged job never
// produced.

import { spawnSync } from 'node:child_process'
import { readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const desktopDir = join(repoRoot, 'apps', 'desktop')
const releaseDir = join(desktopDir, 'release')
const STAGING_MANIFESTS = new Set(['windows-unsigned-staging.json', 'windows-signed-staging.json'])
const INSTALLER_PATTERN = /^Videorc-.*-win-x64\.exe$/

function fail(message) {
  console.error(`windows-nsis-prewarm: ${message}`)
  process.exit(1)
}

const packed = join(releaseDir, 'win-unpacked')
try {
  if (!(await stat(packed)).isDirectory()) {
    fail(`${packed} is not a directory — pack the app before prewarming NSIS`)
  }
} catch {
  fail(`${packed} is missing — pack the app before prewarming NSIS`)
}

const result = spawnSync(
  'pnpm',
  [
    '--filter',
    '@videorc/desktop',
    'exec',
    'electron-builder',
    '--win',
    'nsis',
    '--publish',
    'never',
    '--prepackaged',
    'release/win-unpacked',
    '--config',
    'electron-builder.windows-unsigned.cjs'
  ],
  { cwd: repoRoot, stdio: 'inherit', shell: process.platform === 'win32' }
)
if (result.status !== 0) {
  fail('unable to prewarm the pinned NSIS packaging path')
}

// The installer this produces is unsigned and deliberately discarded; the
// protected job builds the real one from the signed payload.
const entries = await readdir(releaseDir, { withFileTypes: true })
const installers = entries.filter((entry) => entry.isFile() && INSTALLER_PATTERN.test(entry.name))
if (installers.length !== 1) {
  fail(`expected exactly one unsigned installer, found ${installers.length}`)
}

let removed = 0
for (const entry of entries) {
  if (!entry.isFile() || STAGING_MANIFESTS.has(entry.name)) {
    continue
  }
  await rm(resolve(releaseDir, entry.name), { force: true })
  removed += 1
}

console.log(`windows-nsis-prewarm: warmed NSIS and removed ${removed} generated file(s)`)
