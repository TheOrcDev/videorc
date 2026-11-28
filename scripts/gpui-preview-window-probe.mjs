// Plan 260 Phase 3 (L6): `probe:preview-window` on the GPUI app
// (VIDEORC_APP=gpui; scripts/preview-window-probe.mjs hands over here).
// Electron's probe proves its surface stays glued to the window it shows in;
// this proves the same of the GPUI native preview with a geometry oracle that
// no animation can fool: after every move and resize, the rect Core Animation
// DISPLAYS for the video layer (`displayedFrame`, the presentation tree) must
// be the rect the app SET (`layerFrame`), and that must fill the slot the
// preview was laid out in (`slot`), each within 1 point
// (`native-preview-surface-status`). A colour comparison of the screen with
// the backend's frame can't serve: the test pattern animates its whole
// background, and a window capture takes about a second.
//
// 1. Docked in the Studio, at the main window's size.
// 2. Docked, after the main window is resized smaller and larger.
// 3. The Preview window (macOS): opened, then moved, then sized to a
//    non-16:9 frame, each aligned.
// 4. Closed by its close button: `closed`, no window; reopened with ⌘P,
//    aligned again; docked back with `preview-window-close`.
// 5. Docked back while the Studio window draws nothing (minimised, by the
//    app's own pid): the layer takes the slot's size at once, not the
//    Preview window's (#2580: it kept 960x540 in a 619x348 slot until the
//    main window drew again, >2 s under load). SKIPs, saying why, when
//    System Events can't minimise the window (no Accessibility grant).
// 6. Docked on the Scene page (`sceneHostsDocked`): aligned in the canvas.

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  describePreview,
  enableTestPattern,
  launchGpuiApp,
  sleep,
  waitUntil
} from './lib/gpui-preview-probe.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const presentBudgetMs = Number(process.env.VIDEORC_GPUI_PREVIEW_BUDGET_MS ?? 20000)

/** Within `limit` points. */
const near = (a, b, limit = 1) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= limit

/**
 * Why the layer is not where the slot is, or null when it is: the displayed
 * rect matches the set one, and the set one fills the slot. Pure.
 */
export function geometryMismatch(status) {
  const { layerFrame: set, displayedFrame: shown, slot } = status ?? {}
  if (!set || !shown || !slot) return `no geometry yet (${JSON.stringify({ set, shown, slot })})`
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!near(set[key], shown[key])) {
      return `Core Animation shows ${key} ${shown[key]}, the app set ${set[key]}`
    }
  }
  if (!near(set.width, slot.width) || !near(set.height, slot.height)) {
    return `the layer is ${set.width}x${set.height} in a ${slot.width}x${slot.height} slot`
  }
  return null
}

/** Waits up to 2 s for the layer to sit on its slot; throws with why not. */
export async function geometryAligned(command, where) {
  const until = Date.now() + 2000
  let status
  let why
  while (true) {
    status = await command('native-preview-surface-status')
    why = geometryMismatch(status)
    if (!why) {
      return {
        cells: 'aligned',
        slot: `${status.slot.width}x${status.slot.height}`
      }
    }
    if (Date.now() > until) throw new Error(`${where}: ${why}`)
    await sleep(100)
  }
}

/**
 * Minimises (or restores) the launched app's main window, found by its pid
 * (never by name: the owner's Videorc may be running). The Preview window
 * is titled "Preview"; the main window is every other one.
 */
async function minimiseMainWindow(pid, minimised) {
  const target = `(first process whose unix id is ${pid})`
  const run = (script) => promisify(execFile)('osascript', ['-e', script], { timeout: 10000 })
  await run(
    `tell application "System Events" to set value of attribute "AXMinimized" of (first window of ${target} whose name is not "Preview") to ${minimised}`
  )
  const { stdout } = await run(
    `tell application "System Events" to get value of attribute "AXMinimized" of (first window of ${target} whose name is not "Preview")`
  )
  return stdout.trim() === String(minimised)
}

const steps = []
function record(name, verdict, detail = {}) {
  steps.push({ name, verdict, ...detail })
  const words = detail.reason ?? detail.summary ?? ''
  console.log(`gpui-preview-window: ${verdict} ${name}${words ? ` — ${words}` : ''}`)
}

async function step(name, run) {
  try {
    const detail = (await run()) ?? {}
    record(name, detail.skip ? 'SKIP' : 'PASS', detail)
  } catch (error) {
    record(name, 'FAIL', { reason: error?.message ?? String(error) })
  }
}

export async function runGpuiPreviewWindowProbe() {
  const stateDir = resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
      (await mkdtemp(join(tmpdir(), 'videorc-gpui-preview-window-')))
  )
  const { app, command } = await launchGpuiApp({
    stateDir,
    timeoutMs,
    verbose: process.env.VIDEORC_SMOKE_VERBOSE === '1'
  })
  const state = () => command('preview-window-state')
  const presenting = (seen) => seen?.phase === 'presenting' && seen?.closed !== true
  const settleAt = (what, holds) =>
    waitUntil(what, state, holds, { budgetMs: presentBudgetMs, label: describePreview })

  const aligned = (where) => geometryAligned(command, where)

  try {
    await step('docked in the Studio', async () => {
      await enableTestPattern(command)
      await settleAt(
        'the docked preview never presented',
        (seen) => presenting(seen) && seen.mode === 'docked'
      )
      return { summary: JSON.stringify(await aligned('docked')) }
    })

    await step('docked, after the main window is resized', async () => {
      const results = []
      for (const size of [
        { width: 1000, height: 700 },
        { width: 1440, height: 900 },
        { width: 1180, height: 780 }
      ]) {
        await command('resize-window', size)
        await settleAt('the docked preview stopped presenting', presenting)
        results.push(
          `${size.width}x${size.height} ${(await aligned(`main ${size.width}x${size.height}`)).cells}`
        )
      }
      return { summary: results.join('; ') }
    })

    await step('the Preview window: opened, moved, and sized off 16:9', async () => {
      if ((await state())?.canFloat !== true) {
        return {
          skip: true,
          reason: 'the Preview window opens only on macOS with the native preview'
        }
      }
      await command('preview-window-open')
      await settleAt(
        'the Preview window never presented',
        (seen) => seen?.floatingOpen === true && presenting(seen)
      )
      const opened = await aligned('in its window')
      await command('preview-window-set-bounds', { x: 120, y: 120 })
      const moved = await aligned('moved')
      await command('preview-window-set-bounds', { width: 900, height: 420 })
      const wide = await aligned('sized 900x420')
      await command('preview-window-set-bounds', { width: 520, height: 640 })
      const tall = await aligned('sized 520x640')
      return {
        summary: `opened ${opened.cells}, moved ${moved.cells}, 900x420 ${wide.cells}, 520x640 ${tall.cells}`
      }
    })

    await step('closed by its button, reopened with ⌘P, docked back', async () => {
      if ((await state())?.canFloat !== true) {
        return {
          skip: true,
          reason: 'the Preview window opens only on macOS with the native preview'
        }
      }
      await command('preview-window-os-close')
      await waitUntil(
        'closing the window by its button never left the Preview closed',
        state,
        (seen) => seen?.closed === true && seen?.floatingOpen === false,
        { budgetMs: 5000, label: describePreview }
      )
      await command('preview-toggle-open')
      await settleAt(
        '⌘P never reopened the Preview window',
        (seen) => seen?.floatingOpen === true && presenting(seen)
      )
      const reopened = await aligned('reopened')
      await command('preview-window-close')
      await settleAt(
        'the Preview never docked back',
        (seen) => seen?.mode === 'docked' && presenting(seen)
      )
      const docked = await aligned('docked back')
      return { summary: `reopened ${reopened.cells}, docked back ${docked.cells}` }
    })

    await step('docked back while the Studio window draws nothing', async () => {
      if ((await state())?.canFloat !== true) {
        return {
          skip: true,
          reason: 'the Preview window opens only on macOS with the native preview'
        }
      }
      const { pid } = JSON.parse(
        await readFile(join(stateDir, 'profile', 'videorc-app.instance'), 'utf8')
      )
      await command('preview-window-open')
      await settleAt(
        'the Preview window never presented',
        (seen) => seen?.floatingOpen === true && presenting(seen)
      )
      const floating = await aligned('in its window, before docking back')
      try {
        if (!(await minimiseMainWindow(pid, true))) {
          throw new Error('the Studio window did not report AXMinimized')
        }
      } catch (error) {
        await command('preview-window-close')
        return {
          skip: true,
          reason: `System Events could not minimise the Studio window (Accessibility grant?): ${error?.message ?? error}`
        }
      }
      try {
        await command('preview-window-close')
        await waitUntil(
          'the Preview never docked back',
          state,
          (seen) => seen?.mode === 'docked' && seen?.floatingOpen === false,
          { budgetMs: 5000, label: describePreview }
        )
        const docked = await aligned('docked back while the Studio window is minimised')
        return { summary: `floating ${floating.cells}, docked back unseen ${docked.cells}` }
      } finally {
        await minimiseMainWindow(pid, false).catch(() => {})
        await settleAt('the docked preview never presented again', presenting)
      }
    })

    await step('docked on the Scene page', async () => {
      await command('open-tab', { tab: 'layout' })
      const { value } = await settleAt('the Scene page never hosted the preview', presenting)
      if (value.sceneHostsDocked !== true) {
        return {
          skip: true,
          reason: `the Scene canvas does not host the docked preview here (${describePreview(value)})`
        }
      }
      const scene = await aligned('on the Scene page')
      await command('open-tab', { tab: 'studio' })
      return { summary: `scene canvas ${scene.cells}` }
    })
  } finally {
    await app.stop()
    await writeFile(
      join(stateDir, 'gpui-preview-window.json'),
      JSON.stringify({ platform: process.platform, steps }, null, 2)
    )
    console.log(`gpui-preview-window: evidence ${join(stateDir, 'gpui-preview-window.json')}`)
  }
  const failed = steps.filter((each) => each.verdict === 'FAIL')
  console.log(`gpui-preview-window: ${failed.length ? `FAIL (${failed.length})` : 'PASS'}`)
  return failed.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGpuiPreviewWindowProbe().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error?.stack ?? String(error))
      process.exitCode = 1
    }
  )
}
