// Plan 260 Phase 3 (L6): `smoke:preview-surface` on the GPUI app
// (VIDEORC_APP=gpui; scripts/smoke-preview-surface-app.mjs hands over here).
// Electron's promise: the native surface's lifecycle and placement are owned
// by its presenter. On GPUI the element is the presenter: what it tells the
// backend (the surface bounds it last sent) must match where its layer is,
// and the backend's own surface record must follow the lifecycle
// (docs/gpui/native-preview-probes.md).
//
// At each place (docked; after main-window resizes; floating, moved and
// sized; closed; reopened; after Retry):
// - presenting: the backend record (`preview.surface.status`) is live with
//   `presentedFrameId` advancing; the last-sent bounds are the slot's size
//   (within 1 point) and visible;
// - closed: the last-sent bounds say `visible: false` (or none are live) and
//   nothing presents.
// `droppedFrames` and `compositorFrameLag` are reported, not gated.

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
const near = (a, b, limit = 1) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= limit

/** Why the last-sent bounds don't describe the slot, or null. Pure. */
export function boundsMismatch(surface) {
  const sent = surface?.lastBounds
  const slot = surface?.bounds
  if (!sent || !slot) return `no bounds yet (${JSON.stringify({ sent, slot })})`
  if (sent.visible === false) return 'the bounds sent say the preview is hidden'
  if (!near(sent.width, slot.width) || !near(sent.height, slot.height)) {
    return `the backend was told ${sent.width}x${sent.height} for a ${slot.width}x${slot.height} slot`
  }
  return null
}

const steps = []
function record(name, verdict, detail = {}) {
  steps.push({ name, verdict, ...detail })
  const words = detail.reason ?? detail.summary ?? ''
  console.log(`gpui-preview-surface: ${verdict} ${name}${words ? ` — ${words}` : ''}`)
}

export async function runGpuiPreviewSurface() {
  const stateDir = resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
      (await mkdtemp(join(tmpdir(), 'videorc-gpui-preview-surface-')))
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

  /** The backend record live and advancing, and the sent bounds on the slot. */
  const placed = async (where) => {
    const until = Date.now() + 3000
    let why
    let surface
    while (true) {
      surface = await command('native-preview-surface-status')
      why = boundsMismatch(surface)
      if (!why) break
      if (Date.now() > until) throw new Error(`${where}: ${why}`)
      await sleep(150)
    }
    const first = await rpc('preview.surface.status')
    await sleep(1000)
    const last = await rpc('preview.surface.status')
    const advanced = (last?.presentedFrameId ?? 0) - (first?.presentedFrameId ?? 0)
    if (last?.state !== 'live') throw new Error(`${where}: the backend's surface is ${last?.state}`)
    if (!(advanced > 0)) throw new Error(`${where}: the backend's surface presented nothing in 1 s`)
    return `${surface.slot?.width ?? surface.bounds.width}x${surface.bounds.height}, +${advanced} frames, dropped ${last?.droppedFrames ?? '?'}, lag ${last?.compositorFrameLag ?? '?'}`
  }
  const step = async (name, run) => {
    try {
      const summary = (await run()) ?? {}
      if (summary.skip) record(name, 'SKIP', summary)
      else record(name, 'PASS', { summary })
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
    await step('docked', () => placed('docked'))
    await step('docked, after main-window resizes', async () => {
      const results = []
      for (const size of [
        { width: 1000, height: 700 },
        { width: 1440, height: 900 },
        { width: 1180, height: 780 }
      ]) {
        await command('resize-window', size)
        results.push(
          `${size.width}x${size.height}: ${await placed(`main ${size.width}x${size.height}`)}`
        )
      }
      return results.join('; ')
    })
    await step('floating, moved and sized', async () => {
      if ((await state())?.canFloat !== true) {
        return {
          skip: true,
          reason: 'the Preview window opens only on macOS with the native preview'
        }
      }
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
      const opened = await placed('floating')
      await command('preview-window-set-bounds', { x: 160, y: 140, width: 900, height: 420 })
      const sized = await placed('floating 900x420')
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
      return `opened ${opened}; 900x420 ${sized}`
    })
    await step('closed, then reopened', async () => {
      await command('preview-toggle-open')
      await waitUntil('⌘P never closed the Preview', state, (seen) => seen?.closed === true, {
        budgetMs: 5000,
        label: describePreview
      })
      await sleep(1000)
      const closed = await command('native-preview-surface-status')
      const first = closed?.presentedFrameId
      await sleep(800)
      const later = (await command('native-preview-surface-status'))?.presentedFrameId
      if (typeof first === 'number' && typeof later === 'number' && later !== first) {
        throw new Error(`a closed Preview still presented (${first} → ${later})`)
      }
      if (closed?.lastBounds && closed.lastBounds.visible !== false) {
        throw new Error(
          'the bounds the backend holds still say visible while the Preview is closed'
        )
      }
      await command('preview-toggle-open')
      await waitUntil('⌘P never reopened the Preview', state, presenting, {
        budgetMs: presentBudgetMs,
        label: describePreview
      })
      return `closed: nothing presented, bounds hidden; reopened ${await placed('reopened')}`
    })
    await step('after Retry', async () => {
      await command('preview-retry')
      await waitUntil('Retry never presented again', state, presenting, {
        budgetMs: presentBudgetMs,
        label: describePreview
      })
      return placed('after Retry')
    })
  } finally {
    ws.close()
    await app.stop()
    await writeFile(
      join(stateDir, 'gpui-preview-surface.json'),
      JSON.stringify({ platform: process.platform, steps }, null, 2)
    )
  }
  const failed = steps.filter((each) => each.verdict === 'FAIL')
  console.log(`gpui-preview-surface: ${failed.length ? `FAIL (${failed.length})` : 'PASS'}`)
  return failed.length ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGpuiPreviewSurface().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error?.stack ?? String(error))
      process.exitCode = 1
    }
  )
}
