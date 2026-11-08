#!/usr/bin/env node
// The installer gate builds hardened production bytes. Its CDP recovery probe
// needs a second, explicitly test-only package; do not enable hooks in that installer.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { runWindowsRecoveryTestBuild } from './lib/windows-recovery-test-build.mjs'

if (process.platform !== 'win32') throw new Error('Windows recovery requires a Windows host.')
const repoRoot = resolve(import.meta.dirname, '..')
const productionExecutable = process.env.VIDEORC_PERF_APP_EXECUTABLE?.trim()
if (!productionExecutable)
  throw new Error('Set VIDEORC_PERF_APP_EXECUTABLE to the production Videorc.exe.')
const desktopRequire = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json'))
const packageCli = (name, bin) => {
  const manifestPath = desktopRequire.resolve(`${name}/package.json`)
  const manifest = desktopRequire(manifestPath)
  return resolve(dirname(manifestPath), manifest.bin[bin])
}
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-windows-recovery-${Date.now()}`)
)
mkdirSync(outputDirectory, { recursive: true })
const testDirectory = mkdtempSync(join(tmpdir(), 'videorc-recovery-test-package-'))
// Only desktop/build prerequisites enter this unprivileged test build and app.
const allowed = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMDATA',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'HOME',
  'CI',
  'FORCE_COLOR',
  'PNPM_HOME',
  'ELECTRON_CACHE',
  'ELECTRON_BUILDER_CACHE'
])
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase()))
)
env.VIDEORC_SMOKE_OUTPUT_DIR = outputDirectory
try {
  console.log(
    'Building a separate CDP-enabled recovery test package; production installer remains hardened.'
  )
  const report = runWindowsRecoveryTestBuild({
    repoRoot,
    productionExecutable: realpathSync(resolve(productionExecutable)),
    testDirectory,
    viteCli: packageCli('electron-vite', 'electron-vite'),
    builderCli: packageCli('electron-builder', 'electron-builder'),
    env,
    run(args, options) {
      const result = spawnSync(process.execPath, args, {
        ...options,
        stdio: 'inherit',
        windowsHide: true
      })
      if (result.error) throw result.error
      if (result.status !== 0)
        throw new Error(`${args[0]} failed: exit=${result.status}, signal=${result.signal}`)
    }
  })
  writeFileSync(join(outputDirectory, 'test-package.json'), `${JSON.stringify(report, null, 2)}\n`)
} finally {
  rmSync(testDirectory, { recursive: true, force: true, maxRetries: 3 })
}
