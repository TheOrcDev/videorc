import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { connectBackend, request } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 100000)
const measurementMs = Number(process.env.VIDEORC_PREVIEW_MOTION_SAMPLE_MS ?? 10000)
const obsMinFps = Number(process.env.VIDEORC_PREVIEW_MOTION_OBS_MIN_FPS ?? 55)
const obsMaxFrameAgeMs = Number(process.env.VIDEORC_PREVIEW_MOTION_OBS_MAX_AGE_MS ?? 100)
const obsMaxIntervalP95Ms = Number(process.env.VIDEORC_PREVIEW_MOTION_OBS_MAX_INTERVAL_P95_MS ?? 24)
const expectedSurfaceTransport =
  process.env.VIDEORC_EXPECT_NATIVE_METAL_PREVIEW === '1' ? 'native-surface' : 'electron-proof-surface'
const expectedSurfaceBacking =
  process.env.VIDEORC_EXPECT_NATIVE_METAL_PREVIEW === '1' ? 'cametal-layer' : 'electron-browser-window'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-preview-motion-${Date.now()}`)
)

let appProcess
let stopping = false

try {
  const { backend, smoke } = await launchAndReadConnections()
  await runPreviewMotionSmoke(backend, smoke)
} finally {
  await stopApp()
}

async function runPreviewMotionSmoke(connection, smoke) {
  const ws = await connectBackend(connection, timeoutMs)
  try {
    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for preview motion smoke.')
    }
    console.log(`Preview motion smoke using FFmpeg: ${ffmpegPath}`)

    await smokeCommand(smoke, 'open-layout-tab')
    const bootstrap = await smokeCommand(smoke, 'inspect-native-preview-bootstrap')
    assertNativeBootstrap(bootstrap)
    const liveStatus = await waitForNativeSurface(ws)
    const nativeStage = await smokeCommand(smoke, 'inspect-native-preview-bootstrap', {
      requireNativePlaceholder: true
    })
    assertNativeBootstrap(nativeStage, { requireNativePreview: true })

    const measurement = smokeCommand(smoke, 'measure-native-preview-surface', {
      durationMs: measurementMs
    })
    await exerciseLayoutAndMotion(smoke)
    const renderer = await measurement
    const diagnostics = await request(ws, timeoutMs, 'diagnostics.stats')

    assertNativeMotionHealthy(renderer)
    const obsQualified = isObsQualified(liveStatus, renderer, diagnostics)
    const reason = obsQualified
      ? 'Preview meets OBS-quality Phase 0 strict thresholds.'
      : `Current native preview is below OBS target: renderer ${format(renderer.measuredFps)}fps, p95 interval ${format(renderer.intervalP95Ms)}ms, frame age ${format(diagnostics.previewFrameAgeMs)}ms.`

    await request(ws, timeoutMs, 'diagnostics.preview_baseline.record', {
      transport: liveStatus.transport,
      surfaceBacking: liveStatus.backing,
      targetFps: liveStatus.targetFps,
      measuredFps: renderer.measuredFps,
      presentFps: diagnostics.previewPresentFps,
      frameAgeMs: diagnostics.previewFrameAgeMs,
      cadenceP95Ms: renderer.intervalP95Ms,
      intervalJitterP95Ms: renderer.intervalJitterP95Ms,
      blankFrames: renderer.blankFrames,
      longTasks: renderer.longTaskCount ?? 0,
      rendererLongTaskP95Ms: renderer.rendererLongTaskP95Ms,
      obsQualified,
      reason
    })

    if (!obsQualified) {
      throw new Error(reason)
    }

    console.log(
      `Preview motion baseline: ${liveStatus.transport}, renderer ${format(renderer.measuredFps)}fps, p95 interval ${format(renderer.intervalP95Ms)}ms, blanks ${renderer.blankFrames}, compositor frames ${renderer.compositorFrames}, frame age ${format(diagnostics.previewFrameAgeMs)}ms, OBS qualified ${obsQualified ? 'yes' : 'no'}`
    )
  } finally {
    try {
      await request(ws, 5000, 'preview.live.stop')
    } catch {
      // Shutdown also stops preview; best-effort cleanup only.
    }
    ws.close()
  }
}

async function exerciseLayoutAndMotion(smoke) {
  const steps = [
    async () => smokeCommand(smoke, 'exercise-native-preview-scene'),
    async () => smokeCommand(smoke, 'resize-window', { width: 1030, height: 720 }),
    async () => smokeCommand(smoke, 'exercise-native-preview-scene'),
    async () => smokeCommand(smoke, 'resize-window', { width: 1280, height: 820 }),
    async () => smokeCommand(smoke, 'exercise-native-preview-scene')
  ]

  for (const step of steps) {
    await sleep(900)
    await step()
  }
}

function assertNativeMotionHealthy(renderer) {
  if ((renderer.measuredFps ?? 0) < obsMinFps) {
    throw new Error(`Native preview measured ${format(renderer.measuredFps)}fps, expected at least ${obsMinFps}.`)
  }
  if ((renderer.intervalP95Ms ?? Number.POSITIVE_INFINITY) > obsMaxIntervalP95Ms) {
    throw new Error(`Native preview p95 interval ${format(renderer.intervalP95Ms)}ms exceeded ${obsMaxIntervalP95Ms}ms.`)
  }
  if ((renderer.blankFrames ?? 0) > 0) {
    throw new Error(`Native preview reported ${renderer.blankFrames} blank frame(s).`)
  }
}

function assertNativeBootstrap(result, options = {}) {
  if (!result.hasStage || !result.hasSurface) {
    throw new Error(`Preview stage did not render: ${JSON.stringify(result)}`)
  }
  if (!result.hasVideorcBridge || !result.hasCreateNativePreviewSurface || !result.hasUpdateNativePreviewSurfaceBounds) {
    throw new Error(`Native preview bridge is incomplete: ${JSON.stringify(result)}`)
  }
  if (options.requireNativePreview) {
    if (!result.hasNativePlaceholder) {
      throw new Error(`Preview stage did not render the native surface placeholder: ${JSON.stringify(result)}`)
    }
    if ((result.previewImageCount ?? 0) !== 0 || result.hasJpegPollingPreviewImage) {
      throw new Error(`Native preview rendered a JPEG/MJPEG fallback image: ${JSON.stringify(result)}`)
    }
  }
}

function isObsQualified(status, renderer, diagnostics) {
  return (
    status.transport === 'native-surface' &&
    status.backing === 'cametal-layer' &&
    (status.targetFps ?? 0) >= 60 &&
    (renderer.measuredFps ?? 0) >= obsMinFps &&
    (renderer.intervalP95Ms ?? Number.POSITIVE_INFINITY) <= obsMaxIntervalP95Ms &&
    (diagnostics.previewFrameAgeMs ?? Number.POSITIVE_INFINITY) <= obsMaxFrameAgeMs &&
    renderer.blankFrames === 0
  )
}

async function waitForNativeSurface(ws, previousFrames = -1) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  while (Date.now() < deadline) {
    lastStatus = await request(ws, timeoutMs, 'preview.surface.status')
    if (
      lastStatus.state === 'live' &&
      lastStatus.transport === expectedSurfaceTransport &&
      lastStatus.backing === expectedSurfaceBacking &&
      (lastStatus.targetFps ?? 0) >= 60 &&
      lastStatus.framesRendered > previousFrames
    ) {
      return lastStatus
    }
    await sleep(150)
  }
  throw new Error(`Native preview surface did not become live. Last status: ${JSON.stringify(lastStatus)}`)
}

async function smokeCommand(smoke, command, params = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      return await sendSmokeCommand(smoke, command, params)
    } catch (error) {
      lastError = error
      if (!String(error?.message ?? error).includes('Main window is not ready')) {
        throw error
      }
      await sleep(150)
    }
  }
  throw lastError ?? new Error(`${command} smoke command timed out.`)
}

async function sendSmokeCommand(smoke, command, params = {}) {
  const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, params })
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error ?? `${command} smoke command failed.`)
  }
  return payload.result
}

function launchAndReadConnections() {
  return new Promise((resolveConnections, rejectConnections) => {
    const timer = setTimeout(() => {
      rejectConnections(new Error(`Timed out waiting for smoke connections after ${timeoutMs}ms.`))
    }, timeoutMs)
    const connections = { backend: null, smoke: null }

    appProcess = spawn('pnpm', ['dev'], {
      cwd: repoRoot,
      detached: true,
      env: {
        ...process.env,
        VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
        VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
        VIDEORC_SMOKE_PREVIEW_MOTION: '1',
        VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const maybeResolve = () => {
      if (connections.backend && connections.smoke) {
        clearTimeout(timer)
        resolveConnections(connections)
      }
    }
    const handleOutput = (text) => handleAppOutput(text, connections, maybeResolve)

    appProcess.stdout.setEncoding('utf8')
    appProcess.stderr.setEncoding('utf8')
    appProcess.stdout.on('data', handleOutput)
    appProcess.stderr.on('data', handleOutput)
    appProcess.on('error', (error) => {
      clearTimeout(timer)
      rejectConnections(error)
    })
    appProcess.on('exit', (code, signal) => {
      clearTimeout(timer)
      rejectConnections(new Error(`Dev app exited before preview motion smoke completed: code=${code} signal=${signal}`))
    })
  })
}

function handleAppOutput(text, connections, maybeResolve) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() && !stopping) {
      console.log(line)
    }

    const backendMarker = '[smoke] backend-ready '
    const backendIndex = line.indexOf(backendMarker)
    if (backendIndex !== -1) {
      connections.backend = JSON.parse(line.slice(backendIndex + backendMarker.length))
      maybeResolve()
      continue
    }

    const smokeMarker = '[smoke] preview-motion-ready '
    const smokeIndex = line.indexOf(smokeMarker)
    if (smokeIndex !== -1) {
      connections.smoke = JSON.parse(line.slice(smokeIndex + smokeMarker.length))
      maybeResolve()
    }
  }
}

function stopApp() {
  return new Promise((resolveStop) => {
    if (!appProcess?.pid || appProcess.killed) {
      resolveStop()
      return
    }

    const timer = setTimeout(() => {
      killApp('SIGKILL')
      resolveStop()
    }, 5000)

    stopping = true
    appProcess.once('exit', () => {
      clearTimeout(timer)
      resolveStop()
    })
    killApp('SIGTERM')
  })
}

function killApp(signal) {
  if (!appProcess?.pid) {
    return
  }

  try {
    process.kill(-appProcess.pid, signal)
  } catch {
    appProcess.kill(signal)
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function format(value) {
  return typeof value === 'number' ? value.toFixed(1) : 'n/a'
}
