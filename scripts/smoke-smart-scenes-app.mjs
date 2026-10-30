#!/usr/bin/env node
// Proves plan 210 end to end on the dev app (S11): scenes made for apps,
// swap in place within D5's budget, a scene that survives its app's relaunch,
// Follow the app in front (D10), Hide screen on every output (D8) and the
// password-manager hide (D11).
//
// Setup: the two fixture apps (scripts/fixtures/build-fixture-apps.mjs:
// Fixture Alpha, red; Fixture Beta, blue), the dev app on an isolated smoke
// profile with the smoke command server, a 1920x1080@30 canvas, camera off,
// Clips off except where a step needs the ring.
//
// Steps, each PASS, FAIL or SKIP (a SKIP names the macOS grant it lacks):
//   1 new-scenes       New scene… on the Scene page picks both fixtures and
//                      adds two scenes with `app` and no `audio`.
//   2 switches         20 switches A→B→A while recording; the recording,
//                      decoded per frame and aligned by Alpha's white flash,
//                      gives click→new picture p50/p95, black and
//                      wrong-layout frames (Beta is a shrunk freeform layout,
//                      so every switch also changes the layout). Gate: D5.
//   3 relaunch         Quit Fixture Beta: its scene is refused. Relaunch it:
//                      the scene switches to the new window.
//   4 follow           Bring Beta, then Alpha, then Finder (no scene) to the
//                      front with `open`; the program follows within the
//                      400 ms settle plus the budget and stays on Finder (and
//                      on Videorc when it is the only Electron app running).
//   5 hide             Record + stream to a local FFmpeg RTMP sink with the
//                      Screen file (separate source recordings) and the Clips
//                      ring on; Hide screen for four seconds, Show, save a
//                      clip. The recording, the stream, the Screen file and
//                      the clip each show a frosted, still picture for the
//                      hidden span and a sharp, moving one after Show.
//   6 password-manager Fixture Beta goes on the password-manager list; on a
//                      display scene, Beta in front hides, leaving shows, and
//                      a manual hide is never auto-shown.
//
// Output: `<out>/smart-scenes-summary.json` (every number, per-frame
// classes per output) and one line per step. Exit 1 on any FAIL. Never goes
// live on a real channel.
//
// Usage: pnpm smoke:smart-scenes [-- --switches 20 --out <dir>]
//   VIDEORC_SMOKE_TIMEOUT_MS, VIDEORC_SMOKE_RTMP_PORT (13937),
//   VIDEORC_SMOKE_FFMPEG_PATH, VIDEORC_SMOKE_FFPROBE_PATH

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { hostname, loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildFixtureApps } from './fixtures/build-fixture-apps.mjs'
import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import {
  activateApp,
  flashFixtureApp,
  frontApp,
  launchFixtureApp,
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
  frostFeaturesFromRawFrames,
  hideSpanVerdict,
  newScenesGate,
  passwordManagerGate,
  relaunchGate,
  smartScenesVerdict,
  switchGate
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
    skip('scenes for apps, Follow and the fixture apps are macOS only (plan 210 D12)', 'not-macos')
  }
  for (const tool of [ffmpegPath, ffprobePath]) {
    try {
      execFileSync(tool, ['-version'], { stdio: 'ignore' })
    } catch {
      fail(`${tool} is not runnable; the smoke decodes every output with it.`)
    }
  }
  const fixtures = buildFixtureApps({ outputDir: join(tmpdir(), 'videorc-fixture-apps') })
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
    onLine: (line) => devAppLogLines.push(line)
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
  await renderer.evaluate(
    `window.__videorcSmokeScenePresets.configure({video: ${JSON.stringify(video)}}); return true`
  )
  await renderer.chooseCameraOff()
  await renderer.setClips(false)
  await waitForRecordingIdle()
  await renderer.applyLayout(
    { layoutPreset: 'screen-only' },
    (state) => state.canSave && state.visual.layout.layoutPreset === 'screen-only',
    'screen-only working scene'
  )

  // ------------------------------------------------------------------ step 1
  const targets = {
    alpha: { key: 'alpha', color: 'red', fixture: alpha, app: fixtures.apps.alpha, sceneId: null },
    beta: { key: 'beta', color: 'blue', fixture: beta, app: fixtures.apps.beta, sceneId: null }
  }
  summary.steps.newScenes = await step('new-scenes', async () => {
    await openTab(smoke, 'layout', '[data-testid="scene-new"]')
    const before = (await renderer.state()).scenes.length
    await renderer.evaluate(`
      (await waitFor('[data-testid="scene-new"]', 8000)).click();
      for (const id of ${JSON.stringify([fixtures.apps.alpha.bundleId, fixtures.apps.beta.bundleId])}) {
        const card = await waitFor('[data-app-choice="' + id + '"]', 20000);
        if (card.getAttribute('aria-pressed') !== 'true') card.click();
      }
      const add = await waitFor('[data-testid="new-scene-add"]', 8000);
      const deadline = performance.now() + 8000;
      while (add.disabled && performance.now() < deadline) await sleep(50);
      if (add.disabled) throw new Error('Add scenes stayed disabled: ' + (add.closest('[data-slot]')?.textContent ?? ''));
      add.click();
      return true;
    `)
    const state = await renderer.waitFor(
      (current) =>
        current.scenes.length >= before + 2 &&
        [fixtures.apps.alpha.bundleId, fixtures.apps.beta.bundleId].every((id) =>
          current.scenes.some((scene) => scene.visual?.sources?.app?.bundleId === id)
        ),
      'two scenes made for the fixtures'
    )
    for (const target of Object.values(targets)) {
      target.sceneId = state.scenes.find(
        (scene) => scene.visual.sources.app?.bundleId === target.app.bundleId
      ).id
    }
    const verdict = newScenesGate(state.scenes, [fixtures.apps.alpha, fixtures.apps.beta])
    return {
      ...verdict,
      scenes: state.scenes.map((scene) => ({
        id: scene.id,
        name: scene.name,
        app: scene.visual.sources.app ?? null,
        windowId: scene.visual.sources.windowId ?? null,
        audio: scene.audio ?? null
      })),
      detail: `"${state.scenes.find((scene) => scene.id === targets.alpha.sceneId).name}" and "${state.scenes.find((scene) => scene.id === targets.beta.sceneId).name}", app scenes, no audio`
    }
  })
  if (!summary.steps.newScenes.ok) fail('every later step needs the two app scenes; stopping here')
  await openTab(smoke, 'studio', '[data-videorc-preview-card]')

  // Beta becomes a shrunk freeform layout (edits auto-save into the scene on
  // stream, D3), so every switch also changes the layout and a wrong-layout
  // frame is countable. Alpha stays full-bleed for the frost checks.
  // The edit is the Scene page's Freeform entry (`freeformEntryPatch`): the
  // arrangement and the placement, never a layout preset. A preset without
  // `keepScene` is a switch to a built-in layout, which leaves the saved scene
  // by design (D3), so it would never save into Beta.
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
        const requestedAtMs = await renderer.requestSwitch(next.sceneId)
        const done = await renderer.waitForSwitchDone(switchTimeoutMs)
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
      detail: `${stats.switches} switches, click→new picture p50 ${fmt(latency.p50)} p95 ${fmt(latency.p95)} max ${fmt(latency.max)} ms (budget ${SMART_SCENES_BUDGET.switchP95Ms}), black ${stats.pixels.blackFramesTotal + stats.pixels.afterCutBlackFramesTotal}, wrong layout ${stats.pixels.wrongLayoutFramesTotal}, cuts ${stats.pixels.cutsSeen}/${stats.switches}, host load ${run.hostLoad.start}→${run.hostLoad.end}`
    }
  })

  // ------------------------------------------------------------------ step 3
  summary.steps.relaunch = await step('relaunch', async () => {
    const windowIdBefore = beta.windowId
    await stopFixtureApp(beta)
    await sleep(800)
    const refusedAt = Date.now()
    const refused = await renderer.evaluate(
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
    const electronApps = lsappinfoCount(ELECTRON_BUNDLE_ID)
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
      const verdict = hideSpanVerdict({
        features: analysis.features,
        ptsMs: analysis.ptsMs,
        offsetMs: analysis.anchor.offsetMs,
        hideAtMs,
        showAtMs,
        untilMs
      })
      outputs[name] = {
        ...verdict,
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
            rep: feature.repeated ? 1 : 0
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
            : output.hidden
              ? `${name}: frosted ${output.hidden.frostedFrames}/${output.hidden.frames} (sharp max ${output.hidden.sharpMax}, live p50 ${output.liveBefore.sharpP50}→${output.liveAfter.sharpP50}), hide +${fmt(output.hideLatencyMs)} ms, show +${fmt(output.showLatencyMs)} ms${output.ok ? '' : ' FAIL'}`
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
    for (const target of [targets.beta, targets.alpha]) {
      await renderer.evaluate(
        `return window.__videorcSmokeScenePresets.remove(${JSON.stringify(target.sceneId)})`
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
    await renderer.waitFor((state) => state.activeId === null, 'no saved scene on')
    await sleep(1500)
    // D11 acts while a whole display is on stream; the working picture (no
    // saved scene on) is that. The smoke's direct pick keeps the previous
    // scene's `app` on the working sources, which the follower ignores with
    // no saved scene on, and which a saved display scene would carry, so no
    // display scene is saved here.
    await renderer.selectDisplay(display)
    await waitForScreenLive(display.id)

    await openTab(smoke, 'layout', '[data-testid="password-manager-add"]')
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
        renderer.evaluate(`
        const raw = localStorage.getItem('videorc.privacySettings.v1');
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
    console.log(`FAIL ${name}: ${result.failures[0]}`)
    return result
  }
}

/**
 * Records the program while `drive` runs (the fixture flashes at the start
 * and the end for the clock anchor), then decodes the file.
 */
async function recordWhile(name, smoke, drive) {
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
      streamEnabled: false,
      outputDirectoryCapability: directory.capabilityId,
      video,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
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
  await drive(variant)
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
  variant.analysis = analysis
  log(
    `  ${name} recording ${file}: ${analysis.features.length} frames, anchor drift ${fmt(analysis.anchorDriftMs)} ms`
  )
  return variant
}

/** Decodes one file to per-frame features and anchors it on the flashes. */
function analyzeFile(file, flashes) {
  const ptsMs = execFileSync(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'frame=best_effort_timestamp_time',
      '-of',
      'csv=p=0',
      file
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .trim()
    .split(/\r?\n/)
    .map((line) => Number(line.split(',')[0]) * 1000)
  const raw = execFileSync(
    ffmpegPath,
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      `scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT}:flags=area`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    ],
    { maxBuffer: 2 * 1024 * 1024 * 1024 }
  )
  const features = frostFeaturesFromRawFrames(raw, {
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
    const response = await requestSmokeCommand(smoke, 'eval-js', { code }, { timeoutMs })
    return response && typeof response === 'object' && 'result' in response
      ? response.result
      : response
  }
  const state = () => evaluate(scenePresetStateReadCode)
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
    await evaluate(`
      const current = window.__videorcSmokeScenePresets.state();
      window.__videorcSmokeScenePresets.configure({sources: {
        ...current.visual.sources, cameraId: undefined, cameraName: undefined, cameraOff: true
      }});
      return true;
    `)
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
        await requestSmokeCommand(
          smoke,
          'select-screen-device',
          { sourceId: device.id, settleMs: 0 },
          { timeoutMs }
        )
        await waitFor(settled, `working scene on ${device.name} (attempt ${attempt})`, 5000)
        await sleep(1000)
        const held = await state()
        if (!settled(held))
          throw new Error(`${device.name} did not hold: ${JSON.stringify(held.visual.sources)}`)
        await applyLayout(
          { layoutPreset: 'screen-only' },
          (current) => current.canSave && settled(current),
          `${device.name} working scene confirmed (canSave)`
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
    evaluate(`
      return Array.from(document.querySelectorAll('[data-sonner-toast]')).map((node) =>
        (node.textContent ?? '').replace(/\\s+/g, ' ').trim()
      );
    `)
  const goTo = async (target, { attempts = 3 } = {}) => {
    let ok = null
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      ok = await evaluate(
        `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(target.sceneId)})`
      )
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
  const requestSwitch = (sceneId) =>
    evaluate(`
      window.__vrcSmokeSwitch = { reqAt: Date.now(), done: null };
      window.__videorcSmokeScenePresets.apply(${JSON.stringify(sceneId)}).then(
        (ok) => { window.__vrcSmokeSwitch.done = { ok, at: Date.now() }; },
        (error) => { window.__vrcSmokeSwitch.done = { ok: false, error: String(error), at: Date.now() }; }
      );
      return window.__vrcSmokeSwitch.reqAt;
    `)
  const waitForSwitchDone = async (waitMs) => {
    const until = Date.now() + waitMs
    while (Date.now() < until) {
      const done = await evaluate(`return window.__vrcSmokeSwitch?.done ?? null`)
      if (done) return done
      await sleep(25)
    }
    return { ok: false, error: 'renderer never settled the switch', at: null }
  }
  /** The Screen row's Hide screen / Show screen button on the Studio page. */
  const togglePrivacy = () =>
    evaluate(`
      const button = await waitFor('[data-videorc-screen-privacy]', 8000);
      if (button.disabled) throw new Error('Hide screen is disabled: ' + (button.getAttribute('aria-label') ?? button.textContent));
      button.click();
      return true;
    `)
  return {
    evaluate,
    state,
    waitFor,
    applyLayout,
    chooseCameraOff,
    setClips,
    selectDisplay,
    waitForSceneToCarry,
    goTo,
    requestSwitch,
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
        ? 'smoke:smart-scenes: PASS (new scenes, switches, relaunch, follow, hide on every output, password manager)'
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
