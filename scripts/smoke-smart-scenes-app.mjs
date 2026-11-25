#!/usr/bin/env node
// Plan 231 acceptance on an isolated dev profile with real fixture windows:
// v1 migration (Figma/T3 Code stand-ins), three appended app scenes, reorder,
// position keys through the OS-global handler, native Camera-only retention,
// a key superseding a pending switch, and both stream orientations (including
// a screen on the vertical leg while the program is Camera only).
// Keeps plan 210's relaunch, Follow, Hide screen on every output,
// password-manager hide, and plan 219's out-of-sight recovery checks.
//
// Alpha is red/full-bleed; Beta is blue/shrunk. Encoded frame analysis must
// see every cut, zero black and zero wrong-layout frames. Switch timing and
// host load are reported: main also misses 150 ms (plan-231-run/AB/notes.md).
// Follow/privacy gates retain their existing budgets. Never streams to a
// real channel; the dual leg and privacy stream use local FFmpeg receivers.
//
// Usage: pnpm smoke:smart-scenes [-- --switches 20 --out <dir>]
// VIDEORC_SMOKE_TIMEOUT_MS, VIDEORC_SMOKE_RTMP_PORT (13937),
// VIDEORC_SMOKE_FFMPEG_PATH, VIDEORC_SMOKE_FFPROBE_PATH.
// VIDEORC_SMART_SCENES_MAX_HOST_LOAD optionally waits for a timing host.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { hostname, loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFixtureApps, FIXTURE_SOURCE_PATH } from './fixtures/build-fixture-apps.mjs'
import { launchDevApp, smokeAppIsGpui } from './lib/app-launcher.mjs'
import { reloadKeepingSeedJs, UI_SETTINGS_READY_JS } from './lib/renderer-profile-seed.mjs'
import { decodeSceneFrames } from './lib/scene-artifact-frames.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import {
  activateApp,
  flashFixtureApp,
  frontApp,
  launchFixtureApp,
  minimizeFixtureApp,
  restoreFixtureApp,
  stopFixtureApp,
  stopFixtureApps,
  waitForFrontApp
} from './lib/fixture-app-process.mjs'
import { waitForOwnedTcpListener } from './lib/live-control-recycle-smoke.mjs'
import { scenePresetStateReadCode } from './lib/scene-presets-smoke-state.mjs'
import {
  anchorFromFlash,
  percentiles,
  sceneSwitchVerdict
} from './lib/scene-window-switch-frames.mjs'
import { takeSiblingPaths } from './lib/separate-source-take-gates.mjs'
import {
  SMART_SCENES_BUDGET,
  SHARP_HIDDEN_MAX,
  SHARP_LIVE_MIN,
  followBudgetMs,
  followGate,
  frostRunVerdict,
  hiddenContentVerdict,
  newScenesGate,
  passwordManagerGate,
  outOfSightGate,
  outOfSightRefusalCopyOk,
  relaunchGate,
  smartScenesVerdict,
  switchGate,
  unwrapContentClockMs
} from './lib/smart-scenes-gate.mjs'
import { requestSmokeCommand, waitForRendererHook } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

class SmokeExit extends Error {
  constructor(code) {
    super(`smoke exit ${code}`)
    this.code = code
  }
}

// T3 shells export this; the dev app then dies at getVersion.
delete process.env.ELECTRON_RUN_AS_NODE

// Windows runs step 5 (Hide screen on every output) against the DXGI display
// and reports the macOS-only steps as SKIP (issue #1088).
if (process.platform === 'win32') {
  const windowsSmoke = fileURLToPath(
    new URL('./smoke-hide-screen-windows-app.mjs', import.meta.url)
  )
  const delegated = spawnSync(process.execPath, [windowsSmoke, ...process.argv.slice(2)], {
    stdio: 'inherit'
  })
  process.exit(delegated.status ?? 1)
}

const options = parseArgs(process.argv.slice(2))
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120_000)
const switchTimeoutMs = Number(process.env.VIDEORC_SCENE_SWITCH_TIMEOUT_MS ?? 20_000)
const rtmpPortBase = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 13937)
const outputDirectory = resolve(
  options.out ??
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-smart-scenes-${Date.now()}`)
)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const ANALYSIS_WIDTH = 320
const ANALYSIS_HEIGHT = 180
const SETTLE_MS = 1200
const HIDDEN_SPAN_MS = 4000
const video = { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 8000 }
/** Custom RTMP destinations are capped at 6000 kbps; the hide step streams at that. */
const streamVideo = { ...video, bitrateKbps: 6000 }
const summaryPath = join(outputDirectory, 'smart-scenes-summary.json')
const ELECTRON_BUNDLE_ID = 'com.github.Electron'
// Plan 260 Phase 3: VIDEORC_APP=gpui drives the GPUI app. Its Studio smoke
// handler stands in for the renderer's `__videorcSmokeScenePresets`; see
// createRendererDriver and docs/gpui/ui-driver.md ("smart-scenes on GPUI").
const gpuiApp = smokeAppIsGpui()

mkdirSync(outputDirectory, { recursive: true })
log(`evidence directory ${outputDirectory}`)

const summary = {
  skipped: false,
  host: hostname(),
  at: new Date().toISOString(),
  canvas: `${video.width}x${video.height}@${video.fps}`,
  hostLoadAtStart: loadavg().map((value) => Number(value.toFixed(1))),
  budget: {
    ...SMART_SCENES_BUDGET,
    switchTimingPolicy: 'report-only',
    mainMeasuredAppSwitchP95Ms: 229,
    timingBaseline: 'plan-231-run/AB/notes.md (orchestrator ruling 2026-11-16)',
    followBudgetMs: followBudgetMs(),
    sharpLiveMin: SHARP_LIVE_MIN,
    sharpHiddenMax: SHARP_HIDDEN_MAX
  },
  evidenceDir: outputDirectory,
  steps: {}
}
const fixtureProcesses = []
const receivers = []
const devAppLogLines = []
/** Backend events seen on the smoke's own socket. */
const events = []
let launched = null
let smokeConnection = null
let ws = null
let exitCode = 0

try {
  if (process.platform !== 'darwin') {
    skip(
      'scenes for apps, Follow and the fixture apps are macOS only (plan 210 D12); Windows runs the Hide screen step (smoke:hide-screen:windows)',
      'not-macos'
    )
  }
  for (const tool of [ffmpegPath, ffprobePath]) {
    try {
      execFileSync(tool, ['-version'], { stdio: 'ignore' })
    } catch {
      fail(`${tool} is not runnable; the smoke decodes every output with it.`)
    }
  }
  // Keyed by the fixture source: the build reuses any bundle newer than its
  // source, and other worktrees on this Mac share the temp directory, so an
  // unkeyed directory can hand this run a fixture without the content clock.
  const fixtureSourceHash = createHash('sha256')
    .update(readFileSync(FIXTURE_SOURCE_PATH))
    .digest('hex')
    .slice(0, 12)
  const fixtures = buildFixtureApps({
    outputDir: join(tmpdir(), `videorc-fixture-apps-${fixtureSourceHash}`)
  })
  log(`fixture apps in ${fixtures.outputDir}`)
  // Beta sits above Alpha's motion strip, never over it: both strips stay
  // visible, so neither window goes still on screen.
  const alpha = await launchFixture(fixtures.apps.alpha, { x: 40, y: 40 })
  let beta = await launchFixture(fixtures.apps.beta, { x: 200, y: 230 })
  log(
    `fixtures: alpha window ${alpha.windowId} (pid ${alpha.pid}), beta window ${beta.windowId} (pid ${beta.pid})`
  )

  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      // Never VIDEORC_SMOKE_PREVIEW_MOTION=1: it swaps the capture for a
      // synthetic pattern, so no real window would start.
      VIDEORC_SMOKE_PREVIEW_MOTION: '0',
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1'
    },
    onLine: (line) => {
      devAppLogLines.push(line)
      if (line.startsWith('[smoke:'))
        console.log(line.replace(/(token|capability).*$/i, '[handshake omitted]'))
    }
  })
  const smoke = launched.connections['preview-motion-ready']
  smokeConnection = smoke
  ws = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  ws.addEventListener('message', (message) => {
    try {
      const parsed = JSON.parse(message.data)
      if (parsed?.event)
        events.push({ event: parsed.event, payload: parsed.payload, atMs: Date.now() })
    } catch {
      // not JSON
    }
  })

  // The grant check comes first: without it nothing below means anything.
  const devices = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const grantMissing = (devices.devices ?? []).find(
    (device) =>
      (device.kind === 'screen' || device.kind === 'window') &&
      device.status === 'permission-required' &&
      String(device.id).includes('screencapturekit')
  )
  if (grantMissing) {
    skip(
      `the dev app has no Screen Recording grant on this host (${grantMissing.detail ?? grantMissing.id}); New scene…, window capture and Hide screen all need it`,
      'screen-recording-grant-missing'
    )
  }
  for (const fixture of [alpha, beta]) {
    const device = findWindowDevice(devices.devices, fixture.windowId)
    if (!device) fail(`${fixture.name}'s window ${fixture.windowId} is not listed by devices.list`)
    if (device.status !== 'available')
      fail(`${fixture.name}'s window is ${device.status}: ${device.detail ?? ''}`)
  }
  const display = (devices.devices ?? []).find(
    (device) => device.kind === 'screen' && device.status === 'available'
  )
  if (!display) fail('no available display in devices.list; step 6 needs a display scene')

  const renderer = createRendererDriver(smoke)
  await renderer.waitFor(() => true, 'renderer scene-preset actions ready')
  await openTab(smoke, 'studio', '[data-videorc-preview-card]')
  if (gpuiApp) await renderer.command('studio-capture-configure', { config: { video } })
  else
    await renderer.evaluate(
      `window.__videorcSmokeScenePresets.configure({video: ${JSON.stringify(video)}}); return true`
    )
  await renderer.setClips(false)
  await waitForRecordingIdle()
  await renderer.applyLayout(
    { layoutPreset: 'screen-only' },
    (state) => state.canSave && state.visual.layout.layoutPreset === 'screen-only',
    'screen-only working scene'
  )
  await renderer.chooseCameraOff()

  // Plan 231 D15: a real plan-210 library, using the fixture windows as the
  // Figma/T3 Code stand-ins. Camera Off is this host's selected device, not
  // something a migrated scene may change. Follow remains on.
  summary.steps.migration = await step('migration', async () => {
    if (gpuiApp)
      return {
        skipped: true,
        ok: true,
        failures: [],
        detail:
          'SKIP on GPUI: the plan-210 migration is a renderer settings seed and reload; core unit tests cover scenes::migration'
      }
    const before = await renderer.state()
    const now = '2026-10-30T09:00:00.000Z'
    const scenes = [alpha, beta].map((fixture, index) => ({
      id: index === 0 ? 'plan210-figma' : 'plan210-t3code',
      name: index === 0 ? 'Figma' : 'T3 Code',
      createdAt: now,
      updatedAt: now,
      visual: {
        ...before.visual,
        sources: {
          ...before.visual.sources,
          screenId: undefined,
          screenName: undefined,
          windowId: fixture.windowId,
          windowName: fixture.name,
          captureOff: false,
          testPattern: false,
          app: { bundleId: fixture.bundleId, name: fixture.name, follows: true }
        }
      }
    }))
    const working = { version: 1, origin: 'saved', sceneId: scenes[0].id, visual: scenes[0].visual }
    await renderer.evaluate(`
      const state = window.__videorcSmokeScenePresets.streamingState();
      const config = { ...state.captureConfig, sources: ${JSON.stringify(scenes[0].visual.sources)},
        layout: ${JSON.stringify(scenes[0].visual.layout)}, simulcastFollowsProgram: true,
        lastVerticalPreset: 'vertical-camera-top' };
      const old = ${JSON.stringify({ version: 1, scenes })};
      const working = ${JSON.stringify(working)};
      const settings = await ${UI_SETTINGS_READY_JS};
      const seed = () => {
        settings.setItem('videorc.captureConfig', JSON.stringify(config));
        settings.setItem('videorc.scene-presets.v1', JSON.stringify(old));
        settings.setItem('videorc.working-scene.v1', JSON.stringify(working));
        settings.removeItem('videorc.scenes.v2');
      };
      seed(); window.addEventListener('pagehide', seed);
      ${reloadKeepingSeedJs({ forgetWorkingScene: false, forgetScenes: true, delayMs: 100 })}
      return true;
    `)
    await sleep(500)
    const state = await renderer.waitFor(
      (state) => state.canSave && state.scenes[0]?.id === scenes[0].id,
      'plan 210 migration settled'
    )
    const library = await renderer.storedLibrary()
    assert.deepEqual(
      library.scenes.map((scene) => scene.name),
      ['Figma', 'T3 Code', 'Screen + camera', 'Camera only', 'Side by side']
    )
    assert.equal(state.activeId, scenes[0].id, 'STOP: migration changed the scene on stream')
    assert.equal(
      state.visual.sources.windowId,
      alpha.windowId,
      'STOP: migration changed the program window'
    )
    assert.deepEqual(
      state.visual.layout,
      before.visual.layout,
      'STOP: migration changed the program layout'
    )
    assert.equal(library.scenes[0].shows.follows, true)
    assert.equal(library.scenes[0].layouts.vertical.layoutPreset, 'vertical-screen-only')
    assert.deepEqual(
      await renderer.evaluate(
        `return JSON.parse(window.__videorcUiSettings?.getItem('videorc.scene-presets.v1'))`
      ),
      JSON.parse(JSON.stringify({ version: 1, scenes })),
      'migration must never rewrite v1'
    )
    await waitForScreenLive(alpha.windowId)
    await openTab(smoke, 'layout', '[data-testid="scene-new"]')
    const chip = await renderer.evaluate(
      `return document.querySelector('[data-saved-scene="plan210-figma"] [data-slot="scene-shortcut-keys"]')?.textContent`
    )
    assert.match(chip, /1/, 'position 1 belongs to Figma')
    return {
      ok: true,
      failures: [],
      library,
      detail:
        'v1 order, Figma on stream, position 1, Follow and both layouts preserved; v1 untouched'
    }
  })
  if (!summary.steps.migration.ok) fail('STOP: migration acceptance failed; see migration evidence')

  const targets = {
    alpha: { key: 'alpha', color: 'red', fixture: alpha, app: fixtures.apps.alpha, sceneId: null },
    beta: { key: 'beta', color: 'blue', fixture: beta, app: fixtures.apps.beta, sceneId: null }
  }
  summary.steps.newScenes = await step('new-scenes', async () => {
    await openTab(smoke, 'layout', '[data-testid="scene-new"]')
    const before = await renderer.state()
    // GPUI: its Scene page has no Add scene… dialog yet, so the smoke makes
    // the app scenes as the dialog would (v2 scenes from the first stored
    // scene's layouts, Follow on, the app's name, "<name> 2" for a second)
    // and inserts them through the Studio's own insert.
    let gpuiSceneCount = 0
    const gpuiAdd = async (bundleIds) => {
      const current = await renderer.state()
      const template = current.library[0]
      if (!template) throw new Error('GPUI: no stored scene to model the app scenes on')
      const now = new Date().toISOString()
      const scenes = bundleIds.map((bundleId) => {
        const app = Object.values(fixtures.apps).find((entry) => entry.bundleId === bundleId)
        const taken = current.scenes.filter((scene) => scene.name.startsWith(app.name)).length
        gpuiSceneCount += 1
        return {
          ...template,
          id: `scene-gpui-${gpuiSceneCount}`,
          name: taken === 0 ? app.name : `${app.name} ${taken + 1}`,
          createdAt: now,
          updatedAt: now,
          shows: { kind: 'app', bundleId, name: app.name, follows: true },
          audio: undefined
        }
      })
      await renderer.command('studio-scene-insert', { scenes })
      return true
    }
    const add = async (ids) =>
      gpuiApp
        ? gpuiAdd(ids)
        : renderer.evaluate(`
      const closeDeadline = performance.now() + 8000;
      while (document.querySelector('[data-testid="add-scene-dialog"]') && performance.now() < closeDeadline) await sleep(50);
      if (document.querySelector('[data-testid="add-scene-dialog"]')) throw new Error('Previous Add scene dialog did not close');
      (await waitFor('[data-testid="scene-new"]', 8000)).click();
      await waitFor('[data-testid="add-scene-dialog"]', 8000);
      for (const id of ${JSON.stringify(ids)}) {
        const card = await waitFor('[data-app-choice="' + id + '"]', 20000);
        if (card.getAttribute('aria-pressed') !== 'true') card.click();
        await sleep(50);
      }
      const button = await waitFor('[data-testid="new-scene-add"]', 8000);
      const deadline = performance.now() + 8000;
      while (button.disabled && performance.now() < deadline) await sleep(50);
      if (button.disabled) throw new Error('Add scenes stayed disabled: ' + button.closest('[role="dialog"]')?.textContent);
      button.click(); return true;
    `)
    await add([fixtures.apps.alpha.bundleId, fixtures.apps.beta.bundleId])
    await renderer.waitFor(
      (state) => state.scenes.length === before.scenes.length + 2,
      'two app scenes added'
    )
    // A second scene for Alpha is a supported app scene too; proves naming and
    // a third append without requiring an unrelated installed application.
    await add([fixtures.apps.alpha.bundleId])
    const state = await renderer.waitFor(
      (state) => state.scenes.length === before.scenes.length + 3,
      'three app scenes appended'
    )
    assert.deepEqual(
      state.scenes.slice(0, before.scenes.length).map((scene) => scene.id),
      before.scenes.map((scene) => scene.id)
    )
    assert.equal(state.activeId, before.activeId)
    assert.deepEqual(state.visual, before.visual, 'Add scene must never change the program')
    const added = state.scenes.slice(before.scenes.length)
    for (const target of Object.values(targets)) {
      target.sceneId = added.find(
        (scene) => scene.visual.sources.app?.bundleId === target.app.bundleId
      ).id
    }
    assert.equal(added[2].name, 'Fixture Alpha 2')
    const verdict = newScenesGate(added, [fixtures.apps.alpha, fixtures.apps.beta])
    return {
      ...verdict,
      scenes: added,
      detail: `three app scenes at the end; existing keys and program unchanged${gpuiApp ? ' (GPUI: inserted through studio-scene-insert, no Add scene… dialog on its Scene page yet)' : ''}`
    }
  })
  if (!summary.steps.newScenes.ok) fail('every later step needs the app scenes')
  summary.steps.reorder = await step('reorder', async () => {
    const before = await renderer.state()
    const last = before.scenes.at(-1)
    // GPUI: the row's Alt+Arrow needs a focused row (no clicks yet, driver
    // gap 1), so the move goes through the Studio's own move.
    if (gpuiApp)
      await renderer.command('studio-scene-move', {
        id: last.id,
        toIndex: before.scenes.length - 2
      })
    else
      await renderer.evaluate(`
      const button = await waitFor('[data-saved-scene="${last.id}"] [data-slot="list-row-button"]');
      button.focus(); button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
      return true;
    `)
    const state = await renderer.waitFor(
      (state) => state.scenes.at(-2)?.id === last.id,
      'keyboard reorder'
    )
    assert.equal(state.activeId, before.activeId)
    // GPUI: each scene's position key from the Studio (its rows' key chips
    // are Kbd children that only debug builds name).
    const rows = gpuiApp
      ? state.keys.map((entry) => ({ id: entry.id, key: entry.key ?? '' }))
      : await renderer.evaluate(
          `return [...document.querySelectorAll('[data-saved-scene]')].map((row) => ({ id: row.getAttribute('data-saved-scene'), key: row.querySelector('[data-slot="scene-shortcut-keys"]')?.textContent }))`
        )
    for (let i = 0; i < Math.min(9, state.scenes.length); i += 1) {
      assert.match(
        rows.find((row) => row.id === state.scenes[i].id)?.key ?? '',
        new RegExp(String(i + 1))
      )
    }
    return {
      ok: true,
      failures: [],
      rows,
      detail: `reorder kept program; position chips follow the new order${gpuiApp ? " (GPUI: studio-scene-move and the Studio's position keys)" : ''}`
    }
  })
  if (!summary.steps.reorder.ok) fail('reorder acceptance failed')
  await openTab(smoke, 'studio', '[data-videorc-preview-card]')

  // Beta becomes a shrunk freeform layout (edits auto-save into the scene on
  // stream, D3), so every switch also changes the layout and a wrong-layout
  // frame is countable. Alpha stays full-bleed for the frost checks.
  // The edit is the Scene page's Freeform entry (`freeformEntryPatch`): the
  // arrangement and the placement, never a layout preset. A preset without
  // Layout edits save into the scene on stream (D11).
  await renderer.goTo(targets.beta)
  await waitForScreenLive(targets.beta.fixture.windowId)
  await renderer.applyLayout(
    {
      arrangementMode: 'freeform',
      sourceTransformOverrides: { 'source:base': { x: 0.15, y: 0.15, width: 0.7, height: 0.7 } }
    },
    (state) =>
      state.canSave &&
      state.activeId === targets.beta.sceneId &&
      state.visual.layout.arrangementMode === 'freeform' &&
      state.visual.sources.windowId === targets.beta.fixture.windowId,
    'Beta as a shrunk freeform layout'
  )
  await renderer.waitForSceneToCarry(
    targets.beta.sceneId,
    'Fixture Beta',
    (scene) =>
      scene.visual.layout.arrangementMode === 'freeform' &&
      scene.visual.layout.sourceTransformOverrides?.['source:base']?.width === 0.7 &&
      Boolean(scene.visual.sources.app) &&
      !scene.audio,
    'the freeform placement, its app and no audio'
  )
  await renderer.goTo(targets.alpha)
  await renderer.waitFor(
    (state) => state.visual.layout.arrangementMode === 'preset' && !state.pendingId,
    'Alpha back on, full-bleed'
  )
  await waitForScreenLive(targets.alpha.fixture.windowId)
  const layoutMark = { alpha: false, beta: true }

  // ------------------------------------------------------------------ step 2
  summary.steps.switches = await step('switches', async () => {
    const run = await recordWhile('switches', smoke, async (variant) => {
      let current = targets.alpha
      for (let index = 0; index < options.switches; index += 1) {
        const next = current === targets.alpha ? targets.beta : targets.alpha
        const requestedAtMs = await renderer.requestSlot(next.sceneId)
        const settled = await renderer.waitFor(
          (state) => state.activeId === next.sceneId && !state.pendingId,
          'position key put the requested scene on stream',
          switchTimeoutMs
        )
        const done = { ok: settled.activeId === next.sceneId, at: Date.now() }
        variant.switches.push({
          index,
          from: current.key,
          to: next.key,
          requestedAtMs,
          rendererDoneMs: done?.at == null ? null : done.at - requestedAtMs,
          ok: Boolean(done?.ok),
          error: done?.error ?? null
        })
        current = next
        await sleep(SETTLE_MS)
      }
      if (current !== targets.alpha) {
        await renderer.goTo(targets.alpha)
        await sleep(SETTLE_MS)
      }
    })
    const features = run.analysis.features
    for (let index = 0; index < run.switches.length; index += 1) {
      const row = run.switches[index]
      const next = run.switches[index + 1]
      row.pixels = sceneSwitchVerdict({
        features,
        ptsMs: run.analysis.ptsMs,
        offsetMs: run.analysis.anchor.offsetMs,
        requestedAtMs: row.requestedAtMs,
        untilMs: next ? next.requestedAtMs : row.requestedAtMs + SETTLE_MS + switchTimeoutMs,
        fromColor: targets[row.from].color,
        toColor: targets[row.to].color,
        fromLayoutMark: layoutMark[row.from],
        toLayoutMark: layoutMark[row.to]
      })
    }
    const pixels = run.switches.map((row) => row.pixels)
    const stats = {
      switches: run.switches.length,
      failed: run.switches.filter((row) => !row.ok).length,
      rendererDoneMs: percentiles(run.switches.map((row) => row.rendererDoneMs)),
      pixels: {
        latencyMs: percentiles(pixels.map((verdict) => verdict.latencyMs)),
        cutsSeen: pixels.filter((verdict) => verdict.cutSeen).length,
        oldWindowFrames: percentiles(pixels.map((verdict) => verdict.oldWindowFrames)),
        blackFramesTotal: sum(pixels.map((verdict) => verdict.blackFrames)),
        afterCutBlackFramesTotal: sum(pixels.map((verdict) => verdict.afterCutBlackFrames)),
        otherFramesTotal: sum(pixels.map((verdict) => verdict.otherFrames)),
        wrongLayoutFramesTotal: sum(pixels.map((verdict) => verdict.wrongLayoutFrames))
      }
    }
    const verdict = switchGate(stats)
    const latency = stats.pixels.latencyMs
    return {
      ...verdict,
      stats,
      rows: run.switches.map(({ pixels: verdictRow, ...row }) => ({
        ...row,
        latencyMs: verdictRow.latencyMs,
        oldWindowFrames: verdictRow.oldWindowFrames,
        blackFrames: verdictRow.blackFrames + verdictRow.afterCutBlackFrames,
        wrongLayoutFrames: verdictRow.wrongLayoutFrames
      })),
      recording: run.recording,
      hostLoad: run.hostLoad,
      detail: `${stats.switches} switches, click→new picture p50 ${fmt(latency.p50)} p95 ${fmt(latency.p95)} max ${fmt(latency.max)} ms (timing report-only; main p95 229 ms), black ${stats.pixels.blackFramesTotal + stats.pixels.afterCutBlackFramesTotal}, wrong layout ${stats.pixels.wrongLayoutFramesTotal}, cuts ${stats.pixels.cutsSeen}/${stats.switches}, host load ${run.hostLoad.start}→${run.hostLoad.end}`
    }
  })

  const switchPixels = summary.steps.switches.stats?.pixels
  if (
    switchPixels &&
    (switchPixels.blackFramesTotal + switchPixels.afterCutBlackFramesTotal > 0 ||
      switchPixels.wrongLayoutFramesTotal > 0)
  )
    fail('STOP: black or wrong-layout frames in the switching recording')
  // D18: ten Camera only → app swaps, retaining the native capture owner.
  summary.steps.cameraReturn = await step('camera-return', async () => {
    const camera = (devices.devices ?? []).find(
      (device) => device.kind === 'camera' && device.status === 'available'
    )
    if (!camera)
      return {
        skipped: true,
        ok: true,
        failures: [],
        reason: 'No available camera / Camera grant; Camera only acceptance needs the packaged app',
        detail: 'SKIP: no camera grant'
      }
    await requestSmokeCommand(smoke, 'select-camera-device', { settleMs: 500 }, { timeoutMs })
    const base = gpuiApp
      ? (await renderer.state()).library.find((scene) => scene.id === targets.alpha.sceneId)
      : await renderer.evaluate(
          `return JSON.parse(window.__videorcUiSettings?.getItem('videorc.scenes.v2')).scenes.find((scene) => scene.id === ${JSON.stringify(targets.alpha.sceneId)})`
        )
    const cameraScene = {
      ...base,
      id: 'acceptance-camera-only',
      name: 'Acceptance Camera only',
      shows: { kind: 'none' },
      layouts: {
        horizontal: { ...base.layouts.horizontal, layoutPreset: 'camera-only' },
        vertical: { ...base.layouts.vertical, layoutPreset: 'vertical-camera-only' }
      }
    }
    if (gpuiApp) await renderer.command('studio-scene-insert', { scenes: [cameraScene] })
    else
      assert.equal(
        await renderer.evaluate(
          `return window.__videorcSmokeScenePresets.add([${JSON.stringify(cameraScene)}])`
        ),
        true
      )
    await renderer.waitFor(
      (state) => state.scenes.some((scene) => scene.id === cameraScene.id),
      'Camera only added'
    )
    await renderer.goTo(targets.alpha)
    const run = await recordWhile('camera-return', smoke, async (variant) => {
      // Establish fresh native switch attribution inside this recording.
      await renderer.goTo(targets.beta)
      await renderer.goTo(targets.alpha)
      let current = targets.alpha
      for (let i = 0; i < 10; i += 1) {
        const before = await request(ws, timeoutMs, 'compositor.status')
        const screenBefore = await request(ws, timeoutMs, 'preview.screen.status')
        await renderer.goTo({ key: 'Camera only', sceneId: cameraScene.id })
        await sleep(300)
        const held = await request(ws, timeoutMs, 'preview.screen.status')
        const heldCompositor = await request(ws, timeoutMs, 'compositor.status')
        assert.equal(held.state, 'live')
        assert.equal(held.sourceId, screenBefore.sourceId, 'D18 kept the same capture identity')
        assert.ok(
          held.framesCaptured >= screenBefore.framesCaptured,
          'D18 never resets the native frame counter'
        )
        assert.equal(heldCompositor.screenSwitch?.generation, before.screenSwitch?.generation)
        const next = current === targets.alpha ? targets.beta : targets.alpha
        const requestedAtMs = await renderer.requestSlot(next.sceneId)
        await renderer.waitFor(
          (state) => state.activeId === next.sceneId && !state.pendingId,
          'Camera only return'
        )
        const after = await request(ws, timeoutMs, 'compositor.status')
        assert.equal(after.screenSwitch?.mode, 'in-place', 'Camera only return must swap in place')
        assert.ok(
          Number.isInteger(before.screenSwitch?.generation),
          'native generation evidence required'
        )
        // Rebinding a target advances its logical generation even when the
        // native stream is reused. The held identity above and in-place mode
        // prove D18 without mistaking that attribution change for a cold start.
        assert.equal(after.screenSwitch.sourceId, next.fixture.windowId)
        variant.switches.push({
          requestedAtMs,
          to: next.key,
          generationBeforeCamera: before.screenSwitch.generation,
          generationWhileCamera: heldCompositor.screenSwitch.generation,
          generationAfterRebind: after.screenSwitch.generation,
          mode: after.screenSwitch.mode
        })
        current = next
        await sleep(SETTLE_MS)
      }
      await renderer.goTo(targets.alpha)
    })
    const rows = run.switches.map((row, index) => ({
      ...row,
      pixels: sceneSwitchVerdict({
        features: run.analysis.features,
        ptsMs: run.analysis.ptsMs,
        offsetMs: run.analysis.anchor.offsetMs,
        requestedAtMs: row.requestedAtMs,
        untilMs: row.requestedAtMs + SETTLE_MS,
        fromColor: 'other',
        toColor: targets[row.to].color,
        // Leaving a real camera's full-frame picture: it has no reliable mark
        // (a dark room reads black, daylight reads with or without one), so
        // only the incoming layout is judged.
        fromLayoutMark: null,
        toLayoutMark: layoutMark[row.to]
      })
    }))
    for (const row of rows) {
      assert.equal(row.pixels.cutSeen, true)
      assert.equal(row.pixels.afterCutBlackFrames, 0, 'STOP: black frame after Camera only return')
      assert.equal(
        row.pixels.wrongLayoutFrames,
        0,
        'STOP: wrong-layout frame after Camera only return'
      )
    }
    const latencyMs = percentiles(rows.map((row) => row.pixels.latencyMs))
    return {
      ok: true,
      failures: [],
      timingPolicy: 'report-only',
      latencyMs,
      rows,
      hostLoad: run.hostLoad,
      recording: run.recording,
      detail: `10 Camera only round trips: p50 ${fmt(latencyMs.p50)}, p95 ${fmt(latencyMs.p95)} ms; native generation retained, every return in-place; host load ${run.hostLoad.start}→${run.hostLoad.end}`
    }
  })
  const cameraReturn = summary.steps.cameraReturn
  if (cameraReturn.failures?.some((failure) => failure.includes('STOP:')))
    fail('STOP: Camera only pixel regression')
  summary.steps.rapidKeys = await step('rapid-keys', async () => {
    await renderer.goTo(targets.alpha)
    const state = await renderer.state()
    const first = state.scenes.findIndex((scene) => scene.id === targets.beta.sceneId) + 1
    const second = state.scenes.findIndex((scene) => scene.id === targets.alpha.sceneId) + 1
    let firstPending = null
    // GPUI: the two keys through studio-shortcut, the pending wait and the
    // 1.5 s trace polled from the Studio as fast as it answers. Its trace has
    // no renderer diagnostics (layout intent, queued key, resolve
    // generation): those stay null, and the gate reads only the frames and
    // the final state.
    const gpuiRapidKeys = async () => {
      const read = () => renderer.command('studio-scenes-state')
      await renderer.command('studio-shortcut', { action: `scene-slot-${first}` })
      const deadline = Date.now() + 8000
      let pending = await read()
      while (pending.pendingSceneId !== targets.beta.sceneId && Date.now() < deadline)
        pending = await read()
      if (pending.pendingSceneId !== targets.beta.sceneId)
        throw new Error('The first position key never entered a pending switch')
      const proof = {
        pendingId: pending.pendingSceneId,
        activeId: pending.onStreamId ?? null,
        atMs: Date.now()
      }
      await renderer.command('studio-shortcut', { action: `scene-slot-${second}` })
      const trace = []
      const end = Date.now() + 1500
      while (Date.now() < end) {
        const current = await read()
        const row = {
          atMs: Date.now(),
          activeId: current.onStreamId ?? null,
          pendingId: current.pendingSceneId ?? null,
          windowId: current.working?.sources?.windowId,
          intent: null,
          queued: null,
          requested: null,
          generation: null
        }
        if (
          !trace.length ||
          JSON.stringify({ ...trace.at(-1), atMs: 0 }) !== JSON.stringify({ ...row, atMs: 0 })
        )
          trace.push(row)
      }
      return { ...proof, trace }
    }
    const run = await recordWhile('rapid-keys', smoke, async (variant) => {
      firstPending = gpuiApp
        ? await gpuiRapidKeys()
        : await renderer.evaluate(`
        window.__videorcSmokeScenePresets.shortcut('scene-slot-${first}');
        const deadline = performance.now() + 8000;
        let pending = window.__videorcSmokeScenePresets.state();
        while (pending.pendingId !== ${JSON.stringify(targets.beta.sceneId)} && performance.now() < deadline) { await sleep(1); pending = window.__videorcSmokeScenePresets.state(); }
        if (pending.pendingId !== ${JSON.stringify(targets.beta.sceneId)}) throw new Error('The first position key never entered a pending switch');
        const proof = { pendingId: pending.pendingId, activeId: pending.activeId, atMs: Date.now() };
        window.__videorcSmokeScenePresets.shortcut('scene-slot-${second}');
        const trace = [];
        const end = performance.now() + 1500;
        while (performance.now() < end) {
          const state = window.__videorcSmokeScenePresets.state();
          const row = { atMs: Date.now(), activeId: state.activeId, pendingId: state.pendingId,
            windowId: state.visual.sources.windowId, intent: state.diagnostics.layoutIntentId,
            queued: state.diagnostics.sceneShortcutQueued, requested: state.diagnostics.sceneShortcutRequested,
            generation: state.diagnostics.sceneResolveGeneration };
          if (!trace.length || JSON.stringify({ ...trace.at(-1), atMs: 0 }) !== JSON.stringify({ ...row, atMs: 0 })) trace.push(row);
          await sleep(5);
        }
        return { ...proof, trace };
      `)
      variant.rapidKeys = firstPending
      await renderer.waitFor(
        (state) => state.activeId === targets.alpha.sceneId && !state.pendingId,
        'the second key wins'
      )
      await sleep(SETTLE_MS)
      variant.rapidKeys.final = await renderer.state()
      const compositor = await request(ws, timeoutMs, 'compositor.status')
      variant.rapidKeys.compositor = compositor
      const screen = (compositor.sources ?? []).find(
        (source) => source.kind === 'screen' || source.kind === 'window'
      )
      // Capture status may still describe the preceding retained target. The
      // encoded final picture below is the program oracle for the second key.
      variant.rapidKeys.captureStatus = screen
    })
    const bad = run.analysis.features.filter(
      (frame) =>
        frame.centre === 'black' ||
        (frame.centre === 'red' && frame.layoutMark) ||
        (frame.centre === 'blue' && !frame.layoutMark)
    )
    assert.equal(bad.length, 0, 'STOP: rapid-key recording contains black or wrong-layout frames')
    assert.equal(
      firstPending.final.activeId,
      targets.alpha.sceneId,
      'the second scene is on stream'
    )
    assert.equal(firstPending.final.pendingId, null)
    const tail = run.analysis.features.filter(
      (frame) =>
        frame.centre !== 'white' &&
        run.analysis.ptsMs[frame.index] >= run.analysis.ptsMs.at(-1) - 1000
    )
    assert.ok(tail.length >= 15, 'a sustained final picture is required')
    assert.ok(
      tail.every((frame) => frame.centre === 'red' && !frame.layoutMark),
      'the final recorded program must be Alpha in its own layout'
    )

    return {
      ok: true,
      failures: [],
      recording: run.recording,
      firstPending,
      detail:
        'two position keys inside one switch; second scene owns the program; zero black/wrong-layout frames'
    }
  })
  if (summary.steps.rapidKeys.failures?.some((failure) => failure.includes('STOP:')))
    fail('STOP: rapid-key pixel regression')

  summary.steps.verticalKeys = await step('vertical-keys', async () => {
    await renderer.goTo(targets.alpha)
    // Different layouts on both orientations make a stale leg observable.
    const library = await renderer.storedLibrary()
    for (const target of Object.values(targets)) {
      const scene = library.scenes.find((scene) => scene.id === target.sceneId)
      scene.layouts.vertical = {
        ...scene.layouts.horizontal,
        layoutPreset: 'vertical-screen-only',
        verticalScreenFraming: 'fill'
      }
      assert.equal(await renderer.editScene(scene), true)
    }
    const port = await freeTcpPort(rtmpPortBase)
    const receiver = startReceiver({
      port,
      recvPath: join(outputDirectory, 'position-keys-vertical.flv')
    })
    receivers.push(receiver)
    await waitForOwnedTcpListener({
      child: receiver.child,
      port,
      timeoutMs: 8000,
      diagnostics: () => receiver.log
    })
    const target = {
      id: 'scene-keys-vertical',
      platform: 'custom',
      label: 'Scene keys vertical',
      enabled: true,
      serverUrl: `rtmp://127.0.0.1:${port}/live`,
      streamKey: 'scene-keys',
      urlMode: 'server-and-key',
      streamKeyPresent: true,
      authMode: 'manual-rtmp',
      outputOrientation: 'vertical',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }
    const streaming = {
      enabled: true,
      mode: 'multi',
      targets: [target],
      enabledTargetIds: [target.id],
      defaultOutputPreset: 'custom',
      defaultBitrateKbps: 6000
    }
    if (gpuiApp) await renderer.configure({ streamEnabled: true, streaming })
    else
      await renderer.evaluate(
        `window.__videorcSmokeScenePresets.configure({streamEnabled: true, streaming: ${JSON.stringify(streaming)}}); return true`
      )
    await sleep(500)
    const active = library.scenes.find((scene) => scene.id === targets.alpha.sceneId)
    const run = await recordWhile(
      'vertical-keys',
      smoke,
      async (variant) => {
        let current = targets.alpha
        for (let i = 0; i < 4; i += 1) {
          const next = current === targets.alpha ? targets.beta : targets.alpha
          const requestedAtMs = await renderer.requestSlot(next.sceneId)
          await renderer.waitFor(
            (state) => state.activeId === next.sceneId && !state.pendingId,
            'both-leg position key'
          )
          variant.switches.push({ from: current.key, to: next.key, requestedAtMs })
          await sleep(SETTLE_MS)
          current = next
        }
        const stored = await renderer.storedLibrary()
        const noScreen = stored.scenes.find((scene) => scene.id === 'acceptance-camera-only')
        if (noScreen) {
          const own = stored.scenes.find((scene) => scene.id === targets.beta.sceneId)
          noScreen.shows = own.shows
          noScreen.layouts.vertical = own.layouts.vertical
          assert.equal(await renderer.editScene(noScreen), true)
          const requestedAtMs = await renderer.requestSlot(noScreen.id)
          await renderer.waitFor(
            (state) => state.activeId === noScreen.id && !state.pendingId,
            'camera program with its own vertical screen'
          )
          await waitForScreenLive(beta.windowId)
          variant.verticalOnly = [{ requestedAtMs, fromColor: 'red', fromLayoutMark: false }]
          await sleep(SETTLE_MS)
          await renderer.goTo(targets.alpha)
          noScreen.shows = { kind: 'none' }
          noScreen.layouts.vertical = {
            ...noScreen.layouts.vertical,
            layoutPreset: 'vertical-camera-only',
            arrangementMode: 'preset',
            sourceTransformOverrides: {}
          }
          assert.equal(await renderer.editScene(noScreen), true)
          await renderer.goTo({ key: 'Camera only on both legs', sceneId: noScreen.id })
          const kept = await request(ws, timeoutMs, 'preview.screen.status')
          assert.equal(kept.sourceId, alpha.windowId, 'no-screen legs retain Alpha')
          noScreen.shows = own.shows
          noScreen.layouts.vertical = own.layouts.vertical
          const editedAtMs = Date.now()
          assert.equal(await renderer.editScene(noScreen), true)
          await renderer.waitFor(
            (state) =>
              state.activeId === noScreen.id &&
              state.visual.sources.windowId === beta.windowId &&
              !state.pendingId,
            'vertical edit put its own app on'
          )
          await waitForScreenLive(beta.windowId)
          variant.verticalOnly.push({
            requestedAtMs: editedAtMs,
            fromColor: 'other',
            // A full-frame Camera only picture: a real camera's texture reads
            // as a mark, a stand-in's doesn't, so only the incoming layout is
            // judged (its app with the camera inset).
            fromLayoutMark: null
          })
          await sleep(SETTLE_MS)
          await renderer.goTo(targets.alpha)
        }
      },
      {
        streaming,
        simulcast: {
          layout: active.layouts.vertical,
          video: { ...streamVideo, width: 1080, height: 1920 }
        }
      }
    )
    await waitForReceiverExit(receiver, 10000)
    const vertical = analyzeFile(receiver.path, run.flashes)
    assert.ok(vertical.anchor, 'vertical leg must contain the clock anchor')
    assert.deepEqual(
      [run.analysis.width, run.analysis.height],
      [1920, 1080],
      'horizontal recording canvas'
    )
    assert.deepEqual([vertical.width, vertical.height], [1080, 1920], 'vertical stream canvas')
    const legs = {}
    for (const [name, analysis] of Object.entries({ horizontal: run.analysis, vertical })) {
      const rows = run.switches.map((row, index) =>
        sceneSwitchVerdict({
          features: analysis.features,
          ptsMs: analysis.ptsMs,
          offsetMs: analysis.anchor.offsetMs,
          requestedAtMs: row.requestedAtMs,
          untilMs: run.switches[index + 1]?.requestedAtMs ?? row.requestedAtMs + SETTLE_MS,
          fromColor: targets[row.from].color,
          toColor: targets[row.to].color,
          fromLayoutMark: layoutMark[row.from],
          toLayoutMark: layoutMark[row.to]
        })
      )
      for (const row of rows) {
        assert.equal(row.cutSeen, true, `${name} cut missing`)
        assert.equal(row.blackFrames + row.afterCutBlackFrames, 0, `STOP: ${name} black frame`)
        assert.equal(row.wrongLayoutFrames, 0, `STOP: ${name} wrong-layout frame`)
      }
      legs[name] = rows
    }
    const verticalOnly = (run.verticalOnly ?? []).map((row) =>
      sceneSwitchVerdict({
        features: vertical.features,
        ptsMs: vertical.ptsMs,
        offsetMs: vertical.anchor.offsetMs,
        requestedAtMs: row.requestedAtMs,
        untilMs: row.requestedAtMs + SETTLE_MS,
        fromColor: row.fromColor,
        toColor: 'blue',
        fromLayoutMark: row.fromLayoutMark,
        toLayoutMark: true
      })
    )
    for (const row of verticalOnly) {
      assert.equal(row.cutSeen, true, 'vertical-only own app picture required')
      assert.equal(row.afterCutBlackFrames, 0, 'STOP: vertical-only black frame')
      assert.equal(row.wrongLayoutFrames, 0, 'STOP: vertical-only wrong-layout frame')
    }
    if (gpuiApp) await renderer.configure({ streamEnabled: false })
    else
      await renderer.evaluate(
        `window.__videorcSmokeScenePresets.configure({streamEnabled: false}); return true`
      )
    return {
      ok: true,
      failures: [],
      legs,
      verticalOnly,
      hostLoad: run.hostLoad,
      recording: run.recording,
      detail:
        'four position-key cuts on both legs, each in its own layout; zero black/wrong-layout frames'
    }
  })
  if (summary.steps.verticalKeys.failures?.some((failure) => failure.includes('STOP:')))
    fail('STOP: vertical-key pixel regression')

  // D18 and the Camera-only vertical cases temporarily turn the shared
  // camera on. Restore the original camera-off fixture before the existing
  // Follow test, so it measures an app cut rather than a cold camera start.
  await renderer.chooseCameraOff()

  // ------------------------------------------------------------------ step 3
  summary.steps.relaunch = await step('relaunch', async () => {
    const windowIdBefore = beta.windowId
    await stopFixtureApp(beta)
    await sleep(800)
    const refusedAt = Date.now()
    // GPUI: a refused apply is an error answer, read as false.
    const refused = gpuiApp
      ? await renderer.command('studio-scene-apply', { id: targets.beta.sceneId }).then(
          () => true,
          () => false
        )
      : await renderer.evaluate(
          `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(targets.beta.sceneId)})`
        )
    const afterRefusal = await renderer.state()
    beta = await launchFixture(fixtures.apps.beta, { x: 200, y: 230 })
    targets.beta.fixture = beta
    fixtureProcesses.splice(
      fixtureProcesses.findIndex((entry) => entry.windowId === windowIdBefore),
      1
    )
    log(
      `  apply while Beta was quit returned ${JSON.stringify(refused)}; active scene ${afterRefusal.activeId === targets.alpha.sceneId ? 'still Alpha' : afterRefusal.activeId}`
    )
    // ScreenCaptureKit lists the new window a moment after the app drew it;
    // the scene waits for the app's next window, and so does the smoke.
    const listedAt = Date.now()
    await waitForBackendState(
      'devices.list',
      (list) => findWindowDevice(list?.devices, beta.windowId)?.status === 'available',
      'the relaunched window listed by devices.list',
      15_000
    )
    const listedMs = Date.now() - listedAt
    const requestedAtMs = await renderer.requestSwitch(targets.beta.sceneId)
    const done = await renderer.waitForSwitchDone(switchTimeoutMs)
    log(`  apply after the relaunch: ${JSON.stringify(done)} (window listed after ${listedMs} ms)`)
    if (!done?.ok)
      fail(`applying the Beta scene after its relaunch returned ${JSON.stringify(done)}`)
    const state = await renderer.waitFor(
      (current) => current.activeId === targets.beta.sceneId && !current.pendingId,
      'Beta scene active after the relaunch',
      switchTimeoutMs
    )
    await waitForScreenLive(beta.windowId)
    const result = {
      refusedWhileGone: refused === false && afterRefusal.activeId === targets.alpha.sceneId,
      refusalMs: Date.now() - refusedAt,
      appliedAfterRelaunch: Boolean(done?.ok),
      applyMs: done?.at == null ? null : done.at - requestedAtMs,
      windowListedMs: listedMs,
      windowIdBefore,
      windowIdAfter: state.visual.sources.windowId ?? null,
      expectedWindowId: beta.windowId
    }
    await renderer.goTo(targets.alpha)
    await waitForScreenLive(alpha.windowId)
    return {
      ...relaunchGate(result),
      ...result,
      detail: `refused while quit: ${result.refusedWhileGone}; switched to the relaunched window ${result.windowIdAfter} in ${fmt(result.applyMs)} ms`
    }
  })

  // ------------------------------------------------------------------ step 4
  summary.steps.follow = await step('follow', async () => {
    // Finder first: it clears the manual hold left by the switches above
    // (a scene chosen by hand stays until the next app change).
    await activateApp('/System/Library/CoreServices/Finder.app')
    await waitForFrontApp((front) => front.bundleId === 'com.apple.finder')
    await sleep(SMART_SCENES_BUDGET.followSettleMs + 400)
    // GPUI: Videorc is no Electron app; the "Videorc in front" row is
    // Electron's (the dev GPUI binary has no bundle to bring to front).
    const electronApps = gpuiApp ? 0 : lsappinfoCount(ELECTRON_BUNDLE_ID)
    const electronPath = electronApps === 1 ? lsappinfoBundlePath(ELECTRON_BUNDLE_ID) : null
    const plan = [
      { label: 'Fixture Beta in front', target: targets.beta, expect: 'switch' },
      { label: 'Fixture Alpha in front', target: targets.alpha, expect: 'switch' },
      { label: 'Finder in front (no scene)', finder: true, expect: 'stay' },
      ...(electronPath
        ? [{ label: 'Videorc in front', electron: electronPath, expect: 'stay' }]
        : [])
    ]
    const run = await recordWhile('follow', smoke, async (variant) => {
      for (const item of plan) {
        const before = await renderer.state()
        const appPath = item.finder
          ? '/System/Library/CoreServices/Finder.app'
          : (item.electron ?? item.target.app.appPath)
        const bundleId = item.finder
          ? 'com.apple.finder'
          : item.electron
            ? ELECTRON_BUNDLE_ID
            : item.target.app.bundleId
        await activateApp(appPath)
        const front = await waitForFrontApp((entry) => entry.bundleId === bundleId)
        const row = {
          label: item.label,
          expect: item.expect,
          frontAtMs: front.seenAtMs,
          sceneBefore: before.activeId,
          target: item.target?.key ?? null
        }
        if (item.expect === 'switch') {
          const state = await renderer
            .waitFor(
              (current) => current.activeId === item.target.sceneId && !current.pendingId,
              `${item.label}: the program follows`,
              8000
            )
            .catch(() => null)
          row.switched = Boolean(state)
          row.sceneAfter = state?.activeId ?? (await renderer.state()).activeId
        } else {
          await sleep(SMART_SCENES_BUDGET.followSettleMs + 1200)
          const state = await renderer.state()
          row.switched = state.activeId !== before.activeId || Boolean(state.pendingId)
          row.sceneAfter = state.activeId
        }
        variant.switches.push(row)
        await sleep(SETTLE_MS)
      }
    })
    const rows = run.switches.map((row) => {
      if (row.expect !== 'switch' || !row.switched) return { ...row, latencyMs: null }
      const verdict = sceneSwitchVerdict({
        features: run.analysis.features,
        ptsMs: run.analysis.ptsMs,
        offsetMs: run.analysis.anchor.offsetMs,
        requestedAtMs: row.frontAtMs,
        untilMs: row.frontAtMs + 8000,
        fromColor: targets[row.target === 'alpha' ? 'beta' : 'alpha'].color,
        toColor: targets[row.target].color,
        fromLayoutMark: layoutMark[row.target === 'alpha' ? 'beta' : 'alpha'],
        toLayoutMark: layoutMark[row.target]
      })
      return {
        ...row,
        latencyMs: verdict.latencyMs,
        blackFrames: verdict.blackFrames + verdict.afterCutBlackFrames,
        wrongLayoutFrames: verdict.wrongLayoutFrames
      }
    })
    const verdict = followGate(rows)
    const switched = rows.filter((row) => row.expect === 'switch')
    return {
      ...verdict,
      rows,
      videorcChecked: Boolean(electronPath),
      videorcSkippedReason: electronPath
        ? null
        : `${electronApps} Electron apps are running, so \`open\` could not single out this one; Finder stood in for an app without a scene`,
      recording: run.recording,
      hostLoad: run.hostLoad,
      detail: `${switched.map((row) => `${row.target} ${fmt(row.latencyMs)} ms`).join(', ')} from the app reaching the front (budget ${verdict.budgetMs} ms: settle ${SMART_SCENES_BUDGET.followSettleMs} + switch ${SMART_SCENES_BUDGET.switchP95Ms} + observation ${SMART_SCENES_BUDGET.followObservationSlackMs}); ${rows
        .filter((row) => row.expect === 'stay')
        .map((row) => `${row.label}: ${row.switched ? 'SWITCHED' : 'stayed'}`)
        .join(', ')}${electronPath ? '' : '; Videorc-in-front not checked'}`
    }
  })
  // Back on Alpha by hand for the hide step.
  await activateApp('/System/Library/CoreServices/Finder.app')
  await waitForFrontApp((front) => front.bundleId === 'com.apple.finder')
  await renderer.goTo(targets.alpha)
  await waitForScreenLive(alpha.windowId)

  // ------------------------------------------------------------------ step 5
  summary.steps.hide = await step('hide', async () => {
    const privacyBefore = await request(ws, timeoutMs, 'screen.privacy.get')
    // Separate source recordings (the Screen file) need a camera too. The dev
    // app has no Camera grant on most hosts, so the Screen file is a named
    // SKIP there, never a silent pass.
    const cameraList = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
    const camera = (cameraList.devices ?? []).find(
      (device) => device.kind === 'camera' && device.status === 'available'
    )
    const screenFileSkip = camera
      ? null
      : `the dev app has no available camera (Camera grant / TCC), and Separate source recordings need a camera and a screen; the Screen file is not written. Run smoke:separate-source-take on a packaged take for it.`
    if (screenFileSkip) log(`  Screen file: SKIP (${screenFileSkip})`)
    if (privacyBefore.hidden)
      fail(`the screen is already hidden before the step: ${JSON.stringify(privacyBefore)}`)
    // Another smoke on this Mac may hold the base port; take the first free one.
    const rtmpPort = await freeTcpPort(rtmpPortBase)
    log(`  RTMP sink on 127.0.0.1:${rtmpPort}`)
    const receiver = startReceiver({
      port: rtmpPort,
      recvPath: join(outputDirectory, 'hide-stream.flv')
    })
    receivers.push(receiver)
    await waitForOwnedTcpListener({
      child: receiver.child,
      port: rtmpPort,
      timeoutMs: 8000,
      diagnostics: () => receiver.log
    })
    const directory = await requestSmokeCommand(
      smoke,
      'authorize-smoke-resource',
      { path: outputDirectory, kind: 'output-directory' },
      { timeoutMs }
    )
    const visual = (await renderer.state()).visual
    const target = {
      id: 'smart-scenes-sink',
      platform: 'custom',
      label: 'Smart scenes sink',
      enabled: true,
      serverUrl: `rtmp://127.0.0.1:${rtmpPort}/live`,
      streamKey: 'smart-scenes',
      urlMode: 'server-and-key',
      streamKeyPresent: true,
      authMode: 'manual-rtmp',
      outputOrientation: 'horizontal',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }
    const started = await request(ws, timeoutMs, 'session.start', {
      sources: camera
        ? { ...visual.sources, cameraId: camera.id, cameraName: camera.name, cameraOff: false }
        : visual.sources,
      layout: visual.layout,
      background: null,
      output: {
        recordEnabled: true,
        streamEnabled: true,
        outputDirectoryCapability: directory.capabilityId,
        ...(camera ? { separateSourceRecordings: { enabled: true, keepCombined: true } } : {}),
        video: streamVideo,
        rtmp: { preset: 'custom', serverUrl: target.serverUrl, streamKey: target.streamKey }
      },
      streaming: {
        enabled: true,
        mode: 'multi',
        targets: [target],
        enabledTargetIds: [target.id],
        defaultOutputPreset: 'custom',
        defaultBitrateKbps: streamVideo.bitrateKbps
      },
      replay: { seconds: 60 }
    })
    const sessionEventsFrom = events.length
    if (!['recording', 'streaming'].includes(started.state))
      fail(
        `expected a record+stream session after session.start, got ${started.state}: ${JSON.stringify(started).slice(0, 400)}`
      )
    await renderer.waitFor(
      (state) => ['recording', 'streaming'].includes(state.recording),
      'record+stream state'
    )
    if (!/record\+stream/i.test(started.message ?? '') && started.state !== 'streaming')
      fail(
        `session.start did not report a record+stream session: ${JSON.stringify(started).slice(0, 300)}`
      )
    const ring = await waitForBackendState(
      'replay.status',
      (status) => status?.state === 'on' && status?.sessionId === started.sessionId,
      'the Clips ring inside the session',
      20_000
    )
    await sleep(1500)
    const flashes = [await flashFixtureApp(alpha, 'start')]
    await sleep(2500)

    const hideAtMs = Date.now()
    await renderer.togglePrivacy()
    const hidden = await waitForBackendState(
      'screen.privacy.get',
      (privacy) => privacy.hidden === true,
      'Hide screen confirmed',
      5000
    )
    const hideAckMs = Date.now() - hideAtMs
    // When the gate closed, on the backend's clock (this Mac's wall clock):
    // a picture drawn after it must never reach a file.
    const hideGateAtMs = parseSinceMs(hidden.since) ?? hideAtMs
    await sleep(HIDDEN_SPAN_MS)
    const showAtMs = Date.now()
    await renderer.togglePrivacy()
    await waitForBackendState(
      'screen.privacy.get',
      (privacy) => privacy.hidden === false,
      'Show screen confirmed',
      5000
    )
    const showAckMs = Date.now() - showAtMs
    await sleep(2500)
    flashes.push(await flashFixtureApp(alpha, 'end'))
    await sleep(1200)
    const untilMs = Date.now()

    const saveRequestedAt = Date.now()
    const accepted = await request(ws, timeoutMs, 'replay.save', { seconds: 30 })
    const saved = await waitForEvent(
      (entry) =>
        (entry.event === 'replay.saved' || entry.event === 'replay.saveFailed') &&
        entry.payload?.saveId === accepted.saveId,
      'the clip save',
      60_000
    )
    if (saved.event === 'replay.saveFailed')
      fail(`the clip save failed: ${JSON.stringify(saved.payload)}`)
    const clipPath = saved.payload.path
    await sleep(300)
    const stopped = await request(ws, timeoutMs, 'session.stop')
    await renderer.waitFor((state) => state.recording === 'idle', 'session stopped')
    const combined = await resolveFinalRecordingPath({ started, stopped, timeoutMs })
    await waitForReceiverExit(receiver, 20_000)
    const screenFile = camera ? takeSiblingPaths(combined).screen : null
    // Plan 200 D1: under load the separate files are shed so Combined keeps
    // up, and they end there. A shed Screen file is judged for leaks only.
    const shedEvent = events
      .slice(sessionEventsFrom)
      .find(
        (entry) =>
          entry.event === 'health.event' &&
          entry.payload?.code === 'separate-source-recordings-shed'
      )
    const files = {
      recording: combined,
      stream: receiver.path,
      screenFile,
      clip: clipPath
    }
    const outputs = {}
    const frames = {}
    for (const [name, file] of Object.entries(files)) {
      if (name === 'screenFile' && screenFileSkip) {
        outputs[name] = { ok: true, skipped: true, reason: screenFileSkip, failures: [] }
        continue
      }
      if (!file || !existsSync(file)) {
        outputs[name] = { ok: false, failures: [`file missing: ${file}`], file }
        continue
      }
      const analysis = analyzeFile(file, flashes)
      frames[name] = analysis
      if (!analysis.anchor) {
        outputs[name] = {
          ok: false,
          failures: [
            'no white flash frame found; the file cannot be aligned to the hide and show presses'
          ],
          file,
          frameCount: analysis.features.length
        }
        continue
      }
      // Privacy by content: no picture of the hidden span, at either edge.
      const content = hiddenContentVerdict({
        features: analysis.features,
        ptsMs: analysis.ptsMs,
        hideGateAtMs,
        showAtMs
      })
      // The frost itself, in the file's own timeline.
      const frost = frostRunVerdict({
        features: analysis.features,
        ptsMs: analysis.ptsMs,
        offsetMs: analysis.anchor.offsetMs,
        hideAtMs,
        showAtMs,
        untilMs
      })
      const shed =
        name === 'screenFile' && shedEvent && !frost.ok
          ? `separate files shed under load (plan 200 D1) ${shedEvent.atMs - hideAtMs} ms from the hide; the file ends there, so only its leak check is judged`
          : null
      outputs[name] = {
        ...frost,
        ok: content.ok && (frost.ok || shed != null),
        failures: [...content.failures, ...(shed ? [] : frost.failures)],
        shed,
        content,
        file,
        frameCount: analysis.features.length,
        anchor: analysis.anchor,
        anchorDriftMs: analysis.anchorDriftMs
      }
      writeFileSync(
        join(outputDirectory, `hide-${name}-frames.json`),
        JSON.stringify(
          analysis.features.map((feature, index) => ({
            i: index,
            pts: Math.round(analysis.ptsMs[index] ?? -1),
            wall: Math.round((analysis.ptsMs[index] ?? 0) + analysis.anchor.offsetMs),
            c: feature.centre,
            sharp: feature.sharp,
            rep: feature.repeated ? 1 : 0,
            // The fixture's content clock: when this picture was drawn,
            // relative to the hide gate (null: frost, flash, unreadable).
            drawn:
              feature.contentMs == null
                ? null
                : Math.round(unwrapContentClockMs(feature.contentMs, hideGateAtMs) - hideGateAtMs)
          }))
        )
      )
    }
    const failures = []
    if (!hidden.reason || hidden.reason !== 'you')
      failures.push(`hidden reason "${hidden.reason}", expected "you"`)
    const result = {
      ok: failures.length === 0 && Object.values(outputs).every((output) => output.ok),
      failures,
      outputs,
      hideAtMs,
      hideGateAtMs,
      showAtMs,
      hideAckMs,
      showAckMs,
      hiddenSpanMs: showAtMs - hideAtMs,
      ring: { sessionId: ring.sessionId, seconds: ring.seconds },
      clip: {
        seconds: saved.payload.seconds,
        coveredSeconds: saved.payload.coveredSeconds,
        saveMs: saved.atMs - saveRequestedAt
      },
      detail: Object.entries(outputs)
        .map(([name, output]) =>
          output.skipped
            ? `${name}: SKIP (${output.reason})`
            : output.content
              ? `${name}: ${output.content.leaks.length} hidden picture(s) (last live picture drawn ${fmt(output.content.lastBeforeHideMs)} ms before the hide, first ${fmt(output.content.firstAfterShowMs)} ms after the show; clock read on ${output.content.liveReadable}/${output.content.liveFrames} live frames), ${output.shed ? `frost not judged: ${output.shed}` : `frost ${output.hidden.frostedFrames}/${output.hidden.frames} over ${fmt(output.frost?.durationMs)} ms (sharp max ${output.hidden.sharpMax}, live p50 ${output.liveBefore.sharpP50}→${output.liveAfter.sharpP50}), anchored hide ${fmt(output.hideLatencyMs)} ms, show ${fmt(output.showLatencyMs)} ms`}${output.ok ? '' : ' FAIL'}`
              : `${name}: ${output.failures.join('; ')}`
        )
        .join('; ')
    }
    return result
  })

  // ------------------------------------------------------------------ step 6
  summary.steps.passwordManager = await step('password-manager', async () => {
    // A session (the Clips ring included) pins the sources; the display pick
    // below needs the Studio idle. The hide step's `replay` can leave the
    // ring armed, so it is turned off again here.
    await renderer.setClips(false)
    await waitForBackendState(
      'replay.status',
      (ring) => ring?.state === 'off' || ring?.state === 'error',
      'the Clips ring off before the display scene',
      30_000
    ).catch(async (error) => {
      // The ring's own session, if the switch's path did not reach it.
      log(`  ${error.message.split(';')[0]}; stopping the ring's session directly`)
      await request(ws, timeoutMs, 'session.stop')
      await waitForBackendState(
        'replay.status',
        (ring) => ring?.state === 'off' || ring?.state === 'error',
        'the Clips ring off after session.stop',
        20_000
      )
    })
    await waitForRecordingIdle()
    await renderer.waitFor(
      (state) => state.recording === 'idle',
      'the Studio idle before the display scene'
    )
    // Beta's own scene would make the front-app change a switch as well as a
    // hide, and an app scene left on keeps its window on the preview while the
    // smoke's direct source pick takes effect; the list check wants a display
    // scene that stays on, so both app scenes go.
    for (const scene of (await renderer.state()).scenes.filter(
      (scene) => scene.visual.sources.app
    )) {
      const target = { sceneId: scene.id }
      if (gpuiApp) await renderer.command('studio-scene-delete', { id: target.sceneId })
      else
        await renderer.evaluate(
          `return await window.__videorcSmokeScenePresets.remove(${JSON.stringify(target.sceneId)})`
        )
    }
    await renderer.waitFor(
      (state) =>
        !state.scenes.some(
          (scene) => scene.id === targets.beta.sceneId || scene.id === targets.alpha.sceneId
        ),
      'app scenes removed'
    )
    // Deleting the scene on stream restores the working picture a moment
    // later; a display picked before that lands is overwritten by it.
    await renderer.waitFor(
      (state) => Boolean(state.activeId) && !state.pendingId,
      'D16 put the preceding scene on stream'
    )
    await sleep(1500)
    // D11 needs a display scene. Use the real Screen pick so D2 writes the
    // scene's display and clears the previous app before D19's layout edit.
    await renderer.selectDisplay(display)
    await waitForScreenLive(display.id)

    await openTab(smoke, 'layout', '[data-testid="password-manager-add"]')
    // GPUI: its Hide screen section has no Add app… picker yet, so the app
    // goes on the list through the Studio's own privacy settings.
    if (gpuiApp)
      await renderer.command('studio-privacy-add-app', {
        bundleId: fixtures.apps.beta.bundleId,
        name: fixtures.apps.beta.name
      })
    else
      await renderer.evaluate(`
      (await waitFor('[data-testid="password-manager-add"]', 8000)).click();
      const picker = await waitFor('[data-testid="password-manager-picker"]', 8000);
      const deadline = performance.now() + 20000;
      let item = null;
      while (performance.now() < deadline) {
        item = Array.from(picker.querySelectorAll('[data-slot="command-item"]')).find((node) =>
          (node.textContent ?? '').includes(${JSON.stringify(fixtures.apps.beta.name)})
        ) ?? null;
        if (item) break;
        await sleep(100);
      }
      if (!item) throw new Error('Add app… never offered ' + ${JSON.stringify(fixtures.apps.beta.name)} + ': ' + (picker.textContent ?? '').slice(0, 200));
      item.click();
      return true;
    `)
    const listed = await renderer
      .waitFor(() => true, 'privacy settings stored')
      .then(() =>
        gpuiApp
          ? renderer.command('studio-privacy-state')
          : renderer.evaluate(`
        const raw = window.__videorcUiSettings?.getItem('videorc.privacySettings.v1');
        return raw ? JSON.parse(raw) : null;
      `)
      )
    if (
      !listed?.addedPasswordManagers?.some(
        (app) => app.bundleId.toLowerCase() === fixtures.apps.beta.bundleId.toLowerCase()
      )
    )
      fail(
        `Fixture Beta is not on the password-manager list after Add app…: ${JSON.stringify(listed)}`
      )
    await openTab(smoke, 'studio', '[data-videorc-preview-card]')
    await activateApp('/System/Library/CoreServices/Finder.app')
    await waitForFrontApp((front) => front.bundleId === 'com.apple.finder')
    await sleep(SMART_SCENES_BUDGET.followSettleMs + 400)

    writeFileSync(
      join(outputDirectory, 'password-manager-setup.json'),
      JSON.stringify(
        {
          state: await renderer.state(),
          listed,
          native: await request(ws, timeoutMs, 'preview.screen.status')
        },
        null,
        2
      )
    )

    // Beta to the front: hidden for the list.
    await activateApp(fixtures.apps.beta.appPath)
    const front = await waitForFrontApp((entry) => entry.bundleId === fixtures.apps.beta.bundleId)
    const hiddenOnFront = await waitForBackendState(
      'screen.privacy.get',
      (privacy) => privacy.hidden === true,
      'hidden for the password manager',
      SMART_SCENES_BUDGET.passwordManagerHideMs + 2000
    ).catch(() => null)
    const onFront = {
      hidden: Boolean(hiddenOnFront?.hidden),
      reason: hiddenOnFront?.reason ?? null,
      latencyMs: hiddenOnFront ? Date.now() - front.seenAtMs : null
    }
    // Leaving shows.
    await activateApp('/System/Library/CoreServices/Finder.app')
    await waitForFrontApp((entry) => entry.bundleId === 'com.apple.finder')
    const shownOnLeave = await waitForBackendState(
      'screen.privacy.get',
      (privacy) => privacy.hidden === false,
      'shown again when the app left the front',
      SMART_SCENES_BUDGET.passwordManagerShowMs + 2000
    ).catch(() => ({ hidden: true }))
    await sleep(600)

    // A manual hide is never auto-shown.
    await renderer.togglePrivacy()
    const manualHidden = await waitForBackendState(
      'screen.privacy.get',
      (privacy) => privacy.hidden === true,
      'manual Hide screen',
      5000
    )
    await activateApp(fixtures.apps.beta.appPath)
    await waitForFrontApp((entry) => entry.bundleId === fixtures.apps.beta.bundleId)
    await sleep(SMART_SCENES_BUDGET.passwordManagerHideMs + 400)
    const afterFront = await request(ws, timeoutMs, 'screen.privacy.get')
    await activateApp('/System/Library/CoreServices/Finder.app')
    await waitForFrontApp((entry) => entry.bundleId === 'com.apple.finder')
    // A wrong auto-show would land after the settle: wait past it.
    await sleep(SMART_SCENES_BUDGET.passwordManagerShowMs + 400)
    const afterLeave = await request(ws, timeoutMs, 'screen.privacy.get')
    await renderer.togglePrivacy()
    const afterShow = await waitForBackendState(
      'screen.privacy.get',
      (privacy) => privacy.hidden === false,
      'Show screen after the manual hide',
      5000
    ).catch(() => ({ hidden: true }))
    const result = {
      onFront,
      onLeave: { hidden: shownOnLeave.hidden },
      manual: {
        hiddenReason: manualHidden.reason ?? null,
        afterFront: { hidden: afterFront.hidden, reason: afterFront.reason ?? null },
        afterLeave: { hidden: afterLeave.hidden, reason: afterLeave.reason ?? null },
        afterShow: { hidden: afterShow.hidden }
      }
    }
    return {
      ...passwordManagerGate(result),
      ...result,
      detail: `listed app in front → hidden ${onFront.hidden} (${onFront.reason}) in ${fmt(onFront.latencyMs)} ms (budget ${SMART_SCENES_BUDGET.passwordManagerHideMs}); left → hidden ${shownOnLeave.hidden}; manual hide: in front ${afterFront.hidden} (${afterFront.reason}), left ${afterLeave.hidden}, Show → ${afterShow.hidden}`
    }
  })

  // ------------------------------------------------------------------ step 7
  summary.steps.outOfSight = await step('out-of-sight', async () => {
    // Plan 219 S1: Alpha on the canvas, then minimized by the fixture itself
    // for ~15 s. The stall must be held (one notice, no recovery restart,
    // no source-missing), and frames must resume on the same generation.
    // Step 6 removed both app scenes, so the window goes on through the
    // Studio's own picker path (the working picture, no saved scene on).
    const pickWindow = async (fixture) => {
      await requestSmokeCommand(
        smoke,
        'select-screen-device',
        { sourceId: fixture.windowId, settleMs: 0 },
        { timeoutMs }
      )
      return waitForScreenLive(fixture.windowId)
    }
    const privacy = await request(ws, timeoutMs, 'screen.privacy.get')
    if (privacy.hidden) {
      await renderer.togglePrivacy()
      await waitForBackendState(
        'screen.privacy.get',
        (current) => current.hidden === false,
        'Show screen before the out-of-sight step',
        5000
      )
    }
    await pickWindow(alpha)
    // The streamer's case is a session: capture health samples the screen
    // for a consumer, and the Clips ring is the lightest one (the probe that
    // held correctly ran with it on; step 6 turned it off).
    await renderer.setClips(true)
    await waitForBackendState(
      'replay.status',
      (ring) => ring?.state === 'on',
      'the Clips ring on for the out-of-sight hold',
      30_000
    )
    // Capture health needs a flowing producer before it can call a stall:
    // a window minimized in the first second of a fresh generation has no
    // producer evidence yet and is never held. Three seconds of frames first.
    const liveBefore = await waitForBackendState(
      'preview.screen.status',
      (status) =>
        status?.state === 'live' &&
        status.sourceId === alpha.windowId &&
        (status.framesCaptured ?? 0) > 90 &&
        (status.frameAgeMs ?? Infinity) < 500,
      'Alpha flowing for three seconds before the minimize',
      15_000
    )
    const framesBefore = liveBefore.framesCaptured ?? 0
    const eventsFrom = events.length
    const minimizedAtMs = await minimizeFixtureApp(alpha)
    log(`  Alpha minimized at ${minimizedAtMs}`)
    const noticed = await waitForEvent(
      (entry) =>
        entry.event === 'health.event' &&
        entry.payload?.code === 'screen-window-out-of-sight' &&
        entry.atMs >= minimizedAtMs,
      'the out-of-sight notice',
      25_000
    ).catch(() => null)
    if (noticed)
      log(`  notice after ${noticed.atMs - minimizedAtMs} ms: ${noticed.payload.message}`)
    await sleep(Math.max(0, minimizedAtMs + 15_000 - Date.now()))
    const whileHidden = await request(ws, timeoutMs, 'preview.screen.status')
    const restoredAtMs = await restoreFixtureApp(alpha)
    log(`  Alpha restored at ${restoredAtMs}`)
    const back = await waitForEvent(
      (entry) =>
        entry.event === 'health.event' &&
        entry.payload?.code === 'screen-window-back' &&
        entry.atMs >= restoredAtMs,
      'the window-back notice',
      25_000
    ).catch(() => null)
    const resumed = await waitForBackendState(
      'preview.screen.status',
      (status) =>
        status?.state === 'live' &&
        status.sourceId === alpha.windowId &&
        (status.framesCaptured ?? 0) > (whileHidden.framesCaptured ?? 0) + 30,
      'frames flowing again after the restore',
      15_000
    )
    const since = events.slice(eventsFrom)
    const recoveryPhases = since
      .filter(
        (entry) => entry.event === 'capture.recovery.status' && entry.payload?.phase !== 'idle'
      )
      .map((entry) => entry.payload.phase)
    const screenStatuses = since
      .filter((entry) => entry.event === 'preview.screen.status')
      .map((entry) => entry.payload)

    // Plan 219 S2: a start on a window that is out of sight (Beta, not live)
    // is refused with copy the streamer can act on, and the same start goes
    // live once the window is back. Direct backend start, as the ISO
    // preflight does it (the dev app has no camera for a real ISO take).
    const betaSources = { windowId: beta.windowId, windowName: beta.name, cameraOff: true }
    const startParams = {
      sources: betaSources,
      video,
      protectedOverlayWindowIds: [],
      ffmpegPath
    }
    await minimizeFixtureApp(beta)
    await sleep(500)
    const refusedStatus = await request(ws, timeoutMs, 'preview.screen.start', startParams)
    log(`  start on minimized Beta: ${refusedStatus.state}: ${refusedStatus.message ?? ''}`)
    await restoreFixtureApp(beta)
    await sleep(500)
    const acceptedStatus = await request(ws, timeoutMs, 'preview.screen.start', startParams)
    let liveAfterRestore = acceptedStatus.state === 'live'
    if (!liveAfterRestore) {
      liveAfterRestore = await waitForBackendState(
        'preview.screen.status',
        (status) => status?.state === 'live' && status.sourceId === beta.windowId,
        'Beta live after its restore',
        15_000
      )
        .then(() => true)
        .catch(() => false)
    }
    log(`  start on restored Beta: ${acceptedStatus.state}; live ${liveAfterRestore}`)
    // The direct start moved the capture to Beta behind the renderer's
    // back (its pick is still Alpha): pick the display, then Alpha again,
    // so the renderer and the capture agree on Alpha. This is tidy-up for
    // whatever follows, never the step's evidence.
    try {
      await renderer.setClips(false)
      await renderer.selectDisplay(display)
      await waitForScreenLive(display.id)
      await pickWindow(alpha)
    } catch (error) {
      log(`  tidy-up after the step did not settle: ${error?.message?.split('\n')[0]}`)
    }

    const result = {
      noticed: Boolean(noticed),
      noticeMs: noticed ? noticed.atMs - minimizedAtMs : null,
      noticeMessage: noticed?.payload?.message ?? null,
      back: Boolean(back),
      backMs: back ? back.atMs - restoredAtMs : null,
      framesBefore,
      framesWhileHidden: whileHidden.framesCaptured ?? 0,
      framesAfter: resumed.framesCaptured ?? 0,
      stateWhileHidden: whileHidden.state,
      sourceWhileHidden: whileHidden.sourceId ?? null,
      recoveryPhases,
      screenStates: [...new Set(screenStatuses.map((status) => status.state))],
      sourceMissingSeen: screenStatuses.some((status) => status.state === 'source-missing'),
      refusal: {
        state: refusedStatus.state,
        message: refusedStatus.message ?? null,
        copyOk: outOfSightRefusalCopyOk(refusedStatus.message),
        liveAfterRestore
      }
    }
    return {
      ...outOfSightGate(result),
      ...result,
      detail: `minimized ${fmt(restoredAtMs - minimizedAtMs)} ms: notice after ${fmt(result.noticeMs)} ms, frames ${framesBefore} → ${result.framesWhileHidden} → ${result.framesAfter}, recovery ${recoveryPhases.length ? recoveryPhases.join(',') : 'none'}, back after ${fmt(result.backMs)} ms; start on a minimized window → ${result.refusal.state} (${result.refusal.copyOk ? 'copy ok' : 'copy wrong'}), live after restore ${liveAfterRestore}`
    }
  })

  summary.verdict = smartScenesVerdict(summary.steps)
  if (!summary.verdict.ok) exitCode = 1
} catch (error) {
  if (error instanceof SmokeExit) {
    exitCode = error.code
  } else {
    exitCode = 1
    summary.error = error?.stack ?? String(error)
    console.error(`[smoke:smart-scenes] FAIL ${error?.message ?? error}`)
  }
} finally {
  try {
    ws?.close()
  } catch {
    // closing
  }
  if (launched) {
    try {
      await launched.stop()
    } catch (error) {
      console.error(`[smoke:smart-scenes] dev app stop: ${error?.message ?? error}`)
    }
  }
  for (const receiver of receivers) await stopReceiver(receiver)
  await stopFixtureApps(fixtureProcesses)
  summary.hostLoadAtEnd = loadavg().map((value) => Number(value.toFixed(1)))
  writeFileSync(join(outputDirectory, 'dev-app.log'), devAppLogLines.join('\n') + '\n')
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  printHuman(summary)
  log(`summary ${summaryPath}`)
}
process.exit(exitCode)

// ---------------------------------------------------------------------------
// Steps and recordings

async function step(name, run) {
  log(`step ${name}`)
  const startedAt = Date.now()
  try {
    const result = await run()
    result.durationMs = Date.now() - startedAt
    writeFileSync(join(outputDirectory, name + '-result.json'), JSON.stringify(result, null, 2))
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'} ${name}: ${result.detail ?? ''}${result.ok ? '' : `; ${result.failures.join('; ')}`}`
    )
    return result
  } catch (error) {
    if (error instanceof SmokeExit) throw error
    const result = {
      ok: false,
      failures: [error?.message ?? String(error)],
      durationMs: Date.now() - startedAt,
      error: error?.stack ?? String(error)
    }
    writeFileSync(join(outputDirectory, name + '-result.json'), JSON.stringify(result, null, 2))
    console.log(`FAIL ${name}: ${result.failures[0]}`)
    return result
  }
}

/**
 * Records the program while `drive` runs (the fixture flashes at the start
 * and the end for the clock anchor), then decodes the file.
 */
async function recordWhile(name, smoke, drive, { streaming, simulcast } = {}) {
  const maxLoad = Number(process.env.VIDEORC_SMART_SCENES_MAX_HOST_LOAD ?? Infinity)
  if (['switches', 'camera-return'].includes(name) && Number.isFinite(maxLoad)) {
    const deadline = Date.now() + 600_000
    while (loadavg()[0] >= maxLoad) {
      if (Date.now() >= deadline)
        throw new Error(
          `No qualifying timing host: load ${loadavg()[0].toFixed(1)} is not below ${maxLoad}`
        )
      log(`waiting for a timing host below load ${maxLoad}; current ${loadavg()[0].toFixed(1)}`)
      await sleep(15000)
    }
  }
  const variant = {
    name,
    hostLoad: { start: loadavg()[0].toFixed(1), end: null },
    switches: [],
    flashes: []
  }
  const directory = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { path: outputDirectory, kind: 'output-directory' },
    { timeoutMs }
  )
  const renderer = createRendererDriver(smoke)
  const visual = (await renderer.state()).visual
  const started = await request(ws, timeoutMs, 'session.start', {
    sources: visual.sources,
    layout: visual.layout,
    background: null,
    output: {
      recordEnabled: true,
      streamEnabled: Boolean(streaming),
      outputDirectoryCapability: directory.capabilityId,
      video,
      rtmp: {
        preset: 'custom',
        serverUrl: streaming?.targets[0]?.serverUrl ?? '',
        streamKey: streaming?.targets[0]?.streamKey ?? ''
      }
    },
    ...(streaming ? { streaming, simulcast } : {})
  })
  if (!['recording', 'streaming'].includes(started.state))
    fail(`[${name}] expected a recording after session.start, got ${started.state}`)
  await renderer.waitFor(
    (state) => ['recording', 'streaming'].includes(state.recording),
    `${name}: recording state`
  )
  await sleep(1500)
  variant.flashes.push(await flashFixtureApp(fixtureByKey('alpha'), 'start'))
  await sleep(1200)
  let driveError = null
  try {
    await drive(variant)
  } catch (error) {
    driveError = error
  }
  await sleep(400)
  variant.flashes.push(await flashFixtureApp(fixtureByKey('alpha'), 'end'))
  await sleep(900)
  const stopped = await request(ws, timeoutMs, 'session.stop')
  await renderer.waitFor((state) => state.recording === 'idle', `${name}: session stopped`)
  const file = await resolveFinalRecordingPath({ started, stopped, timeoutMs })
  if (!file || !existsSync(file)) fail(`[${name}] recording file missing: ${file}`)
  const analysis = analyzeFile(file, variant.flashes)
  if (!analysis.anchor)
    fail(`[${name}] no white flash frame in ${file}; the recording cannot be aligned`)
  writeFileSync(
    join(outputDirectory, `${name}-frames.json`),
    JSON.stringify(
      analysis.features.map((feature, index) => ({
        i: index,
        pts: Math.round(analysis.ptsMs[index] ?? -1),
        c: feature.centre,
        mark: feature.layoutMark ? 1 : 0,
        rep: feature.repeated ? 1 : 0,
        sharp: feature.sharp
      }))
    )
  )
  variant.hostLoad.end = loadavg()[0].toFixed(1)
  variant.recording = {
    file,
    frameCount: analysis.features.length,
    anchorOffsetMs: analysis.anchor.offsetMs,
    anchorDriftMs: analysis.anchorDriftMs
  }
  writeFileSync(
    join(outputDirectory, name + '-recording.json'),
    JSON.stringify(
      {
        recording: variant.recording,
        switches: variant.switches,
        verticalOnly: variant.verticalOnly,
        rapidKeys: variant.rapidKeys,
        flashes: variant.flashes,
        hostLoad: variant.hostLoad,
        driveError: driveError?.message ?? null
      },
      null,
      2
    )
  )
  if (driveError) throw driveError
  variant.analysis = analysis
  log(
    `  ${name} recording ${file}: ${analysis.features.length} frames, anchor drift ${fmt(analysis.anchorDriftMs)} ms`
  )
  return variant
}

/** Decodes one file to per-frame features and anchors it on the flashes. */
function analyzeFile(file, flashes) {
  const { features, ptsMs, width, height } = decodeSceneFrames(file, {
    ffmpegPath,
    ffprobePath,
    width: ANALYSIS_WIDTH,
    height: ANALYSIS_HEIGHT
  })
  const start = flashes.find((flash) => flash.label === 'start')
  const end = flashes.find((flash) => flash.label === 'end')
  let anchor = start ? anchorFromFlash(features, ptsMs, start.drawnAtMs) : null
  let anchorDriftMs = null
  let anchoredBy = anchor ? 'start' : null
  if (anchor && end) {
    const endAnchor = anchorFromFlash(features, ptsMs, end.drawnAtMs, {
      afterPtsMs: ptsMs[anchor.frameIndex] + 1000
    })
    if (endAnchor) anchorDriftMs = Math.round(endAnchor.offsetMs - anchor.offsetMs)
    else if (end.drawnAtMs - start.drawnAtMs > 1500) {
      // One white run only: a file that starts after the start flash (a
      // clip) holds the end flash alone.
      anchor = anchorFromFlash(features, ptsMs, end.drawnAtMs)
      anchoredBy = 'end'
    }
  }
  return {
    file,
    width,
    height,
    ptsMs,
    features,
    anchor: anchor ? { ...anchor, by: anchoredBy } : null,
    anchorDriftMs
  }
}

// ---------------------------------------------------------------------------
// Renderer driver

function createRendererDriver(smoke) {
  const evaluate = async (code) => {
    if (gpuiApp) throw new Error('eval-js has no GPUI form; this step needs a GPUI branch')
    const response = await requestSmokeCommand(smoke, 'eval-js', { code }, { timeoutMs })
    return response && typeof response === 'object' && 'result' in response
      ? response.result
      : response
  }
  const command = (name, params = {}, waitMs = timeoutMs) =>
    requestSmokeCommand(smoke, name, params, { timeoutMs: waitMs })
  /** The renderer's scene-preset state, from the GPUI Studio smoke handler. */
  const gpuiState = async () => {
    const [scenes, studio] = await Promise.all([
      command('studio-scenes-state'),
      command('studio-state')
    ])
    return {
      canSave: scenes.loaded === true && !scenes.readOnly,
      scenes: scenes.scenes ?? [],
      library: scenes.library ?? [],
      keys: scenes.keys ?? [],
      activeId: scenes.onStreamId ?? null,
      pendingId: scenes.pendingSceneId ?? null,
      modified: scenes.modified,
      visual: { sources: scenes.working?.sources ?? {}, layout: scenes.working?.layout ?? {} },
      recording: studio.status?.state ?? null,
      diagnostics: { wsStatus: studio.connection?.state, phase: studio.phase }
    }
  }
  const state = () => (gpuiApp ? gpuiState() : evaluate(scenePresetStateReadCode))
  /** What a refused apply said: the Studio's start failure and last error. */
  const gpuiReasons = async () => {
    const studio = await command('studio-state').catch(() => null)
    return [studio?.startFailure, studio?.lastError].filter(Boolean)
  }
  /** `apply(id)`: true once on stream; false with the reason otherwise. */
  const applyScene = async (sceneId) => {
    if (!gpuiApp)
      return evaluate(
        `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(sceneId)})`
      )
    try {
      await command('studio-scene-apply', { id: sceneId })
      return true
    } catch (error) {
      log(`studio-scene-apply ${sceneId}: ${error?.message ?? error}`)
      return false
    }
  }
  let gpuiSwitch = null
  /** The stored v2 library (`videorc.scenes.v2`): `{scenes: [...]}`. */
  const storedLibrary = async () =>
    gpuiApp
      ? { scenes: (await gpuiState()).library }
      : evaluate(`return JSON.parse(window.__videorcUiSettings?.getItem('videorc.scenes.v2'))`)
  /** `edit(scene)`: a stored v2 scene in its place; true when saved. */
  const editScene = async (scene) => {
    if (!gpuiApp)
      return evaluate(`return window.__videorcSmokeScenePresets.edit(${JSON.stringify(scene)})`)
    await command('studio-scene-edit', { scene })
    return true
  }
  /** `configure(patch)`: a patch over the capture config. */
  const configure = async (patch) => {
    if (gpuiApp) return command('studio-capture-configure', { config: patch })
    return evaluate(
      `window.__videorcSmokeScenePresets.configure(${JSON.stringify(patch)}); return true`
    )
  }
  const waitFor = async (predicate, description, waitMs = timeoutMs) => {
    const until = Date.now() + waitMs
    let lastState = null
    let lastError = null
    while (Date.now() < until) {
      try {
        lastState = await state()
        lastError = null
      } catch (error) {
        if (!/not ready|destroyed|navigation|context/i.test(String(error))) throw error
        lastError = String(error)
      }
      if (lastState && predicate(lastState)) return lastState
      await sleep(100)
    }
    const statePath = join(outputDirectory, 'last-renderer-state.json')
    writeFileSync(statePath, JSON.stringify(lastState, null, 2))
    throw new Error(
      `Timed out: ${description}; last error: ${lastError}; renderer state in ${statePath}; diagnostics: ${JSON.stringify(lastState?.diagnostics)?.slice(0, 800)}`
    )
  }
  const applyLayout = async (
    patch,
    predicate,
    description,
    { attempts = 4, waitMs = 10_000 } = {}
  ) => {
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (gpuiApp) await command('studio-scene-layout', { patch }).catch(() => undefined)
      else
        await evaluate(
          `window.__videorcSmokeScenePresets.layout(${JSON.stringify(patch)}); return true`
        )
      try {
        return await waitFor(predicate, `${description} (attempt ${attempt})`, waitMs)
      } catch (error) {
        lastError = error
        log(`${description}: not confirmed on attempt ${attempt}, retrying`)
      }
    }
    throw lastError
  }
  const chooseCameraOff = async () => {
    if (gpuiApp) await command('select-camera-device', { off: true, settleMs: 0 })
    else await evaluate(`return await window.__videorcSmokeScenePresets.pickCameraOff()`)
    return waitFor(
      (current) =>
        current.canSave &&
        current.visual.sources.cameraOff === true &&
        !current.visual.sources.cameraId,
      'confirmed Camera Off'
    )
  }
  /**
   * The default Clips ring restarts on every scene apply; off unless a step
   * needs it. The Output switch's own path (`__videorcSmokeSetReplayBuffer`,
   * as smoke:replay-buffer uses it) stops a running buffer-only session too.
   */
  const setClips = async (enabled) => {
    if (gpuiApp) {
      const armed = await command('studio-replay-buffer', { armed: enabled, seconds: 60 })
      if (armed?.armed !== enabled)
        throw new Error(`studio-replay-buffer answered ${JSON.stringify(armed)}`)
      return
    }
    await waitForRendererHook(smoke, '__videorcSmokeSetReplayBuffer', { timeoutMs })
    const outcome = await evaluate(
      `return window.__videorcSmokeSetReplayBuffer?.(${enabled ? 'true' : 'false'}, 60) ?? null`
    )
    if (outcome !== true)
      throw new Error(`the renderer's replay buffer hook returned ${JSON.stringify(outcome)}`)
  }
  /**
   * The Studio's own Screen picker path for a display. The renderer may still
   * be restoring the working picture after a scene left, so the pick is
   * repeated until the display holds for a second without a window.
   */
  const selectDisplay = async (device, { attempts = 4 } = {}) => {
    const settled = (current) =>
      current.visual.sources.screenId === device.id && !current.visual.sources.windowId
    let lastError = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const before = await state()
        if (gpuiApp) await command('select-screen-device', { sourceId: device.id, settleMs: 0 })
        else
          await evaluate(
            `return await window.__videorcSmokeScenePresets.pickScreen(${JSON.stringify(device.id)})`
          )
        await waitFor(settled, `working scene on ${device.name} (attempt ${attempt})`, 5000)
        await sleep(1000)
        const held = await state()
        if (!settled(held))
          throw new Error(`${device.name} did not hold: ${JSON.stringify(held.visual.sources)}`)
        await applyLayout(
          { layoutPreset: 'screen-only' },
          (current) =>
            current.canSave &&
            settled(current) &&
            current.visual.layout.layoutPreset === 'screen-only',
          `${device.name} scene-screen pick and Screen only confirmed`
        )
        const after = await state()
        assert.equal(after.activeId, before.activeId, 'a Screen pick edits the scene on stream')
        assert.equal(
          after.scenes.find((scene) => scene.id === after.activeId).visual.sources.app,
          undefined
        )
        return
      } catch (error) {
        lastError = error
        log(`display pick attempt ${attempt} failed: ${error?.message?.split('\n')[0]}`)
      }
    }
    throw lastError
  }
  /**
   * D3: an edit made while a saved scene is on saves into it as it lands.
   * The smoke never saves on the scene's behalf: a scene that does not carry
   * the edit is a product failure, and the message says what it holds.
   */
  const waitForSceneToCarry = async (id, name, predicate, what) => {
    try {
      await waitFor(
        (current) => {
          const scene = current.scenes.find((entry) => entry.id === id)
          return Boolean(scene && predicate(scene))
        },
        `scene ${name} carries ${what}`,
        5000
      )
    } catch (error) {
      const current = await state()
      const scene = current.scenes.find((entry) => entry.id === id)
      throw new Error(
        `D3 auto-save: scene "${name}" did not carry ${what} within 5 s of the edit (active scene ${JSON.stringify(current.activeId)}, working layout ${JSON.stringify(current.visual?.layout?.arrangementMode)}; saved layout ${JSON.stringify(scene?.visual?.layout ?? null).slice(0, 300)}; audio ${JSON.stringify(scene?.audio ?? null)}): ${error?.message?.split('\n')[0]}`
      )
    }
  }
  /** The refusal copy a scene apply toasts, so a refused switch names its reason. */
  const toasts = () =>
    gpuiApp
      ? gpuiReasons()
      : evaluate(`
      return Array.from(document.querySelectorAll('[data-sonner-toast]')).map((node) =>
        (node.textContent ?? '').replace(/\\s+/g, ' ').trim()
      );
    `)
  const goTo = async (target, { attempts = 3 } = {}) => {
    let ok = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      ok = await applyScene(target.sceneId)
      if (ok === true) break
      const reasons = await toasts()
      log(
        `applying scene ${target.key} returned ${JSON.stringify(ok)} on attempt ${attempt}; toasts: ${JSON.stringify(reasons)}`
      )
      if (attempt < attempts) await sleep(700)
    }
    if (ok !== true)
      throw new Error(
        `Applying scene ${target.key} returned ${JSON.stringify(ok)} after ${attempts} attempts; toasts: ${JSON.stringify(await toasts())}`
      )
    await waitFor(
      (current) => current.activeId === target.sceneId && !current.pendingId,
      `scene ${target.key} active`
    )
  }
  const requestSwitch = async (sceneId) => {
    if (gpuiApp) {
      const reqAt = Date.now()
      gpuiSwitch = { sceneId, reqAt }
      await command('studio-scene-apply', { id: sceneId, wait: false })
      return reqAt
    }
    return evaluate(`
      window.__vrcSmokeSwitch = { reqAt: Date.now(), done: null };
      window.__videorcSmokeScenePresets.apply(${JSON.stringify(sceneId)}).then(
        (ok) => { window.__vrcSmokeSwitch.done = { ok, at: Date.now() }; },
        (error) => { window.__vrcSmokeSwitch.done = { ok: false, error: String(error), at: Date.now() }; }
      );
      return window.__vrcSmokeSwitch.reqAt;
    `)
  }
  const requestSlot = async (sceneId) => {
    const position = (await state()).scenes.findIndex((scene) => scene.id === sceneId) + 1
    assert.ok(position >= 1 && position <= 9)
    if (gpuiApp) {
      const requested = Date.now()
      await command('studio-shortcut', { action: `scene-slot-${position}` })
      return requested
    }
    return evaluate(`
      const requested = Date.now();
      window.__videorcSmokeScenePresets.shortcut('scene-slot-${position}');
      return requested;
    `)
  }
  const waitForSwitchDone = async (waitMs) => {
    const until = Date.now() + waitMs
    while (Date.now() < until) {
      if (gpuiApp) {
        // The GPUI apply runs on in the app: done once its scene is on
        // stream with nothing pending (a refusal shows as never done).
        const scenes = await command('studio-scenes-state')
        if (gpuiSwitch && scenes.onStreamId === gpuiSwitch.sceneId && !scenes.pendingSceneId) {
          return { ok: true, at: Date.now() }
        }
        await sleep(25)
        continue
      }
      const done = await evaluate(`return window.__vrcSmokeSwitch?.done ?? null`)
      if (done) return done
      await sleep(25)
    }
    return { ok: false, error: 'renderer never settled the switch', at: null }
  }
  /** The Screen row's Hide screen / Show screen button on the Studio page. */
  const togglePrivacy = async () => {
    if (gpuiApp) {
      // The Studio's Hide screen / Show screen, as the streamer's own.
      const current = await request(ws, timeoutMs, 'screen.privacy.get', {})
      if (current?.unavailable)
        throw new Error(`Hide screen is unavailable: ${current.unavailable}`)
      await command('studio-screen-privacy', { hidden: !current?.hidden })
      return true
    }
    return evaluate(`
      const button = await waitFor('[data-videorc-screen-privacy]', 8000);
      if (button.disabled) throw new Error('Hide screen is disabled: ' + (button.getAttribute('aria-label') ?? button.textContent));
      button.click();
      return true;
    `)
  }
  return {
    evaluate,
    command,
    storedLibrary,
    editScene,
    configure,
    state,
    waitFor,
    applyLayout,
    chooseCameraOff,
    setClips,
    selectDisplay,
    waitForSceneToCarry,
    goTo,
    requestSwitch,
    requestSlot,
    waitForSwitchDone,
    togglePrivacy
  }
}

async function openTab(smoke, tab, waitForSelector) {
  await requestSmokeCommand(smoke, 'open-tab', { tab, waitFor: waitForSelector }, { timeoutMs })
}

// ---------------------------------------------------------------------------
// Backend waits

async function waitForRecordingIdle() {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'recording.status')
    if (last?.state === 'idle') return last
    await sleep(100)
  }
  throw new Error(`Backend never went idle after turning Clips off: ${JSON.stringify(last)}`)
}

async function waitForScreenLive(sourceId) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'preview.screen.status')
    if (last?.state === 'live' && last.sourceId === sourceId && (last.framesCaptured ?? 0) > 0)
      return last
    await sleep(100)
  }
  const statePath = join(outputDirectory, 'last-renderer-state.json')
  try {
    writeFileSync(
      statePath,
      JSON.stringify(await createRendererDriver(smokeConnection).state(), null, 2)
    )
  } catch {
    // the renderer may be gone
  }
  throw new Error(
    `Screen preview never went live on ${sourceId}: ${JSON.stringify(last)}; renderer state in ${statePath}`
  )
}

async function waitForBackendState(method, predicate, description, waitMs = timeoutMs) {
  const deadline = Date.now() + waitMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, method)
    if (predicate(last)) return last
    await sleep(25)
  }
  throw new Error(
    `Timed out: ${description}; last ${method}: ${JSON.stringify(last)?.slice(0, 400)}`
  )
}

async function waitForEvent(predicate, description, waitMs) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found) return found
    await sleep(50)
  }
  throw new Error(
    `Timed out: ${description}; events seen: ${events
      .map((entry) => entry.event)
      .slice(-12)
      .join(', ')}`
  )
}

// ---------------------------------------------------------------------------
// Fixtures and the RTMP sink

async function launchFixture(app, placement) {
  const fixture = await launchFixtureApp(app, { ...placement, width: 1280, height: 720 })
  fixtureProcesses.push(fixture)
  return fixture
}

function fixtureByKey(key) {
  return fixtureProcesses.find((fixture) => fixture.key === key && !fixture.exited)
}

function lsappinfoCount(bundleId) {
  try {
    const out = execFileSync('lsappinfo', ['find', `bundleid=${bundleId}`], { encoding: 'utf8' })
    return out.split(/\s+/).filter((token) => token.startsWith('ASN:')).length
  } catch {
    return 0
  }
}

function lsappinfoBundlePath(bundleId) {
  try {
    const asn = execFileSync('lsappinfo', ['find', `bundleid=${bundleId}`], {
      encoding: 'utf8'
    }).trim()
    const out = execFileSync('lsappinfo', ['info', '-only', 'bundlepath', asn], {
      encoding: 'utf8'
    })
    return /"LSBundlePath"="([^"]*)"/.exec(out)?.[1] ?? null
  } catch {
    return null
  }
}

/** The first TCP port at or above `base` that binds on the loopback address. */
async function freeTcpPort(base, span = 20) {
  for (let port = base; port < base + span; port += 1) {
    const free = await new Promise((resolveFree) => {
      const server = createServer()
      server.once('error', () => resolveFree(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolveFree(true)))
    })
    if (free) return port
  }
  throw new Error(`no free TCP port in ${base}..${base + span - 1} for the RTMP sink`)
}

function startReceiver({ port, recvPath }) {
  const child = spawn(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      `rtmp://127.0.0.1:${port}/live/smart-scenes`,
      '-c',
      'copy',
      '-f',
      'flv',
      recvPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const receiver = { child, path: recvPath, log: '', exited: null }
  receiver.exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
    child.once('error', (error) => resolveExit({ error }))
  })
  child.stderr.on('data', (text) => {
    receiver.log = (receiver.log + text).slice(-8000)
  })
  return receiver
}

async function waitForReceiverExit(receiver, ms) {
  let timer
  try {
    const result = await Promise.race([
      receiver.exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the RTMP sink did not finish: ${receiver.log}`)),
          ms
        )
      })
    ])
    if (result.error) throw result.error
  } finally {
    clearTimeout(timer)
  }
}

async function stopReceiver(receiver) {
  if (receiver.child.exitCode !== null || receiver.child.signalCode !== null) return
  receiver.child.kill('SIGTERM')
  try {
    await waitForReceiverExit(receiver, 2000)
  } catch {
    receiver.child.kill('SIGKILL')
    await waitForReceiverExit(receiver, 2000).catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Small helpers

function skip(reason, flag) {
  summary.skipped = true
  summary.reason = reason
  summary.flag = flag
  console.log(`SKIP smoke:smart-scenes: ${reason}`)
  throw new SmokeExit(0)
}

function fail(message) {
  throw new Error(message)
}

function log(message) {
  console.log(`[smoke:smart-scenes] ${message}`)
}

/**
 * Wall milliseconds of the backend's RFC 3339 `since` (it carries
 * nanoseconds; `Date.parse` takes at most milliseconds), or null.
 */
function parseSinceMs(since) {
  if (typeof since !== 'string') return null
  const trimmed = since.replace(/(\.\d{3})\d+/, '$1')
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? ms : null
}

function fmt(value) {
  return value == null ? 'n/a' : String(Math.round(value))
}

function sum(values) {
  return values.reduce((total, value) => total + (value ?? 0), 0)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function findWindowDevice(devices, windowId) {
  return (
    (devices ?? []).find((device) => device.kind === 'window' && device.id === windowId) ?? null
  )
}

function printHuman(summaryValue) {
  if (summaryValue.skipped) {
    console.log(`SKIP smoke:smart-scenes: ${summaryValue.reason}`)
    return
  }
  if (summaryValue.error)
    console.log(`smoke:smart-scenes FAILED: ${summaryValue.error.split('\n')[0]}`)
  if (summaryValue.verdict) {
    console.log(
      summaryValue.verdict.ok
        ? 'smoke:smart-scenes: PASS (migration, append/reorder/keys, retained capture, both legs, relaunch, Follow and privacy)'
        : `smoke:smart-scenes: FAIL ${summaryValue.verdict.failures.join('; ')}`
    )
  }
}

function parseArgs(argv) {
  const parsed = { switches: 20, out: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const [flag, inlineValue] = argument.includes('=') ? argument.split(/=(.*)/s) : [argument, null]
    const value = () => {
      if (inlineValue != null) return inlineValue
      if (index + 1 >= argv.length) throw new Error(`${flag} needs a value`)
      index += 1
      return argv[index]
    }
    switch (flag) {
      case '--switches':
        parsed.switches = Math.max(1, Number(value()))
        break
      case '--out':
        parsed.out = value()
        break
      default:
        throw new Error(`Unknown argument ${argument}`)
    }
  }
  return parsed
}
