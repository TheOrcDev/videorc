#!/usr/bin/env node
// Hide screen on every output leg, on Windows (issue #1088; plan 210 D8, the
// Windows port of smoke:smart-scenes step 5). The promise is made at the
// capture source, so the recording, a local RTMP sink and a Clips save must
// each show a frosted, still picture for the hidden span and the sharp,
// moving live picture again after Show. (Windows writes no Screen file:
// Separate source recordings are Mac only, so that leg is a named SKIP.)
//
// Setup: the Windows fixture window (scripts/fixtures/windows-fixture-window:
// Fixture Alpha's picture, red with a motion strip, borderless and
// always-on-top over the primary display), the dev app on an isolated smoke
// profile with the smoke command server, a 1920x1080@30 canvas, the Studio's
// own Screen picker on the DXGI display, Camera off in the program.
//
// One step, PASS, FAIL or SKIP (a SKIP names its reason, never silent):
//   hide  Record + stream to a local FFmpeg RTMP sink (127.0.0.1 only) with
//         the Clips ring on. Flash, Hide screen with the Studio's
//         Screen-row button for four seconds, Show, flash, save a clip. Each
//         file is decoded per frame, aligned on the flashes and judged by
//         `hideSpanVerdict` (the macOS smoke's own bar).
// The Follow and app-scene steps are macOS only (plan 210 D12) and report
// as SKIP here.
//
// SKIPs: not Windows; no DXGI display (gdigrab refuses Hide screen by
// design); Desktop Duplication refused this process (0x80070005,
// 0x887A0022, 0x887A0026); a refused D3D11 media path is a named SKIP
// while the CPU-bridge legs are still judged.
//
// Output: `<out>/hide-screen-windows-summary.json` (every number, per-frame
// features per output) and one line per output. Exit 1 on any FAIL.
// Never goes live on a real channel.
//
// Usage: pnpm smoke:hide-screen:windows [-- --out <dir> --media auto|cpu]
//   --media cpu   forces the CPU compositor and FFmpeg bridge
//                 (VIDEORC_WINDOWS_D3D11_MEDIA=disabled); auto (default) is
//                 the shipping choice, and the summary names the path it took.
//   VIDEORC_SMOKE_TIMEOUT_MS, VIDEORC_SMOKE_RTMP_PORT (13937),
//   VIDEORC_SMOKE_FFMPEG_PATH, VIDEORC_SMOKE_FFPROBE_PATH

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import {
  anchorHideFile,
  captureAlignedHideBudget,
  distinctFrameRate,
  selectWindowsHideScreen,
  windowsHideOutputsVerdict,
  windowsHideSessionPath,
  windowsScreenStartSkip
} from './lib/hide-screen-windows-gates.mjs'
import { waitForOwnedTcpListener } from './lib/live-control-recycle-smoke.mjs'
import { scenePresetStateReadCode } from './lib/scene-presets-smoke-state.mjs'
import { anchorFromFlash } from './lib/scene-window-switch-frames.mjs'
import {
  SMART_SCENES_BUDGET,
  SHARP_HIDDEN_MAX,
  SHARP_LIVE_MIN,
  frostFeaturesFromRawFrames,
  hideSpanVerdict
} from './lib/smart-scenes-gate.mjs'
import { requestSmokeCommand, waitForRendererHook } from './lib/smoke-command-client.mjs'
import {
  flashWindowsFixtureWindow,
  launchWindowsFixtureWindow,
  stopWindowsFixtureWindow,
  windowsFixtureStats
} from './lib/windows-fixture-window-process.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

class SmokeExit extends Error {
  constructor(code) {
    super(`smoke exit ${code}`)
    this.code = code
  }
}

delete process.env.ELECTRON_RUN_AS_NODE

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = parseArgs(process.argv.slice(2))
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120_000)
const rtmpPortBase = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 13937)
const outputDirectory = resolve(
  options.out ??
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-hide-screen-windows-${Date.now()}`)
)
const vendoredBin = join(repoRoot, 'vendor', 'ffmpeg', 'windows-x64', 'bin')
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  (existsSync(join(vendoredBin, 'ffmpeg.exe')) ? join(vendoredBin, 'ffmpeg.exe') : 'ffmpeg')
const ffprobePath =
  process.env.VIDEORC_SMOKE_FFPROBE_PATH ??
  (existsSync(join(vendoredBin, 'ffprobe.exe')) ? join(vendoredBin, 'ffprobe.exe') : 'ffprobe')
const ANALYSIS_WIDTH = 320
const ANALYSIS_HEIGHT = 180
const HIDDEN_SPAN_MS = 4000
const video = { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
const summaryPath = join(outputDirectory, 'hide-screen-windows-summary.json')

mkdirSync(outputDirectory, { recursive: true })
log(`evidence directory ${outputDirectory}`)

const summary = {
  skipped: false,
  host: hostname(),
  at: new Date().toISOString(),
  platform: process.platform,
  canvas: `${video.width}x${video.height}@${video.fps}`,
  media: options.media,
  budget: {
    hideEdgeMs: SMART_SCENES_BUDGET.hideEdgeMs,
    hideLatencyMaxMs: SMART_SCENES_BUDGET.hideLatencyMaxMs,
    showLatencyMaxMs: SMART_SCENES_BUDGET.showLatencyMaxMs,
    sharpLiveMin: SHARP_LIVE_MIN,
    sharpHiddenMax: SHARP_HIDDEN_MAX
  },
  evidenceDir: outputDirectory,
  steps: {
    newScenes: { skipped: true, reason: 'scenes for apps are macOS only (plan 210 D12)' },
    switches: { skipped: true, reason: 'scenes for apps are macOS only (plan 210 D12)' },
    relaunch: { skipped: true, reason: 'scenes for apps are macOS only (plan 210 D12)' },
    follow: { skipped: true, reason: 'Follow the app in front is macOS only (plan 210 D12)' },
    passwordManager: {
      skipped: true,
      reason: 'the password-manager hide rides Follow, macOS only (plan 210 D11, D12)'
    }
  }
}
const receivers = []
const devAppLogLines = []
const events = []
let fixture = null
let launched = null
let ws = null
let exitCode = 0

try {
  if (process.platform !== 'win32') {
    skip(
      'this is the Windows port of the Hide screen step; run pnpm smoke:smart-scenes on macOS',
      'not-windows'
    )
  }
  for (const tool of [ffmpegPath, ffprobePath]) {
    try {
      execFileSync(tool, ['-version'], { stdio: 'ignore' })
    } catch {
      fail(
        `${tool} is not runnable; the smoke decodes every output with it (pnpm ffmpeg:fetch:windows).`
      )
    }
  }

  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      // Never 1: it swaps the capture for a synthetic pattern.
      VIDEORC_SMOKE_PREVIEW_MOTION: '0',
      ...(options.media === 'cpu' ? { VIDEORC_WINDOWS_D3D11_MEDIA: 'disabled' } : {})
    },
    onLine: (line) => devAppLogLines.push(line)
  })
  const smoke = launched.connections['preview-motion-ready']
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

  const devices = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const picked = selectWindowsHideScreen(devices.devices ?? [])
  if (picked.skip) skip(picked.skip.reason, picked.skip.flag)
  const screen = picked.screen
  summary.screen = { id: screen.id, name: screen.name, detail: screen.detail ?? null }
  log(`screen ${screen.id} (${screen.name})`)

  // The fixture covers the display only once the app is up: the owner's
  // screen is hidden for the measured part, not for the build and launch.
  fixture = await launchWindowsFixtureWindow({ displayIndex: 0, color: 'red' })
  log(
    `fixture window ${fixture.ready.hwnd} (pid ${fixture.pid}) over ${fixture.ready.bounds.width}x${fixture.ready.bounds.height} DIP at ${fixture.ready.scale}x`
  )

  const renderer = createRendererDriver(smoke)
  await renderer.waitFor(() => true, 'renderer scene-preset actions ready')
  await openTab(smoke, 'studio', '[data-videorc-preview-card]')
  await renderer.evaluate(
    `window.__videorcSmokeScenePresets.configure({video: ${JSON.stringify(video)}}); return true`
  )
  await renderer.chooseCameraOff()
  await renderer.setClips(false)
  await waitForRecordingIdle()
  await renderer.selectDisplay(screen)
  const live = await waitForScreenLiveOrSkip(screen.id)
  summary.screenStatus = {
    width: live.width ?? null,
    height: live.height ?? null,
    d3d11TextureAvailable: live.d3d11TextureAvailable ?? null,
    sourceFps: live.sourceFps ?? null
  }
  log(
    `screen live ${live.width}x${live.height}, D3D11 texture ${live.d3d11TextureAvailable ?? 'n/a'}`
  )

  summary.steps.hide = await step('hide', () => hideStep({ renderer, smoke, screen }))
  if (!summary.steps.hide.ok) exitCode = 1
} catch (error) {
  if (error instanceof SmokeExit) {
    exitCode = error.code
  } else {
    exitCode = 1
    summary.error = error?.stack ?? String(error)
    console.error(`[smoke:hide-screen:windows] FAIL ${error?.message ?? error}`)
  }
} finally {
  try {
    ws?.close()
  } catch {
    // already closed
  }
  if (launched) {
    try {
      await launched.stop()
    } catch (error) {
      console.error(`[smoke:hide-screen:windows] dev app stop: ${error?.message ?? error}`)
    }
  }
  for (const receiver of receivers) await stopReceiver(receiver)
  if (fixture) await stopWindowsFixtureWindow(fixture).catch(() => undefined)
  writeFileSync(join(outputDirectory, 'dev-app.log'), devAppLogLines.join('\n') + '\n')
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2))
  printHuman(summary)
  log(`summary ${summaryPath}`)
}
process.exit(exitCode)

// ---------------------------------------------------------------------------
// The step

async function hideStep({ renderer, smoke, screen }) {
  const privacyBefore = await request(ws, timeoutMs, 'screen.privacy.get')
  if (privacyBefore.hidden)
    fail(`the screen is already hidden before the step: ${JSON.stringify(privacyBefore)}`)
  // Separate source recordings are Mac only: session.start refuses them on
  // Windows (separate-source-recordings-unsupported-platform), so no Screen
  // file exists here to carry or leak the live picture.
  const screenFileSkip =
    'Separate source recordings are Mac only (session.start refuses them on Windows with separate-source-recordings-unsupported-platform), so Windows writes no Screen file'
  log(`  Screen file: SKIP (${screenFileSkip})`)

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
  if (visual.sources.screenId !== screen.id)
    fail(`the working scene is not on ${screen.id}: ${JSON.stringify(visual.sources)}`)
  const target = {
    id: 'hide-screen-sink',
    platform: 'custom',
    label: 'Hide screen sink',
    enabled: true,
    serverUrl: `rtmp://127.0.0.1:${rtmpPort}/live`,
    streamKey: 'hide-screen',
    urlMode: 'server-and-key',
    streamKeyPresent: true,
    authMode: 'manual-rtmp',
    outputOrientation: 'horizontal',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
  }
  const started = await request(ws, timeoutMs, 'session.start', {
    sources: visual.sources,
    layout: visual.layout,
    background: null,
    output: {
      recordEnabled: true,
      streamEnabled: true,
      outputDirectoryCapability: directory.capabilityId,
      video,
      rtmp: { preset: 'custom', serverUrl: target.serverUrl, streamKey: target.streamKey }
    },
    streaming: {
      enabled: true,
      mode: 'multi',
      targets: [target],
      enabledTargetIds: [target.id],
      defaultOutputPreset: 'custom',
      defaultBitrateKbps: video.bitrateKbps
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
  const ring = await waitForBackendState(
    'replay.status',
    (status) => status?.state === 'on' && status?.sessionId === started.sessionId,
    'the Clips ring inside the session',
    20_000
  )
  await openTab(smoke, 'studio', '[data-videorc-screen-privacy]')
  await sleep(1500)
  const fixtureBefore = await windowsFixtureStats(fixture)
  const flashes = [await flashWindowsFixtureWindow(fixture, 'start')]
  await sleep(2500)
  const fixtureAfter = await windowsFixtureStats(fixture)
  const fixtureFps =
    fixtureBefore && fixtureAfter && fixtureAfter.atMs > fixtureBefore.atMs
      ? Number(
          (
            ((fixtureAfter.frames - fixtureBefore.frames) * 1000) /
            (fixtureAfter.atMs - fixtureBefore.atMs)
          ).toFixed(1)
        )
      : null
  const pathWhileLive = windowsHideSessionPath(
    await request(ws, timeoutMs, 'diagnostics.stats').catch(() => null)
  )

  const hideAtMs = Date.now()
  await renderer.togglePrivacy()
  const hidden = await waitForBackendState(
    'screen.privacy.get',
    (privacy) => privacy.hidden === true,
    'Hide screen confirmed',
    5000
  )
  const hideAckMs = Date.now() - hideAtMs
  await sleep(HIDDEN_SPAN_MS / 2)
  const diagnosticsHidden = await request(ws, timeoutMs, 'diagnostics.stats').catch(() => null)
  await sleep(HIDDEN_SPAN_MS / 2)
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
  flashes.push(await flashWindowsFixtureWindow(fixture, 'end'))
  await sleep(1200)
  const untilMs = Date.now()
  for (const flash of flashes)
    if (!flash.drawnReported)
      log(`  the ${flash.label} flash was not reported drawn; its send time stands in`)

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
  const files = { recording: combined, stream: receiver.path, screenFile: null, clip: clipPath }
  const outputs = {}
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
    // Distinct pictures per second before the hide: the capture's real
    // cadence, which bounds how precisely the flashes align the file.
    const liveFps = distinctFrameRate(analysis.features, analysis.ptsMs, {
      untilPts: hideAtMs - analysis.anchor.offsetMs
    })
    const budget = captureAlignedHideBudget(SMART_SCENES_BUDGET, liveFps)
    const verdict = hideSpanVerdict({
      features: analysis.features,
      ptsMs: analysis.ptsMs,
      offsetMs: analysis.anchor.offsetMs,
      hideAtMs,
      showAtMs,
      untilMs,
      budget
    })
    outputs[name] = {
      ...verdict,
      file,
      frameCount: analysis.features.length,
      liveFps,
      showSlackMs: budget.showSlackMs,
      anchor: analysis.anchor,
      anchorDriftMs: analysis.anchorDriftMs,
      endFlashSeen: analysis.endSeen
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
  const verdict = windowsHideOutputsVerdict(outputs, { hiddenReason: hidden.reason ?? null })
  const sessionPath = windowsHideSessionPath(diagnosticsHidden)
  if (pathWhileLive.path !== sessionPath.path)
    verdict.failures.push(
      `the session changed path across the hide (${pathWhileLive.path} → ${sessionPath.path})`
    )
  verdict.ok = verdict.failures.length === 0
  if (sessionPath.d3d11Skip) log(`  D3D11 media path: SKIP (${sessionPath.d3d11Skip.reason})`)
  return {
    ...verdict,
    outputs,
    session: {
      id: started.sessionId,
      message: started.message ?? null,
      path: sessionPath.path,
      pathWhileLive: pathWhileLive.path,
      captureBackend: sessionPath.captureBackend,
      mediaState: sessionPath.mediaState,
      fallbackReason: sessionPath.fallbackReason
    },
    d3d11Skip: sessionPath.d3d11Skip,
    fixtureFps,
    hideAtMs,
    showAtMs,
    hideAckMs,
    showAckMs,
    hiddenSpanMs: showAtMs - hideAtMs,
    flashes,
    ring: { sessionId: ring.sessionId, seconds: ring.seconds },
    clip: {
      seconds: saved.payload.seconds,
      coveredSeconds: saved.payload.coveredSeconds,
      saveMs: saved.atMs - saveRequestedAt
    },
    detail: [
      `session path ${sessionPath.path}${sessionPath.captureBackend ? ` (${sessionPath.captureBackend})` : ''}${sessionPath.d3d11Skip ? `, D3D11 media path SKIP (${sessionPath.d3d11Skip.flag})` : ''}`,
      `fixture ${fixtureFps ?? 'n/a'} fps`,
      ...Object.entries(outputs).map(([name, output]) =>
        output.skipped
          ? `${name}: SKIP (${output.reason})`
          : output.hidden
            ? `${name}: frosted ${output.hidden.frostedFrames}/${output.hidden.frames} (sharp max ${output.hidden.sharpMax}, live p50 ${output.liveBefore.sharpP50}→${output.liveAfter.sharpP50}), ${output.liveFps ?? 'n/a'} distinct fps live (show slack ${output.showSlackMs} ms), hide +${fmt(output.hideLatencyMs)} ms, show +${fmt(output.showLatencyMs)} ms${output.endFlashSeen ? '' : ', end flash not captured'}${output.ok ? '' : ` FAIL: ${output.failures.join('; ')}`}`
            : `${name}: ${output.failures.join('; ')}`
      )
    ].join('; ')
  }
}

async function step(name, run) {
  const startedAt = Date.now()
  try {
    const result = await run()
    result.durationMs = Date.now() - startedAt
    log(`${result.ok ? 'PASS' : 'FAIL'} ${name}: ${result.detail ?? ''}`)
    if (!result.ok && result.failures?.length) log(`  failures: ${result.failures.join('; ')}`)
    return result
  } catch (error) {
    if (error instanceof SmokeExit) throw error
    const message = error?.message ?? String(error)
    log(`FAIL ${name}: ${message}`)
    return { ok: false, failures: [message], error: error?.stack ?? message }
  }
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
  const { anchor, anchorDriftMs, endSeen } = anchorHideFile(
    anchorFromFlash,
    features,
    ptsMs,
    flashes
  )
  return { file, ptsMs, features, anchor, anchorDriftMs, endSeen }
}

// ---------------------------------------------------------------------------
// Renderer driver (the smart-scenes smoke's, trimmed to what this step uses)

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
      `Timed out: ${description}; last error: ${lastError}; renderer state in ${statePath}`
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
  const setClips = async (enabled) => {
    await waitForRendererHook(smoke, '__videorcSmokeSetReplayBuffer', { timeoutMs })
    const outcome = await evaluate(
      `return window.__videorcSmokeSetReplayBuffer?.(${enabled ? 'true' : 'false'}, 60) ?? null`
    )
    if (outcome !== true)
      throw new Error(`the renderer's replay buffer hook returned ${JSON.stringify(outcome)}`)
  }
  /** The Studio's own Screen picker path for the DXGI display, full-bleed. */
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
          (current) =>
            current.canSave &&
            settled(current) &&
            current.visual.layout.layoutPreset === 'screen-only',
          `${device.name} full-bleed working scene confirmed (canSave)`
        )
        return
      } catch (error) {
        lastError = error
        log(`display pick attempt ${attempt} failed: ${error?.message?.split('\n')[0]}`)
      }
    }
    throw lastError
  }
  /** The Screen row's Hide screen / Show screen button on the Studio page. */
  const togglePrivacy = () =>
    evaluate(`
      const button = await waitFor('[data-videorc-screen-privacy]', 8000);
      if (button.disabled) throw new Error('Hide screen is disabled: ' + (button.getAttribute('aria-label') ?? button.textContent));
      button.click();
      return true;
    `)
  return { evaluate, state, waitFor, chooseCameraOff, setClips, selectDisplay, togglePrivacy }
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

/** The DXGI screen live with frames, or a named SKIP when Desktop Duplication refused. */
async function waitForScreenLiveOrSkip(sourceId) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'preview.screen.status')
    if (last?.state === 'live' && last.sourceId === sourceId && (last.framesCaptured ?? 0) > 0)
      return last
    if (last?.sourceId === sourceId && ['failed', 'permission-needed'].includes(last?.state)) {
      const refusal = windowsScreenStartSkip(last)
      if (refusal) skip(refusal.reason, refusal.flag)
      fail(`the DXGI screen did not start: ${last.state}: ${last.message ?? 'no message'}`)
    }
    await sleep(100)
  }
  const refusal = windowsScreenStartSkip(last)
  if (refusal) skip(refusal.reason, refusal.flag)
  throw new Error(`Timed out waiting for ${sourceId} to go live: ${JSON.stringify(last)}`)
}

async function waitForBackendState(method, predicate, description, waitMs = timeoutMs) {
  const deadline = Date.now() + waitMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, method)
    if (predicate(last)) return last
    await sleep(50)
  }
  throw new Error(`Timed out: ${description}; last ${method}: ${JSON.stringify(last)}`)
}

async function waitForEvent(predicate, description, waitMs) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const found = events.find(predicate)
    if (found) return found
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

// ---------------------------------------------------------------------------
// The local RTMP sink (127.0.0.1 only)

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
      `rtmp://127.0.0.1:${port}/live/hide-screen`,
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
  receiver.child.kill()
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
  console.log(`SKIP smoke:hide-screen:windows: ${reason}`)
  throw new SmokeExit(0)
}

function fail(message) {
  throw new Error(message)
}

function log(message) {
  console.log(`[smoke:hide-screen:windows] ${message}`)
}

function fmt(value) {
  return value == null ? 'n/a' : String(Math.round(value))
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function printHuman(summaryValue) {
  if (summaryValue.skipped) return
  for (const [name, stepResult] of Object.entries(summaryValue.steps)) {
    if (stepResult?.skipped) console.log(`SKIP ${name}: ${stepResult.reason}`)
  }
  const hide = summaryValue.steps.hide
  if (!hide) {
    console.log('smoke:hide-screen:windows: FAIL (the hide step did not run)')
    return
  }
  if (hide.d3d11Skip) console.log(`SKIP d3d11-media path: ${hide.d3d11Skip.reason}`)
  console.log(
    hide.ok
      ? `smoke:hide-screen:windows: PASS (hide on the recording, the stream and the clip; ${hide.session?.path ?? 'unknown'} path; Screen file SKIP, Windows writes none)`
      : `smoke:hide-screen:windows: FAIL ${hide.failures?.join('; ') ?? ''}`
  )
}

function parseArgs(argv) {
  const values = argv[0] === '--' ? argv.slice(1) : argv
  const parsed = { out: null, media: 'auto' }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--out') parsed.out = values[++index]
    // smoke:smart-scenes passes its own arguments through on Windows; the
    // switch count belongs to the macOS-only switches step.
    else if (value === '--switches') index += 1
    else if (value === '--media') {
      parsed.media = values[++index]
      if (!['auto', 'cpu'].includes(parsed.media))
        throw new Error(`--media takes auto or cpu, got ${parsed.media}`)
    } else throw new Error(`Unknown argument: ${value}`)
  }
  return parsed
}
