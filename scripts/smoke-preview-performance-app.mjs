import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp, performanceAppSpawnSpec, repoRoot } from './lib/app-launcher.mjs'
import {
  collectPerformanceMetadata,
  createPerformanceReport,
  evaluateExplicitFallbackStatus,
  failingChecks,
  passingCheck,
  performanceMode,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const mode = performanceMode()
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const warmupMs = Number(process.env.VIDEORC_PREVIEW_WARMUP_MS ?? 2500)
const sampleMs = Number(process.env.VIDEORC_PREVIEW_SAMPLE_MS ?? 5000)
const pollMs = Number(process.env.VIDEORC_PREVIEW_POLL_MS ?? 100)
const minSuccessfulPollRatio = Number(process.env.VIDEORC_PREVIEW_MIN_SUCCESS_RATIO ?? 0.7)
const maxFrameAgeMs = Number(process.env.VIDEORC_PREVIEW_MAX_FRAME_AGE_MS ?? 500)
const maxCadenceMs = Number(process.env.VIDEORC_PREVIEW_MAX_CADENCE_MS ?? 300)
const minTargetFps = Number(process.env.VIDEORC_PREVIEW_MIN_TARGET_FPS ?? 10)
const expectedTransport = process.env.VIDEORC_PREVIEW_EXPECT_TRANSPORT ?? 'latest-jpeg-polling'
const expectedBacking = process.env.VIDEORC_PREVIEW_EXPECT_BACKING ?? 'none'
const explicitOutputDirectory = Boolean(process.env.VIDEORC_SMOKE_OUTPUT_DIR)
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-preview-performance-${Date.now()}`)
)

let launched
let result = null
let runError = null

try {
  const connection = await launchAndReadConnection()
  result = await runPreviewSmoke(connection)
} catch (error) {
  runError = error
} finally {
  await stopApp()
}

const report = createPerformanceReport({
  scenario: process.env.VIDEORC_PERF_SCENARIO ?? 'jpeg-fallback-preview',
  mode,
  metadata: await collectPerformanceMetadata({
    cwd: repoRoot,
    env: {
      ...process.env,
      VIDEORC_PERF_APP_ROLE: process.env.VIDEORC_PERF_APP_ROLE ?? 'jpeg-fallback-preview',
      VIDEORC_PERF_SOURCE_WIDTH: process.env.VIDEORC_PERF_SOURCE_WIDTH ?? '1280',
      VIDEORC_PERF_SOURCE_HEIGHT: process.env.VIDEORC_PERF_SOURCE_HEIGHT ?? '720',
      VIDEORC_PERF_SOURCE_FPS: process.env.VIDEORC_PERF_SOURCE_FPS ?? '60'
    }
  }),
  timing: { warmupMs, measurementMs: sampleMs, pollIntervalMs: pollMs },
  metrics: result,
  checks: runError
    ? failingChecks([runError.message])
    : [
        passingCheck(
          `explicit JPEG fallback proved transport=${result.previewContract.actualTransport}, backing=${result.previewContract.actualBacking}, reason=${JSON.stringify(result.previewContract.fallbackMessage)}`
        )
      ]
})
const reportPath = await writePerformanceReport(report)
console.log(`JPEG fallback performance report: ${reportPath}`)
if (!runError && !explicitOutputDirectory && process.env.VIDEORC_PERF_RETAIN_ARTIFACTS !== '1') {
  await rm(outputDirectory, { recursive: true, force: true })
} else if (runError) {
  console.log(`JPEG fallback scratch retained: ${outputDirectory}`)
}
if (runError) throw runError

async function runPreviewSmoke(connection) {
  const ws = await connectBackend(connection, timeoutMs)
  const diagnostics = []
  try {
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.event === 'diagnostics.stats') {
          diagnostics.push({ ...message.payload, receivedAt: Date.now() })
        }
      } catch {
        // Ignore non-JSON noise from the socket.
      }
    })

    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for preview smoke.')
    }
    console.log(`Preview performance smoke using FFmpeg: ${ffmpegPath}`)

    await request(ws, timeoutMs, 'preview.live.start', previewParams())
    const liveStatus = await waitForLivePreview(ws)
    assertPreviewStatus(liveStatus)

    await sleep(warmupMs)
    const polls = await pollPreviewFrames(connection, sampleMs)
    const finalDiagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
    assertPollsHealthy(polls)
    assertDiagnosticsHealthy(finalDiagnostics, diagnostics)

    console.log(
      `Preview performance OK: ${liveStatus.transport}/${liveStatus.backing} ${liveStatus.width}x${liveStatus.height} @ ${liveStatus.targetFps}fps, ${polls.successes}/${polls.attempts} frame polls, age ${format(finalDiagnostics.previewFrameAgeMs)}ms, cadence ${format(finalDiagnostics.previewLatencyMs)}ms, reason ${JSON.stringify(liveStatus.message)}`
    )
    return {
      liveStatus,
      polls,
      finalDiagnostics,
      previewContract: {
        expectedTransport,
        actualTransport: liveStatus.transport,
        diagnosticTransport: finalDiagnostics.previewTransport,
        expectedBacking,
        actualBacking: liveStatus.backing,
        diagnosticBacking: finalDiagnostics.previewSurfaceBacking,
        fallbackMessage: liveStatus.message
      }
    }
  } finally {
    try {
      await request(ws, 5000, 'preview.live.stop')
    } catch {
      // The app shutdown path also stops preview; this is best-effort cleanup.
    }
    ws.close()
  }
}

async function waitForLivePreview(ws) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  while (Date.now() < deadline) {
    lastStatus = await request(ws, timeoutMs, 'preview.live.status')
    if (lastStatus.state === 'live') {
      return lastStatus
    }
    await sleep(250)
  }
  throw new Error(`Live preview did not become live. Last status: ${JSON.stringify(lastStatus)}`)
}

function assertPreviewStatus(status) {
  const failures = evaluateExplicitFallbackStatus({
    expectedTransport,
    actualTransport: status.transport,
    expectedBacking,
    actualBacking: status.backing,
    fallbackMessage: status.message,
    fallbackLabel: 'JPEG'
  })
  if (failures.length > 0) {
    throw new Error(`JPEG fallback status contract failed: ${failures.join('; ')}.`)
  }
  if ((status.targetFps ?? 0) < minTargetFps) {
    throw new Error(
      `Expected preview target FPS >= ${minTargetFps}, got ${status.targetFps ?? 'missing'}.`
    )
  }
  if (!status.width || !status.height) {
    throw new Error(`Preview status did not advertise dimensions: ${JSON.stringify(status)}`)
  }
}

function assertPollsHealthy(polls) {
  if (polls.attempts <= 0 || polls.successes <= 0) {
    throw new Error(
      `JPEG fallback made no frame progress: ${polls.successes}/${polls.attempts} successful polls.`
    )
  }
  const minSuccesses = Math.ceil(polls.attempts * minSuccessfulPollRatio)
  if (polls.successes < minSuccesses) {
    throw new Error(
      `Preview frame polling only succeeded ${polls.successes}/${polls.attempts}; expected at least ${minSuccesses}.`
    )
  }
}

function assertDiagnosticsHealthy(finalDiagnostics, samples) {
  if (finalDiagnostics.previewTransport !== expectedTransport) {
    throw new Error(
      `Expected diagnostic preview transport ${expectedTransport}, got ${finalDiagnostics.previewTransport}.`
    )
  }
  if (finalDiagnostics.previewSurfaceBacking !== expectedBacking) {
    throw new Error(
      `Expected diagnostic preview backing ${expectedBacking}, got ${finalDiagnostics.previewSurfaceBacking}.`
    )
  }
  if ((finalDiagnostics.previewTargetFps ?? 0) < minTargetFps) {
    throw new Error(
      `Expected diagnostic preview target FPS >= ${minTargetFps}, got ${finalDiagnostics.previewTargetFps ?? 'missing'}.`
    )
  }
  if ((finalDiagnostics.previewDroppedFrames ?? 0) > 0) {
    throw new Error(`Preview reported ${finalDiagnostics.previewDroppedFrames} dropped frame(s).`)
  }
  if (typeof finalDiagnostics.previewFrameAgeMs !== 'number') {
    throw new Error('Preview diagnostics did not report frame age.')
  }
  if (finalDiagnostics.previewFrameAgeMs > maxFrameAgeMs) {
    throw new Error(
      `Preview frame age ${finalDiagnostics.previewFrameAgeMs}ms exceeded ${maxFrameAgeMs}ms.`
    )
  }
  if (typeof finalDiagnostics.previewLatencyMs !== 'number') {
    throw new Error('Preview diagnostics did not report frame cadence.')
  }
  if (finalDiagnostics.previewLatencyMs > maxCadenceMs) {
    throw new Error(
      `Preview cadence ${finalDiagnostics.previewLatencyMs}ms exceeded ${maxCadenceMs}ms.`
    )
  }

  const steadySamples = samples.filter((sample) => typeof sample.previewFrameAgeMs === 'number')
  if (!steadySamples.length) {
    throw new Error('Preview smoke did not receive preview diagnostics over the socket.')
  }
}

async function pollPreviewFrames(connection, durationMs) {
  const deadline = Date.now() + durationMs
  let attempts = 0
  let successes = 0
  while (Date.now() < deadline) {
    attempts += 1
    const url = `http://${connection.host}:${connection.port}/preview/live.jpg?token=${encodeURIComponent(connection.token)}&t=${Date.now()}`
    try {
      const response = await fetch(url)
      if (response.ok) {
        const bytes = await response.arrayBuffer()
        if (bytes.byteLength > 0) {
          successes += 1
        }
      }
    } catch {
      // Count failed fetches through the success ratio assertion.
    }
    await sleep(pollMs)
  }
  return { attempts, successes }
}

function previewParams() {
  return {
    sources: { testPattern: true },
    layout: {
      layoutPreset: 'screen-camera',
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
    ffmpegPath,
    video: {
      preset: 'custom',
      width: 1280,
      height: 720,
      fps: 60,
      bitrateKbps: 4000
    }
  }
}

function launchAndReadConnection() {
  return launchDevApp({
    timeoutMs,
    requiredMarkers: ['backend-ready'],
    spawnSpec: performanceAppSpawnSpec(),
    env: {
      VIDEORC_NATIVE_PREVIEW_SURFACE: '0',
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
    },
    onLine: (line) => console.log(line)
  }).then((app) => {
    launched = app
    return app.connections['backend-ready']
  })
}

async function stopApp() {
  await launched?.stop()
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function format(value) {
  return typeof value === 'number' ? value.toFixed(0) : 'n/a'
}
