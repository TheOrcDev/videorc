// probe:ui-glass on the GPUI app (`VIDEORC_APP=gpui`; plan 260 smoke port,
// Batch A). Electron's probe launches the dev app, puts stand-in wallpapers
// behind each window and REGION-captures the screen (`screencapture -R`).
// That cannot be the GPUI probe: a region capture records whatever else is on
// screen, and the owner uses this Mac. This one measures the Videorc windows
// ALONE: `screencapture -x -o -l <window id>` returns that window's own pixels
// (with its alpha channel), covered or not, and never the screen.
//
// What the solid-palette checks mean for a window-only capture:
//
//   opaquePixels   Electron: the pixels do not change over five different
//                  desktops behind the window. Window-only: every pixel of the
//                  sample has alpha 255 (nothing shows through), and two
//                  captures a moment apart are identical (nothing moves). A
//                  translucent window has alpha < 255; one that tracks what
//                  is behind it changes between captures.
//   followsTheme   the sample's ground is dark under the dark theme and light
//                  under the light one (Electron reads the page's `dark` class;
//                  GPUI has none), except the Preview, pinned dark.
//   pinnedDark     the Preview's sample stays dark under the light theme.
//   foreground / muted-foreground / subtle contrast
//                  the app's own text tokens (`window-theme-tokens`) against the
//                  worst pixel of each text-free sample, at the WCAG ratios.
//
// Not ported, each named in the report as a SKIP with its reason:
//   mode solid / noVibrancy   the GPUI windows are Metal-drawn: the app has no
//                  NSVisualEffectView and no glass mode to read back. The
//                  alpha check above is the real evidence of opacity.
//   noGround       there is no chrome-ground image in the GPUI app to mount.
//   --surfaces / --style / --persistence / --frost-check   they drive Chromium
//                  CSS (injected float surfaces, backdrop-filter) and the
//                  clear-glass AppKit material; neither exists on GPUI.
//
// The run never activates the app (`raise-window` with `focus: false`), takes
// `~/videorc-app-run.lock` while the app runs, uses an isolated profile, and
// needs Screen Recording permission for the terminal as the gallery does.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { launchDevApp, repoRoot, gpuiAppBinaryPath } from './lib/app-launcher.mjs'
import { requireAppRunLock } from './lib/app-run-lock.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { decodePng, parseHexColor } from './lib/image-stats.mjs'
import { evaluateGpuiGround, GPUI_GROUND_SAMPLES } from './lib/ui-glass-gpui.mjs'

const OPEN_COMMAND = {
  chat: 'comments-window-open',
  captions: 'captions-window-open',
  notes: 'notes-window-open'
}
const SET_BOUNDS_COMMAND = {
  chat: 'comments-window-set-bounds',
  captions: 'captions-window-set-bounds',
  notes: 'notes-window-set-bounds'
}
const WINDOW_SIZE = { width: 1100, height: 700 }
const SETTLE_MS = 700
const SECOND_CAPTURE_MS = 500

export async function run(argv) {
  const flag = (name) => argv.includes(`--${name}`)
  const option = (name, fallback) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
  const gate = flag('gate')
  const themes = option('themes', 'dark,light').split(',')
  const roles = option('roles', 'main,chat,captions,notes').split(',')
  const report = {
    app: 'gpui',
    gate,
    themes,
    roles,
    results: [],
    skips: [],
    validity: { status: 'VALID', samples: [] }
  }
  const skip = (name, reason) => {
    report.skips.push({ name, reason })
    console.log(`SKIP ${name}: ${reason}`)
  }
  for (const [name, reason] of [
    ['mode / noVibrancy', 'GPUI windows have no NSVisualEffectView or glass mode to read back'],
    ['noGround', 'the GPUI app has no chrome-ground image to mount'],
    [
      'preview window',
      "`raise-window` has no preview role on GPUI; the Preview's dark-always chrome is held by the preview probes"
    ]
  ]) {
    skip(name, reason)
  }
  for (const name of ['surfaces', 'style', 'persistence', 'frost-check']) {
    if (flag(name) || argv.some((arg) => arg.startsWith(`--${name}=`))) {
      skip(
        `--${name}`,
        'Chromium CSS / clear-glass AppKit material only; the GPUI floating surfaces are solid Metal fills'
      )
    }
  }
  if (flag('dom-only')) {
    skip('--dom-only', 'there is no DOM; the window-only capture is the only measurement')
  }

  const bins = {
    app: gpuiAppBinaryPath(),
    backend:
      process.env.VIDEORC_GPUI_BACKEND_BINARY ?? join(repoRoot, 'target/debug/videorc-backend')
  }
  for (const [name, path] of Object.entries(bins)) {
    if (!existsSync(path)) throw new Error(`Build the GPUI ${name} first: ${path} is missing.`)
  }
  const outputRoot = resolve(process.env.VIDEORC_UI_GLASS_OUTPUT_DIR ?? tmpdir())
  mkdirSync(outputRoot, { recursive: true })
  const outputDir = mkdtempSync(join(outputRoot, 'videorc-ui-glass-gpui-'))
    const profile = join(outputDir, 'profile')
  mkdirSync(profile, { recursive: true })

  const lock = await requireAppRunLock({ lane: 'ui-glass-gpui' })
  let app = null
  let exitCode = 0
  try {
    app = await launchDevApp({
      env: {
        VIDEORC_APP: 'gpui',
        VIDEORC_SMOKE_COMMAND_SERVER: '1',
        VIDEORC_SMOKE_STATE_DIR: profile,
        VIDEORC_SMOKE_OUTPUT_DIR: profile,
        VIDEORC_APP_DATA_DIR: join(profile, 'app-data'),
        VIDEORC_USER_DATA_DIR: join(profile, 'user-data'),
        VIDEORC_DEV_BACKEND_PROFILE: 'debug'
      },
      spawnSpec: {
        command: bins.app,
        args: ['--backend', bins.backend, '--workspace', repoRoot],
        cwd: repoRoot
      },
      timeoutMs: Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180_000),
      requiredMarkers: ['preview-motion-ready', 'backend-ready']
    })
    const smoke = app.connections['preview-motion-ready']
    const command = (name, params = {}, timeoutMs = 30_000) =>
      requestSmokeCommand(smoke, name, params, { timeoutMs })

    for (const role of roles) {
      if (OPEN_COMMAND[role]) {
        await command(OPEN_COMMAND[role])
        await delay(SETTLE_MS)
        await command(SET_BOUNDS_COMMAND[role], { x: 120, y: 60, ...WINDOW_SIZE })
      }
    }
    await command('main-window-set-bounds', { x: 80, y: 40, ...WINDOW_SIZE })
    await delay(SETTLE_MS)

    // The window's own capture id, from `raise-window`: never a guess by
    // size (every probe window is placed at the same size, so a nearest match
    // could measure the wrong window under the right name).
    const windowIdFor = async (role, raisedId) => {
      if (!Number.isInteger(raisedId)) throw new Error(`raise-window gave no window id for ${role}.`)
      return raisedId
    }

    // Roles outside, themes inside: each window is raised once (the owner uses
    // this Mac), then measured under each theme without raising it again.
    for (const role of roles) {
      // The Notes window is content-protected (hidden from capture and the
      // stream by design: `protected` in its state), so no window capture can
      // return its pixels. That is the feature, not a probe failure.
      if (role === 'notes') {
        const notes = await command('notes-window-state')
        if (notes.protected === true) {
          skip(
            'notes window',
            'content-protected by design (sharing type none): a window capture cannot return its pixels'
          )
          continue
        }
      }
      let windowId
      try {
        const raised = await command('raise-window', { role, level: 'floating', focus: false })
        await delay(SETTLE_MS)
        windowId = await windowIdFor(role, raised?.windowId)
      } catch (error) {
        report.validity.status = 'INVALID'
        report.validity.samples.push({ role, reason: String(error?.message ?? error) })
        console.error(`INVALID ${role}: ${error?.message ?? error}`)
        continue
      }
      for (const theme of themes) {
        await command('ui-appearance', { theme, increaseContrast: null, reduceMotion: null })
        const tokens = await command('window-theme-tokens')
        if (tokens.theme !== theme) {
          throw new Error(`The app draws ${tokens.theme}, not ${theme}: the theme was not applied.`)
        }
        const text = {
          foreground: parseHexColor(tokens.foreground),
          'muted-foreground': parseHexColor(tokens.mutedForeground),
          subtle: parseHexColor(tokens.subtle)
        }
        await delay(SETTLE_MS)
        const shots = []
        try {
          for (const attempt of [0, 1]) {
            const file = join(outputDir, `${theme}-${role}-${attempt}.png`)
            execFileSync('screencapture', ['-x', '-o', '-l', String(windowId), file], {
              stdio: 'pipe'
            })
            shots.push(decodePng(readFileSync(file)))
            if (attempt === 0) await delay(SECOND_CAPTURE_MS)
          }
        } catch (error) {
          report.validity.status = 'INVALID'
          report.validity.samples.push({
            role,
            theme,
            windowId,
            reason: `capture failed: ${String(error?.stderr ?? error?.message ?? error).trim()}`
          })
          console.error(`INVALID ${theme} ${role}: window ${windowId} could not be captured`)
          continue
        }
        const [first] = shots
        const points = { width: first.width / 2, height: first.height / 2 }
        for (const sample of GPUI_GROUND_SAMPLES[role] ?? []) {
          const scale = first.width / points.width
          const rect = Object.fromEntries(
            Object.entries(sample.rect(points)).map(([key, value]) => [key, value * scale])
          )
          const result = evaluateGpuiGround({ theme, role, images: shots, rect, text })
          report.results.push({ theme, role, sample: sample.name, ...result })
          const failed = Object.entries(result.checks)
            .filter(([, ok]) => !ok)
            .map(([name]) => name)
          console.log(
            `${result.pass ? 'PASS' : 'FAIL'} ${theme.padEnd(5)} ${role.padEnd(8)} ${sample.name.padEnd(15)} ${JSON.stringify(result.metrics)}${failed.length ? ` failed=${failed.join(',')}` : ''}`
          )
        }
      }
    }
  } catch (error) {
    report.error = String(error?.stack ?? error)
    report.validity.status = 'INVALID'
    console.error(report.error)
  } finally {
    try {
      await app?.stop()
    } catch {
      report.validity.status = 'INVALID'
      report.validity.samples.push({ role: 'probe', reason: 'owned-teardown-failed' })
    }
    lock.release()
  }
  report.outputDir = outputDir
  writeFileSync(join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const failures = report.results.filter((result) => !result.pass).length
  console.log(`report: ${join(outputDir, 'report.json')}`)
  if (report.validity.status === 'INVALID') {
    console.error(
      'probe:ui-glass (GPUI) INVALID: a window could not be captured; no verdict. Check Screen Recording permission for the terminal.'
    )
    exitCode = 1
  } else if (failures && gate) {
    console.error(`probe:ui-glass (GPUI) FAILED: ${failures} sample(s) outside the thresholds.`)
    exitCode = 1
  } else {
    console.log(gate ? 'probe:ui-glass (GPUI) PASSED' : 'probe:ui-glass (GPUI) report complete.')
  }
  return exitCode
}
