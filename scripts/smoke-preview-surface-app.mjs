import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { connectBackend, request } from './smoke-recording-session.mjs'
import { createPreviewSurfaceOutputGuard } from './lib/smoke-output-guards.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 100000)
const launchAttempts = Number(process.env.VIDEORC_PREVIEW_SURFACE_LAUNCH_ATTEMPTS ?? 2)
const measurementMs = Number(process.env.VIDEORC_PREVIEW_SURFACE_SAMPLE_MS ?? 3000)
const resizedMeasurementMs = Number(
  process.env.VIDEORC_PREVIEW_SURFACE_RESIZE_SAMPLE_MS ?? Math.min(measurementMs, 3000)
)
const minFps = Number(process.env.VIDEORC_PREVIEW_SURFACE_MIN_FPS ?? 55)
const maxIntervalP95Ms = Number(process.env.VIDEORC_PREVIEW_SURFACE_MAX_INTERVAL_P95_MS ?? 24)
const expectedSurfaceTransport =
  process.env.VIDEORC_EXPECT_NATIVE_METAL_PREVIEW === '1' ? 'native-surface' : 'electron-proof-surface'
const expectedSurfaceBacking =
  process.env.VIDEORC_EXPECT_NATIVE_METAL_PREVIEW === '1' ? 'cametal-layer' : 'electron-browser-window'
const expectedSurfaceBadge =
  expectedSurfaceTransport === 'native-surface' ? 'Native preview' : 'Electron proof'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-preview-surface-${Date.now()}`)
)

let appProcess
let stopping = false
const outputGuard = createPreviewSurfaceOutputGuard()

try {
  const { backend, smoke } = await launchAndReadConnectionsWithRetry()
  await runPreviewSurfaceSmoke(backend, smoke)
  outputGuard.assertClean()
} finally {
  await stopApp()
}

async function runPreviewSurfaceSmoke(connection, smoke) {
  const ws = await connectBackend(connection, timeoutMs)
  try {
    await smokeCommand(smoke, 'open-layout-tab')
    const bootstrap = await smokeCommand(smoke, 'inspect-native-preview-bootstrap')
    assertNativeBootstrap(bootstrap)
    const firstStatus = await waitForNativeSurface(ws)
    const nativeStage = await smokeCommand(smoke, 'inspect-native-preview-bootstrap', {
      requireNativePlaceholder: true
    })
    assertNativeBootstrap(nativeStage, { requireNativePreview: true })
    const badges = await smokeCommand(smoke, 'inspect-preview-stage-badges')
    assertNativePreviewBadge(badges)
    const sceneExercise = await smokeCommand(smoke, 'exercise-native-preview-scene')
    assertSceneExercise(sceneExercise)

    const firstMeasurement = await smokeCommand(smoke, 'measure-native-preview-surface', {
      durationMs: measurementMs
    })
    assertNativeMeasurement(firstMeasurement, 'initial')

    const firstDiagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
    if (firstDiagnostics.previewTransport !== expectedSurfaceTransport) {
      throw new Error(
        `Diagnostics preview transport is ${firstDiagnostics.previewTransport}, expected ${expectedSurfaceTransport}.`
      )
    }
    if (firstDiagnostics.previewSurfaceBacking !== expectedSurfaceBacking) {
      throw new Error(
        `Diagnostics preview backing is ${firstDiagnostics.previewSurfaceBacking}, expected ${expectedSurfaceBacking}.`
      )
    }
    assertPreviewImagePollCountsIdle(firstDiagnostics.previewImagePollCounts)
    if ((firstDiagnostics.previewPresentFps ?? 0) < minFps) {
      throw new Error(`Diagnostics preview FPS ${format(firstDiagnostics.previewPresentFps)} is below ${minFps}.`)
    }
    await waitForCompositorRenderFloor(ws)

    await smokeCommand(smoke, 'resize-window', { width: 1280, height: 820 })
    const resizedStatus = await waitForNativeSurface(ws, firstStatus.framesRendered)
    const resizedMeasurement = await smokeCommand(smoke, 'measure-native-preview-surface', {
      durationMs: resizedMeasurementMs
    })
    assertNativeMeasurement(resizedMeasurement, 'resized')

    const surfaceBoundsChanged =
      resizedStatus.width !== firstStatus.width ||
      resizedStatus.height !== firstStatus.height ||
      resizedStatus.bounds?.width !== firstStatus.bounds?.width ||
      resizedStatus.bounds?.height !== firstStatus.bounds?.height
    const resizedDiagnostics = surfaceBoundsChanged
      ? await waitForPreviewResizeDiagnostics(ws, firstDiagnostics.previewSurfaceResizeCount ?? 0)
      : await request(ws, timeoutMs, 'diagnostics.stats')

    console.log(
      `Preview surface smoke: native ${format(firstMeasurement.measuredFps)}fps initial, ${format(resizedMeasurement.measuredFps)}fps after resize, scene update ${format(sceneExercise.updateLatencyMs)}ms, frames ${resizedStatus.framesRendered}, p95 ${format(resizedMeasurement.intervalP95Ms)}ms, resize count ${resizedDiagnostics.previewSurfaceResizeCount}${surfaceBoundsChanged ? '' : ' (bounds unchanged)'}`
    )
  } finally {
    ws.close()
  }
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

async function waitForCompositorRenderFloor(ws) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  while (Date.now() < deadline) {
    lastStatus = await request(ws, timeoutMs, 'compositor.status')
    if (
      lastStatus.state === 'live' &&
      (lastStatus.framesRendered ?? 0) > 0 &&
      (lastStatus.renderFps ?? 0) >= 30
    ) {
      return lastStatus
    }
    await sleep(150)
  }
  throw new Error(`Compositor did not reach the 30fps render floor. Last status: ${JSON.stringify(lastStatus)}`)
}

async function waitForPreviewResizeDiagnostics(ws, previousResizeCount = 0) {
  const deadline = Date.now() + timeoutMs
  let lastDiagnostics = null
  while (Date.now() < deadline) {
    lastDiagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
    if ((lastDiagnostics.previewSurfaceResizeCount ?? 0) > previousResizeCount) {
      return lastDiagnostics
    }
    await sleep(150)
  }
  throw new Error(
    `Native preview surface resize count did not increase after surface bounds changed. Previous count: ${previousResizeCount}. Last diagnostics: ${JSON.stringify(lastDiagnostics)}`
  )
}

function assertNativeMeasurement(measurement, label) {
  if ((measurement.measuredFps ?? 0) < minFps) {
    throw new Error(
      `Native preview surface ${label} measurement ${format(measurement.measuredFps)}fps is below ${minFps}.`
    )
  }
  if ((measurement.intervalP95Ms ?? Number.POSITIVE_INFINITY) > maxIntervalP95Ms) {
    throw new Error(
      `Native preview surface ${label} p95 interval ${format(measurement.intervalP95Ms)}ms exceeded ${maxIntervalP95Ms}ms.`
    )
  }
  if ((measurement.blankFrames ?? 0) > 0) {
    throw new Error(`Native preview surface ${label} reported ${measurement.blankFrames} blank frame(s).`)
  }
  if ((measurement.compositorFrames ?? 0) <= 0) {
    throw new Error(`Native preview surface ${label} did not receive compositor frames.`)
  }
  if (measurement.compositorState !== 'live') {
    throw new Error(`Native preview surface ${label} compositor state is ${measurement.compositorState}, expected live.`)
  }
  if (!measurement.width || !measurement.height) {
    throw new Error(`Native preview surface ${label} has invalid dimensions ${measurement.width}x${measurement.height}.`)
  }
}

function assertPreviewImagePollCountsIdle(counts = {}) {
  const total =
    (counts.cameraPng ?? 0) +
    (counts.screenPng ?? 0) +
    (counts.liveJpeg ?? 0) +
    (counts.liveMjpeg ?? 0)
  if (total > 0) {
    throw new Error(`Native preview surface smoke used image-poll routes: ${JSON.stringify(counts)}`)
  }
}

function assertNativeBootstrap(result, options = {}) {
  if (!result.hasStage || !result.hasSurface) {
    throw new Error(`Preview stage did not render: ${JSON.stringify(result)}`)
  }
  if (!result.hasVideorcBridge || !result.hasCreateNativePreviewSurface || !result.hasUpdateNativePreviewSurfaceBounds) {
    throw new Error(`Native preview bridge is incomplete: ${JSON.stringify(result)}`)
  }
  if (!result.hasUpdateNativePreviewSurfaceScene) {
    throw new Error(`Native preview scene bridge is unavailable: ${JSON.stringify(result)}`)
  }
  if (options.requireNativePreview) {
    if (!result.hasNativePlaceholder) {
      throw new Error(`Preview stage did not render the native surface placeholder: ${JSON.stringify(result)}`)
    }
    if ((result.previewImageCount ?? 0) !== 0 || result.hasJpegPollingPreviewImage) {
      throw new Error(`Native preview rendered a JPEG/MJPEG fallback image: ${JSON.stringify(result)}`)
    }
  }
  if ((result.surfaceWidth ?? 0) <= 0 || (result.surfaceHeight ?? 0) <= 0) {
    throw new Error(`Native preview surface has invalid bounds: ${JSON.stringify(result)}`)
  }
}

function assertNativePreviewBadge(result) {
  const badges = result.badges ?? []
  if (!badges.includes(expectedSurfaceBadge)) {
    throw new Error(`Preview stage badges did not include "${expectedSurfaceBadge}": ${JSON.stringify(badges)}`)
  }
}

function assertSceneExercise(result) {
  if (result.sceneRevision !== 2) {
    throw new Error(`Native preview scene revision ${result.sceneRevision} did not reach the surface.`)
  }
  if (result.compositorSceneRevision !== 2) {
    throw new Error(`Compositor scene revision ${result.compositorSceneRevision} did not reach the surface.`)
  }
  if (result.sceneMatchesCompositor !== true) {
    throw new Error(`Native preview scene did not match compositor revision: ${JSON.stringify(result)}`)
  }
  if ((result.layerCount ?? 0) < 2) {
    throw new Error(`Native preview scene rendered ${result.layerCount ?? 0} layer(s), expected at least 2.`)
  }
  if (result.cameraLeft !== '62%') {
    throw new Error(`Native preview camera layer left was ${result.cameraLeft}, expected 62%.`)
  }
  if ((result.updateLatencyMs ?? Number.POSITIVE_INFINITY) > 50) {
    throw new Error(`Native preview scene update took ${format(result.updateLatencyMs)}ms, expected <= 50ms.`)
  }
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
  const body = JSON.stringify({ command, params })
  const { statusCode, payload } = await new Promise((resolveCommand, rejectCommand) => {
    const request = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (response) => {
        response.setEncoding('utf8')
        let text = ''
        response.on('data', (chunk) => {
          text += chunk
        })
        response.on('end', () => {
          try {
            resolveCommand({
              statusCode: response.statusCode ?? 0,
              payload: JSON.parse(text)
            })
          } catch {
            rejectCommand(new Error(`${command} smoke command returned invalid JSON: ${text.slice(0, 200)}`))
          }
        })
      }
    )
    request.on('error', rejectCommand)
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`${command} smoke command timed out after ${timeoutMs}ms.`))
    })
    request.end(body)
  })
  if (statusCode < 200 || statusCode >= 300 || !payload.ok) {
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
        VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
        VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
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
      rejectConnections(new Error(`Preview surface app exited before smoke completed: code=${code} signal=${signal}`))
    })
  })
}

async function launchAndReadConnectionsWithRetry() {
  let lastError = null
  const attempts = Math.max(1, Math.floor(launchAttempts))
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await launchAndReadConnections()
    } catch (error) {
      lastError = error
      await stopApp()
      appProcess = null
      if (attempt >= attempts) {
        throw error
      }
      console.warn(
        `Preview surface smoke launch attempt ${attempt}/${attempts} failed before connections were ready: ${error.message}`
      )
      await sleep(1000)
    }
  }
  throw lastError ?? new Error('Preview surface smoke failed before launch.')
}

function handleAppOutput(text, connections, maybeResolve) {
  for (const line of text.split(/\r?\n/)) {
    outputGuard.inspectLine(line)
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
      appProcess = null
      stopping = false
      resolveStop()
      return
    }

    const timer = setTimeout(() => {
      killApp('SIGKILL')
      appProcess = null
      stopping = false
      resolveStop()
    }, 5000)

    stopping = true
    appProcess.once('exit', () => {
      clearTimeout(timer)
      appProcess = null
      stopping = false
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
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'n/a'
}
