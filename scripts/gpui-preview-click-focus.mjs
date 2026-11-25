// Plan 260 Phase 3 (L6): `smoke:preview-click-focus` on the GPUI app
// (VIDEORC_APP=gpui; scripts/smoke-preview-click-focus-app.mjs hands over
// here). Electron's promise: clicking or focusing the detached preview neither
// stops presentation nor strands scene updates. The GPUI version
// (docs/gpui/native-preview-probes.md), for the Preview window and the docked
// slot:
//
// 1. The Preview window open and presenting; a click into its video.
// 2. Focus moved between the main window and the Preview window five times.
// 3. Docked back; a click into the docked slot.
// Between the steps a new scene is committed (`scene.layout.apply_preview`).
// Through it all the preview keeps presenting (never still more than 1 s) and
// `presentedSceneRevision` reaches each committed scene within 2 s.

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  describePreview,
  enableTestPattern,
  launchGpuiApp,
  sleep,
  waitUntil
} from './lib/gpui-preview-probe.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'
import { continuity, continuityFailures } from './gpui-preview-interaction-stress.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const presentBudgetMs = Number(process.env.VIDEORC_GPUI_PREVIEW_BUDGET_MS ?? 20000)
const video = { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
const CORNERS = ['bottom-right', 'top-left', 'top-right', 'bottom-left']
/** The overlay-presentation smoke's full layout; only the corner moves. */
const LAYOUT = {
  layoutPreset: 'screen-only',
  cameraTransformMode: 'preset',
  cameraTransform: null,
  cameraCorner: 'bottom-right',
  cameraSize: 'medium',
  cameraShape: 'rectangle',
  cameraMargin: 32,
  cameraFit: 'fill',
  cameraMirror: false,
  cameraZoom: 100,
  cameraOffsetX: 0,
  cameraOffsetY: 0,
  sideBySideSplit: '70-30',
  sideBySideCameraSide: 'right'
}

const steps = []
function record(name, verdict, detail = {}) {
  steps.push({ name, verdict, ...detail })
  const words = detail.reason ?? detail.summary ?? ''
  console.log(`gpui-click-focus: ${verdict} ${name}${words ? ` — ${words}` : ''}`)
}

export async function runGpuiPreviewClickFocus() {
  const stateDir = resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
      (await mkdtemp(join(tmpdir(), 'videorc-gpui-click-focus-')))
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
  const samples = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const at = Date.now()
      const [surface, seen] = await Promise.all([
        command('native-preview-surface-status').catch(() => null),
        state().catch(() => null)
      ])
      samples.push({ at, presented: surface?.presentedFrameId ?? null, phase: seen?.phase ?? null })
      await sleep(100)
    }
  })()
  let corner = 0
  /** A new scene (the camera corner moved) and the preview catching up with it. */
  const commitScene = async () => {
    corner = (corner + 1) % CORNERS.length
    await rpc('scene.layout.apply_preview', {
      sources: { testPattern: true },
      layout: { ...LAYOUT, cameraCorner: CORNERS[corner] },
      video
    })
    const target = (await rpc('compositor.status'))?.sceneRevision
    await waitUntil(
      `the preview never showed scene ${target}`,
      () => command('native-preview-surface-status'),
      (surface) => typeof target === 'number' && (surface?.presentedSceneRevision ?? 0) >= target,
      { budgetMs: 2000, everyMs: 100 }
    )
    return target
  }
  /** The centre of the slot, in the window that shows the preview. */
  const slotCentre = async () => {
    const { bounds } = await command('native-preview-surface-status')
    if (!bounds) throw new Error('the preview reports no slot')
    return [Math.round(bounds.x + bounds.width / 2), Math.round(bounds.y + bounds.height / 2)]
  }
  const step = async (name, run) => {
    const from = samples.length
    try {
      const summary = await run()
      const judged = continuity(samples.slice(from))
      const failures = continuityFailures(name, judged)
      record(name, failures.length ? 'FAIL' : 'PASS', {
        summary: `${summary}; still ≤ ${judged.longestStillMs} ms, +${judged.advance} frames`,
        failures
      })
    } catch (error) {
      record(name, 'FAIL', { reason: error?.message ?? String(error) })
    }
  }
  try {
    await enableTestPattern(command)
    await waitUntil('the preview never presented', state, presenting, {
      budgetMs: presentBudgetMs,
      label: describePreview
    })
    const canFloat = (await state())?.canFloat === true

    if (canFloat) {
      await step('a click into the Preview window', async () => {
        await command('preview-window-open')
        await waitUntil(
          'the Preview window never presented',
          state,
          (seen) => seen?.floatingOpen && presenting(seen),
          {
            budgetMs: presentBudgetMs,
            label: describePreview
          }
        )
        const [x, y] = await slotCentre()
        await ui.clickAt(x, y, { window: 'preview' })
        await sleep(1500)
        const revision = await commitScene()
        return `clicked (${x}, ${y}); scene ${revision} shown`
      })

      await step('focus moved between the windows five times', async () => {
        const [x, y] = await slotCentre()
        for (let round = 0; round < 5; round++) {
          await command('main-window-focus')
          await sleep(300)
          await ui.clickAt(x, y, { window: 'preview' })
          await sleep(300)
        }
        const revision = await commitScene()
        return `scene ${revision} shown after the focus moves`
      })

      await command('preview-window-close')
      await waitUntil(
        'the Preview never docked back',
        state,
        (seen) => seen?.mode === 'docked' && presenting(seen),
        {
          budgetMs: presentBudgetMs,
          label: describePreview
        }
      )
    } else {
      record('the Preview window', 'SKIP', {
        reason: 'the Preview window opens only on macOS with the native preview'
      })
    }

    await step('a click into the docked slot', async () => {
      const [x, y] = await slotCentre()
      await ui.clickAt(x, y)
      await sleep(1500)
      const revision = await commitScene()
      return `clicked (${x}, ${y}); scene ${revision} shown`
    })
  } finally {
    sampling = false
    await sampler
    ws.close()
    await app.stop()
    await writeFile(
      join(stateDir, 'gpui-click-focus.json'),
      JSON.stringify({ platform: process.platform, steps }, null, 2)
    )
  }
  const failed = steps.filter((each) => each.verdict === 'FAIL')
  console.log(`gpui-click-focus: ${failed.length ? `FAIL (${failed.length})` : 'PASS'}`)
  return failed.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGpuiPreviewClickFocus().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error?.stack ?? String(error))
      process.exitCode = 1
    }
  )
}
