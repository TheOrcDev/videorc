#!/usr/bin/env node
// Measures what viewers see when the program switches from one app window to
// another (plan 210 S0; S3 and S11 reuse it against new code).
//
// Setup: two fixture apps (Fixture Alpha, red; Fixture Beta, blue) from
// scripts/fixtures/build-fixture-apps.mjs; the dev app on an isolated smoke
// profile; two saved Screen-only scenes, one per fixture window, made through
// the renderer's own scene-preset actions (`__videorcSmokeScenePresets`, the
// same `applySavedScene` the Studio cards call). `--mode direct` instead
// switches the working scene's window through the renderer's source picker
// path (`select-screen-device`).
//
// Run: A→B→A for `--switches` (20) switches per variant:
//   idle       status evidence only (no program file while idle);
//   recording  the recording decoded per frame (ffmpeg, 160x90 rgb24): each
//              frame's centre colour (red, blue, black, white, other), the
//              bottom-right inset patch, and whether the bottom-left motion
//              strip repeats the previous frame;
//   layout     recording again, scene Beta = Screen + camera (the synthetic
//              camera), so a frame of the new window under the old layout
//              (or the old window under the new one) is countable.
//
// Per switch it reports click → first program frame of the new window,
// frozen (repeated old-window) frames, black frames, and wrong-layout frames
// (frozen counts are meaningful only for full-bleed scenes: a shrunk window
// moves its motion strip off the sampled canvas strip, so read
// `oldWindowFrames` for the layout variant's marked scene),
// and splits the gap from the backend's own timestamped log lines:
// renderer preflight → backend begins the new capture generation → old
// stream stop join → shareable content loaded (`[videorc-capture-sizing]`)
// → first captured frame → first program frame (compositor status).
//
// Clock alignment: Fixture Alpha flashes white for 200 ms on SIGUSR1 and
// prints when it drew the flash; the first white frame in the recording pins
// `wall = pts + offset`. The flash repeats at the end to report drift.
//
// Output: `<out>/scene-window-switch-summary.json` (p50/p95/max per number,
// per-switch rows, split) plus one human line per variant. `--budget-ms N`
// exits 1 when the recording variants' p95 exceeds N or any black or
// wrong-layout frame appears; without it the probe only reports.
//
// SKIP (exit 0, `skipped: true` in the summary, `SKIP` on stdout) when the
// dev app has no Screen Recording grant on this host.
//
// Usage: pnpm probe:scene-window-switch [-- --switches 20 --budget-ms 150
//   --variants idle,recording,layout --mode scenes|direct --canvas 1920x1080
//   --fps 30 --settle-ms 1200 --out <dir>]

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { hostname, loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildFixtureApps } from './fixtures/build-fixture-apps.mjs'
import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { scenePresetStateReadCode } from './lib/scene-presets-smoke-state.mjs'
import {
  anchorFromFlash,
  featuresFromRawFrames,
  largestShare,
  parseBackendLogLine,
  percentiles,
  sceneSwitchVerdict,
  splitSwitchGap
} from './lib/scene-window-switch-frames.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

/** Thrown to leave the run early with a known exit code (SKIP = 0). */
class ProbeExit extends Error {
  constructor(code) {
    super(`probe exit ${code}`)
    this.code = code
  }
}

// T3 shells export this; the dev app then dies at getVersion.
delete process.env.ELECTRON_RUN_AS_NODE

const options = parseArgs(process.argv.slice(2))
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120_000)
const switchTimeoutMs = Number(process.env.VIDEORC_SCENE_SWITCH_TIMEOUT_MS ?? 20_000)
const pollIntervalMs = Number(process.env.VIDEORC_SCENE_SWITCH_POLL_MS ?? 15)
const outputDirectory = resolve(
  options.out ??
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-scene-window-switch-${Date.now()}`)
)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const ANALYSIS_WIDTH = 160
const ANALYSIS_HEIGHT = 90
const video = {
  preset: 'custom',
  width: options.canvas.width,
  height: options.canvas.height,
  fps: options.fps,
  bitrateKbps: options.canvas.width >= 1920 ? 8000 : 2500
}
const summaryPath = options.summaryOut ?? join(outputDirectory, 'scene-window-switch-summary.json')

mkdirSync(outputDirectory, { recursive: true })
log(`evidence directory ${outputDirectory}`)

if (process.platform !== 'darwin') {
  skip('window switching on ScreenCaptureKit is macOS only', 'not-macos')
}
for (const tool of [ffmpegPath, ffprobePath]) {
  try {
    execFileSync(tool, ['-version'], { stdio: 'ignore' })
  } catch {
    fail(`${tool} is not runnable; the probe decodes the recording with it.`)
  }
}

const fixtures = buildFixtureApps({
  outputDir: options.fixtureDir ?? join(tmpdir(), 'videorc-fixture-apps')
})
log(`fixture apps in ${fixtures.outputDir}`)

/** @type {Array<{atMs:number,text:string}>} backend lines with tracing timestamps */
const backendLog = []
const devAppLogLines = []
const fixtureProcesses = []
let launched = null
let ws = null
let summary = {
  skipped: false,
  host: hostname(),
  at: new Date().toISOString(),
  mode: options.mode,
  canvas: `${video.width}x${video.height}@${video.fps}`,
  switchesPerVariant: options.switches,
  evidenceDir: outputDirectory,
  variants: {}
}
let exitCode = 0

try {
  // Beta sits above Alpha's motion strip, never over it: both strips stay
  // visible, so neither window goes still on screen.
  const alpha = await launchFixture(fixtures.apps.alpha, { x: 40, y: 40 })
  const beta = await launchFixture(fixtures.apps.beta, { x: 200, y: 230 })
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
      // Never VIDEORC_SMOKE_PREVIEW_MOTION=1 here: it swaps the whole capture
      // config for a synthetic test pattern, so no real window would start.
      VIDEORC_SMOKE_PREVIEW_MOTION: '0',
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1'
    },
    onLine: (line) => {
      devAppLogLines.push(line)
      if (
        line.includes('[capture-generation]') ||
        line.includes('[videorc-capture-sizing]') ||
        line.includes('screen capture startup phase') ||
        line.includes('preview_screen') ||
        line.includes('live_layout')
      ) {
        const parsed = parseBackendLogLine(line)
        if (parsed) backendLog.push(parsed)
      }
    }
  })
  const smoke = launched.connections['preview-motion-ready']
  ws = await connectBackend(launched.connections['backend-ready'], timeoutMs)

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
      `the dev app has no Screen Recording grant on this host: ${grantMissing.detail ?? grantMissing.id}`,
      'screen-recording-grant-missing',
      { devices: summarizeDevices(devices.devices) }
    )
  }
  const alphaDevice = findWindowDevice(devices.devices, alpha.windowId)
  const betaDevice = findWindowDevice(devices.devices, beta.windowId)
  if (!alphaDevice || !betaDevice) {
    fail(
      `fixture windows are not listed by devices.list (alpha ${alpha.windowId}: ${alphaDevice ? 'yes' : 'no'}, beta ${beta.windowId}: ${betaDevice ? 'yes' : 'no'}). Windows seen: ${summarizeDevices(
        devices.devices
      )}`
    )
  }
  if (alphaDevice.status !== 'available' || betaDevice.status !== 'available') {
    fail(
      `fixture windows are listed but not available: alpha ${alphaDevice.status} (${alphaDevice.detail ?? ''}), beta ${betaDevice.status} (${betaDevice.detail ?? ''})`
    )
  }
  log(`devices: "${alphaDevice.name}" and "${betaDevice.name}" available`)
  summary.devices = { alpha: alphaDevice, beta: betaDevice }

  const renderer = createRendererDriver(smoke)
  await renderer.waitFor(() => true, 'renderer scene-preset actions ready')
  // The renderer starts the native screen preview from the Studio page.
  await requestSmokeCommand(
    smoke,
    'open-tab',
    { tab: 'studio', waitFor: '[data-videorc-preview-card]' },
    { timeoutMs }
  )
  await renderer.evaluate(
    `window.__videorcSmokeScenePresets.configure({video: ${JSON.stringify(video)}}); return true`
  )
  await renderer.chooseCameraOff()
  // The default Clips ring (plan 181) runs a buffer-only session that stops
  // and restarts on every scene apply; it would hide the switch itself. Off.
  await renderer.evaluate(`
    const current = JSON.parse(localStorage.getItem('videorc.captureConfig') ?? '{}');
    window.__videorcSmokeScenePresets.configure({
      replayBuffer: { ...(current.replayBuffer ?? {}), enabled: false, explicit: true }
    });
    return true;
  `)
  await waitForRecordingIdle()
  await renderer.applyLayout(
    { layoutPreset: 'screen-only' },
    (state) => state.canSave && state.visual.layout.layoutPreset === 'screen-only',
    'screen-only working scene'
  )

  const targets = {
    alpha: {
      key: 'alpha',
      color: 'red',
      windowId: alpha.windowId,
      device: alphaDevice,
      fixture: alpha
    },
    beta: { key: 'beta', color: 'blue', windowId: beta.windowId, device: betaDevice, fixture: beta }
  }

  // Scenes: one per fixture window, saved through the renderer.
  if (options.mode === 'scenes') {
    targets.alpha.sceneId = await renderer.saveWindowScene(targets.alpha, 'Fixture Alpha')
    targets.beta.sceneId = await renderer.saveWindowScene(targets.beta, 'Fixture Beta')
    log(
      `saved scenes: Fixture Alpha ${targets.alpha.sceneId}, Fixture Beta ${targets.beta.sceneId}`
    )
  }
  await renderer.goTo(targets.alpha)
  await waitForScreenLive(targets.alpha.windowId)

  const wantedVariants = options.variants
  if (wantedVariants.includes('idle')) {
    summary.variants.idle = await runVariant('idle', { renderer, targets, record: false })
  }
  if (wantedVariants.includes('recording')) {
    summary.variants.recording = await runVariant('recording', {
      renderer,
      targets,
      record: true,
      smoke
    })
  }
  if (wantedVariants.includes('layout')) {
    // Scene Beta becomes a freeform layout with the window at 70% of the
    // canvas (canvas showing around it); Alpha stays full-bleed Screen only,
    // so every switch also changes the layout. No camera needed: the dev app
    // has no camera grant.
    if (options.mode === 'scenes') {
      await renderer.goTo(targets.beta)
      await waitForScreenLive(targets.beta.windowId)
      await renderer.applyLayout(
        {
          layoutPreset: 'screen-only',
          arrangementMode: 'freeform',
          sourceTransformOverrides: { 'source:base': { x: 0.15, y: 0.15, width: 0.7, height: 0.7 } }
        },
        (state) =>
          state.canSave &&
          state.visual.layout.arrangementMode === 'freeform' &&
          state.visual.sources.windowId === targets.beta.windowId,
        'Beta as a shrunk freeform layout'
      )
      await renderer.save('Fixture Beta', targets.beta.sceneId)
      await renderer.goTo(targets.alpha)
      await renderer.waitFor(
        (state) => state.visual.layout.arrangementMode === 'preset' && !state.pendingId,
        'Alpha back on, full-bleed'
      )
      await waitForScreenLive(targets.alpha.windowId)
      summary.variants.layout = await runVariant('layout', {
        renderer,
        targets,
        record: true,
        smoke,
        layoutMark: { alpha: false, beta: true }
      })
    } else {
      log('layout variant needs saved scenes; skipped in direct mode')
    }
  }

  summary.split = overallSplit(summary.variants)
  summary.budget = evaluateBudget(summary, options.budgetMs)
  if (summary.budget && !summary.budget.pass) exitCode = 1
} catch (error) {
  if (error instanceof ProbeExit) {
    exitCode = error.code
  } else {
    exitCode = 1
    summary.error = error?.stack ?? String(error)
    console.error(`[probe:scene-window-switch] FAIL ${error?.message ?? error}`)
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
      console.error(`[probe:scene-window-switch] dev app stop: ${error?.message ?? error}`)
    }
  }
  await stopFixtures()
  writeFileSync(join(outputDirectory, 'dev-app.log'), devAppLogLines.join('\n') + '\n')
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  printHuman(summary)
  log(`summary ${summaryPath}`)
}
process.exit(exitCode)

// ---------------------------------------------------------------------------

async function runVariant(name, { renderer, targets, record, smoke, layoutMark = null }) {
  log(`variant ${name}: ${options.switches} switches, ${record ? 'recording' : 'idle'}`)
  const variant = {
    name,
    record,
    layoutChange: Boolean(layoutMark),
    // Other work on the host (compiles, builds) stretches every number.
    hostLoadAtStart: loadavg().map((value) => Number(value.toFixed(1))),
    switches: [],
    flashes: [],
    recording: null
  }
  let started = null
  let current = targets.alpha
  if (record) {
    const directory = await requestSmokeCommand(
      smoke,
      'authorize-smoke-resource',
      { path: outputDirectory, kind: 'output-directory' },
      { timeoutMs }
    )
    const visual = (await renderer.state()).visual
    started = await request(ws, timeoutMs, 'session.start', {
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
    if (!['recording', 'streaming'].includes(started.state)) {
      fail(`[${name}] expected a recording after session.start, got ${started.state}`)
    }
    await renderer.waitFor(
      (state) => ['recording', 'streaming'].includes(state.recording),
      `${name}: recording state`
    )
    await sleep(1500)
    variant.flashes.push(await flashFixture(targets.alpha.fixture, 'start'))
    await sleep(1200)
  }

  for (let index = 0; index < options.switches; index += 1) {
    const next = current === targets.alpha ? targets.beta : targets.alpha
    const row = await measureSwitch(renderer, { from: current, to: next, index })
    variant.switches.push(row)
    const status = row.ok ? 'ok' : `FAILED ${row.error ?? ''}`
    log(
      `  ${name} #${index + 1} ${current.key}→${next.key}: first captured ${fmt(row.firstCapturedMs)} ms, compositor status ${fmt(
        row.programMs
      )} ms, renderer done ${fmt(row.rendererDoneMs)} ms ${status}`
    )
    current = next
    await sleep(options.settleMs)
  }

  if (record) {
    if (current === targets.alpha) {
      await sleep(400)
      variant.flashes.push(await flashFixture(targets.alpha.fixture, 'end'))
    }
    await sleep(900)
    const stopped = await request(ws, timeoutMs, 'session.stop')
    await renderer.waitFor((state) => state.recording === 'idle', `${name}: session stopped`)
    const file = await resolveFinalRecordingPath({ started, stopped, timeoutMs })
    if (!file || !existsSync(file)) fail(`[${name}] recording file missing: ${file}`)
    variant.recording = analyzeRecordingFrames(file, variant, targets, layoutMark)
    log(
      `  ${name} recording ${file}: ${variant.recording.frameCount} frames, anchor offset ${variant.recording.anchor?.offsetMs ?? 'none'} ms, drift ${fmt(variant.recording.anchorDriftMs)} ms`
    )
  }

  variant.hostLoadAtEnd = loadavg().map((value) => Number(value.toFixed(1)))
  variant.stats = variantStats(variant)
  return variant
}

/** One switch request through the renderer, with status polling for its edges. */
async function measureSwitch(renderer, { from, to, index }) {
  const baseline = await request(ws, timeoutMs, 'compositor.status')
  const logStart = backendLog.length
  const requestedAtMs = await renderer.requestSwitch(to)
  let screenLiveAt = null
  let firstCapturedAt = null
  let programAt = null
  let lastScreen = null
  let lastCompositor = null
  const trace = []
  const deadline = Date.now() + switchTimeoutMs
  while (Date.now() < deadline) {
    const screen = await request(ws, timeoutMs, 'preview.screen.status')
    const nowScreen = Date.now()
    lastScreen = screen
    pushTrace(
      trace,
      nowScreen - requestedAtMs,
      'screen',
      `${screen.state}:${screen.sourceId ?? '-'}`
    )
    if (screen.state === 'live' && screen.sourceId === to.windowId) {
      screenLiveAt ??= nowScreen
      if ((screen.framesCaptured ?? 0) > 0) firstCapturedAt ??= nowScreen
    }
    const compositor = await request(ws, timeoutMs, 'compositor.status')
    const nowCompositor = Date.now()
    lastCompositor = compositor
    // The compositor names the slot by what it captures: `window` for a window.
    const screenSource = (compositor.sources ?? []).find(
      (source) => source.kind === 'screen' || source.kind === 'window'
    )
    const newSourceOnProgram =
      (screenSource?.sourceId === to.windowId && (screenSource.sequence ?? 0) > 0) ||
      compositor.activeScreenId === to.windowId
    const revisionAdvanced =
      (compositor.frameSceneRevision ?? 0) > (baseline.frameSceneRevision ?? 0)
    pushTrace(
      trace,
      nowCompositor - requestedAtMs,
      'compositor',
      `${compositor.state}:rev ${compositor.sceneRevision}/${compositor.frameSceneRevision}:active ${compositor.activeScreenId ?? '-'}:src ${screenSource?.kind ?? '-'} ${screenSource?.sourceId ?? '-'} seq ${screenSource?.sequence ?? '-'}`
    )
    if (newSourceOnProgram && revisionAdvanced) {
      programAt = nowCompositor
      break
    }
    // About 60 polls a second: enough resolution, and the probe must not be
    // the load it measures (an unthrottled loop ran ~700 requests a second).
    await sleep(pollIntervalMs)
  }
  const done = await renderer.waitForSwitchDone(switchTimeoutMs)
  const row = {
    index,
    from: from.key,
    to: to.key,
    requestedAtMs,
    screenLiveMs: screenLiveAt == null ? null : screenLiveAt - requestedAtMs,
    firstCapturedMs: firstCapturedAt == null ? null : firstCapturedAt - requestedAtMs,
    programMs: programAt == null ? null : programAt - requestedAtMs,
    rendererDoneMs: done?.at == null ? null : done.at - requestedAtMs,
    ok: Boolean(done?.ok) && programAt != null,
    error: done?.error ?? (programAt == null ? 'no program frame of the new window seen' : null),
    split: splitSwitchGap({
      requestedAtMs,
      logLines: backendLog.slice(logStart),
      firstCapturedFrameAtMs: firstCapturedAt,
      firstProgramFrameAtMs: programAt
    })
  }
  row.baseline = compactCompositor(baseline)
  row.trace = trace
  if (!row.ok) {
    row.lastScreenStatus = lastScreen
    row.lastCompositorStatus = compactCompositor(lastCompositor)
  }
  return row
}

function analyzeRecordingFrames(file, variant, targets, layoutMark) {
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
    { maxBuffer: 1024 * 1024 * 1024 }
  )
  const features = featuresFromRawFrames(raw, { width: ANALYSIS_WIDTH, height: ANALYSIS_HEIGHT })
  const result = {
    file,
    frameCount: features.length,
    anchor: null,
    anchorDriftMs: null,
    classCounts: countBy(features.map((feature) => feature.centre))
  }
  const startFlash = variant.flashes.find((flash) => flash.label === 'start')
  const endFlash = variant.flashes.find((flash) => flash.label === 'end')
  const anchor = startFlash ? anchorFromFlash(features, ptsMs, startFlash.drawnAtMs) : null
  if (!anchor) {
    result.error = 'no white flash frame found; the recording cannot be aligned to the requests'
    return result
  }
  result.anchor = anchor
  if (endFlash) {
    const endAnchor = anchorFromFlash(features, ptsMs, endFlash.drawnAtMs, {
      afterPtsMs: ptsMs[anchor.frameIndex] + 1000
    })
    if (endAnchor) result.anchorDriftMs = Math.round(endAnchor.offsetMs - anchor.offsetMs)
  }
  for (let index = 0; index < variant.switches.length; index += 1) {
    const row = variant.switches[index]
    const next = variant.switches[index + 1]
    const verdict = sceneSwitchVerdict({
      features,
      ptsMs,
      offsetMs: anchor.offsetMs,
      requestedAtMs: row.requestedAtMs,
      untilMs: next ? next.requestedAtMs : row.requestedAtMs + options.settleMs + switchTimeoutMs,
      fromColor: targets[row.from].color,
      toColor: targets[row.to].color,
      fromLayoutMark: layoutMark ? layoutMark[row.from] : null,
      toLayoutMark: layoutMark ? layoutMark[row.to] : null
    })
    row.pixels = verdict
  }
  writeFileSync(
    join(outputDirectory, `${variant.name}-frames.json`),
    JSON.stringify(
      features.map((feature, index) => ({
        i: index,
        pts: Math.round(ptsMs[index] ?? -1),
        c: feature.centre,
        mark: feature.layoutMark ? 1 : 0,
        rep: feature.repeated ? 1 : 0,
        d: feature.diff
      }))
    )
  )
  return result
}

function variantStats(variant) {
  const rows = variant.switches
  const stats = {
    switches: rows.length,
    failed: rows.filter((row) => !row.ok).length,
    programMs: percentiles(rows.map((row) => row.programMs)),
    screenLiveMs: percentiles(rows.map((row) => row.screenLiveMs)),
    firstCapturedMs: percentiles(rows.map((row) => row.firstCapturedMs)),
    rendererDoneMs: percentiles(rows.map((row) => row.rendererDoneMs)),
    split: {
      preflightMs: percentiles(rows.map((row) => row.split?.preflightMs)),
      stopMs: percentiles(rows.map((row) => row.split?.stopMs)),
      shareableMs: percentiles(rows.map((row) => row.split?.shareableMs)),
      startToFirstFrameMs: percentiles(rows.map((row) => row.split?.startToFirstFrameMs)),
      commitMs: percentiles(rows.map((row) => row.split?.commitMs))
    },
    largestShare: largestShare(rows.map((row) => row.split)).largest
  }
  if (variant.record && variant.recording?.anchor) {
    const pixels = rows.map((row) => row.pixels).filter(Boolean)
    stats.pixels = {
      latencyMs: percentiles(pixels.map((verdict) => verdict.latencyMs)),
      cutsSeen: pixels.filter((verdict) => verdict.cutSeen).length,
      oldWindowFrames: percentiles(pixels.map((verdict) => verdict.oldWindowFrames)),
      frozenFrames: percentiles(pixels.map((verdict) => verdict.frozenFrames)),
      blackFramesTotal: sum(pixels.map((verdict) => verdict.blackFrames)),
      otherFramesTotal: sum(pixels.map((verdict) => verdict.otherFrames)),
      afterCutBlackFramesTotal: sum(pixels.map((verdict) => verdict.afterCutBlackFrames)),
      afterCutOldWindowFramesTotal: sum(pixels.map((verdict) => verdict.afterCutOldWindowFrames)),
      wrongLayoutFramesTotal: variant.layoutChange
        ? sum(pixels.map((verdict) => verdict.wrongLayoutFrames))
        : null
    }
  }
  return stats
}

function overallSplit(variants) {
  const splits = Object.values(variants).flatMap((variant) =>
    variant.switches.map((row) => row.split)
  )
  return largestShare(splits)
}

function evaluateBudget(summaryValue, budgetMs) {
  if (budgetMs == null) return null
  const failures = []
  for (const variant of Object.values(summaryValue.variants)) {
    const stats = variant.stats
    if (!stats) continue
    const p95 = stats.pixels?.latencyMs?.p95 ?? stats.programMs?.p95
    if (p95 == null) failures.push(`${variant.name}: no latency evidence`)
    else if (p95 > budgetMs) failures.push(`${variant.name}: p95 ${p95} ms > ${budgetMs} ms`)
    if (stats.failed > 0) failures.push(`${variant.name}: ${stats.failed} switch(es) failed`)
    if (stats.pixels) {
      const black = stats.pixels.blackFramesTotal + stats.pixels.afterCutBlackFramesTotal
      if (black > 0) failures.push(`${variant.name}: ${black} black frame(s)`)
      if ((stats.pixels.wrongLayoutFramesTotal ?? 0) > 0)
        failures.push(
          `${variant.name}: ${stats.pixels.wrongLayoutFramesTotal} wrong-layout frame(s)`
        )
      if (stats.pixels.cutsSeen < stats.switches)
        failures.push(`${variant.name}: only ${stats.pixels.cutsSeen}/${stats.switches} cuts seen`)
    }
  }
  return { budgetMs, pass: failures.length === 0, failures }
}

function printHuman(summaryValue) {
  if (summaryValue.skipped) {
    console.log(`SKIP probe:scene-window-switch: ${summaryValue.reason}`)
    return
  }
  for (const variant of Object.values(summaryValue.variants)) {
    const stats = variant.stats
    if (!stats) continue
    const pixels = stats.pixels
    const head = `probe:scene-window-switch ${variant.name}${variant.layoutChange ? ' (layout change)' : ''}: ${stats.switches} switches`
    const statusLine = `status click→first captured frame p50 ${fmt(stats.firstCapturedMs.p50)} p95 ${fmt(stats.firstCapturedMs.p95)} max ${fmt(stats.firstCapturedMs.max)} ms, click→compositor shows it (status, coarse) p50 ${fmt(stats.programMs.p50)} p95 ${fmt(stats.programMs.p95)} ms`
    const pixelLine = pixels
      ? `; pixels click→new window p50 ${fmt(pixels.latencyMs.p50)} p95 ${fmt(pixels.latencyMs.p95)} max ${fmt(pixels.latencyMs.max)} ms, old-window frames p50 ${fmt(pixels.oldWindowFrames.p50)} max ${fmt(pixels.oldWindowFrames.max)} (frozen p50 ${fmt(pixels.frozenFrames.p50)}), black ${pixels.blackFramesTotal + pixels.afterCutBlackFramesTotal}, other ${pixels.otherFramesTotal}${
          variant.layoutChange ? `, wrong layout ${pixels.wrongLayoutFramesTotal}` : ''
        }, cuts ${pixels.cutsSeen}/${stats.switches}`
      : ''
    const split = stats.split
    const splitLine = `; split p50 preflight ${fmt(split.preflightMs.p50)} | stop ${fmt(split.stopMs.p50)} | shareable ${fmt(split.shareableMs.p50)} | start→first frame ${fmt(split.startToFirstFrameMs.p50)} | commit ${fmt(split.commitMs.p50)} ms (largest ${stats.largestShare ?? 'n/a'})`
    console.log(
      `${head}: ${statusLine}${pixelLine}${splitLine}; host load ${variant.hostLoadAtStart?.[0]}→${variant.hostLoadAtEnd?.[0]}${stats.failed ? `; FAILED ${stats.failed}` : ''}`
    )
  }
  if (summaryValue.budget) {
    console.log(
      summaryValue.budget.pass
        ? `probe:scene-window-switch budget ${summaryValue.budget.budgetMs} ms: PASS`
        : `probe:scene-window-switch budget ${summaryValue.budget.budgetMs} ms: FAIL ${summaryValue.budget.failures.join('; ')}`
    )
  }
  if (summaryValue.error)
    console.log(`probe:scene-window-switch FAILED: ${summaryValue.error.split('\n')[0]}`)
}

// ---------------------------------------------------------------------------
// Renderer driver

function createRendererDriver(smoke) {
  const evaluate = async (code) => {
    const response = await requestSmokeCommand(smoke, 'eval-js', { code }, { timeoutMs })
    // `null` is a valid answer ("not done yet"); never fall back to the wrapper.
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
      `Timed out: ${description}; last error: ${lastError}; full renderer state in ${statePath}; diagnostics: ${JSON.stringify(lastState?.diagnostics)?.slice(0, 1200)}`
    )
  }
  /**
   * A layout call the renderer drops silently (reconnecting, a reconcile in
   * flight) must not stall the run: re-issue it until the state shows it.
   */
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
  const selectWindow = async (target) => {
    await evaluate(`
      const current = window.__videorcSmokeScenePresets.state();
      window.__videorcSmokeScenePresets.configure({sources: {
        ...current.visual.sources,
        screenId: undefined, screenName: undefined,
        windowId: ${JSON.stringify(target.windowId)},
        windowName: ${JSON.stringify(target.device.name)},
        testPattern: false
      }});
      return true;
    `)
    await waitFor(
      (current) => current.visual.sources.windowId === target.windowId,
      `working scene on ${target.key}`
    )
    await waitFor(
      (current) => current.diagnostics?.selectedDeviceAvailability?.window === 'available',
      `${target.key} window listed as available in the renderer`
    )
    // A source change alone does not confirm the working visual; a layout
    // transaction with the same preset does, which is what Save needs.
    await applyLayout(
      { layoutPreset: 'screen-only' },
      (current) => current.canSave && current.visual.sources.windowId === target.windowId,
      `${target.key} working scene confirmed (canSave)`
    )
  }
  const save = async (name, id) => {
    const ok = await evaluate(
      `return window.__videorcSmokeScenePresets.save(${JSON.stringify(name)}${id ? `, ${JSON.stringify(id)}` : ''})`
    )
    if (ok !== true) throw new Error(`Saving scene "${name}" returned ${JSON.stringify(ok)}`)
    const scene = (await state()).scenes.find((entry) =>
      id ? entry.id === id : entry.name === name
    )
    if (!scene) throw new Error(`Saved scene "${name}" is not in the library`)
    return scene.id
  }
  const saveWindowScene = async (target, name) => {
    await selectWindow(target)
    await waitForScreenLive(target.windowId)
    return save(name)
  }
  const goTo = async (target) => {
    if (options.mode === 'scenes') {
      const ok = await evaluate(
        `return await window.__videorcSmokeScenePresets.apply(${JSON.stringify(target.sceneId)})`
      )
      if (ok !== true)
        throw new Error(`Applying scene ${target.key} returned ${JSON.stringify(ok)}`)
      await waitFor(
        (current) => current.activeId === target.sceneId && !current.pendingId,
        `scene ${target.key} active`
      )
    } else {
      await requestSmokeCommand(
        smoke,
        'select-screen-device',
        { sourceId: target.windowId, settleMs: 0 },
        { timeoutMs }
      )
      await waitFor(
        (current) => current.visual.sources.windowId === target.windowId && !current.pendingLayout,
        `working scene on ${target.key}`
      )
    }
  }
  /** Fires the switch and returns the renderer's own request timestamp. */
  const requestSwitch = async (target) => {
    if (options.mode === 'scenes') {
      return evaluate(`
        window.__vrcProbeSwitch = { reqAt: Date.now(), done: null };
        window.__videorcSmokeScenePresets.apply(${JSON.stringify(target.sceneId)}).then(
          (ok) => { window.__vrcProbeSwitch.done = { ok, at: Date.now() }; },
          (error) => { window.__vrcProbeSwitch.done = { ok: false, error: String(error), at: Date.now() }; }
        );
        return window.__vrcProbeSwitch.reqAt;
      `)
    }
    return evaluate(`
      window.__vrcProbeSwitch = { reqAt: Date.now(), done: null };
      const picked = window.__videorcSmokeSelectFirstScreen?.(${JSON.stringify(target.windowId)}) ?? null;
      window.__vrcProbeSwitch.done = picked ? null : { ok: false, error: 'window not selectable', at: Date.now() };
      window.__vrcProbeSwitch.direct = true;
      return window.__vrcProbeSwitch.reqAt;
    `)
  }
  const waitForSwitchDone = async (waitMs) => {
    const until = Date.now() + waitMs
    while (Date.now() < until) {
      const done = await evaluate(`
        const probe = window.__vrcProbeSwitch;
        if (!probe) return null;
        if (probe.done) return probe.done;
        if (probe.direct) {
          const current = window.__videorcSmokeScenePresets.state();
          if (!current.pendingLayout && !current.diagnostics?.visualTransactionPending && !current.diagnostics?.sourceDeviceSwitchPending) {
            return { ok: true, at: Date.now() };
          }
        }
        return null;
      `)
      if (done) return done
      await sleep(25)
    }
    return { ok: false, error: 'renderer never settled the switch', at: null }
  }
  return {
    evaluate,
    state,
    waitFor,
    applyLayout,
    chooseCameraOff,
    selectWindow,
    save,
    saveWindowScene,
    goTo,
    requestSwitch,
    waitForSwitchDone
  }
}

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

async function waitForScreenLive(windowId) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'preview.screen.status')
    if (last?.state === 'live' && last.sourceId === windowId && (last.framesCaptured ?? 0) > 0) {
      return last
    }
    await sleep(100)
  }
  throw new Error(`Screen preview never went live on ${windowId}: ${JSON.stringify(last)}`)
}

// ---------------------------------------------------------------------------
// Fixtures

function launchFixture(app, { x, y }) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(
      app.executablePath,
      ['--width', '1280', '--height', '720', '--x', String(x), '--y', String(y)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const fixture = {
      key: app.key,
      name: app.name,
      pid: child.pid,
      child,
      windowNumber: null,
      windowId: null,
      lines: [],
      flashWaiters: []
    }
    fixtureProcesses.push(fixture)
    let buffer = ''
    const timer = setTimeout(
      () => rejectLaunch(new Error(`${app.name} printed no ready line within 15 s`)),
      15_000
    )
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      buffer += text
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        fixture.lines.push(line)
        const ready = /^ready pid=(\d+) window_number=(\d+)/.exec(line)
        if (ready) {
          clearTimeout(timer)
          fixture.windowNumber = Number(ready[2])
          fixture.windowId = `window:screencapturekit:${ready[2]}`
          resolveLaunch(fixture)
        }
        const drawn = /^flash drawn_at_ms=(\d+)/.exec(line)
        if (drawn) {
          const waiter = fixture.flashWaiters.shift()
          waiter?.(Number(drawn[1]))
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) fixture.lines.push(`stderr: ${line}`)
    })
    child.on('exit', (code, signal) => {
      fixture.exited = { code, signal }
      clearTimeout(timer)
      rejectLaunch(
        new Error(`${app.name} exited before it was ready: code=${code} signal=${signal}`)
      )
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectLaunch(error)
    })
  })
}

/** SIGUSR1 → the fixture flashes white; returns when it drew the flash. */
function flashFixture(fixture, label) {
  return new Promise((resolveFlash) => {
    const sentAtMs = Date.now()
    const timer = setTimeout(() => {
      fixture.flashWaiters = fixture.flashWaiters.filter((entry) => entry !== onDrawn)
      resolveFlash({ label, sentAtMs, drawnAtMs: sentAtMs, drawnReported: false })
    }, 1500)
    const onDrawn = (drawnAtMs) => {
      clearTimeout(timer)
      resolveFlash({ label, sentAtMs, drawnAtMs, drawnReported: true })
    }
    fixture.flashWaiters.push(onDrawn)
    try {
      process.kill(fixture.pid, 'SIGUSR1')
    } catch (error) {
      clearTimeout(timer)
      resolveFlash({
        label,
        sentAtMs,
        drawnAtMs: sentAtMs,
        drawnReported: false,
        error: String(error)
      })
    }
  })
}

async function stopFixtures() {
  for (const fixture of fixtureProcesses) {
    if (fixture.exited || !fixture.pid) continue
    try {
      process.kill(fixture.pid, 'SIGTERM')
    } catch {
      continue
    }
    const exited = await Promise.race([
      new Promise((resolveExit) => fixture.child.once('exit', () => resolveExit(true))),
      sleep(2000).then(() => false)
    ])
    if (!exited) {
      try {
        process.kill(fixture.pid, 'SIGKILL')
      } catch {
        // gone
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers

function skip(reason, flag, extra = {}) {
  summary = { ...summary, skipped: true, reason, flag, ...extra }
  console.log(`SKIP probe:scene-window-switch: ${reason}`)
  throw new ProbeExit(0)
}

function fail(message) {
  throw new Error(message)
}

function log(message) {
  console.log(`[probe:scene-window-switch] ${message}`)
}

function fmt(value) {
  return value == null ? 'n/a' : String(Math.round(value))
}

function sum(values) {
  return values.reduce((total, value) => total + (value ?? 0), 0)
}

/** Appends a trace entry only when the value changed (the loop polls ~60 Hz). */
function pushTrace(trace, t, key, value) {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    if (key in trace[index]) {
      if (trace[index][key] === value) return
      break
    }
  }
  trace.push({ t, [key]: value })
}

function countBy(values) {
  const counts = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function findWindowDevice(devices, windowId) {
  return (
    (devices ?? []).find((device) => device.kind === 'window' && device.id === windowId) ?? null
  )
}

function summarizeDevices(devices) {
  return (devices ?? [])
    .filter((device) => device.kind === 'window' || device.kind === 'screen')
    .map((device) => `${device.kind}:${device.id}:${device.status}:${device.name}`)
    .join(', ')
}

function compactCompositor(status) {
  if (!status) return null
  return {
    state: status.state,
    sceneRevision: status.sceneRevision,
    frameSceneRevision: status.frameSceneRevision,
    activeScreenId: status.activeScreenId,
    sources: status.sources,
    framesRendered: status.framesRendered,
    message: status.message
  }
}

function parseArgs(argv) {
  const parsed = {
    switches: 20,
    budgetMs: null,
    variants: ['idle', 'recording', 'layout'],
    mode: 'scenes',
    canvas: { width: 1920, height: 1080 },
    fps: 30,
    settleMs: 1200,
    out: null,
    summaryOut: null,
    fixtureDir: null
  }
  const take = (index) => {
    if (index + 1 >= argv.length) throw new Error(`${argv[index]} needs a value`)
    return argv[index + 1]
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const [flag, inlineValue] = argument.includes('=') ? argument.split(/=(.*)/s) : [argument, null]
    const value = () => {
      if (inlineValue != null) return inlineValue
      const next = take(index)
      index += 1
      return next
    }
    switch (flag) {
      case '--switches':
        parsed.switches = Math.max(1, Number(value()))
        break
      case '--budget-ms':
        parsed.budgetMs = Number(value())
        break
      case '--variants':
        parsed.variants = value()
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
        break
      case '--mode':
        parsed.mode = value() === 'direct' ? 'direct' : 'scenes'
        break
      case '--canvas': {
        const [width, height] = value().split('x').map(Number)
        parsed.canvas = { width, height }
        break
      }
      case '--fps':
        parsed.fps = Number(value())
        break
      case '--settle-ms':
        parsed.settleMs = Number(value())
        break
      case '--out':
        parsed.out = value()
        break
      case '--summary-out':
        parsed.summaryOut = value()
        break
      case '--fixture-dir':
        parsed.fixtureDir = value()
        break
      default:
        throw new Error(`Unknown argument ${argument}`)
    }
  }
  for (const variant of parsed.variants) {
    if (!['idle', 'recording', 'layout'].includes(variant)) {
      throw new Error(`Unknown variant ${variant}; use idle, recording or layout`)
    }
  }
  return parsed
}
