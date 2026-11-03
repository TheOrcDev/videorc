#!/usr/bin/env node
// smoke:virtual-camera (plan 214 F1): a packaged, signed Videorc turns
// Videorc Camera on, and the platform's own FFmpeg reads it back the way Meet
// or Zoom would.
//
//   pnpm smoke:virtual-camera [-- <app>] [--report <path>] [--debug]
//
// <app> is the packaged app: /Applications/Videorc.app (the default on macOS;
// the camera extension activates only from /Applications), Videorc.exe of an
// installed or unpacked Windows build, or the Linux `videorc` binary. The run
// gets its own profile (removed at the end) and drives the app through the
// packaged smoke command server and the renderer socket: no eval-js, no
// import commands.
//
// The scene is a marker the reader can decode, not the test pattern: the
// bundled background in the ring around the stage (the image), four 2x2
// checker banners in the left ring (a finder, and a 3-bit Gray code that steps
// once a second through the banner path) and a capture source in the stage
// (macOS: the Fixture Alpha window; Windows and Linux: the display). The
// banners are imported through Agents' edit_banner, the product's own route.
//
// Every assertion in VIRTUAL_CAMERA_SMOKE_ASSERTIONS (lib/virtual-camera-
// smoke.mjs) is judged, or the run fails with "<id>: not judged".
//
// SKIP (exit 0, always naming the reason): the camera needs approval or its
// setup, is unsupported, or is unavailable while no app lists it; Videorc has
// no Screen Recording grant; the reader's own camera grant is denied.
// FAIL (exit 1): everything else, including "no frames from Videorc Camera"
// and "still instead of program".
//
// Cleanup, whatever happened: Show, recording stopped, the camera off and
// checked off, banners hidden, Agents off, the app quit by its exact PID, the
// fixture stopped, the profile removed. The evidence (report, stills,
// recording reports) stays in the output folder.
//
// Env: VIDEORC_SMOKE_FFMPEG_PATH / VIDEORC_SMOKE_FFPROBE_PATH (decode and
// analyzer; default the app's bundled FFmpeg, required for an AppImage),
// VIDEORC_VIRTUAL_CAMERA_READER_FFMPEG (the camera reader; default the same
// FFmpeg), VIDEORC_SMOKE_TIMEOUT_MS (RPC timeout, 60000),
// VIDEORC_SMOKE_OUTPUT_DIR, VIDEORC_SMOKE_PRINT_APP_OUTPUT=1.

import './lib/smoke-env.mjs'

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { buildFixtureApps } from './fixtures/build-fixture-apps.mjs'
import { postMcp, resultText } from './lib/agent-mcp-client.mjs'
import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveExistingSiblingFfprobe } from './lib/ffmpeg-sibling-paths.mjs'
import { launchFixtureApp, stopFixtureApp } from './lib/fixture-app-process.mjs'
import {
  assertPackagedSmokePlatform,
  bundledFfmpegPathForPackagedApp,
  isLinuxAppImageExecutable
} from './lib/packaged-smoke-paths.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { evaluateRecordingWallDuration } from './lib/recording-duration-gate.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  ANALYSIS_HEIGHT,
  ANALYSIS_WIDTH,
  MARKER_CELLS,
  VIRTUAL_CAMERA,
  VIRTUAL_CAMERA_SMOKE_ASSERTIONS,
  VIRTUAL_CAMERA_SMOKE_BUDGET,
  VIRTUAL_CAMERA_SMOKE_SCHEDULE,
  analyzeFrame,
  cadenceVerdict,
  cameraAccessDenied,
  cameraHideVerdict,
  cameraListing,
  cameraReaderPlan,
  classifyCameraRead,
  classifyCameraStart,
  codeBannerRgb,
  codeStep,
  counterVerdict,
  encodePngRgb,
  markerBannerUpdate,
  markerSummary,
  matchCodeTracks,
  parseShowinfoLine,
  presenceVerdict,
  ptsUsable,
  readerOutputArgs,
  selfListedCameras,
  smokeSceneBackground,
  smokeVerdict,
  wallOffsetMs
} from './lib/virtual-camera-smoke.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    app: { type: 'string' },
    report: { type: 'string' },
    debug: { type: 'boolean', default: false }
  },
  strict: true
})

const platform = process.platform
const budget = VIRTUAL_CAMERA_SMOKE_BUDGET
const schedule = VIRTUAL_CAMERA_SMOKE_SCHEDULE
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 60_000)
const appArgument =
  args.app ?? positionals[0] ?? (platform === 'darwin' ? '/Applications/Videorc.app' : null)
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-virtual-camera-${Date.now()}`)
)
const reportPath = resolve(args.report ?? join(outputDirectory, 'virtual-camera-report.json'))
const terminalName = process.env.TERM_PROGRAM
  ? `the terminal app (${process.env.TERM_PROGRAM})`
  : 'the terminal app'
const REPORTED_EVENTS = new Set([
  'virtualCamera.changed',
  'recording.status',
  'recording.finalization',
  'screen.privacy.changed',
  'health.event'
])

class SmokeStop extends Error {
  constructor(kind, reason) {
    super(reason)
    this.kind = kind
  }
}

function skipRun(reason) {
  throw new SmokeStop('skip', reason)
}

function failRun(reason) {
  throw new SmokeStop('fail', reason)
}

function log(message) {
  console.log(`virtual-camera: ${message}`)
}

function debug(message) {
  if (args.debug) log(`debug: ${message}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)))
}

function sleepUntil(wallMs) {
  return sleep(wallMs - Date.now())
}

async function settledWithin(promise, ms) {
  let timer
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), ms)
  })
  const settled = await Promise.race([promise.then(() => true), timeout])
  clearTimeout(timer)
  return settled
}

function packagedExecutable(appPath) {
  const path = resolve(appPath)
  if (platform === 'darwin' && /\.app\/?$/i.test(path)) {
    return join(path, 'Contents', 'MacOS', 'Videorc')
  }
  return path
}

// Everything cleanup must undo, recorded as it is created.
const run = {
  launch: null,
  renderer: null,
  smoke: null,
  fixture: null,
  profileDirectory: null,
  cameraTurnedOn: false,
  sessionActive: false,
  screenHidden: false,
  bannersShown: false,
  agentsEnabled: false,
  agentId: null,
  ticker: null,
  readers: new Set(),
  children: new Set()
}

const report = {
  smoke: 'virtual-camera',
  plan: '214 F1',
  platform,
  startedAt: new Date().toISOString(),
  app: appArgument,
  outputDirectory,
  steps: {},
  timeline: {},
  assertions: {},
  events: [],
  cleanup: [],
  verdict: null
}

class EventLog {
  constructor(ws) {
    this.records = []
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (!message?.event || !REPORTED_EVENTS.has(message.event)) return
      this.records.push({ event: message.event, payload: message.payload, at: Date.now() })
    })
  }

  find(predicate) {
    return this.records.find(predicate) ?? null
  }
}

let events = null

function rpc(method, params = {}, ms = timeoutMs) {
  return request(run.renderer, ms, method, params)
}

// ---------------------------------------------------------------------------
// FFmpeg: one-shot runs and frame readers, every child owned and reaped

function runProcess(command, commandArgs, { limitMs = 20_000 } = {}) {
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolveRun({ code: null, stdout: '', stderr: '', error: error.message })
      return
    }
    run.children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (text) => {
      stdout += text
    })
    child.stderr.setEncoding('utf8').on('data', (text) => {
      stderr += text
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), limitMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      run.children.delete(child)
      resolveRun({ code: null, stdout, stderr, error: error.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      run.children.delete(child)
      resolveRun({ code, signal, stdout, stderr, error: null })
    })
  })
}

/**
 * One FFmpeg decode to 480x270 rgb24: every frame analyzed as it lands, its
 * pts from showinfo, its arrival on the wall clock, one still a second kept.
 */
function startFrameReader({ label, ffmpegPath, inputArgs }) {
  const frameBytes = ANALYSIS_WIDTH * ANALYSIS_HEIGHT * 3
  const commandArgs = ['-hide_banner', '-nostats', ...inputArgs, ...readerOutputArgs()]
  const reader = {
    label,
    commandArgs,
    features: [],
    ptsMs: [],
    arrivalMs: [],
    snapshots: [],
    stderrTail: [],
    stderrText: '',
    exited: null,
    spawnError: null
  }
  const listeners = new Set()
  const child = spawn(ffmpegPath, commandArgs, { stdio: ['pipe', 'pipe', 'pipe'] })
  run.children.add(child)
  child.stdin.on('error', () => {})
  let pending = null
  let previous = null
  child.stdout.on('data', (chunk) => {
    pending = pending ? Buffer.concat([pending, chunk]) : chunk
    while (pending.length >= frameBytes) {
      const frame = new Uint8Array(pending.subarray(0, frameBytes))
      pending = pending.subarray(frameBytes)
      const arrival = Date.now()
      const index = reader.features.length
      const feature = { index, ...analyzeFrame(frame, previous) }
      previous = frame
      reader.features.push(feature)
      reader.arrivalMs.push(arrival)
      if (index % budget.fps === 0 && reader.snapshots.length < 40) {
        reader.snapshots.push({ index, frame })
      }
      for (const listener of listeners) listener(feature, arrival)
    }
    if (pending.length === 0) pending = null
  })
  let stderrBuffer = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text) => {
    stderrBuffer += text
    for (let newline = stderrBuffer.search(/[\r\n]/); newline >= 0; ) {
      const line = stderrBuffer.slice(0, newline)
      stderrBuffer = stderrBuffer.slice(newline + 1)
      newline = stderrBuffer.search(/[\r\n]/)
      if (!line.trim()) continue
      const info = parseShowinfoLine(line)
      if (info) {
        reader.ptsMs[info.n] = info.ptsMs
        continue
      }
      if (/Parsed_showinfo/.test(line)) continue
      if (reader.stderrText.length < 64_000) reader.stderrText += `${line}\n`
      reader.stderrTail.push(line)
      if (reader.stderrTail.length > 40) reader.stderrTail.shift()
    }
  })
  reader.done = new Promise((resolveDone) => {
    child.on('error', (error) => {
      reader.spawnError = error.message
    })
    child.on('close', (code, signal) => {
      reader.exited = { code, signal, at: Date.now() }
      run.children.delete(child)
      for (const listener of [...listeners]) listener(null, Date.now())
      resolveDone(reader.exited)
    })
  })
  reader.waitFor = (predicate, limitMs) =>
    new Promise((resolveWait) => {
      const existing = reader.features.find(predicate)
      if (existing) {
        resolveWait({ feature: existing, arrival: reader.arrivalMs[existing.index] })
        return
      }
      if (reader.exited) {
        resolveWait(null)
        return
      }
      const listener = (feature, arrival) => {
        if (feature && !predicate(feature)) return
        clearTimeout(timer)
        listeners.delete(listener)
        resolveWait(feature ? { feature, arrival } : null)
      }
      const timer = setTimeout(() => {
        listeners.delete(listener)
        resolveWait(null)
      }, limitMs)
      listeners.add(listener)
    })
  reader.stop = async () => {
    if (!reader.exited) {
      try {
        child.stdin.end('q')
      } catch {
        // FFmpeg already closed its stdin.
      }
      if (!(await settledWithin(reader.done, 3000))) {
        child.kill('SIGTERM')
        if (!(await settledWithin(reader.done, 2000))) {
          child.kill('SIGKILL')
          await settledWithin(reader.done, 2000)
        }
      }
    }
    run.readers.delete(reader)
    return reader.exited
  }
  run.readers.add(reader)
  return reader
}

function readerFailure(reader) {
  if (reader.spawnError) return `the reader did not start: ${reader.spawnError}`
  const tail = reader.stderrTail.slice(-3).join(' | ')
  return `no frame within ${Math.round(budget.wakeMs / 1000)} s of opening the camera${tail ? ` (FFmpeg: ${tail})` : ''}`
}

function saveSnapshots(reader, label, limit = 12) {
  const directory = join(outputDirectory, 'frames')
  mkdirSync(directory, { recursive: true })
  return reader.snapshots.slice(0, limit).map((snapshot) => {
    const path = join(directory, `${label}-${String(snapshot.index).padStart(4, '0')}.png`)
    writeFileSync(
      path,
      encodePngRgb({ width: ANALYSIS_WIDTH, height: ANALYSIS_HEIGHT, data: snapshot.frame })
    )
    return path
  })
}

// ---------------------------------------------------------------------------
// The camera from the outside

let readerFfmpeg = null
let plan = null

async function listCamera(label) {
  const result = await runProcess(readerFfmpeg, plan.listArgs)
  const listing = cameraListing(platform, `${result.stderr}\n${result.stdout}`)
  log(
    `${label}: "${plan.device}" ${listing.listed ? `listed${listing.count > 1 ? ` ${listing.count} times` : ''}` : 'not listed'}`
  )
  return { label, ...listing, error: result.error }
}

/** Waits for the listing to say `listed` (a registration can lag the status). */
async function listCameraUntil(label, listed) {
  const deadline = Date.now() + budget.presenceSettleMs
  let listing = await listCamera(label)
  while (listing.listed !== listed && Date.now() < deadline) {
    await sleep(500)
    listing = await listCamera(label)
  }
  return listing
}

/** A short read for the off still: frames, the marker summary, a denied grant. */
async function readFor(label, durationMs) {
  const reader = startFrameReader({ label, ffmpegPath: readerFfmpeg, inputArgs: plan.inputArgs })
  const first = await reader.waitFor(() => true, budget.wakeMs)
  if (first) await sleep(durationMs)
  await reader.stop()
  const stills = saveSnapshots(reader, label, 2)
  return {
    summary: markerSummary(reader.features),
    accessDenied: cameraAccessDenied(platform, reader.stderrText, { terminal: terminalName }),
    error: first ? null : readerFailure(reader),
    stills
  }
}

async function cameraStatus() {
  return rpc('virtualCamera.status', {})
}

/** `virtualCamera.set {on:true}` until ready or streaming, or a state that won't change. */
async function waitForCameraStart() {
  const startedAt = Date.now()
  let status = null
  let skipStateSince = null
  while (Date.now() - startedAt < budget.readyTimeoutMs) {
    status = await cameraStatus()
    if (status?.state === 'ready' || status?.state === 'streaming') break
    if (status?.platformStep === 'unsupported') break
    if (status?.state === 'unavailable' && status?.available === false) break
    if (status?.state === 'needs-approval' || status?.state === 'needs-setup') {
      skipStateSince ??= Date.now()
      if (Date.now() - skipStateSince >= 3000) break
    } else {
      skipStateSince = null
    }
    await sleep(250)
  }
  return { status, waitedMs: Date.now() - startedAt }
}

async function turnCameraOff(limitMs = 10_000) {
  await rpc('virtualCamera.set', { on: false })
  const startedAt = Date.now()
  let status = null
  while (Date.now() - startedAt < limitMs) {
    status = await cameraStatus()
    if (status?.on === false) {
      run.cameraTurnedOn = false
      return status
    }
    await sleep(200)
  }
  throw new Error(`Videorc Camera still reports on ${limitMs} ms after the switch went off`)
}

async function framePipeline() {
  try {
    return (await rpc('compositor.status', {}))?.framePipeline ?? {}
  } catch (error) {
    return { error: error.message }
  }
}

async function selfListingAt(phase) {
  try {
    const offenders = selfListedCameras(await rpc('devices.list', {}))
    return { phase, offenders: offenders.map((device) => `${device.name} (${device.id})`) }
  } catch (error) {
    return { phase, error: error.message, offenders: [] }
  }
}

// ---------------------------------------------------------------------------
// The scene: capture source, bundled background, marker banners

async function findCaptureSource() {
  const deadline = Date.now() + 15_000
  for (;;) {
    const devices = (await rpc('devices.list', {}))?.devices ?? []
    const grantMissing = devices.find(
      (device) =>
        (device.kind === 'screen' || device.kind === 'window') &&
        device.status === 'permission-required'
    )
    const wanted = run.fixture
      ? devices.find((device) => device.kind === 'window' && device.id === run.fixture.windowId)
      : devices.find((device) => device.kind === 'screen' && device.status === 'available')
    if (wanted?.status === 'available') return wanted
    if (grantMissing && (!wanted || wanted.status === 'permission-required')) {
      const where =
        platform === 'darwin'
          ? 'grant Videorc in System Settings > Privacy & Security > Screen & System Audio Recording'
          : 'allow screen capture for Videorc'
      skipRun(
        `Videorc has no screen capture grant (${grantMissing.detail ?? grantMissing.id}); the scene and Hide screen need a capture source: ${where}, then run again`
      )
    }
    if (Date.now() > deadline) {
      failRun(
        run.fixture
          ? `Fixture Alpha's window ${run.fixture.windowId} is ${wanted?.status ?? 'not listed'} in devices.list`
          : 'devices.list has no available display'
      )
    }
    await sleep(500)
  }
}

/** One MCP tools/call to the Agents listener, waiting out its rate limit. */
async function callAgentTool(port, token, name, toolArgs) {
  for (let attempt = 1; ; attempt += 1) {
    const response = await postMcp({
      port,
      token,
      body: {
        jsonrpc: '2.0',
        id: attempt,
        method: 'tools/call',
        params: { name, arguments: toolArgs }
      },
      timeoutMs: 30_000
    })
    if (response.status !== 200) {
      throw new Error(`${name}: the Agents listener answered HTTP ${response.status}`)
    }
    const dataLine = response.body
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .at(-1)
    const message = JSON.parse(dataLine ? dataLine.slice(5) : response.body)
    if (message.error)
      throw new Error(`${name}: ${message.error.message ?? JSON.stringify(message.error)}`)
    const text = resultText(message.result)
    if (message.result?.isError && text.startsWith('Slow down:') && attempt < 10) {
      await sleep(1000)
      continue
    }
    if (message.result?.isError) throw new Error(`${name} was refused: ${text}`)
    return message.result
  }
}

/** The four marker banners, imported through Agents (edit_banner) and placed in the ring. */
async function importMarkerBanners() {
  const enabled = await rpc('agents.enable', {})
  run.agentsEnabled = true
  if (!enabled?.enabled || !enabled.port)
    failRun(`agents.enable answered ${JSON.stringify(enabled)}`)
  const created = await rpc('agents.create', { name: 'Videorc Camera smoke', client: 'other' })
  run.agentId = created?.agent?.id ?? null
  if (!created?.token) failRun('agents.create returned no token')
  const directory = join(outputDirectory, 'marker')
  mkdirSync(directory, { recursive: true })
  const ids = []
  for (const [index, cell] of MARKER_CELLS.entries()) {
    const label = cell.role === 'finder' ? 'finder' : `bit ${cell.bit}`
    const path = join(directory, `marker-${index}-${cell.role}${cell.bit ?? ''}.png`)
    writeFileSync(path, encodePngRgb(codeBannerRgb(index)))
    const result = await callAgentTool(enabled.port, created.token, 'edit_banner', {
      path,
      name: `Camera smoke ${label}`
    })
    const banner = result.structuredContent?.banner
    if (!banner?.id) failRun(`edit_banner imported no banner: ${JSON.stringify(result)}`)
    await rpc('banners.update', markerBannerUpdate(banner.id, cell))
    ids.push(banner.id)
  }
  if (run.agentId) await rpc('agents.remove', { id: run.agentId })
  run.agentId = null
  await rpc('agents.disable', {})
  run.agentsEnabled = false
  return ids
}

/** The corner code: one bit banner toggles each second (Gray code, so one change per step). */
function startCodeTicker(bannerIds) {
  const ticker = { log: [], stopped: false, step: 0 }
  const startedAt = Date.now()
  let timer = null
  let inFlight = Promise.resolve()
  const tick = () => {
    if (ticker.stopped) return
    ticker.step += 1
    const step = ticker.step
    const { bit, shown } = codeStep(step)
    const at = Date.now()
    inFlight = rpc(shown ? 'banners.show' : 'banners.hide', { id: bannerIds[bit + 1] }, 5000)
      .then(() => ticker.log.push({ step, bit, shown, at, ms: Date.now() - at }))
      .catch((error) => ticker.log.push({ step, bit, shown, at, error: error.message }))
    timer = setTimeout(tick, Math.max(0, startedAt + (step + 1) * 1000 - Date.now()))
  }
  timer = setTimeout(tick, 1000)
  ticker.stop = async () => {
    ticker.stopped = true
    clearTimeout(timer)
    await inFlight
  }
  return ticker
}

function sessionParams(source, background) {
  const transform = {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    cropLeft: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0
  }
  const kind = source.kind === 'window' ? 'window' : 'screen'
  const { width, height, fps } = VIRTUAL_CAMERA
  return {
    sources:
      kind === 'window'
        ? { windowId: source.id, testPattern: false }
        : { screenId: source.id, testPattern: false },
    layout: {
      layoutPreset: 'screen-only',
      cameraTransformMode: 'preset',
      cameraTransform: null,
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rectangle',
      cameraMargin: 32,
      cameraFit: 'fill',
      cameraMirror: false,
      cameraZoom: 100,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      sideBySideSplit: '70-30',
      sideBySideCameraSide: 'right'
    },
    output: {
      recordEnabled: true,
      streamEnabled: false,
      video: { preset: 'custom', width, height, fps, bitrateKbps: 8000 },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    },
    scene: {
      id: 'scene:virtual-camera-smoke',
      name: 'Videorc Camera smoke',
      sources: [
        {
          id: 'source:capture',
          name: source.name,
          kind,
          deviceId: source.id,
          transform,
          defaultTransform: transform,
          visible: true,
          locked: false
        }
      ],
      outputs: [],
      background
    }
  }
}

async function waitForRecordingFile(sessionId, stopped) {
  const direct = stopped?.outputPath
  if (typeof direct === 'string' && /\.mp4$/i.test(direct) && existsSync(direct)) return direct
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const finalized = events.find(
      (record) =>
        record.event === 'recording.finalization' &&
        record.payload?.sessionId === sessionId &&
        (record.payload?.state === 'finalized' || record.payload?.state === 'failed')
    )
    if (finalized?.payload.state === 'failed') {
      throw new Error(`finalization failed: ${finalized.payload.error ?? 'no reason given'}`)
    }
    if (finalized?.payload.mp4Path) return finalized.payload.mp4Path
    const page = await rpc('sessions.list', { limit: 20 }).catch(() => null)
    const item = page?.items?.find((entry) => entry.id === sessionId)
    if (item?.mp4Path && existsSync(item.mp4Path)) return item.mp4Path
    if (item?.finalizationState === 'failed') throw new Error('finalization failed')
    await sleep(500)
  }
  return null
}

// ---------------------------------------------------------------------------
// The run

async function main() {
  assertPackagedSmokePlatform(platform)
  if (!appArgument) {
    failRun(
      'pass the packaged app: pnpm smoke:virtual-camera -- <Videorc.exe | videorc> (macOS defaults to /Applications/Videorc.app)'
    )
  }
  const appExecutable = packagedExecutable(appArgument)
  if (!existsSync(appExecutable)) failRun(`no packaged app at ${appExecutable}`)
  if (platform === 'darwin' && !resolve(appArgument).startsWith('/Applications/')) {
    log(
      `note: ${appArgument} is outside /Applications; macOS activates the camera extension only from there`
    )
  }
  mkdirSync(outputDirectory, { recursive: true })
  if (isLinuxAppImageExecutable(appExecutable) && !process.env.VIDEORC_SMOKE_FFMPEG_PATH) {
    failRun(
      'an AppImage mounts its payload privately; pass VIDEORC_SMOKE_FFMPEG_PATH (the pinned vendor/ffmpeg/linux-x64/bin/ffmpeg), or smoke the linux-unpacked dir'
    )
  }
  const bundledFfmpeg = bundledFfmpegPathForPackagedApp({ appExecutable, platform })
  const ffmpegPath =
    process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? (existsSync(bundledFfmpeg) ? bundledFfmpeg : null)
  if (!ffmpegPath) failRun(`the packaged app has no bundled FFmpeg at ${bundledFfmpeg}`)
  const ffprobePath =
    process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? resolveExistingSiblingFfprobe(ffmpegPath) ?? 'ffprobe'
  readerFfmpeg = process.env.VIDEORC_VIRTUAL_CAMERA_READER_FFMPEG ?? ffmpegPath
  plan = cameraReaderPlan(platform)
  Object.assign(report, { appExecutable, ffmpegPath, ffprobePath, readerFfmpeg, reader: plan })

  const formats = await runProcess(readerFfmpeg, ['-hide_banner', '-devices'])
  // `ffmpeg -devices` rows: " D  avfoundation", " D  dshow", " DE video4linux2,v4l2".
  const inputRow = new RegExp(`^\\s*D\\S*\\s+(?:\\S+,)?${plan.format}\\b`, 'm')
  if (!inputRow.test(formats.stdout + formats.stderr)) {
    failRun(
      `the reader ${readerFfmpeg} has no ${plan.format} input${formats.error ? ` (${formats.error})` : ''}; point VIDEORC_VIRTUAL_CAMERA_READER_FFMPEG at an FFmpeg with it`
    )
  }

  // 1. The capture source with sharp, moving content (macOS).
  if (platform === 'darwin') {
    const fixtures = buildFixtureApps({ outputDir: join(tmpdir(), 'videorc-fixture-apps') })
    run.fixture = await launchFixtureApp(fixtures.apps.alpha, {
      x: 80,
      y: 80,
      width: 1280,
      height: 720
    })
    log(`Fixture Alpha up: pid ${run.fixture.pid}, ${run.fixture.windowId}`)
  }

  // 2. The packaged app in its own profile.
  run.profileDirectory = mkdtempSync(join(tmpdir(), 'videorc-virtual-camera-profile-'))
  const capability = randomBytes(32).toString('base64url')
  run.launch = await launchDevApp({
    spawnSpec: { command: appExecutable, args: [] },
    launchViaMacosLaunchServices: platform === 'darwin',
    packagedSmokeCommandCapability: capability,
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_PACKAGED_SMOKE_TEST: '1',
      VIDEORC_SMOKE_COMMAND_CAPABILITY: capability,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
      VIDEORC_SMOKE_STATE_DIR: run.profileDirectory,
      VIDEORC_APP_DATA_DIR: join(run.profileDirectory, 'app-data'),
      VIDEORC_USER_DATA_DIR: join(run.profileDirectory, 'user-data')
    },
    timeoutMs: Math.max(timeoutMs, 120_000),
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1') console.log(line)
    }
  })
  run.renderer = await connectBackend(run.launch.connections['backend-ready'], timeoutMs)
  run.smoke = run.launch.connections['preview-motion-ready']
  events = new EventLog(run.renderer)
  const health = await rpc('health.ping', {})
  if (health?.ffmpeg && health.ffmpeg.available === false) {
    failRun(`the app's FFmpeg is unavailable: ${health.ffmpeg.message ?? ''}`)
  }
  log(`packaged app up from ${appExecutable}`)

  // 3. The scene.
  const source = await findCaptureSource()
  report.captureSource = { id: source.id, kind: source.kind, name: source.name }
  const bundled = await requestSmokeCommand(
    run.smoke,
    'inspect-packaged-bundled-background',
    {},
    {
      timeoutMs: 30_000
    }
  )
  if (!bundled?.id || !bundled.managedAssetPath) {
    failRun(`inspect-packaged-bundled-background answered ${JSON.stringify(bundled)}`)
  }
  const background = smokeSceneBackground(bundled)
  report.background = { id: bundled.id, name: bundled.name }
  const bannerIds = await importMarkerBanners()
  run.bannersShown = true
  for (const id of bannerIds) await rpc('banners.show', { id })
  await sleep(1000)
  for (const id of bannerIds.slice(1)) await rpc('banners.hide', { id })
  await rpc('banners.show', { id: bannerIds[0] })
  run.ticker = startCodeTicker(bannerIds)
  log(
    `scene ready: ${source.kind} "${source.name}", background "${bundled.name}", marker banners ticking`
  )

  // 4. Off: presence and the backend's own camera list.
  const selfListing = [await selfListingAt('before the switch went on')]
  const initial = await cameraStatus()
  report.steps.initialStatus = initial
  if (initial?.on) {
    log('note: the fresh profile started with the switch on; turning it off first')
    run.cameraTurnedOn = true
    await turnCameraOff()
  }
  const listingBefore = await listCamera('off')
  let readBefore = null
  if (platform === 'darwin' && listingBefore.listed) {
    readBefore = await readFor('off-before', budget.offReadMs)
    if (readBefore.accessDenied) skipRun(readBefore.accessDenied)
  }
  report.steps.before = { listing: listingBefore, read: readBefore }

  // 5. On.
  report.timeline.onRequestedAt = Date.now()
  run.cameraTurnedOn = true
  const setAnswer = await rpc('virtualCamera.set', { on: true })
  const waited = await waitForCameraStart()
  const listingOn = await listCameraUntil('on', true)
  const start = classifyCameraStart({
    status: waited.status,
    listed: listingOn.listed,
    waitedMs: waited.waitedMs,
    platform
  })
  report.steps.on = { setAnswer, ...waited, listing: listingOn, start }
  log(
    `switch on: state ${waited.status?.state}${waited.status?.platformStep ? ` (${waited.status.platformStep})` : ''} after ${waited.waitedMs} ms`
  )
  if (start.action === 'skip') skipRun(start.reason)
  if (start.action === 'fail') failRun(start.reason)
  if (start.note) log(`note: ${start.note}; reading anyway, which must fail`)

  // 6. The read, with Record, Hide screen, Show and Stop scheduled inside it.
  const countersBefore = await framePipeline()
  const reader = startFrameReader({
    label: 'on',
    ffmpegPath: readerFfmpeg,
    inputArgs: plan.inputArgs
  })
  report.timeline.readOpenedAt = Date.now()
  const firstMarker = await reader.waitFor((feature) => feature.finder, budget.wakeMs)
  if (!firstMarker) {
    await reader.stop()
    const stills = saveSnapshots(reader, 'on', 3)
    const read = classifyCameraRead({
      summary: markerSummary(reader.features),
      start,
      accessDenied: cameraAccessDenied(platform, reader.stderrText, { terminal: terminalName }),
      readerError: reader.features.length ? null : readerFailure(reader)
    })
    report.steps.read = { ...read, frames: reader.features.length, stills }
    if (read.kind === 'skip') skipRun(read.reason)
    failRun(read.reason)
  }
  const timeline = report.timeline
  timeline.programAt = firstMarker.arrival
  log(`program on the camera ${timeline.programAt - timeline.readOpenedAt} ms after opening it`)

  await sleepUntil(timeline.programAt + schedule.recordAfterProgramMs)
  timeline.recordRequestedAt = Date.now()
  let started = null
  let startError = null
  try {
    started = await rpc('session.start', sessionParams(source, background), 90_000)
    run.sessionActive = true
    if (started?.state !== 'recording') {
      startError = `session.start answered state ${started?.state}: ${started?.message ?? ''}`
    }
  } catch (error) {
    startError = `session.start failed: ${error.message}`
  }
  timeline.recordAnsweredAt = Date.now()

  await sleepUntil(timeline.recordAnsweredAt + schedule.hideAfterRecordingMs)
  timeline.hideAt = Date.now()
  const privacyErrors = []
  try {
    const privacy = await rpc('screen.hide', { reason: 'you' })
    run.screenHidden = true
    if (!privacy?.hidden) privacyErrors.push(`screen.hide answered ${JSON.stringify(privacy)}`)
  } catch (error) {
    privacyErrors.push(`screen.hide failed: ${error.message}`)
  }
  await sleepUntil(timeline.hideAt + schedule.showAfterHideMs)
  timeline.showAt = Date.now()
  try {
    await rpc('screen.show', {})
    run.screenHidden = false
  } catch (error) {
    privacyErrors.push(`screen.show failed: ${error.message}`)
  }
  selfListing.push(await selfListingAt('while the switch is on'))
  report.steps.statusDuringRead = await cameraStatus().catch((error) => ({ error: error.message }))

  await sleepUntil(timeline.showAt + schedule.stopAfterShowMs)
  timeline.stopRequestedAt = Date.now()
  let stopped = null
  let stopError = null
  if (run.sessionActive) {
    try {
      stopped = await rpc('session.stop', {}, 90_000)
      run.sessionActive = false
    } catch (error) {
      stopError = `session.stop failed: ${error.message}`
    }
  }
  timeline.stopAnsweredAt = Date.now()
  timeline.readUntil = Math.max(
    timeline.programAt + budget.judgedReadMs,
    timeline.stopAnsweredAt + schedule.tailAfterStopMs
  )
  await sleepUntil(timeline.readUntil)
  const countersAfter = await framePipeline()
  await reader.stop()
  timeline.readStoppedAt = Date.now()
  await run.ticker.stop()
  report.steps.ticker = {
    steps: run.ticker.log.length,
    errors: run.ticker.log.filter((e) => e.error)
  }
  const onStills = saveSnapshots(reader, 'on', 14)
  log(
    `read ${reader.features.length} frame(s) over ${timeline.readStoppedAt - timeline.readOpenedAt} ms`
  )

  // 7. Off again.
  timeline.offRequestedAt = Date.now()
  await turnCameraOff()
  await sleep(budget.presenceSettleMs)
  const listingAfter = await listCameraUntil('off again', platform === 'darwin')
  const readAfter =
    platform === 'darwin' && listingAfter.listed
      ? await readFor('off-after', budget.offReadMs)
      : null
  selfListing.push(await selfListingAt('after the switch went off'))
  report.steps.after = { listing: listingAfter, read: readAfter }

  // 8. The recording.
  let recordingPath = null
  let recordingError = null
  if (started?.sessionId && !startError) {
    try {
      recordingPath = await waitForRecordingFile(started.sessionId, stopped)
      if (!recordingPath) recordingError = 'no finished recording within 60 s of Stop'
    } catch (error) {
      recordingError = error.message
    }
  }
  let recordingTrack = []
  let quality = null
  let qualityReportPath = null
  if (recordingPath) {
    const decoder = startFrameReader({
      label: 'recording',
      ffmpegPath,
      inputArgs: ['-i', recordingPath]
    })
    await decoder.done
    run.readers.delete(decoder)
    const recordingStatus = events.find(
      (record) =>
        record.event === 'recording.status' &&
        record.payload?.sessionId === started.sessionId &&
        record.payload?.state === 'recording'
    )
    const epoch = recordingStatus?.at ?? timeline.recordAnsweredAt
    const pts = decoder.ptsMs.slice(0, decoder.features.length)
    const usable = ptsUsable(pts)
    recordingTrack = decoder.features.map((feature) => ({
      tMs: epoch + (usable ? pts[feature.index] - pts[0] : (feature.index * 1000) / budget.fps),
      code: feature.code,
      ringRgb: feature.ringRgb
    }))
    report.steps.recording = {
      path: recordingPath,
      frames: decoder.features.length,
      epochFrom: recordingStatus ? 'recording.status' : 'session.start answer',
      ...markerSummary(decoder.features)
    }
    quality = await analyzeRecording(recordingPath, {
      ffmpegPath,
      ffprobePath,
      intendedFps: VIRTUAL_CAMERA.fps,
      expectAudio: false,
      gates: { requireMotion: false }
    })
    qualityReportPath = writeReports(quality, { outDir: join(outputDirectory, 'reports') })?.mdPath
  }

  // 9. The verdicts.
  const assertions = report.assertions
  const phases = [
    [
      'before the switch went on',
      presenceVerdict({ platform, phase: 'off', listing: listingBefore, read: readBefore?.summary })
    ],
    ['while the switch is on', presenceVerdict({ platform, phase: 'on', listing: listingOn })],
    [
      'after the switch went off',
      presenceVerdict({ platform, phase: 'off', listing: listingAfter, read: readAfter?.summary })
    ]
  ]
  assertions.presence = {
    ok: phases.every(([, verdict]) => verdict.ok),
    failures: phases.flatMap(([label, verdict]) => verdict.failures.map((f) => `${label}: ${f}`)),
    phases: Object.fromEntries(phases)
  }

  const cameraPts = reader.ptsMs.slice(0, reader.features.length)
  const usePts = ptsUsable(cameraPts)
  const offsetMs = usePts ? wallOffsetMs(cameraPts, reader.arrivalMs) : 0
  const cameraTimes = reader.features.map((feature) =>
    usePts ? cameraPts[feature.index] + offsetMs : reader.arrivalMs[feature.index]
  )
  const judged = { fromMs: timeline.programAt, toMs: timeline.readUntil }
  const windows = [
    {
      label: 'Record',
      fromMs: timeline.recordRequestedAt - budget.transitionLeadMs,
      toMs: timeline.recordAnsweredAt + budget.transitionTailMs
    },
    {
      label: 'Stop',
      fromMs: timeline.stopRequestedAt - budget.transitionLeadMs,
      toMs: timeline.stopAnsweredAt + budget.transitionTailMs
    }
  ]
  const cadence = cadenceVerdict({ timesMs: cameraTimes, judged, windows })
  const windowFailures = cadence.failures.filter((failure) =>
    windows.some((window) => failure.startsWith(`${window.label}:`))
  )
  assertions.cadence = {
    ok: !cadence.failures.some((failure) => !windowFailures.includes(failure)),
    failures: cadence.failures.filter((failure) => !windowFailures.includes(failure)),
    clock: usePts ? 'pts' : 'arrival',
    ...cadence.overall
  }

  const read = classifyCameraRead({ summary: markerSummary(reader.features), start })
  report.steps.read = { ...read, ...markerSummary(reader.features), stills: onStills }
  const content = recordingTrack.length
    ? matchCodeTracks({
        camera: reader.features.map((feature) => ({
          tMs: cameraTimes[feature.index],
          code: feature.code,
          ringRgb: feature.ringRgb
        })),
        recording: recordingTrack
      })
    : { ok: false, failures: [recordingError ?? startError ?? 'no recording to compare with'] }
  assertions.content = {
    ...content,
    ok: read.kind === 'program' && content.ok,
    failures: [...(read.kind === 'program' ? [] : [read.reason]), ...content.failures]
  }

  const hide = cameraHideVerdict({
    features: reader.features,
    ptsMs: usePts ? cameraPts : reader.arrivalMs,
    offsetMs: usePts ? offsetMs : 0,
    hideAtMs: timeline.hideAt,
    showAtMs: timeline.showAt,
    untilMs: timeline.stopRequestedAt,
    requireMotion: Boolean(run.fixture)
  })
  assertions['hide-screen'] = {
    ...hide,
    ok: hide.ok && privacyErrors.length === 0,
    failures: [...privacyErrors, ...hide.failures]
  }

  const selfFailures = selfListing.flatMap((entry) => [
    ...(entry.error ? [`devices.list failed ${entry.phase}: ${entry.error}`] : []),
    ...(entry.offenders.length
      ? [`devices.list offers ${entry.offenders.join(', ')} as a camera ${entry.phase}`]
      : [])
  ])
  assertions['no-self-listing'] = {
    ok: selfFailures.length === 0,
    failures: selfFailures,
    phases: selfListing
  }

  const recordFailures = [...windowFailures]
  if (startError) recordFailures.push(startError)
  if (stopError) recordFailures.push(stopError)
  if (!startError && recordingError) recordFailures.push(recordingError)
  if (quality) {
    if (!quality.verdict.pass) {
      recordFailures.push(
        `the recording failed the analyzer: ${quality.verdict.failures.join('; ')} (report: ${qualityReportPath})`
      )
    }
    const { width, height, durationSeconds } = quality.metrics ?? {}
    if (width !== VIRTUAL_CAMERA.width || height !== VIRTUAL_CAMERA.height) {
      recordFailures.push(
        `the recording is ${width}x${height}, not ${VIRTUAL_CAMERA.width}x${VIRTUAL_CAMERA.height}`
      )
    }
    recordFailures.push(
      ...evaluateRecordingWallDuration({
        expectedDurationMs: timeline.stopRequestedAt - timeline.recordAnsweredAt,
        actualDurationSeconds: durationSeconds
      })
    )
  }
  assertions['record-stop'] = {
    ok: recordFailures.length === 0,
    failures: recordFailures,
    windows: cadence.windows,
    recording: recordingPath,
    analyzerReport: qualityReportPath
  }

  assertions.counters = {
    ...counterVerdict({ platform, before: countersBefore, after: countersAfter }),
    before: countersBefore,
    after: countersAfter
  }

  report.tracks = {
    camera: reader.features.map((feature) => [
      Math.round(cameraTimes[feature.index] - timeline.programAt),
      feature.code,
      feature.sharp
    ]),
    recording: recordingTrack.map((frame) => [
      Math.round(frame.tMs - timeline.programAt),
      frame.code
    ])
  }
}

// ---------------------------------------------------------------------------
// Cleanup and the verdict

async function cleanup() {
  const problems = []
  const attempt = async (label, action) => {
    try {
      await action()
    } catch (error) {
      problems.push(`${label}: ${error.message}`)
    }
  }
  if (run.ticker) await run.ticker.stop().catch(() => {})
  for (const reader of [...run.readers]) await reader.stop().catch(() => {})
  if (run.renderer?.readyState === WebSocket.OPEN) {
    if (run.screenHidden) {
      await attempt('Show', async () => {
        await rpc('screen.show', {}, 10_000)
        run.screenHidden = false
      })
    }
    if (run.sessionActive) {
      await attempt('stopping the recording', async () => {
        await rpc('session.stop', {}, 90_000)
        run.sessionActive = false
      })
    }
    if (run.cameraTurnedOn) await attempt('turning Videorc Camera off', () => turnCameraOff())
    if (run.bannersShown) await attempt('hiding the banners', () => rpc('banners.hide', {}, 10_000))
    if (run.agentsEnabled) {
      await attempt('turning Agents off', async () => {
        if (run.agentId) await rpc('agents.remove', { id: run.agentId }, 10_000)
        await rpc('agents.disable', {}, 10_000)
      })
    }
  } else if (run.cameraTurnedOn) {
    problems.push('the backend socket closed before Videorc Camera could be switched off')
  }
  try {
    run.renderer?.close()
  } catch {
    // Already closed.
  }
  if (run.launch) await attempt('quitting Videorc', () => run.launch.stop())
  if (run.fixture) await attempt('stopping Fixture Alpha', () => stopFixtureApp(run.fixture))
  for (const child of [...run.children]) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  if (run.profileDirectory) {
    await attempt(`removing the profile ${run.profileDirectory}`, async () =>
      rmSync(run.profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    )
  }
  return problems
}

let finishing = null

function finish(outcome) {
  finishing ??= (async () => {
    const problems = await cleanup()
    report.cleanup = problems
    report.events = events?.records ?? []
    const cleanupFailure = problems.length ? `cleanup: ${problems.join('; ')}` : null
    let verdict
    if (outcome.kind === 'skip' && !cleanupFailure) {
      verdict = smokeVerdict({ skip: outcome.reason })
    } else {
      const fatal = [outcome.kind === 'fail' ? outcome.reason : null, cleanupFailure]
        .filter(Boolean)
        .join('; ')
      verdict = smokeVerdict({ fatal: fatal || null, assertions: report.assertions })
    }
    report.verdict = verdict
    report.finishedAt = new Date().toISOString()
    mkdirSync(outputDirectory, { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    printSummary(verdict)
    return verdict.result === 'FAIL' ? 1 : 0
  })()
  return finishing
}

function printSummary(verdict) {
  console.log('')
  if (verdict.result === 'SKIP') {
    console.log(`SKIP smoke:virtual-camera: ${verdict.reason}`)
  } else {
    for (const { id, rule } of VIRTUAL_CAMERA_SMOKE_ASSERTIONS) {
      const assertion = report.assertions[id]
      const state = !assertion ? 'not judged' : assertion.ok ? 'PASS' : 'FAIL'
      console.log(`  ${state.padEnd(10)} ${id}: ${rule}`)
      for (const failure of assertion?.failures ?? []) console.log(`             - ${failure}`)
    }
    console.log(
      verdict.result === 'PASS'
        ? 'PASS smoke:virtual-camera'
        : `FAIL smoke:virtual-camera: ${verdict.reason}`
    )
  }
  console.log(`report: ${reportPath}`)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    log(`${signal}: cleaning up`)
    finish({ kind: 'fail', reason: `interrupted by ${signal}` }).then(() => process.exit(130))
  })
}

let outcome = { kind: 'done' }
try {
  await main()
} catch (error) {
  if (error instanceof SmokeStop) outcome = { kind: error.kind, reason: error.message }
  else {
    debug(error.stack ?? String(error))
    outcome = { kind: 'fail', reason: error.message ?? String(error) }
  }
}
process.exitCode = await finish(outcome)
