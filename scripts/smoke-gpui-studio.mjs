// Plan 260 Phase 3 (L6): the Studio's preview and session on the GPUI app,
// driven through the UI driver (`scripts/lib/ui-driver.mjs`) the way a person
// uses the page, never through `eval-js`.
//
//   pnpm smoke:gpui-studio
//
// It launches `apps/videorc` (VIDEORC_APP=gpui) on an isolated profile and
// checks, in order:
//
// 1. Isolation: the backend's database, secrets and recordings live in the
//    smoke's own directory.
// 2. Preview: the compositor renders the committed scene
//    (`sceneRevision == frameSceneRevision`) and its frames advance.
// 3. The Studio page: the Record button (`session-record`) is in the main
//    window's tree and says "Record".
// 4. Session: with a source, Space starts a take (the button reads "Stop
//    recording" and `recording.status` is recording), Space stops it, and the
//    take lands in the isolated recordings folder. Without one (a smoke run
//    picks no devices, and the GPUI app has no test-pattern source until the
//    Studio's `enable-synthetic-source` lands), Record must say why it is
//    blocked instead; the smoke checks that and says the take was skipped.
//    VIDEORC_SMOKE_REQUIRE_TAKE=1 makes a skipped take a failure.
//
// Functional contract only: no fps floors (perf stays in its own gates).

import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { nodeWords, previewConverged } from './lib/gpui-studio-smoke.mjs'
import { createUiDriver } from './lib/ui-driver.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const previewBudgetMs = Number(process.env.VIDEORC_GPUI_PREVIEW_BUDGET_MS ?? 20000)
const takeMs = Number(process.env.VIDEORC_GPUI_TAKE_MS ?? 3000)
const requireTake = process.env.VIDEORC_SMOKE_REQUIRE_TAKE === '1'

const RECORD = { role: 'button', id: 'session-record' }
const BLOCKED_REASON = { id: 'session-blocked-reason' }

async function main() {
  const stateDir = resolve(
    process.env.VIDEORC_SMOKE_STATE_DIR ?? (await mkdtemp(join(tmpdir(), 'videorc-gpui-studio-')))
  )
  const app = await launchDevApp({
    env: {
      VIDEORC_APP: 'gpui',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: stateDir,
      VIDEORC_USER_DATA_DIR: join(stateDir, 'profile')
    },
    timeoutMs,
    requiredMarkers: ['preview-motion-ready', 'backend-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_SMOKE_VERBOSE === '1') console.log(line)
    }
  })
  const smoke = app.connections['preview-motion-ready']
  const ws = await connectBackend(app.connections['backend-ready'], timeoutMs)
  const rpc = (method, params = {}) => request(ws, 15000, method, params)
  const ui = createUiDriver(smoke, { app: 'gpui' })
  try {
    // 1. Isolation.
    const isolation = await requestSmokeCommand(smoke, 'inspect-backend-state-isolation', {})
    if (isolation?.isolated !== true) {
      throw new Error(
        `gpui-studio: FAIL — backend state is not isolated: ${JSON.stringify(isolation)}`
      )
    }
    console.log('gpui-studio: isolated profile ✓')

    // 2. Preview.
    const first = await rpc('compositor.status')
    let latest = first
    const deadline = Date.now() + previewBudgetMs
    while (!previewConverged(first, latest)) {
      if (Date.now() > deadline) {
        throw new Error(
          `gpui-studio: FAIL — the preview did not converge in ${previewBudgetMs} ms: ` +
            JSON.stringify({ first, latest })
        )
      }
      await new Promise((done) => setTimeout(done, 250))
      latest = await rpc('compositor.status')
    }
    console.log(
      `gpui-studio: preview renders scene ${latest.sceneRevision}, ` +
        `${latest.framesRendered - first.framesRendered} new frames ✓`
    )

    // 3. The Studio page.
    const record = await ui.waitFor(RECORD, { timeoutMs: 15000 })
    const recordWords = nodeWords(record)
    if (!/\bRecord\b/.test(recordWords)) {
      throw new Error(`gpui-studio: FAIL — the Record button says "${recordWords}".`)
    }
    console.log('gpui-studio: Studio page with Record ✓')

    // 4. Session.
    const blocked = await ui
      .waitFor(BLOCKED_REASON, { timeoutMs: 1000 })
      .then((node) => nodeWords(node))
      .catch(() => null)
    if (blocked) {
      if (requireTake) {
        throw new Error(`gpui-studio: FAIL — Record is blocked: ${blocked}`)
      }
      console.log(
        `gpui-studio: Record is blocked and says why ("${blocked}") ✓ — ` +
          'take skipped: no source until the Studio smoke handler gives a test pattern.'
      )
      return
    }
    await ui.press('Space')
    await ui.waitFor({ role: 'label', value: 'Stop recording' }, { timeoutMs: 15000 })
    const started = await rpc('recording.status')
    if (started?.state !== 'recording') {
      throw new Error(`gpui-studio: FAIL — Space did not start a take: ${JSON.stringify(started)}`)
    }
    console.log(`gpui-studio: Space started take ${started.sessionId} ✓`)
    await new Promise((done) => setTimeout(done, takeMs))
    await ui.press('Space')
    await ui.waitFor({ role: 'label', value: 'Record' }, { timeoutMs: 30000 })
    const stopped = await rpc('recording.status')
    if (stopped?.state === 'recording') {
      throw new Error(`gpui-studio: FAIL — Space did not stop the take: ${JSON.stringify(stopped)}`)
    }
    const output = stopped?.outputPath ?? started?.outputPath
    if (!output || !existsSync(output)) {
      throw new Error(`gpui-studio: FAIL — the take's file is missing: ${output}`)
    }
    if (relative(stateDir, output).startsWith('..')) {
      throw new Error(`gpui-studio: FAIL — the take left the smoke's directory: ${output}`)
    }
    console.log(`gpui-studio: Space stopped the take; ${output} ✓`)
  } finally {
    ws.close()
    await app.stop()
  }
}

main().then(
  () => console.log('gpui-studio: PASS'),
  (error) => {
    console.error(error?.stack ?? String(error))
    process.exitCode = 1
  }
)
