import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { performanceAppSpawnSpec, launchDevApp } from './lib/app-launcher.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { evaluateRecordingWallDuration } from './lib/recording-duration-gate.mjs'
import {
  collectPerformanceMetadata,
  createPerformanceReport,
  failingChecks,
  passingCheck,
  performanceMode,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import { collectWindowsProcessTreeTelemetry } from './lib/process-endurance.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  evaluateWindowsPerformanceBudget,
  loadWindowsPerformanceBudget
} from './lib/windows-performance-budget.mjs'
import {
  assertBmpHeaders,
  assertNonblankBmp,
  nativeWindowsCompositorUsesScreen,
  nativeWindowsScreenCandidates,
  nativeWindowsScreenRecordingActive
} from './lib/windows-native-screen-gates.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

if (process.platform !== 'win32') {
  throw new Error('The native Windows screen/BMP smoke must run on Windows.')
}

const performanceModeValue = performanceMode()

const repoRoot = resolve(import.meta.dirname, '..')
const spawnSpec = performanceAppSpawnSpec()
if (!spawnSpec) {
  throw new Error('Set VIDEORC_PERF_APP_EXECUTABLE to the packaged Videorc.exe.')
}

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-windows-native-screen-${Date.now()}`)
)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180_000)
const recordingMs = Number(process.env.VIDEORC_WINDOWS_NATIVE_SCREEN_RECORDING_MS ?? 6_000)
const performanceWarmupMs = Number(process.env.VIDEORC_PERF_WARMUP_MS ?? 0)
const performanceMeasurementMs = Number(
  process.env.VIDEORC_PERF_MEASUREMENT_MS ?? Math.max(1, recordingMs - performanceWarmupMs)
)
const performanceIntervalMs = Number(process.env.VIDEORC_PERF_SAMPLE_INTERVAL_MS ?? 1_000)
const performanceReportRequested = Boolean(process.env.VIDEORC_PERF_REPORT_PATH)
const measureOccludedAuxWindows = process.env.VIDEORC_PERF_OCCLUDED_AUX_WINDOWS === '1'
const performanceEvaluationRequested = performanceReportRequested || performanceModeValue === 'gate'
const video = {
  preset: 'custom',
  width: Number(process.env.VIDEORC_SMOKE_VIDEO_WIDTH ?? 1280),
  height: Number(process.env.VIDEORC_SMOKE_VIDEO_HEIGHT ?? 720),
  fps: Number(process.env.VIDEORC_SMOKE_VIDEO_FPS ?? 30),
  bitrateKbps: Number(process.env.VIDEORC_SMOKE_VIDEO_BITRATE_KBPS ?? 4_000)
}

mkdirSync(outputDirectory, { recursive: true })

const packagedSmokeCommandCapability = measureOccludedAuxWindows
  ? randomBytes(32).toString('base64url')
  : undefined
const launched = await launchDevApp({
  spawnSpec,
  timeoutMs,
  requiredMarkers: measureOccludedAuxWindows
    ? ['backend-ready', 'preview-motion-ready']
    : ['backend-ready'],
  packagedSmokeCommandCapability,
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_DISABLE_AUTO_PREVIEW: '1',
    ...(measureOccludedAuxWindows
      ? {
          VIDEORC_SMOKE_COMMAND_SERVER: '1',
          VIDEORC_PACKAGED_SMOKE_TEST: '1',
          VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCommandCapability
        }
      : {})
  }
})

let ws
let performanceTelemetry = null
let bmpEvidence = null
let recordingEvidence = null
let selectedScreen = null
let teardownEvidence = null
let occludedAuxWindowsEvidence = null
let collectorFailure = null
let collectorFailed = false
const collectorHardFailures = []
try {
  const connection = launched.connections['backend-ready']
  ws = await connectBackend(connection, timeoutMs)
  const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(health?.ffmpeg?.message ?? 'Bundled FFmpeg is unavailable.')
  }

  const deviceList = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const candidates = nativeWindowsScreenCandidates(deviceList?.devices ?? [])
  if (candidates.length === 0) {
    throw new Error(
      `No available Windows DXGI/gdigrab screen source. Devices: ${JSON.stringify(deviceList?.devices ?? [])}`
    )
  }
  const screen = await startAvailableWindowsScreenPreview(ws, candidates)
  selectedScreen = screen
  const sources = { screenId: screen.id, testPattern: false }
  console.log(`Windows native screen smoke selected ${screen.id}: ${screen.detail ?? screen.name}`)
  await waitForNativeScreenFrame(ws, screen.id)

  const firstBmp = await waitForNonblankBmpFrame(connection)

  const started = await request(ws, timeoutMs, 'session.start', screenOnlySessionParams(sources))
  if (started?.state !== 'recording') {
    throw new Error(`Expected ScreenOnly recording, got ${started?.state ?? 'no state'}.`)
  }
  const recordingStartedAt = Date.now()
  const activeRecording = await waitForActiveNativeScreenRecording(ws, screen.id)
  if (!nativeWindowsCompositorUsesScreen(activeRecording.compositor, screen.id)) {
    throw new Error(
      `Recording compositor did not retain selected native screen ${screen.id}: ${JSON.stringify(activeRecording)}`
    )
  }
  if (measureOccludedAuxWindows) {
    occludedAuxWindowsEvidence = await prepareOccludedAuxWindows(
      launched.connections['preview-motion-ready']
    )
  }

  const telemetryPromise = performanceEvaluationRequested
    ? collectWindowsProcessTreeTelemetry({
        rootPid: launched.process.pid,
        warmupMs: performanceWarmupMs,
        measurementMs: performanceMeasurementMs,
        intervalMs: performanceIntervalMs
      })
    : Promise.resolve(null)
  const [telemetryResult, bmpResult] = await Promise.allSettled([
    telemetryPromise,
    pollBmpDuringRecording(connection, firstBmp.cursor, recordingMs)
  ])
  if (telemetryResult.status === 'fulfilled') {
    performanceTelemetry = telemetryResult.value
  } else {
    if (!collectorFailed) collectorFailure = telemetryResult.reason
    collectorFailed = true
    collectorHardFailures.push(
      `Windows process telemetry collection failed: ${failureMessage(telemetryResult.reason)}`
    )
  }
  if (bmpResult.status === 'fulfilled') {
    bmpEvidence = bmpResult.value
  } else {
    if (!collectorFailed) collectorFailure = bmpResult.reason
    collectorFailed = true
    collectorHardFailures.push(`BMP proof polling failed: ${failureMessage(bmpResult.reason)}`)
  }
  if (collectorFailed && !performanceEvaluationRequested) throw collectorFailure
  const stopRequestedAt = Date.now()
  const stopped = await request(ws, timeoutMs, 'session.stop')
  const outputPath = stopped?.outputPath ?? started?.outputPath
  if (!outputPath || !existsSync(outputPath) || statSync(outputPath).size <= 0) {
    throw new Error(
      `Native ScreenOnly recording output is missing or empty: ${outputPath ?? 'none'}`
    )
  }

  const report = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: video.fps,
    expectAudio: false,
    gates: { requireMotion: false }
  })
  recordingEvidence = {
    outputPath,
    sizeBytes: statSync(outputPath).size,
    metrics: report.metrics,
    verdict: report.verdict
  }
  const reportPaths = writeReports(report)
  if (!report.verdict.pass) {
    throw new Error(
      `Native ScreenOnly recording quality failed: ${report.verdict.failures.join('; ')} (report: ${reportPaths.mdPath})`
    )
  }
  const durationFailures = evaluateRecordingWallDuration({
    expectedDurationMs: stopRequestedAt - recordingStartedAt,
    actualDurationSeconds: report.metrics.durationSeconds
  })
  if (durationFailures.length > 0) {
    throw new Error(`Native ScreenOnly duration failed: ${durationFailures.join('; ')}`)
  }
  assertNonblankRecordingFrame(outputPath)

  if (!collectorFailed) {
    console.log(
      `Windows native screen/BMP PASS: ${screen.id}, ${bmpEvidence.advancedFrames} BMP frame advances, ` +
        `${report.metrics.observedFrames ?? 'n/a'} recorded frames, ${report.metrics.durationSeconds.toFixed(2)}s, ` +
        `${outputPath} (report: ${reportPaths.mdPath})`
    )
  }
} finally {
  if (ws) {
    try {
      await request(ws, 10_000, 'preview.screen.stop')
    } catch {
      // Process teardown below is authoritative.
    }
    ws.close()
  }
  teardownEvidence = await launched.stop()
}

if (performanceEvaluationRequested) {
  const requiredRoles = [
    'backend',
    'electron-main',
    'electron-renderer',
    'electron-gpu',
    'ffmpeg',
    ...(measureOccludedAuxWindows
      ? ['electron-renderer-notes', 'electron-renderer-comments', 'electron-renderer-captions']
      : [])
  ]
  const telemetryFailures = requiredRoles.filter(
    (role) =>
      (performanceTelemetry?.memory?.summary?.roles?.[role]?.minMeasuredCount ?? 0) < 1 ||
      (performanceTelemetry?.cpu?.summary?.byRole?.[role]?.samples ?? 0) < 1
  )
  const hardFailures = [
    ...collectorHardFailures,
    ...(telemetryFailures.length > 0
      ? [`Windows process telemetry did not continuously identify: ${telemetryFailures.join(', ')}`]
      : []),
    ...(bmpEvidence?.advancedFrames > 0
      ? []
      : ['BMP proof polling did not observe frame progress']),
    ...(recordingEvidence?.verdict?.pass === true
      ? []
      : ['final recording media validity was missing'])
  ]
  const metadata = await collectPerformanceMetadata({ cwd: repoRoot })
  let activeBudget = null
  let budgetFailures = []
  if (performanceModeValue === 'gate') {
    try {
      activeBudget = await loadWindowsPerformanceBudget({
        path: process.env.VIDEORC_WINDOWS_PERF_BUDGET_PATH,
        profileId: process.env.VIDEORC_WINDOWS_PERF_BUDGET_PROFILE,
        context: {
          scenario: process.env.VIDEORC_PERF_SCENARIO ?? 'windows-proof-recording',
          hardwareClass: metadata.hardwareClass,
          profileClass: metadata.profileClass,
          buildMode: metadata.buildMode,
          operatingSystem: metadata.operatingSystem,
          timing: {
            warmupMs: performanceWarmupMs,
            measurementMs: performanceMeasurementMs,
            intervalMs: performanceIntervalMs
          }
        }
      })
      budgetFailures = evaluateWindowsPerformanceBudget(activeBudget.profile, {
        processTree: performanceTelemetry,
        bmp: bmpEvidence,
        recording: recordingEvidence,
        teardownClean: teardownEvidence?.state === 'terminated'
      })
    } catch (error) {
      budgetFailures = [error?.message ?? String(error)]
    }
  }
  const report = createPerformanceReport({
    scenario: process.env.VIDEORC_PERF_SCENARIO ?? 'windows-proof-recording',
    mode: performanceModeValue,
    metadata,
    timing: {
      warmupMs: performanceWarmupMs,
      measurementMs: performanceMeasurementMs,
      intervalMs: performanceIntervalMs
    },
    metrics: {
      screen: selectedScreen,
      processTree: performanceTelemetry,
      bmp: bmpEvidence,
      recording: recordingEvidence,
      occludedAuxWindows: occludedAuxWindowsEvidence,
      teardown: teardownEvidence,
      activeBudget: activeBudget
        ? { path: activeBudget.path, profileId: activeBudget.profile.id }
        : null,
      budgetFailures
    },
    checks: [
      ...(hardFailures.length === 0
        ? [
            passingCheck(
              'packaged Windows source, media, BMP, and per-role process evidence passed'
            )
          ]
        : []),
      ...failingChecks(hardFailures),
      ...failingChecks(budgetFailures)
    ]
  })
  if (performanceReportRequested) {
    const reportPath = await writePerformanceReport(report)
    console.log(`Windows packaged performance report: ${reportPath}`)
  }
  if (collectorFailed) throw collectorFailure
  if (hardFailures.length > 0 || budgetFailures.length > 0) {
    throw new Error([...hardFailures, ...budgetFailures].join('\n'))
  }
}

async function prepareOccludedAuxWindows(smoke) {
  const placements = [
    ['notes-window-open', 'notes-window-set-bounds', { x: 140, y: 140, width: 640, height: 420 }],
    [
      'comments-window-open',
      'comments-window-set-bounds',
      { x: 180, y: 120, width: 420, height: 640 }
    ],
    [
      'captions-window-open',
      'captions-window-set-bounds',
      { x: 120, y: 360, width: 640, height: 320 }
    ]
  ]
  const windows = {}
  for (const [openCommand, boundsCommand, bounds] of placements) {
    await requestSmokeCommand(smoke, openCommand, {}, { timeoutMs })
    windows[openCommand.replace('-open', '')] = await requestSmokeCommand(
      smoke,
      boundsCommand,
      bounds,
      { timeoutMs }
    )
  }
  const main = await requestSmokeCommand(
    smoke,
    'main-window-set-bounds',
    { x: 80, y: 80, width: 1180, height: 780 },
    { timeoutMs }
  )
  const focus = await requestSmokeCommand(smoke, 'main-window-focus', {}, { timeoutMs })
  if (focus?.focused !== true) {
    throw new Error('Main window did not occlude the auxiliary performance surfaces.')
  }
  return { windows, main, mainFocused: true }
}

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function startAvailableWindowsScreenPreview(ws, candidates) {
  const failures = []
  for (const candidate of candidates) {
    const preview = await request(ws, timeoutMs, 'preview.screen.start', {
      sources: { screenId: candidate.id, testPattern: false },
      video,
      protectedOverlayWindowIds: [],
      ffmpegPath
    })
    if (preview?.state === 'live') {
      return candidate
    }
    failures.push(`${candidate.id}: ${preview?.state} ${preview?.message ?? ''}`)
    await request(ws, timeoutMs, 'preview.screen.stop')
  }
  throw new Error(`No Windows native screen backend could start: ${failures.join('; ')}`)
}

async function waitForNativeScreenFrame(ws, sourceId) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, 'preview.screen.status')
    if (
      last?.state === 'live' &&
      last?.sourceId === sourceId &&
      ((last.framesCaptured ?? 0) > 0 || last.sequence != null)
    ) {
      return last
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${sourceId} frame: ${JSON.stringify(last)}`)
}

async function waitForNonblankBmpFrame(connection) {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const frame = await fetchBmpFrame(connection, null)
      if (frame.status === 200) {
        assertNonblankBmp(frame.bytes, frame.headers)
        return frame
      }
    } catch (error) {
      lastError = error
    }
    await sleep(150)
  }
  throw new Error('Timed out waiting for the first nonblank native BMP preview frame.', {
    cause: lastError
  })
}

async function waitForActiveNativeScreenRecording(ws, sourceId) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    const [diagnostics, compositor, recording] = await Promise.all([
      request(ws, timeoutMs, 'diagnostics.stats'),
      request(ws, timeoutMs, 'compositor.status'),
      request(ws, timeoutMs, 'recording.status')
    ])
    last = { diagnostics, compositor, recording }
    if (nativeWindowsScreenRecordingActive(last, sourceId)) {
      return last
    }
    await sleep(100)
  }
  throw new Error(
    `Timed out waiting for ScreenOnly recording/source authority for ${sourceId}: ${JSON.stringify(last)}`
  )
}

async function pollBmpDuringRecording(connection, initialCursor, durationMs) {
  const deadline = Date.now() + durationMs
  let cursor = initialCursor
  let advancedFrames = 0
  let nonblankFrames = 0
  const observations = []
  while (Date.now() < deadline) {
    const frame = await fetchBmpFrame(connection, cursor)
    if (frame.status === 200) {
      assertNonblankBmp(frame.bytes, frame.headers)
      cursor = frame.cursor
      advancedFrames += 1
      nonblankFrames += 1
      observations.push({
        atMs: Date.now(),
        bytes: frame.bytes.length,
        sequence: frame.cursor.sequence
      })
    }
    await sleep(100)
  }
  if (advancedFrames < 5 || nonblankFrames !== advancedFrames) {
    throw new Error(
      `Native BMP preview did not stay live during recording: advanced=${advancedFrames}, nonblank=${nonblankFrames}.`
    )
  }
  const intervalsMs = observations
    .slice(1)
    .map((sample, index) => sample.atMs - observations[index].atMs)
    .filter((intervalMs) => Number.isFinite(intervalMs) && intervalMs >= 0)
  const bytes = observations.map((sample) => sample.bytes)
  return {
    advancedFrames,
    cursor,
    observations,
    totalBytes: bytes.reduce((total, value) => total + value, 0),
    maxBytes: bytes.length > 0 ? Math.max(...bytes) : 0,
    intervalP95Ms: percentileNearestRank(intervalsMs, 0.95)
  }
}

async function fetchBmpFrame(connection, cursor) {
  const url = new URL(`http://${connection.host}:${connection.port}/preview/screen/latest.bmp`)
  url.searchParams.set('token', connection.token)
  url.searchParams.set('maxWidth', '640')
  if (cursor) {
    url.searchParams.set('afterGeneration', cursor.generation)
    url.searchParams.set('afterSequence', String(cursor.sequence))
  }
  const response = await fetch(url, { cache: 'no-store' })
  if (![200, 204].includes(response.status)) {
    throw new Error(`BMP preview request failed with HTTP ${response.status}.`)
  }
  const headers = Object.fromEntries(response.headers.entries())
  assertBmpHeaders(headers, response.status)
  const generation = headers['x-videorc-frame-generation']
  const sequence = Number(headers['x-videorc-frame-sequence'])
  const nextCursor = { generation, sequence }
  if (response.status === 204) {
    return { status: 204, bytes: Buffer.alloc(0), headers, cursor: nextCursor }
  }
  return {
    status: 200,
    bytes: Buffer.from(await response.arrayBuffer()),
    headers,
    cursor: nextCursor
  }
}

function screenOnlySessionParams(sources) {
  return {
    sources,
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
      video,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    },
    audio: {
      microphoneGainDb: 0,
      microphoneMuted: true,
      microphoneSyncOffsetMs: 0
    }
  }
}

function assertNonblankRecordingFrame(outputPath) {
  const rawPath = join(outputDirectory, `native-screen-recording-${Date.now()}.rgb`)
  const result = spawnSync(
    ffmpegPath,
    [
      '-v',
      'error',
      '-y',
      '-ss',
      '0.5',
      '-i',
      outputPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=320:180',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      rawPath
    ],
    { encoding: 'utf8', cwd: repoRoot }
  )
  if (result.status !== 0) {
    throw new Error(`Could not decode native ScreenOnly frame: ${result.stderr || result.stdout}`)
  }
  const bytes = readFileSync(rawPath)
  let minimum = 255
  let maximum = 0
  for (let offset = 0; offset < bytes.length; offset += 97) {
    minimum = Math.min(minimum, bytes[offset])
    maximum = Math.max(maximum, bytes[offset])
  }
  if (bytes.length < 320 * 180 * 3 || maximum - minimum < 8 || maximum < 16) {
    throw new Error(
      `Native ScreenOnly recording decoded as blank/constant: bytes=${bytes.length}, range=${maximum - minimum}, max=${maximum}.`
    )
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function percentileNearestRank(values, percentile) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]
}
