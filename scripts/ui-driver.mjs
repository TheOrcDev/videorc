// UI driver: launches the dev app on an ISOLATED profile with the smoke
// command server, writes the connection info to a well-known file, and stays
// alive until killed. Pair with scripts/ui-cmd.mjs to drive tabs, run
// renderer JS (eval-js), and capture page screenshots for acceptance sweeps.
//
//   pnpm ui:driver                 # terminal 1 (or run_in_background)
//   pnpm ui:cmd capture-page '{"name":"settings"}'   # terminal 2
//
// Sweep captures land in VIDEORC_UI_SWEEP_DIR (default docs/acceptance/sweeps/
// staging under .tmp — copy the ones acceptance needs into a dated folder).
// Born as the launch-QA driver (2026-07-02); promoted in UX-rework slice E0.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
export const UI_DRIVER_CONNECTION_FILE = join(tmpdir(), 'videorc-ui-driver-connection.json')

const sweepDir = resolve(
  process.env.VIDEORC_UI_SWEEP_DIR ?? join(repoRoot, 'docs', 'acceptance', 'sweeps', '.staging')
)
mkdirSync(sweepDir, { recursive: true })

const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs: Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 240000),
  env: {
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    // capture-page writes here (the smoke command server reads this env).
    VIDEORC_SMOKE_OUTPUT_DIR: sweepDir,
    // Dev builds resolve to Developer entitlements on their own; the env var is
    // downgrade-only now, so it is only ever set to force the Basic gates.
    ...(process.env.VIDEORC_UI_DRIVER_PREMIUM === '0'
      ? { VIDEORC_PREMIUM_FEATURES: '0' }
      : {}),
    ...(process.env.VIDEORC_UI_DRIVER_SYNTHETIC === '1'
      ? { VIDEORC_SMOKE_PREVIEW_MOTION: '1' }
      : {})
  }
})

writeFileSync(
  UI_DRIVER_CONNECTION_FILE,
  JSON.stringify(
    {
      smoke: launched.connections['preview-motion-ready'],
      backend: launched.connections['backend-ready'],
      sweepDir,
      startedAt: new Date().toISOString()
    },
    null,
    2
  ),
  { encoding: 'utf8', mode: 0o600 }
)
// The file contains the per-run command capability. Tighten an existing
// well-known file too: writeFile's mode only applies when it creates the file.
chmodSync(UI_DRIVER_CONNECTION_FILE, 0o600)
console.log(`UI driver ready — connection info at ${UI_DRIVER_CONNECTION_FILE}`)
console.log(`Sweep captures: ${sweepDir}`)

// Keep the app alive until this process is killed.
setInterval(() => {}, 60_000)
