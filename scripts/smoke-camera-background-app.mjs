// Plan 258 S2/S3: the camera background leak smoke.
//
// The dev app runs with the fixture camera (`VIDEORC_FIXTURE_CAMERA`, a
// figure over a magenta/cyan code "room") in an isolated profile. Each full
// pass records, streams to local FFmpeg RTMP sinks (horizontal and vertical
// legs), keeps the Clips ring and saves a Clip, and, when a screen is
// listed, writes the separate Camera file; meanwhile the Preview's pixels
// are sampled through the dev oracle. Every output is scanned with
// `scripts/lib/camera-background-leak.mjs`:
//   --effect off (default): the room MUST be found in every output. That
//     proves the detector sees the fixture on each one, so a later clean
//     scan means something.
//   --effect strong-blur | slight-blur | image: the camera's background is
//     turned on the way a streamer does it (plan 258 S5): the smoke pins the
//     fixture camera in the renderer, clicks the Studio's Background trigger
//     and the pass's tile (a picture through Choose image… when it is not in
//     the popover's row), and reads the per-camera setting the click stored;
//     the session's layout carries exactly that, as every renderer commit
//     does. The macOS stage (S3) draws it, and the room must be found in NO
//     output. The relaunch pass clicks nothing: the setting must come back.
//   --effect all (the S3 gate): Off, Strong blur and the picture on every
//     output, then three short passes that scan every recorded frame:
//     a segmentation stall mid-recording (the cover within D6's budget,
//     `test.cameraBackground.segmentationStall`), a camera switch with
//     Record pressed at once, and a relaunch on the same profile.
// Videorc Camera (packaged app only, owed by the owner) and the talk-show
// room (S8) are named SKIPs. Nothing goes live.
//
// Evidence: VIDEORC_SMOKE_OUTPUT_DIR (the artifacts, a PNG of each output's
// worst frame and camera-background-report.json).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import {
  FIXTURE_DIRECTORY,
  judgeOutput,
  loadFixtureSpec,
  saveFramePng,
  scanFrame,
  scanVideoFile,
  summarizeScans
} from './lib/camera-background-leak.mjs'
import {
  CAMERA_BACKGROUND_OUTPUTS,
  controlChoiceFor,
  controlsMatchPass,
  effectRequestFrom,
  expectationFor,
  finalVerdict,
  isFullPass,
  judgeStall,
  neutralGroundFraction,
  parseSmokeArgs,
  passesFor
} from './lib/camera-background-smoke-plan.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { waitForOwnedTcpListener } from './lib/live-control-recycle-smoke.mjs'
import { takeSiblingPaths } from './lib/separate-source-take-gates.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const { effect } = parseSmokeArgs(process.argv.slice(2))
const passes = passesFor(effect)
const spec = loadFixtureSpec()
const outputRoot = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-camera-background-smoke-${Date.now()}`)
)
const userDataDir = join(outputRoot, 'user-data')
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90_000)
/** How long a full pass's session runs with the camera on every output. */
const SESSION_MS = Number(process.env.VIDEORC_CAMERA_BACKGROUND_SESSION_MS ?? 12_000)
/** Preview samples taken across a full session. */
const PREVIEW_SAMPLES = 8
/** Frames per second decoded from each file of a full pass. */
const SCAN_FPS = 2
const RTMP_PORT_BASE = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 13985)
// 720p keeps four encoders light; the fixture's cells are then 13 px in the
// camera's own raster and about 11 px on the 360x640 vertical leg.
const VIDEO = { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 }
const VERTICAL_VIDEO = { preset: 'custom', width: 360, height: 640, fps: 30, bitrateKbps: 1500 }

mkdirSync(outputRoot, { recursive: true })
mkdirSync(userDataDir, { recursive: true })
const log = (line) => console.log(`[camera-background] ${line}`)

if (process.platform !== 'darwin') {
  // D13: macOS first. The fixture camera itself is cross-platform; S10/S11
  // run this smoke on Windows and Linux.
  console.log(
    'SKIP smoke:camera-background: macOS first (plan 258 D13); S10/S11 add Windows and Linux.'
  )
  process.exit(0)
}
if (process.env.VIDEORC_DEV_BACKEND_PROFILE === 'release') {
  console.error(
    'smoke:camera-background needs the debug backend: release builds refuse VIDEORC_FIXTURE_CAMERA and the Preview oracle. Unset VIDEORC_DEV_BACKEND_PROFILE.'
  )
  process.exit(1)
}
for (const tool of [ffmpegPath, ffprobePath]) {
  try {
    execFileSync(tool, ['-version'], { stdio: 'ignore' })
  } catch {
    console.error(`${tool} is not runnable; the smoke decodes every output with it.`)
    process.exit(1)
  }
}

let app = null
const receivers = []
const report = {
  plan: '258 S3',
  effect,
  passes: {},
  outputDirectory: outputRoot,
  fixture: FIXTURE_DIRECTORY,
  startedAt: new Date().toISOString()
}
let exitCode = 1

try {
  app = await launchApp()
  const setup = await discover(app.ws)
  report.camera = setup.camera
  report.screen = setup.screen ? { id: setup.screen.id, name: setup.screen.name } : null
  for (const pass of passes) {
    if (pass === 'relaunch') {
      log('relaunch: quitting the app and starting it again on the same profile')
      await app.stop()
      app = await launchApp()
      setup.screenStarted = false
    }
    log(`--- pass ${pass} ---`)
    const result = await runPass(pass, app, setup).catch((error) => ({
      verdict: {
        ok: false,
        failures: [`${pass}: ${error?.message ?? error}`],
        lines: [`${pass}: FAIL (${error?.message ?? error})`]
      },
      error: String(error?.stack ?? error)
    }))
    report.passes[pass] = result
    for (const line of result.verdict.lines) log(`${pass} · ${line}`)
  }
  const failures = Object.entries(report.passes).flatMap(([pass, result]) =>
    result.verdict.ok ? [] : result.verdict.failures.map((failure) => `${pass}: ${failure}`)
  )
  report.ok = failures.length === 0
  report.finishedAt = new Date().toISOString()
  if (report.ok) {
    log(`PASS (${effect}): ${passes.join(', ')}`)
    exitCode = 0
  } else {
    for (const failure of failures) console.error(`[camera-background] FAIL ${failure}`)
  }
} catch (error) {
  report.error = String(error?.stack ?? error)
  console.error(`[camera-background] FAIL ${error?.message ?? error}`)
} finally {
  for (const receiver of receivers) {
    if (receiver.child.exitCode === null && receiver.child.signalCode === null)
      receiver.child.kill('SIGTERM')
  }
  await app
    ?.stop()
    .catch((error) => console.error(`stopping the dev app: ${error?.message ?? error}`))
  writeFileSync(join(outputRoot, 'camera-background-report.json'), JSON.stringify(report, null, 2))
  log(`report: ${join(outputRoot, 'camera-background-report.json')}`)
}
process.exit(exitCode)

/** The dev app on the isolated profile, its backend socket and its events. */
async function launchApp() {
  const launch = await launchDevApp({
    env: {
      VIDEORC_FIXTURE_CAMERA: FIXTURE_DIRECTORY,
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '0',
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_SMOKE_STATE_DIR: outputRoot,
      VIDEORC_SMOKE_OUTPUT_DIR: outputRoot,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3')
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (line.startsWith('[smoke:'))
        log(line.replace(/(token|capability).*$/i, '[handshake omitted]'))
    }
  })
  const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  const events = []
  ws.addEventListener('message', (message) => {
    try {
      const parsed = JSON.parse(message.data)
      if (parsed?.event)
        events.push({ event: parsed.event, payload: parsed.payload, atMs: Date.now() })
    } catch {
      // not JSON
    }
  })
  // The image pass's picture is one of the bundled set, which main registers
  // with the backend when the renderer loads its background library
  // (`backgrounds:bundled-assets`); the registration RPC is main's alone. A
  // picture that never resolves draws the neutral ground, which the image
  // pass fails by name.
  return {
    ws,
    events,
    smoke: launch.connections['preview-motion-ready'],
    stop: launch.stop
  }
}

/** The fixture camera, a screen if one is listed, and the pass layout. */
async function discover(ws) {
  // The fixture camera is listed, and a screen if this host lets the dev app
  // capture one (the Camera file needs a camera and a screen).
  const devices = (await request(ws, timeoutMs, 'devices.list', { ffmpegPath })).devices ?? []
  const camera = devices.find(
    (device) => device.kind === 'camera' && /fixture camera/i.test(device.name)
  )
  if (!camera) {
    throw new Error(
      `the fixture camera is not in devices.list; is the dev backend a debug build? Cameras: ${JSON.stringify(devices.filter((device) => device.kind === 'camera'))}`
    )
  }
  const screen = devices.find((device) => device.kind === 'screen' && device.status === 'available')
  log(`camera ${camera.id}; screen ${screen ? screen.id : 'none (the Camera file is a SKIP)'}`)
  // Side by side keeps the camera at its own scale in the right 30 % (the
  // fixture's room shows round the figure's head); camera-only when there is
  // no screen.
  const layout = {
    layoutPreset: screen ? 'side-by-side' : 'camera-only',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'large',
    cameraShape: 'rectangle',
    cameraMargin: 0,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right'
  }
  const cameraRect = screen ? { x: 0.7, y: 0, w: 0.3, h: 1 } : { x: 0, y: 0, w: 1, h: 1 }
  const sources = {
    cameraId: camera.id,
    cameraName: camera.name,
    cameraOff: false,
    ...(screen ? { screenId: screen.id } : {})
  }
  return { camera, screen, layout, cameraRect, sources, screenStarted: false }
}

/** One pass: the camera (re)started with the pass's background, then its session. */
async function runPass(pass, appHandle, setup) {
  const { ws } = appHandle
  const outputDirectory = join(outputRoot, pass)
  mkdirSync(outputDirectory, { recursive: true })
  const controls = await backgroundThroughControls(appHandle, setup, pass)
  log(
    `${pass}: Background ${controls.clicked ? `clicked "${controls.clicked}"` : 'kept'} → ${controls.trigger ?? '(no trigger label)'}; stored ${JSON.stringify(controls.stored)}`
  )
  const background = layoutBackgroundFromControls(controls.stored)
  const layout = { ...setup.layout, ...(background ? { cameraBackground: background } : {}) }
  const expectation = expectationFor(pass)
  if (pass === 'camera-switch-record') {
    // A camera switch: the session ends and a new camera store starts armed.
    await request(ws, timeoutMs, 'preview.camera.stop')
    await waitFor(
      async () => {
        const status = await request(ws, 5000, 'preview.camera.status')
        return status.state !== 'live' ? status : null
      },
      'the camera to stop',
      15_000
    )
  }
  // Warm the camera so the session's first frames already carry it.
  await request(ws, timeoutMs, 'preview.camera.start', {
    sources: setup.sources,
    layout,
    video: VIDEO
  })
  const live = await waitFor(
    async () => {
      const status = await request(ws, 5000, 'preview.camera.status')
      return status.state === 'live' && status.framesCaptured > 0 ? status : null
    },
    'the fixture camera live with frames',
    20_000
  )
  // And the screen: session.start refuses a screen source with no frames yet.
  if (setup.screen && !setup.screenStarted) {
    await request(ws, timeoutMs, 'preview.screen.start', { sources: setup.sources, video: VIDEO })
    await waitFor(
      async () => {
        const status = await request(ws, 5000, 'preview.screen.status')
        return status.state === 'live' && status.framesCaptured > 0 ? status : null
      },
      'the screen source live with frames',
      20_000
    )
    setup.screenStarted = true
  }
  let effectRequest = effectRequestFrom(pass, live)
  if (!effectRequest.applied) {
    // The stage arms with the start; give the status poll a beat to say so.
    const settled = await waitFor(
      async () => {
        const status = await request(ws, 5000, 'preview.camera.status')
        return effectRequestFrom(pass, status).applied ? status : null
      },
      `the camera status to show ${pass}`,
      5_000
    ).catch(() => null)
    if (settled) effectRequest = effectRequestFrom(pass, settled)
  }
  if (!effectRequest.applied) log(`${pass} NOT applied: ${effectRequest.reason}`)
  const context = { ...appHandle, setup, layout, expectation, outputDirectory, pass }
  if (isFullPass(pass)) {
    const outputs = {}
    const files = await runSession({ ...context, outputs })
    for (const output of CAMERA_BACKGROUND_OUTPUTS) {
      if (output.pending) {
        outputs[output.id] = { ok: true, skipped: true, reason: output.pending }
        continue
      }
      if (outputs[output.id]) continue // judged during the session (Preview) or skipped
      const file = files[output.id]
      if (!file || !existsSync(file)) {
        outputs[output.id] = { ok: false, failures: [`file missing: ${file}`], file }
        continue
      }
      outputs[output.id] = await judgeFile(file, output.id, expectation, outputDirectory, {
        fps: SCAN_FPS
      })
      log(`${pass} · ${output.label}: ${describe(outputs[output.id])}`)
    }
    const stage = await stageStatus(ws)
    return {
      controls,
      effectRequest,
      stage,
      files,
      outputs,
      verdict: finalVerdict({ effect: pass, effectRequest, outputs })
    }
  }
  const { outputs, stage, stall } = await runShortSession(context)
  return {
    controls,
    effectRequest,
    stage,
    stall,
    outputs,
    verdict: finalVerdict({
      effect: pass,
      effectRequest,
      outputs,
      outputIds: Object.keys(outputs)
    })
  }
}

/** Renderer JS run through the smoke command server; returns the code's value. */
async function evaluate(smoke, code, params = {}) {
  const response = await requestSmokeCommand(smoke, 'eval-js', { code, ...params }, { timeoutMs })
  return response && typeof response === 'object' && 'result' in response
    ? response.result
    : response
}

/** The renderer's stored background for the camera (settings.cameraBackgrounds), or null. */
const READ_STORED_BACKGROUND = `
  const settings = JSON.parse(localStorage.getItem('videorc.settings') ?? '{}');
  return settings.cameraBackgrounds?.[params.cameraId] ?? null;
`

/**
 * Plan 258 S5: clicks the Studio's Background trigger and the pass's tile,
 * the way a streamer turns the effect on. A picture outside the popover's
 * row goes through Choose image…. Returns the trigger's name after the
 * click and the per-camera setting the click stored.
 */
const PICK_BACKGROUND = `
  const inside = (scope, choice) =>
    document.querySelector(scope + ' [data-videorc-camera-background-choice="' + choice + '"]');
  await openTab('studio', '[data-videorc-camera-background-trigger]');
  const trigger = await waitFor('[data-videorc-camera-background-trigger]', 15000);
  const before = trigger.getAttribute('aria-label');
  if (!document.querySelector('[data-videorc-camera-background-popover]')) trigger.click();
  await waitFor('[data-videorc-camera-background-popover]');
  let tile = inside('[data-videorc-camera-background-popover]', params.choice);
  if (!tile && params.choice.startsWith('image:')) {
    (await waitFor('[data-videorc-camera-background-popover] [data-videorc-camera-background-choose-image]')).click();
    await waitFor('[data-videorc-camera-background-image-dialog]');
    tile = inside('[data-videorc-camera-background-image-dialog]', params.choice);
  }
  if (!tile) throw new Error('No Background tile ' + params.choice);
  if (tile.disabled) {
    const reason = document.querySelector('[data-videorc-camera-background-reason]')?.textContent ?? '';
    throw new Error('The Background tile ' + params.choice + ' is disabled: ' + reason);
  }
  tile.click();
  let stored = null;
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const settings = JSON.parse(localStorage.getItem('videorc.settings') ?? '{}');
    stored = settings.cameraBackgrounds?.[params.cameraId] ?? null;
    if ((stored?.mode ?? 'off') === params.mode) break;
    await sleep(50);
  }
  // Close the popover (a pick leaves it open, as the Studio does).
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(200);
  const after = document.querySelector('[data-videorc-camera-background-trigger]')?.getAttribute('aria-label') ?? null;
  return { before, after, stored };
`

/**
 * Plan 258 S5: the pass's background through the Studio's controls, never
 * the layout shortcut S3 used (a renderer commit dropped that). The renderer
 * first pins the fixture camera, so the per-camera setting is the recorded
 * camera's. The relaunch pass clicks nothing: the stored setting must have
 * survived the relaunch on the same profile.
 */
async function backgroundThroughControls(appHandle, setup, pass) {
  const { smoke } = appHandle
  const cameraId = setup.camera.id
  if (!appHandle.rendererCameraPinned) {
    await requestSmokeCommand(
      smoke,
      'select-camera-device',
      { cameraId, settleMs: 800 },
      { timeoutMs }
    )
    appHandle.rendererCameraPinned = true
  }
  let stored = await evaluate(smoke, READ_STORED_BACKGROUND, { cameraId })
  if (pass === 'relaunch') {
    if (!controlsMatchPass(pass, stored))
      throw new Error(
        `the camera's background did not survive the relaunch: stored ${JSON.stringify(stored)}`
      )
    return { clicked: null, trigger: null, stored }
  }
  if (controlsMatchPass(pass, stored)) return { clicked: null, trigger: null, stored }
  const choice = controlChoiceFor(pass)
  const picked = await evaluate(smoke, PICK_BACKGROUND, {
    cameraId,
    choice,
    mode: choice === 'off' ? 'off' : choice.startsWith('image:') ? 'image' : 'blur'
  })
  stored = picked?.stored ?? null
  if (!controlsMatchPass(pass, stored))
    throw new Error(
      `clicking "${choice}" stored ${JSON.stringify(stored)} for ${cameraId}, not the ${pass} background`
    )
  return { clicked: choice, trigger: picked?.after ?? null, triggerBefore: picked?.before, stored }
}

async function stageStatus(ws) {
  return (await request(ws, 5000, 'preview.camera.status')).cameraBackground ?? null
}

function describe(judged) {
  return `room in ${judged.leakFrames}/${judged.frames} frames, figure in ${judged.personFrames}, max ${judged.maxPatternTiles} tiles → ${judged.ok ? 'PASS' : 'FAIL'}`
}

async function judgeFile(file, id, expectation, outputDirectory, { fps }) {
  const scanned = await scanVideoFile(file, { ffmpegPath, ffprobePath, fps, spec })
  const judged = judgeOutput(scanned.summary, expectation)
  const evidence = await saveEvidenceFrame(file, id, scanned.summary, outputDirectory)
  return { ...judged, file, size: [scanned.width, scanned.height], scanFps: fps, evidence }
}

/** Preview samples of the camera's rect, judged together. */
async function samplePreview(ws, setup, count, everyMs, outputDirectory, expectation) {
  const scans = []
  const failures = []
  let neutral = null
  for (let i = 0; i < count; i += 1) {
    if (everyMs) await sleep(everyMs)
    try {
      const sample = await request(ws, 5000, 'preview.debug.sample', {
        rects: [setup.cameraRect],
        crop: setup.cameraRect
      })
      const { width, height, rgbBase64 } = sample.crop
      const rgb = new Uint8Array(Buffer.from(rgbBase64, 'base64'))
      scans.push(scanFrame({ width, height, rgb }, { spec }))
      neutral = neutralGroundFraction({ width, height, rgb })
      if (i === count - 1) savePreviewPng(rgb, width, height, outputDirectory)
    } catch (error) {
      failures.push(String(error?.message ?? error))
    }
  }
  const summary = summarizeScans(scans, {})
  const judged = judgeOutput(summary, expectation)
  return {
    ...judged,
    ok: judged.ok && failures.length === 0,
    failures: [...judged.failures, ...failures.map((text) => `Preview sample failed: ${text}`)],
    neutralGroundFraction: neutral,
    evidence: join(outputDirectory, 'preview-last.png')
  }
}

/**
 * A record-only session with every recorded frame scanned: the stall, the
 * camera switch with Record pressed at once, and the relaunch.
 */
async function runShortSession(context) {
  const { ws, smoke, setup, layout, expectation, outputDirectory, pass } = context
  const directory = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { path: outputDirectory, kind: 'output-directory' },
    { timeoutMs }
  )
  const started = await startSession(ws, {
    sources: setup.sources,
    layout,
    background: null,
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability: directory.capabilityId,
      video: VIDEO,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  })
  log(`${pass}: session ${started.sessionId} ${started.state}`)
  const outputs = {}
  let stall = null
  let stage = null
  let stopped
  try {
    if (pass === 'stall') {
      stall = await holdSegmentation(ws, setup, outputDirectory, expectation)
      outputs.stall = { ok: stall.ok, failures: stall.failures }
      outputs.preview = stall.preview
    } else {
      outputs.preview = await samplePreview(ws, setup, 6, 400, outputDirectory, expectation)
    }
    stage = await stageStatus(ws)
  } finally {
    // A failed step never leaves a session behind for the next pass.
    stopped = await request(ws, timeoutMs, 'session.stop')
  }
  const recording = await resolveFinalRecordingPath({ started, stopped, timeoutMs: 120_000 })
  // Every frame, from the first: a raw first frame is the bug this pass hunts.
  outputs.recording = await judgeFile(recording, 'recording', expectation, outputDirectory, {
    fps: VIDEO.fps
  })
  log(`${pass} · Recording (every frame): ${describe(outputs.recording)}`)
  return { outputs, stage, stall }
}

/** D6 in the running app: hold the segment worker, watch the cover take over, release it. */
async function holdSegmentation(ws, setup, outputDirectory, expectation) {
  const running = await waitFor(
    async () => {
      const stage = await stageStatus(ws)
      return stage?.state === 'running' && stage.processedFrames > 30 ? stage : null
    },
    'processed frames before the stall',
    15_000
  )
  log(
    `stall: running (segment p95 ${running.segmentMsP95} ms, compose p95 ${running.composeMsP95} ms, GPU p95 ${running.composeGpuMsP95} ms)`
  )
  await request(ws, 5000, 'test.cameraBackground.segmentationStall', { stalled: true })
  let covered = null
  const preview = { scans: [] }
  try {
    covered = await waitFor(
      async () => {
        const stage = await stageStatus(ws)
        return stage?.state === 'cover' ? stage : null
      },
      'the cover while the segmenter is held',
      3_000
    ).catch(() => null)
    Object.assign(preview, await samplePreview(ws, setup, 5, 300, outputDirectory, expectation))
  } finally {
    await request(ws, 5000, 'test.cameraBackground.segmentationStall', { stalled: false })
  }
  const recovered = await waitFor(
    async () => {
      const stage = await stageStatus(ws)
      return stage?.state === 'running' ? stage : null
    },
    'processed frames after the stall',
    5_000
  ).catch(() => null)
  await sleep(1500)
  const judged = judgeStall({
    coverSeen: Boolean(covered),
    coverAfterMaskAgeMs: (covered ?? recovered)?.coverAfterMaskAgeMs,
    recovered: Boolean(recovered),
    fps: VIDEO.fps
  })
  log(
    `stall: cover took over with a ${(covered ?? recovered)?.coverAfterMaskAgeMs} ms old matte (budget ${judged.budgetMs} ms) → ${judged.ok ? 'PASS' : 'FAIL'}`
  )
  return { ...judged, running, covered, recovered, preview }
}

/**
 * One record + stream (both legs) session with the Clips ring, a Clip saved,
 * and the separate Camera file when a screen exists. Samples the Preview
 * while it runs (judged into `outputs.preview`). Returns each output's file.
 */
async function runSession({
  ws,
  smoke,
  events,
  setup,
  layout,
  expectation,
  outputDirectory,
  outputs
}) {
  const { sources, screen } = setup
  const targets = []
  const sinks = []
  for (const orientation of ['horizontal', 'vertical']) {
    const port = await freeTcpPort(RTMP_PORT_BASE + targets.length * 20)
    const target = {
      id: `camera-background-${orientation}`,
      platform: 'custom',
      label: `Camera background ${orientation}`,
      enabled: true,
      serverUrl: `rtmp://127.0.0.1:${port}/live`,
      streamKey: `camera-background-${orientation}`,
      urlMode: 'server-and-key',
      streamKeyPresent: true,
      authMode: 'manual-rtmp',
      outputOrientation: orientation,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z'
    }
    const receiver = startReceiver(target, join(outputDirectory, `stream-${orientation}.flv`))
    receivers.push(receiver)
    sinks.push(receiver)
    await waitForOwnedTcpListener({
      child: receiver.child,
      port,
      timeoutMs: 8000,
      diagnostics: () => receiver.log
    })
    targets.push(target)
  }
  const directory = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { path: outputDirectory, kind: 'output-directory' },
    { timeoutMs }
  )
  const started = await startSession(ws, {
    sources,
    layout,
    background: null,
    output: {
      recordEnabled: true,
      streamEnabled: true,
      outputDirectoryCapability: directory.capabilityId,
      ...(screen ? { separateSourceRecordings: { enabled: true, keepCombined: true } } : {}),
      video: VIDEO,
      rtmp: { preset: 'custom', serverUrl: targets[0].serverUrl, streamKey: targets[0].streamKey }
    },
    streaming: {
      enabled: true,
      mode: 'multi',
      targets,
      enabledTargetIds: targets.map((target) => target.id),
      defaultOutputPreset: 'custom',
      defaultBitrateKbps: VIDEO.bitrateKbps
    },
    simulcast: {
      layout: { ...layout, layoutPreset: 'vertical-camera-only', verticalScreenFraming: 'fit' },
      video: VERTICAL_VIDEO
    },
    replay: { seconds: 60 }
  })
  if (!['recording', 'streaming'].includes(started.state)) {
    throw new Error(
      `session.start did not start a record+stream session: ${JSON.stringify(started).slice(0, 400)}`
    )
  }
  log(`session ${started.sessionId} ${started.state}`)
  await waitFor(
    async () => {
      const status = await request(ws, 5000, 'replay.status')
      return status?.state === 'on' && status?.sessionId === started.sessionId ? status : null
    },
    'the Clips ring inside the session',
    20_000
  )

  // The Preview: full-resolution pixels of the camera's rect, spread over
  // the session (the Clip below needs the ring to fill anyway).
  outputs.preview = await samplePreview(
    ws,
    setup,
    PREVIEW_SAMPLES,
    SESSION_MS / PREVIEW_SAMPLES,
    outputDirectory,
    expectation
  )
  log(
    `Preview: room in ${outputs.preview.leakFrames}/${outputs.preview.frames} samples, figure in ${outputs.preview.personFrames}`
  )
  if (layout.cameraBackground?.mode === 'image' && outputs.preview.neutralGroundFraction > 0.5) {
    outputs.preview.ok = false
    outputs.preview.failures.push(
      `the picture never drew: ${Math.round(outputs.preview.neutralGroundFraction * 100)} % of the camera is the neutral ground`
    )
  }

  const accepted = await request(ws, timeoutMs, 'replay.save', { seconds: 30 })
  const saved = await waitFor(
    async () =>
      events.find(
        (entry) =>
          (entry.event === 'replay.saved' || entry.event === 'replay.saveFailed') &&
          entry.payload?.saveId === accepted.saveId
      ) ?? null,
    'the Clip save',
    60_000
  )
  if (saved.event === 'replay.saveFailed')
    throw new Error(`the Clip save failed: ${JSON.stringify(saved.payload)}`)
  const stopped = await request(ws, timeoutMs, 'session.stop')
  const recording = await resolveFinalRecordingPath({ started, stopped, timeoutMs: 120_000 })
  for (const receiver of sinks) await waitForExit(receiver, 20_000)
  if (!screen) {
    outputs['camera-file'] = {
      ok: true,
      skipped: true,
      reason:
        'no available screen in devices.list (the dev app has no Screen Recording grant here), and separate source recordings need a camera and a screen'
    }
  }
  return {
    recording,
    'stream-horizontal': sinks[0].path,
    'stream-vertical': sinks[1].path,
    clip: saved.payload.path,
    'camera-file': screen ? takeSiblingPaths(recording).camera : null
  }
}

/**
 * session.start, retried for up to 15 s while it refuses a capture source
 * that has not produced frames yet (a warm-up race, never a leak question).
 */
async function startSession(ws, params) {
  const deadline = Date.now() + 15_000
  for (;;) {
    try {
      return await request(ws, timeoutMs, 'session.start', params)
    } catch (error) {
      if (!/produced no frames/.test(error?.message ?? '') || Date.now() > deadline) throw error
      log(`session.start: ${error.message}; retrying`)
      await sleep(1000)
    }
  }
}

async function saveEvidenceFrame(file, id, summary, outputDirectory) {
  const seconds = summary.worstSeconds ?? 1
  try {
    return await saveFramePng(file, seconds, join(outputDirectory, `${id}-frame.png`), {
      ffmpegPath
    })
  } catch (error) {
    return `no evidence frame: ${error?.message ?? error}`
  }
}

function savePreviewPng(rgb, width, height, outputDirectory) {
  const child = spawn(
    ffmpegPath,
    [
      '-v',
      'error',
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-s',
      `${width}x${height}`,
      '-i',
      '-',
      join(outputDirectory, 'preview-last.png')
    ],
    { stdio: ['pipe', 'ignore', 'ignore'] }
  )
  child.stdin.end(Buffer.from(rgb))
}

async function waitFor(probe, what, ms) {
  const deadline = Date.now() + ms
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

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

function startReceiver(target, recvPath) {
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
      `${target.serverUrl}/${target.streamKey}`,
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

async function waitForExit(receiver, ms) {
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
