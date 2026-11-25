// Plan 260 Phase 3 (L6): `probe:preview-window` on the GPUI app
// (VIDEORC_APP=gpui; scripts/preview-window-probe.mjs hands over here).
// Electron's probe proves its surface stays glued to the window it shows in;
// this proves the same of the GPUI native preview with one oracle: the
// Preview on screen (`preview-surface-sample`, the composited window
// captured) against the frame the backend presents (`preview.debug.sample`,
// the debug backend's lease-free read), cell by cell over a 4 × 4 grid of the
// canvas. A layer that is off its slot, scaled wrong or not letterboxed the
// way the canvas fits reads other colours than the frame.
//
// 1. Docked in the Studio, at the main window's size.
// 2. Docked, after the main window is resized smaller and larger.
// 3. The Preview window (macOS): opened, then moved, then sized to a
//    non-16:9 frame (the video contain-fits inside), each aligned.
// 4. Closed by its close button: `closed`, no window; reopened with ⌘P,
//    aligned again; docked back with `preview-window-close`.
// 5. Docked on the Scene page (`sceneHostsDocked`): aligned in the canvas.
//
// A cell matches when every channel is within VIDEORC_PREVIEW_WINDOW_TOLERANCE
// (48: a screen capture goes through the display's colour profile); a place
// passes when at least 13 of 16 cells match (the test pattern's moving strip
// may differ between the two reads). Needs Screen Recording for the app
// process (the capture) and the debug backend (the oracle).

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  TOGGLE_PREVIEW_MODIFIERS,
  describePreview,
  enableTestPattern,
  launchGpuiApp,
  sleep,
  waitUntil,
  warmUiTree
} from './lib/gpui-preview-probe.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const presentBudgetMs = Number(process.env.VIDEORC_GPUI_PREVIEW_BUDGET_MS ?? 20000)
const tolerance = Number(process.env.VIDEORC_PREVIEW_WINDOW_TOLERANCE ?? 48)
const MIN_MATCHING_CELLS = 13
const SETTLE_MS = 600

/** The 4 × 4 grid of canvas cells. */
export const GRID = Array.from({ length: 16 }, (_, index) => ({
  x: (index % 4) * 0.25,
  y: Math.floor(index / 4) * 0.25,
  w: 0.25,
  h: 0.25
}))

/** The cells whose screen colour is within `tolerance` of the frame's. Pure. */
export function alignedCells(screen, frame, limit = tolerance) {
  return screen.map((cell, index) => {
    const other = frame[index]
    if (!cell || !other) return false
    return ['r', 'g', 'b'].every((channel) => Math.abs(cell[channel] - other[channel]) <= limit)
  })
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
  const { app, command, ui } = await launchGpuiApp({
    stateDir,
    timeoutMs,
    verbose: process.env.VIDEORC_SMOKE_VERBOSE === '1'
  })
  const ws = await connectBackend(app.connections['backend-ready'], timeoutMs)
  const rpc = (method, params = {}) => request(ws, 15000, method, params)
  const state = () => command('preview-window-state')
  const presenting = (seen) => seen?.phase === 'presenting' && seen?.closed !== true
  const settleAt = (what, holds) =>
    waitUntil(what, state, holds, { budgetMs: presentBudgetMs, label: describePreview })

  /** The screen against the frame, over the grid; throws on a misaligned place. */
  const aligned = async (where) => {
    await sleep(SETTLE_MS)
    const screen = await command('preview-surface-sample', { rects: GRID })
    if (screen.error) throw new Error(`${where}: the capture says ${screen.error}`)
    const frame = await rpc('preview.debug.sample', { rects: GRID })
    const matches = alignedCells(screen.samples ?? [], frame.samples ?? [])
    const count = matches.filter(Boolean).length
    const detail = {
      cells: `${count}/16`,
      stage: screen.stage,
      captured: `${screen.width}x${screen.height}`,
      frame: `${frame.width}x${frame.height}`
    }
    if (count < MIN_MATCHING_CELLS) {
      const off = matches.flatMap((match, index) => (match ? [] : [index]))
      throw new Error(
        `${where}: only ${count}/16 cells match the presented frame (off: ${off.join(', ')}; ` +
          `screen ${JSON.stringify(screen.samples?.[off[0]])} vs frame ${JSON.stringify(frame.samples?.[off[0]])}; ${JSON.stringify(detail)})`
      )
    }
    return detail
  }

  try {
    await step('docked in the Studio', async () => {
      await enableTestPattern(command)
      await warmUiTree(ui)
      await settleAt(
        'the docked preview never presented',
        (seen) => presenting(seen) && seen.mode === 'docked'
      )
      const probe = await rpc('preview.debug.sample', { rects: [GRID[5]] }).catch((error) => ({
        error: error.message
      }))
      if (probe.error) {
        throw new Error(`the oracle needs the debug backend (preview.debug.sample: ${probe.error})`)
      }
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
      await ui.press('p', { modifiers: TOGGLE_PREVIEW_MODIFIERS })
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

    await step('docked on the Scene page', async () => {
      await command('open-tab', { tab: 'scene' })
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
    ws.close()
    await app.stop()
    await writeFile(
      join(stateDir, 'gpui-preview-window.json'),
      JSON.stringify({ platform: process.platform, tolerance, steps }, null, 2)
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
