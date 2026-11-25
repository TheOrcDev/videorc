// Plan 260 Phase 3 (L6): `smoke:preview-pump-diagnostics` on the GPUI app
// (VIDEORC_APP=gpui; scripts/smoke-preview-pump-diagnostics-app.mjs hands over
// here). Electron's promise: a present that is skipped says why, so the
// preview never starves silently. The GPUI version (docs/gpui/
// native-preview-probes.md): whenever the element is not presenting, its
// status names a reason, and its counters say what happened.
//
// 1. Docked and presenting; a sampler reads `native-preview-surface-status`
//    and the phase every 100 ms from here on.
// 2. The backend surface torn down (`preview.surface.destroy`): the preview
//    heals by itself or Retry brings it back.
// 3. Close Preview (the menu's ⌘P): parked, nothing presents, the status says
//    it is closed; then opened again.
// Through it all: every sample that isn't presenting carries a message, and
// `skipped`, `refused` and `dropped` only grow.

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

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const presentBudgetMs = Number(process.env.VIDEORC_GPUI_PREVIEW_BUDGET_MS ?? 20000)
const COUNTERS = ['skipped', 'refused', 'dropped']

/** The problems in a run of samples: silent waits and shrinking counters. Pure. */
export function pumpProblems(samples) {
  const problems = []
  const silent = samples.filter(
    (sample) =>
      sample.phase && sample.phase !== 'presenting' && !String(sample.message ?? '').trim()
  )
  if (silent.length) {
    problems.push(
      `${silent.length} sample(s) not presenting gave no reason (first in phase ${silent[0].phase})`
    )
  }
  for (const key of COUNTERS) {
    for (let index = 1; index < samples.length; index++) {
      const before = samples[index - 1][key]
      const after = samples[index][key]
      if (typeof before === 'number' && typeof after === 'number' && after < before) {
        problems.push(`${key} went back from ${before} to ${after}`)
        break
      }
    }
  }
  return problems
}

const steps = []
function record(name, verdict, detail = {}) {
  steps.push({ name, verdict, ...detail })
  const words = detail.reason ?? detail.summary ?? ''
  console.log(`gpui-pump-diagnostics: ${verdict} ${name}${words ? ` — ${words}` : ''}`)
}

export async function runGpuiPreviewPumpDiagnostics() {
  const stateDir = resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
      (await mkdtemp(join(tmpdir(), 'videorc-gpui-pump-diagnostics-')))
  )
  const { app, command } = await launchGpuiApp({
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
      samples.push({
        at,
        phase: seen?.closed ? 'closed' : (seen?.phase ?? null),
        message: surface?.message ?? null,
        presented: surface?.presentedFrameId ?? null,
        skipped: surface?.skipped ?? null,
        refused: surface?.refused ?? null,
        dropped: surface?.dropped ?? null
      })
      await sleep(100)
    }
  })()
  const window = async (name, run) => {
    const from = samples.length
    try {
      const summary = await run()
      const slice = samples.slice(from)
      const problems = pumpProblems(slice)
      record(name, problems.length ? 'FAIL' : 'PASS', {
        summary: `${summary}; ${slice.length} samples, phases [${[...new Set(slice.map((s) => s.phase))].join(', ')}]`,
        problems
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

    await window('the backend surface torn down', async () => {
      await rpc('preview.surface.destroy')
      await sleep(4000)
      let healed = presenting(await state())
      if (!healed) {
        await command('preview-retry')
        await waitUntil('Retry never brought the preview back', state, presenting, {
          budgetMs: presentBudgetMs,
          label: describePreview
        })
      }
      return healed ? 'healed by itself' : 'Retry brought it back'
    })

    await window('Close Preview parks it', async () => {
      await command('preview-toggle-open')
      await waitUntil('⌘P never closed the Preview', state, (seen) => seen?.closed === true, {
        budgetMs: 5000,
        label: describePreview
      })
      const parkedFrom = samples.length
      await sleep(2000)
      const parked = samples.slice(parkedFrom).map((sample) => sample.presented)
      const moved = parked.filter((id) => typeof id === 'number')
      if (moved.length > 1 && moved.at(-1) !== moved[0]) {
        throw new Error(`a closed Preview presented frames ${moved[0]} → ${moved.at(-1)}`)
      }
      await command('preview-toggle-open')
      await waitUntil('⌘P never reopened the Preview', state, presenting, {
        budgetMs: presentBudgetMs,
        label: describePreview
      })
      return 'parked 2 s with no frames, reopened'
    })
  } finally {
    sampling = false
    await sampler
    ws.close()
    await app.stop()
    await writeFile(
      join(stateDir, 'gpui-pump-diagnostics.json'),
      JSON.stringify({ platform: process.platform, steps, samples }, null, 2)
    )
  }
  const counters = samples.at(-1) ?? {}
  console.log(
    `gpui-pump-diagnostics: counters at the end skipped ${counters.skipped} refused ${counters.refused} dropped ${counters.dropped}`
  )
  const failed = steps.filter((each) => each.verdict === 'FAIL')
  console.log(`gpui-pump-diagnostics: ${failed.length ? `FAIL (${failed.length})` : 'PASS'}`)
  return failed.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGpuiPreviewPumpDiagnostics().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error?.stack ?? String(error))
      process.exitCode = 1
    }
  )
}
