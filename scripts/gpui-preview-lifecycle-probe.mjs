// Plan 260 Phase 3 (L6): `probe:preview-lifecycle` on the GPUI app
// (VIDEORC_APP=gpui; scripts/preview-lifecycle-probe.mjs hands over here).
// Electron's probe proves its detached window's lifecycle and budgets; this
// one proves the GPUI native preview's, through the paths a person takes:
//
// 1. Docked and presenting: the element shows frames (`presentedFrameId`
//    advances) with the test pattern on.
// 2. Retry while presenting (P117, P146; `Preview::retry`): `retried: true`,
//    the log says `retry preview (1)` (and `reset-native-path` on macOS), and
//    the phase is back at presenting with frames advancing.
// 3. ⌘P cycles (P131, P541): Close Preview (`closed: true`, nothing shown),
//    then ⌘P opens it where it was, presenting again. Repeated
//    VIDEORC_PREVIEW_LIFECYCLE_CYCLES times (10) so it never sticks. A
//    closed Preview parks (L1's #2207, as Electron's close): no frame
//    presents while it is closed, and the status says why ("The Preview is
//    closed: no surface until it opens.").
// 4. The Preview window (macOS): open, ⌘P closes it and reopens it as a
//    window, its close button (`preview-window-os-close`, the should-close
//    path) leaves the Preview closed, ⌘P opens the window again, and
//    `preview-window-close` docks it back.
// 5. Retry after the backend surface is torn down (`preview.surface.destroy`):
//    Retry brings it back presenting. A forced first-frame fallback has no
//    switch in the GPUI app yet: that case is a named SKIP.
//
// Functional contract only (no fps or memory budgets). Evidence:
// <VIDEORC_SMOKE_OUTPUT_DIR or a temp dir>/gpui-preview-lifecycle.json.

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  describePreview,
  enableTestPattern,
  launchGpuiApp,
  logLinesSince,
  presentedAdvance,
  waitUntil
} from './lib/gpui-preview-probe.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const cycles = Math.max(1, Number(process.env.VIDEORC_PREVIEW_LIFECYCLE_CYCLES ?? 10))
const presentBudgetMs = Number(process.env.VIDEORC_GPUI_PREVIEW_BUDGET_MS ?? 20000)
const sampleMs = 1000
const mac = process.platform === 'darwin'

const steps = []
function record(name, verdict, detail = {}) {
  steps.push({ name, verdict, ...detail })
  const words = detail.reason ?? detail.summary ?? ''
  console.log(`gpui-preview-lifecycle: ${verdict} ${name}${words ? ` — ${words}` : ''}`)
}

async function step(name, run) {
  try {
    const detail = (await run()) ?? {}
    record(name, detail.skip ? 'SKIP' : 'PASS', detail)
  } catch (error) {
    record(name, 'FAIL', { reason: error?.message ?? String(error) })
  }
}

export async function runGpuiPreviewLifecycleProbe() {
  const stateDir = resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
      (await mkdtemp(join(tmpdir(), 'videorc-gpui-preview-lifecycle-')))
  )
  const { app, command, logs } = await launchGpuiApp({
    stateDir,
    timeoutMs,
    verbose: process.env.VIDEORC_SMOKE_VERBOSE === '1'
  })
  const ws = await connectBackend(app.connections['backend-ready'], timeoutMs)
  const rpc = (method, params = {}) => request(ws, 15000, method, params)
  const state = () => command('preview-window-state')
  const phaseOf = (seen) => describePreview(seen)
  const presenting = (seen) => seen?.phase === 'presenting' && seen?.closed !== true
  // Window → Preview / ⌘P: the `TogglePreview` action itself, as the menu
  // dispatches it (the UI driver's keys need the accessibility tree, which a
  // smoke run can't switch on yet).
  const togglePreview = () => command('preview-toggle-open')
  const framesAdvance = async (what) => {
    const { advance, last } = await presentedAdvance(command, sampleMs)
    if (!(advance > 0)) {
      throw new Error(`${what}: no frames presented in ${sampleMs} ms (${JSON.stringify(last)})`)
    }
    return advance
  }
  let canFloat = false
  try {
    await step('docked and presenting', async () => {
      await enableTestPattern(command)
      const { value } = await waitUntil(
        'the docked preview never presented',
        state,
        (seen) => presenting(seen) && seen.mode === 'docked',
        { budgetMs: presentBudgetMs, label: phaseOf }
      )
      canFloat = value.canFloat === true
      const advance = await framesAdvance('docked')
      return { summary: `${advance} frames in ${sampleMs} ms; canFloat ${canFloat}` }
    })

    await step('retry while presenting', async () => {
      const mark = logs.length
      const retried = await command('preview-retry')
      if (retried?.retried !== true) throw new Error(`retried: ${JSON.stringify(retried)}`)
      const { trail } = await waitUntil(
        'the retried preview never presented again',
        state,
        (seen) => presenting(seen),
        { budgetMs: presentBudgetMs, label: phaseOf }
      )
      const rearmed = logLinesSince(logs, mark, /\[preview\] retry preview \(\d+\)/)
      if (!rearmed.length) throw new Error('the log never said "retry preview (n)"')
      if (mac && !logLinesSince(logs, mark, /reset-native-path/).length) {
        throw new Error('the log never said reset-native-path')
      }
      const advance = await framesAdvance('after retry')
      return { summary: `phases [${trail.join(' → ')}], ${advance} frames after`, trail }
    })

    await step(`⌘P close and reopen, ${cycles} cycles`, async () => {
      const whileClosed = []
      const reopenMs = []
      for (let cycle = 1; cycle <= cycles; cycle++) {
        await togglePreview()
        const { value: closed } = await waitUntil(
          `cycle ${cycle}: ⌘P never closed the Preview`,
          state,
          (seen) => seen?.closed === true && seen?.open === false,
          { budgetMs: 5000, label: phaseOf }
        )
        if (closed.floatingOpen) throw new Error(`cycle ${cycle}: closed with its window open`)
        const parked = await presentedAdvance(command, 300)
        whileClosed.push(parked.advance)
        if (parked.advance > 0) {
          throw new Error(
            `cycle ${cycle}: the closed Preview still presented ${parked.advance} frames in 300 ms`
          )
        }
        if (!/closed/i.test(parked.last?.message ?? '')) {
          throw new Error(
            `cycle ${cycle}: a parked Preview's status should say it is closed, got ${JSON.stringify(parked.last?.message)}`
          )
        }
        const opened = Date.now()
        await togglePreview()
        await waitUntil(
          `cycle ${cycle}: ⌘P never reopened the Preview`,
          state,
          (seen) => presenting(seen) && seen.mode === 'docked',
          { budgetMs: presentBudgetMs, label: phaseOf }
        )
        reopenMs.push(Date.now() - opened)
      }
      await framesAdvance('after the cycles')
      return {
        summary: `reopened in ≤ ${Math.max(...reopenMs)} ms; frames while closed ${JSON.stringify(whileClosed)}`,
        reopenMs,
        framesWhileClosed: whileClosed
      }
    })

    await step('the Preview window: ⌘P, its close button, and docking back', async () => {
      if ((await state())?.canFloat !== true) {
        return {
          skip: true,
          reason: 'the Preview window opens only on macOS with the native preview'
        }
      }
      await command('preview-window-open')
      await waitUntil(
        'the Preview window never opened',
        state,
        (seen) => seen?.floatingOpen === true && presenting(seen),
        {
          budgetMs: presentBudgetMs,
          label: phaseOf
        }
      )
      await framesAdvance('in its window')
      await togglePreview()
      await waitUntil(
        '⌘P never closed the Preview window',
        state,
        (seen) => seen?.closed === true && seen?.floatingOpen === false,
        {
          budgetMs: 5000,
          label: phaseOf
        }
      )
      await togglePreview()
      await waitUntil(
        '⌘P never reopened the Preview as a window',
        state,
        (seen) => seen?.closed === false && seen?.floatingOpen === true && presenting(seen),
        { budgetMs: presentBudgetMs, label: phaseOf }
      )
      await command('preview-window-os-close')
      await waitUntil(
        'closing the window by its button never left the Preview closed',
        state,
        (seen) => seen?.closed === true && seen?.floatingOpen === false,
        { budgetMs: 5000, label: phaseOf }
      )
      await togglePreview()
      await waitUntil(
        '⌘P never reopened the hand-closed Preview window',
        state,
        (seen) => seen?.floatingOpen === true && presenting(seen),
        { budgetMs: presentBudgetMs, label: phaseOf }
      )
      await command('preview-window-close')
      await waitUntil(
        'the Preview never docked back',
        state,
        (seen) => seen?.mode === 'docked' && seen?.floatingOpen === false && presenting(seen),
        { budgetMs: presentBudgetMs, label: phaseOf }
      )
      const advance = await framesAdvance('docked back')
      return { summary: `docked back, ${advance} frames` }
    })

    await step('retry after the backend surface is torn down', async () => {
      await rpc('preview.surface.destroy')
      // The watch may heal on its own; either way Retry must bring it back.
      const mark = logs.length
      const retried = await command('preview-retry')
      if (retried?.retried !== true) throw new Error(`retried: ${JSON.stringify(retried)}`)
      const { trail } = await waitUntil(
        'the preview never presented after Retry',
        state,
        (seen) => presenting(seen),
        { budgetMs: presentBudgetMs, label: phaseOf }
      )
      if (!logLinesSince(logs, mark, /\[preview\] retry preview \(\d+\)/).length) {
        throw new Error('the log never said "retry preview (n)"')
      }
      const advance = await framesAdvance('after the torn-down retry')
      return { summary: `phases [${trail.join(' → ')}], ${advance} frames after` }
    })

    record('retry after a forced first-frame fallback', 'SKIP', {
      reason:
        'the GPUI app has no switch that forces the first-frame fallback yet (the budget is 15 s of no frames)'
    })
  } finally {
    ws.close()
    await app.stop()
    await writeFile(
      join(stateDir, 'gpui-preview-lifecycle.json'),
      JSON.stringify({ platform: process.platform, cycles, steps }, null, 2)
    )
    console.log(`gpui-preview-lifecycle: evidence ${join(stateDir, 'gpui-preview-lifecycle.json')}`)
  }
  const failed = steps.filter((each) => each.verdict === 'FAIL')
  console.log(`gpui-preview-lifecycle: ${failed.length ? `FAIL (${failed.length})` : 'PASS'}`)
  return failed.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGpuiPreviewLifecycleProbe().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error?.stack ?? String(error))
      process.exitCode = 1
    }
  )
}
