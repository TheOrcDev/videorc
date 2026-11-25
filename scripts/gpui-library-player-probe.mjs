// Plan 260 Phase 3 (L6): the Library player's layer geometry on the GPUI app.
// The session player draws on the same `VideoLayer` as the live preview
// (`tune_video_layer`), so #2212's size bug could reach it; this checks it
// the way `probe:preview-window` checks the preview.
//
//   VIDEORC_GPUI_APP_BINARY=… node scripts/gpui-library-player-probe.mjs
//
// 1. Records a short take with the test pattern (`studio-record`,
//    `studio-stop`) and waits for the session to end.
// 2. Opens the Library page and the take's player the way a person does:
//    the row's ⋯ (Session actions), then Markers (the dialog player).
// 3. Reads `session-player-geometry` until the player is open and placed:
//    the rect Core Animation displays (`displayedFrame`) must equal the rect
//    the app set (`layerFrame`), and that must fill the player's slot, within
//    1 point. Then the main window is resized and it is read again.
//
// macOS only (the session player's native layer). Evidence:
// <VIDEORC_SMOKE_OUTPUT_DIR or a temp dir>/gpui-library-player.json.

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
const takeMs = Number(process.env.VIDEORC_LIBRARY_PROBE_TAKE_MS ?? 3000)

const near = (a, b, limit = 1) =>
  typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= limit

/** Why the player's layer is not on its slot, or null when it is. Pure. */
export function playerMismatch(player) {
  const { layerFrame: set, displayedFrame: shown, slot } = player ?? {}
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

const steps = []
function record(name, verdict, detail = {}) {
  steps.push({ name, verdict, ...detail })
  const words = detail.reason ?? detail.summary ?? ''
  console.log(`gpui-library-player: ${verdict} ${name}${words ? ` — ${words}` : ''}`)
}

async function step(name, run) {
  try {
    const detail = (await run()) ?? {}
    record(name, 'PASS', detail)
    return true
  } catch (error) {
    record(name, 'FAIL', { reason: error?.message ?? String(error) })
    return false
  }
}

export async function runGpuiLibraryPlayerProbe() {
  if (process.platform !== 'darwin') {
    console.log('gpui-library-player: SKIP — the session player’s native layer is macOS only')
    return 0
  }
  const stateDir = resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
      (await mkdtemp(join(tmpdir(), 'videorc-gpui-library-player-')))
  )
  const { app, command, ui } = await launchGpuiApp({
    stateDir,
    timeoutMs,
    verbose: process.env.VIDEORC_SMOKE_VERBOSE === '1'
  })
  const ws = await connectBackend(app.connections['backend-ready'], timeoutMs)
  const rpc = (method, params = {}) => request(ws, 15000, method, params)
  /** The open player, or null: the Library's, once a take is in it. */
  const openPlayer = async () => {
    const { players = [] } = await command('session-player-geometry')
    return players.find((player) => player.open && player.active) ?? null
  }
  const aligned = async (where) => {
    const until = Date.now() + 5000
    let player
    let why
    while (true) {
      player = await openPlayer()
      why = player ? playerMismatch(player) : 'no player is open'
      if (!why) return `${player.slot.width}x${player.slot.height} aligned`
      if (Date.now() > until) throw new Error(`${where}: ${why}`)
      await sleep(150)
    }
  }
  try {
    const recorded = await step('a short take with the test pattern', async () => {
      await enableTestPattern(command)
      await waitUntil(
        'the preview never presented',
        () => command('preview-window-state'),
        (seen) => seen?.phase === 'presenting',
        { budgetMs: 20000, label: describePreview }
      )
      await command('studio-record')
      await sleep(takeMs)
      await command('studio-stop')
      await waitUntil(
        'the take never ended',
        () => rpc('recording.status'),
        (status) => status?.state !== 'recording' && status?.state !== 'stopping',
        { budgetMs: 30000, everyMs: 250 }
      )
      return { summary: `${takeMs} ms` }
    })
    if (!recorded) return finish()

    const opened = await step('the take opened in the Library player', async () => {
      await command('open-tab', { tab: 'library' })
      await ui.click({ name: 'Session actions', role: 'button' }, { timeoutMs: 20000 })
      await ui.click({ name: 'Markers' }, { timeoutMs: 5000 })
      await waitUntil('the player never opened', openPlayer, Boolean, {
        budgetMs: 15000,
        everyMs: 200
      })
      return { summary: await aligned('opened') }
    })
    if (!opened) return finish()

    await step('after the main window is resized', async () => {
      const results = []
      for (const size of [
        { width: 1000, height: 700 },
        { width: 1440, height: 900 }
      ]) {
        await command('resize-window', size)
        results.push(
          `${size.width}x${size.height}: ${await aligned(`main ${size.width}x${size.height}`)}`
        )
      }
      return { summary: results.join('; ') }
    })
  } finally {
    ws.close()
    await app.stop()
  }
  return finish()

  async function finish() {
    await writeFile(
      join(stateDir, 'gpui-library-player.json'),
      JSON.stringify({ platform: process.platform, steps }, null, 2)
    )
    const failed = steps.filter((each) => each.verdict === 'FAIL')
    console.log(`gpui-library-player: evidence ${join(stateDir, 'gpui-library-player.json')}`)
    console.log(`gpui-library-player: ${failed.length ? `FAIL (${failed.length})` : 'PASS'}`)
    return failed.length ? 1 : 0
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGpuiLibraryPlayerProbe().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error?.stack ?? String(error))
      process.exitCode = 1
    }
  )
}
