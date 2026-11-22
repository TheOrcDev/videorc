// Plan 258 S2: the camera background leak smoke (skeleton).
//
// The dev app runs with the fixture camera (`VIDEORC_FIXTURE_CAMERA`, a
// figure over a magenta/cyan code "room") in an isolated profile. One
// session records, streams to local FFmpeg RTMP sinks (horizontal and
// vertical legs), keeps the Clips ring and saves a Clip, and, when a screen
// is listed, writes the separate Camera file; meanwhile the Preview's pixels
// are sampled through the dev oracle. Every output is scanned with
// `scripts/lib/camera-background-leak.mjs`:
//   --effect off (default): the room MUST be found in every output. That
//     proves the detector sees the fixture on each one, so a later clean
//     scan means something.
//   --effect strong-blur | slight-blur | image: the room must be found in
//     NO output. Until S1 (the setting) and S3 (the macOS stage) land, the
//     effect cannot be applied, so this fails and says why, naming every
//     output that carried the room.
// Videorc Camera (packaged app only) and the talk-show room (the renderer's
// own camera) are named SKIPs that S3 and S8 fill in. Nothing goes live.
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
  effectRequestToday,
  expectationFor,
  finalVerdict,
  parseSmokeArgs
} from './lib/camera-background-smoke-plan.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { waitForOwnedTcpListener } from './lib/live-control-recycle-smoke.mjs'
import { takeSiblingPaths } from './lib/separate-source-take-gates.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const { effect } = parseSmokeArgs(process.argv.slice(2))
const expectation = expectationFor(effect)
const spec = loadFixtureSpec()
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-camera-background-smoke-${Date.now()}`)
)
const userDataDir = join(outputDirectory, 'user-data')
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90_000)
/** How long the session runs with the camera on every output. */
const SESSION_MS = Number(process.env.VIDEORC_CAMERA_BACKGROUND_SESSION_MS ?? 12_000)
/** Preview samples taken across the session. */
const PREVIEW_SAMPLES = 8
/** Frames per second decoded from each file. */
const SCAN_FPS = 2
const RTMP_PORT_BASE = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 13985)
// 720p keeps four encoders light; the fixture's cells are then 13 px in the
// camera's own raster and about 11 px on the 360x640 vertical leg.
const VIDEO = { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 }
const VERTICAL_VIDEO = { preset: 'custom', width: 360, height: 640, fps: 30, bitrateKbps: 1500 }

mkdirSync(outputDirectory, { recursive: true })
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

let stopApp = async () => {}
const receivers = []
const events = []
const report = {
  plan: '258 S2',
  effect,
  expectation,
  outputDirectory,
  fixture: FIXTURE_DIRECTORY,
  startedAt: new Date().toISOString()
}
let exitCode = 1

try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_FIXTURE_CAMERA: FIXTURE_DIRECTORY,
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '0',
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
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
  stopApp = launch.stop
  const smoke = launch.connections['preview-motion-ready']
  const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  ws.addEventListener('message', (message) => {
    try {
      const parsed = JSON.parse(message.data)
      if (parsed?.event)
        events.push({ event: parsed.event, payload: parsed.payload, atMs: Date.now() })
    } catch {
      // not JSON
    }
  })

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
  report.camera = camera
  report.screen = screen ? { id: screen.id, name: screen.name } : null
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

  // Warm the camera so the session's first frames already carry it.
  await request(ws, timeoutMs, 'preview.camera.start', { sources, layout, video: VIDEO })
  await waitFor(
    async () => {
      const status = await request(ws, 5000, 'preview.camera.status')
      return status.state === 'live' && status.framesCaptured > 0 ? status : null
    },
    'the fixture camera live with frames',
    20_000
  )

  const effectRequest = effectRequestToday(effect)
  report.effectRequest = effectRequest
  if (!effectRequest.applied) log(`effect ${effect} NOT applied: ${effectRequest.reason}`)

  const outputs = {}
  const files = await runSession({ ws, smoke, sources, layout, cameraRect, screen, outputs })
  report.files = files

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
    const scanned = await scanVideoFile(file, { ffmpegPath, ffprobePath, fps: SCAN_FPS, spec })
    const judged = judgeOutput(scanned.summary, expectation)
    const evidence = await saveEvidenceFrame(file, output.id, scanned.summary)
    outputs[output.id] = { ...judged, file, size: [scanned.width, scanned.height], evidence }
    log(
      `${output.label}: room in ${judged.leakFrames}/${judged.frames} frames, figure in ${judged.personFrames}, max ${judged.maxPatternTiles} tiles → ${judged.ok ? 'PASS' : 'FAIL'}`
    )
  }

  const verdict = finalVerdict({ effect, effectRequest, outputs })
  Object.assign(report, { outputs, verdict, finishedAt: new Date().toISOString() })
  for (const line of verdict.lines) log(line)
  if (verdict.ok) {
    log(
      `PASS (${effect}): the detector ${effect === 'off' ? 'found the room on' : 'found no room on'} ${verdict.judged} outputs`
    )
    exitCode = 0
  } else {
    for (const failure of verdict.failures) console.error(`[camera-background] FAIL ${failure}`)
  }
} catch (error) {
  report.error = String(error?.stack ?? error)
  console.error(`[camera-background] FAIL ${error?.message ?? error}`)
} finally {
  for (const receiver of receivers) {
    if (receiver.child.exitCode === null && receiver.child.signalCode === null)
      receiver.child.kill('SIGTERM')
  }
  await stopApp().catch((error) =>
    console.error(`stopping the dev app: ${error?.message ?? error}`)
  )
  writeFileSync(
    join(outputDirectory, 'camera-background-report.json'),
    JSON.stringify(report, null, 2)
  )
  log(`report: ${join(outputDirectory, 'camera-background-report.json')}`)
}
process.exit(exitCode)

/**
 * One record + stream (both legs) session with the Clips ring, a Clip saved,
 * and the separate Camera file when a screen exists. Samples the Preview
 * while it runs (judged into `outputs.preview`). Returns each output's file.
 */
async function runSession({ ws, smoke, sources, layout, cameraRect, screen, outputs }) {
  const targets = []
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
  const started = await request(ws, timeoutMs, 'session.start', {
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
  const previewScans = []
  const previewFailures = []
  const sampleEveryMs = SESSION_MS / PREVIEW_SAMPLES
  for (let i = 0; i < PREVIEW_SAMPLES; i += 1) {
    await sleep(sampleEveryMs)
    try {
      const sample = await request(ws, 5000, 'preview.debug.sample', {
        rects: [cameraRect],
        crop: cameraRect
      })
      const { width, height, rgbBase64 } = sample.crop
      const rgb = new Uint8Array(Buffer.from(rgbBase64, 'base64'))
      previewScans.push(scanFrame({ width, height, rgb }, { spec }))
      if (i === PREVIEW_SAMPLES - 1) savePreviewPng(rgb, width, height)
    } catch (error) {
      previewFailures.push(String(error?.message ?? error))
    }
  }
  const previewSummary = summarizeScans(previewScans, {
    fps: PREVIEW_SAMPLES / (SESSION_MS / 1000)
  })
  const previewJudged = judgeOutput(previewSummary, expectation)
  outputs.preview = {
    ...previewJudged,
    ok: previewJudged.ok && previewFailures.length === 0,
    failures: [
      ...previewJudged.failures,
      ...previewFailures.map((text) => `Preview sample failed: ${text}`)
    ],
    evidence: join(outputDirectory, 'preview-last.png')
  }
  log(
    `Preview: room in ${previewSummary.leakFrames}/${previewSummary.frames} samples, figure in ${previewSummary.personFrames}`
  )

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
  for (const receiver of receivers) await waitForExit(receiver, 20_000)
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
    'stream-horizontal': receivers[0].path,
    'stream-vertical': receivers[1].path,
    clip: saved.payload.path,
    'camera-file': screen ? takeSiblingPaths(recording).camera : null
  }
}

async function saveEvidenceFrame(file, id, summary) {
  const seconds = summary.worstSeconds ?? 1
  try {
    return await saveFramePng(file, seconds, join(outputDirectory, `${id}-frame.png`), {
      ffmpegPath
    })
  } catch (error) {
    return `no evidence frame: ${error?.message ?? error}`
  }
}

function savePreviewPng(rgb, width, height) {
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
