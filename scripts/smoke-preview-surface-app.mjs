import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { appSpawnSpec, devAppSpawnSpec, smokeAppEnv, stopProcess } from './lib/app-launcher.mjs'
import { assertSmokeCommandConnection } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'
import { createPreviewSurfaceOutputGuard } from './lib/smoke-output-guards.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 100000)
const launchAttempts = Number(process.env.VIDEORC_PREVIEW_SURFACE_LAUNCH_ATTEMPTS ?? 2)
const measurementMs = Number(process.env.VIDEORC_PREVIEW_SURFACE_SAMPLE_MS ?? 3000)
const resizedMeasurementMs = Number(
  process.env.VIDEORC_PREVIEW_SURFACE_RESIZE_SAMPLE_MS ?? Math.min(measurementMs, 3000)
)
// This smoke proves detached native-surface lifecycle and packaging invariants.
// Final currentness remains covered by the stricter recording-native-preview gate.
const minFps = Number(process.env.VIDEORC_PREVIEW_SURFACE_MIN_FPS ?? 30)
const maxIntervalP95Ms = Number(process.env.VIDEORC_PREVIEW_SURFACE_MAX_INTERVAL_P95_MS ?? 120)
const maxInputToPresentLatencyP95Ms = Number(
  process.env.VIDEORC_PREVIEW_SURFACE_MAX_INPUT_TO_PRESENT_P95_MS ?? 100
)
const expectNativeMetalPreview =
  process.env.VIDEORC_EXPECT_NATIVE_METAL_PREVIEW === '1' ||
  (process.env.VIDEORC_EXPECT_NATIVE_METAL_PREVIEW !== '0' && process.platform === 'darwin')
const expectedSurfaceTransport = expectNativeMetalPreview
  ? 'native-surface'
  : 'electron-proof-surface'
const expectedSurfaceBacking = expectNativeMetalPreview
  ? 'cametal-layer'
  : 'electron-browser-window'
const expectedSurfaceBadge =
  expectedSurfaceTransport === 'native-surface' ? 'Native preview' : 'Electron proof'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-preview-surface-${Date.now()}`)
)
const usePackagedApp =
  process.env.VIDEORC_SMOKE_PACKAGED_APP === '1' ||
  Boolean(process.env.VIDEORC_PACKAGED_APP_EXECUTABLE)
const packagedAppExecutable = resolve(
  repoRoot,
  process.env.VIDEORC_PACKAGED_APP_EXECUTABLE ??
    'apps/desktop/release/mac-arm64/Videorc.app/Contents/MacOS/Videorc'
)
const packagedNativePreviewHelper = resolve(
  dirname(packagedAppExecutable),
  '..',
  'Resources',
  'native_preview_host_helper'
)
const packagedSmokeCapability = usePackagedApp ? randomBytes(32).toString('base64url') : null

if (usePackagedApp) {
  if (process.platform !== 'darwin') {
    throw new Error('Packaged preview surface smoke currently targets macOS app bundles.')
  }
  if (!existsSync(packagedAppExecutable)) {
    throw new Error(`Packaged app executable not found: ${packagedAppExecutable}`)
  }
  if (expectedSurfaceTransport === 'native-surface' && !existsSync(packagedNativePreviewHelper)) {
    throw new Error(`Packaged native preview helper not found: ${packagedNativePreviewHelper}`)
  }
}

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
  assertSmokeCommandConnection(smoke)
  const ws = await connectBackend(connection, timeoutMs)
  try {
    await smokeCommand(smoke, 'open-tab', {
      tab: 'studio',
      waitFor: '[data-videorc-preview-card]'
    })
    const bootstrap = await smokeCommand(smoke, 'inspect-native-preview-bootstrap')
    assertNativeBootstrap(bootstrap)
    const runtime = await smokeCommand(smoke, 'inspect-native-preview-runtime')
    console.log(`Preview surface runtime: ${JSON.stringify(runtime)}`)
    await smokeCommand(smoke, 'preview-window-open')
    await waitForPreviewWindowSurface(smoke)
    const firstStatus = await waitForNativeSurface(ws)
    const nativeStage = await smokeCommand(smoke, 'inspect-native-preview-bootstrap', {
      requireNativePlaceholder: true
    })
    assertNativeBootstrap(nativeStage, { requireNativePreview: true })
    await waitForNativePreviewBadge(smoke)
    const sceneExercise = await smokeCommand(smoke, 'exercise-native-preview-scene')
    assertSceneExercise(sceneExercise)
    const backgroundSceneExercise = await waitForBackgroundSceneExercise(smoke)
    const sceneReattach = await smokeCommand(
      smoke,
      'exercise-native-preview-scene-after-surface-loss'
    )
    assertSceneReattach(sceneReattach)
    await waitForPreviewWindowSurface(smoke)
    const reattachedStatus = await waitForNativeSurface(ws, firstStatus.framesRendered)
    const reattachedMainStatus = await waitForMainNativeSurface(smoke, firstStatus.framesRendered)

    const firstMeasurement = await smokeCommand(smoke, 'measure-native-preview-surface', {
      durationMs: measurementMs
    })
    assertNativeMeasurement(firstMeasurement, 'initial')
    const pumpReconnect = await smokeCommand(smoke, 'exercise-main-present-pump-reconnect')
    assertMainPumpReconnect(pumpReconnect)

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
      throw new Error(
        `Diagnostics preview FPS ${format(firstDiagnostics.previewPresentFps)} is below ${minFps}.`
      )
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

    await smokeCommand(smoke, 'move-window', { x: 80, y: 80 })
    const movedStatus = await waitForNativeSurface(ws, resizedStatus.framesRendered)

    await smokeCommand(smoke, 'minimize-window')
    await sleep(500)
    await smokeCommand(smoke, 'restore-window')
    const restoredStatus = await waitForNativeSurface(ws, movedStatus.framesRendered)
    const restoredMeasurement = await smokeCommand(smoke, 'measure-native-preview-surface', {
      durationMs: resizedMeasurementMs
    })
    assertNativeMeasurement(restoredMeasurement, 'restored')

    const reportPath = writePreviewSurfaceGateReport({
      firstMeasurement,
      resizedMeasurement,
      restoredMeasurement,
      firstStatus,
      resizedStatus,
      movedStatus,
      restoredStatus,
      resizedDiagnostics,
      sceneExercise,
      sceneReattach,
      reattachedStatus,
      reattachedMainStatus,
      pumpReconnect
    })

    console.log(
      `Preview surface smoke: native ${format(firstMeasurement.measuredFps)}fps initial, ${format(resizedMeasurement.measuredFps)}fps after resize, ${format(restoredMeasurement.measuredFps)}fps after restore, scene update ${format(sceneExercise.updateLatencyMs)}ms, reattach ${format(sceneReattach.updateLatencyMs)}ms, reattached frames ${reattachedStatus.framesRendered}, final frames ${restoredStatus.framesRendered}, p95 ${format(restoredMeasurement.intervalP95Ms)}ms, resize count ${resizedDiagnostics.previewSurfaceResizeCount}${surfaceBoundsChanged ? '' : ' (bounds unchanged)'}, report ${reportPath}`
    )
  } finally {
    ws.close()
  }
}

async function waitForPreviewWindowSurface(smoke) {
  const deadline = Date.now() + timeoutMs
  let lastState = null
  while (Date.now() < deadline) {
    lastState = await smokeCommand(smoke, 'preview-window-state')
    if (
      lastState.open === true &&
      lastState.visible === true &&
      lastState.surface?.exists === true &&
      lastState.nativeOwnsPlacement === true &&
      lastState.surfaceStatus?.state === 'live' &&
      lastState.surfaceStatus?.transport === expectedSurfaceTransport
    ) {
      return lastState
    }
    await sleep(150)
  }
  throw new Error(`Preview window surface did not open. Last state: ${JSON.stringify(lastState)}`)
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
  throw new Error(
    `Native preview surface did not become live. Last status: ${JSON.stringify(lastStatus)}`
  )
}

async function waitForMainNativeSurface(smoke, previousFrames = -1) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = null
  while (Date.now() < deadline) {
    lastStatus = await smokeCommand(smoke, 'native-preview-surface-status')
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
  throw new Error(
    `Main native preview surface did not return to ${expectedSurfaceTransport}. Last status: ${JSON.stringify(lastStatus)}`
  )
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
  throw new Error(
    `Compositor did not reach the 30fps render floor. Last status: ${JSON.stringify(lastStatus)}`
  )
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

async function waitForNativePreviewBadge(smoke) {
  const deadline = Date.now() + 8000
  let lastBadges = null
  while (Date.now() < deadline) {
    lastBadges = await smokeCommand(smoke, 'inspect-preview-stage-badges')
    if ((lastBadges.badges ?? []).includes(expectedSurfaceBadge)) {
      return lastBadges
    }
    await sleep(150)
  }
  assertNativePreviewBadge(lastBadges ?? { badges: [] })
}

async function waitForBackgroundSceneExercise(smoke) {
  const deadline = Date.now() + 8000
  let lastResult = null
  let lastError = null
  while (Date.now() < deadline) {
    lastResult = await smokeCommand(smoke, 'exercise-native-preview-scene-background')
    try {
      assertBackgroundSceneExercise(lastResult)
      return lastResult
    } catch (error) {
      lastError = error
      await sleep(150)
    }
  }
  throw (
    lastError ??
    new Error(`Background scene exercise did not complete: ${JSON.stringify(lastResult)}`)
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
  if (
    expectedSurfaceTransport === 'native-surface' &&
    (measurement.inputToPresentLatencyP95Ms ?? Number.POSITIVE_INFINITY) >
      maxInputToPresentLatencyP95Ms
  ) {
    throw new Error(
      `Native preview surface ${label} input-to-present p95 ${format(measurement.inputToPresentLatencyP95Ms)}ms exceeded ${maxInputToPresentLatencyP95Ms}ms.`
    )
  }
  if ((measurement.blankFrames ?? 0) > 0) {
    throw new Error(
      `Native preview surface ${label} reported ${measurement.blankFrames} blank frame(s).`
    )
  }
  if ((measurement.compositorFrames ?? 0) <= 0) {
    throw new Error(`Native preview surface ${label} did not receive compositor frames.`)
  }
  if (measurement.compositorState !== 'live') {
    throw new Error(
      `Native preview surface ${label} compositor state is ${measurement.compositorState}, expected live.`
    )
  }
  if (!measurement.width || !measurement.height) {
    throw new Error(
      `Native preview surface ${label} has invalid dimensions ${measurement.width}x${measurement.height}.`
    )
  }
}

function assertPreviewImagePollCountsIdle(counts = {}) {
  const total =
    (counts.cameraPng ?? 0) +
    (counts.screenPng ?? 0) +
    (counts.liveJpeg ?? 0) +
    (counts.liveMjpeg ?? 0)
  if (total > 0) {
    throw new Error(
      `Native preview surface smoke used image-poll routes: ${JSON.stringify(counts)}`
    )
  }
}

function assertNativeBootstrap(result, options = {}) {
  if (!result.hasStage) {
    throw new Error(`Preview card did not render: ${JSON.stringify(result)}`)
  }
  if (
    !result.hasVideorcBridge ||
    !result.hasCreateNativePreviewSurface ||
    !result.hasUpdateNativePreviewSurfaceBounds
  ) {
    throw new Error(`Native preview bridge is incomplete: ${JSON.stringify(result)}`)
  }
  if (!result.hasUpdateNativePreviewSurfaceScene) {
    throw new Error(`Native preview scene bridge is unavailable: ${JSON.stringify(result)}`)
  }
  if (options.requireNativePreview) {
    if (!result.previewWindowOpen || !result.hasNativePlaceholder) {
      throw new Error(
        `Detached preview window did not expose the native surface: ${JSON.stringify(result)}`
      )
    }
    if (result.surfaceTransport !== expectedSurfaceTransport) {
      throw new Error(
        `Detached preview transport is ${result.surfaceTransport}, expected ${expectedSurfaceTransport}: ${JSON.stringify(result)}`
      )
    }
    if (result.surfaceBacking !== expectedSurfaceBacking) {
      throw new Error(
        `Detached preview backing is ${result.surfaceBacking}, expected ${expectedSurfaceBacking}: ${JSON.stringify(result)}`
      )
    }
    if ((result.previewImageCount ?? 0) !== 0 || result.hasJpegPollingPreviewImage) {
      throw new Error(
        `Native preview rendered a JPEG/MJPEG fallback image: ${JSON.stringify(result)}`
      )
    }
  }
  if ((result.surfaceWidth ?? 0) <= 0 || (result.surfaceHeight ?? 0) <= 0) {
    throw new Error(`Preview surface/card has invalid bounds: ${JSON.stringify(result)}`)
  }
}

function assertNativePreviewBadge(result) {
  const badges = result.badges ?? []
  if (!badges.includes(expectedSurfaceBadge)) {
    throw new Error(
      `Preview stage badges did not include "${expectedSurfaceBadge}": ${JSON.stringify(badges)}`
    )
  }
}

function assertSceneExercise(result) {
  if (result.sceneRevision !== 2) {
    throw new Error(
      `Native preview scene revision ${result.sceneRevision} did not reach the surface.`
    )
  }
  if (result.compositorSceneRevision !== 2) {
    throw new Error(
      `Compositor scene revision ${result.compositorSceneRevision} did not reach the surface.`
    )
  }
  if (result.sceneMatchesCompositor !== true) {
    throw new Error(
      `Native preview scene did not match compositor revision: ${JSON.stringify(result)}`
    )
  }
  if ((result.layerCount ?? 0) < 2) {
    throw new Error(
      `Native preview scene rendered ${result.layerCount ?? 0} layer(s), expected at least 2.`
    )
  }
  if (result.cameraLeft !== '62%') {
    throw new Error(`Native preview camera layer left was ${result.cameraLeft}, expected 62%.`)
  }
  if ((result.updateLatencyMs ?? Number.POSITIVE_INFINITY) > 50) {
    throw new Error(
      `Native preview scene update took ${format(result.updateLatencyMs)}ms, expected <= 50ms.`
    )
  }
}

function assertBackgroundSceneExercise(result) {
  if (result.status?.state !== 'live') {
    throw new Error(
      `Native preview background scene status is ${result.status?.state}, expected live: ${JSON.stringify(result)}`
    )
  }
  if (result.backgroundLayer !== true) {
    throw new Error(`Native preview background layer was missing: ${JSON.stringify(result)}`)
  }
  if (
    result.backgroundLeft !== '0%' ||
    result.backgroundTop !== '0%' ||
    result.backgroundWidth !== '100%' ||
    result.backgroundHeight !== '100%'
  ) {
    throw new Error(
      `Native preview background layer did not fill the frame: ${JSON.stringify(result)}`
    )
  }
  if (result.backgroundZIndex !== '0' || result.screenZIndex !== '1') {
    throw new Error(
      `Native preview background/source stacking was wrong: ${JSON.stringify(result)}`
    )
  }
  if (result.backgroundObjectFit !== 'cover') {
    throw new Error(
      `Native preview background object-fit was ${result.backgroundObjectFit}, expected cover.`
    )
  }
  if (
    result.screenLeft !== '10%' ||
    result.screenTop !== '10%' ||
    result.screenWidth !== '80%' ||
    result.screenHeight !== '80%'
  ) {
    throw new Error(
      `Native preview screen source was not inset to the 80% stage: ${JSON.stringify(result)}`
    )
  }
  if ((result.layerCount ?? 0) < 3) {
    throw new Error(
      `Native preview background scene rendered ${result.layerCount ?? 0} layer(s), expected at least 3.`
    )
  }
}

function assertSceneReattach(result) {
  if (!result.previewWindowOpen) {
    throw new Error(`Preview window was not open during scene reattach: ${JSON.stringify(result)}`)
  }
  if (!result.surfaceExists) {
    throw new Error(
      `Native preview scene update did not recreate the detached surface: ${JSON.stringify(result)}`
    )
  }
  if (result.status?.state !== 'live') {
    throw new Error(
      `Native preview reattach status is ${result.status?.state}, expected live: ${JSON.stringify(result)}`
    )
  }
  if (
    result.status?.transport !== 'native-surface' &&
    result.status?.transport !== 'electron-proof-surface'
  ) {
    throw new Error(
      `Native preview reattach transport is ${result.status?.transport}, expected an active detached surface: ${JSON.stringify(result)}`
    )
  }
  if (
    !result.status?.bounds ||
    result.status.bounds.width <= 0 ||
    result.status.bounds.height <= 0
  ) {
    throw new Error(`Native preview reattach had invalid bounds: ${JSON.stringify(result)}`)
  }
  if (result.status.transport === 'electron-proof-surface' && result.surfaceVisible !== true) {
    throw new Error(
      `Electron proof surface was not visible after reattach: ${JSON.stringify(result)}`
    )
  }
  if (
    typeof result.targetSceneRevision === 'number' &&
    result.compositorSceneRevision !== result.targetSceneRevision
  ) {
    throw new Error(
      `Native preview reattach compositor scene revision was ${result.compositorSceneRevision}, expected ${result.targetSceneRevision}.`
    )
  }
  if (typeof result.targetSceneRevision === 'number' && result.sceneMatchesCompositor !== true) {
    throw new Error(`Native preview reattach scene mismatch: ${JSON.stringify(result)}`)
  }
  if ((result.layerCount ?? 0) < 1) {
    throw new Error(
      `Native preview reattach rendered ${result.layerCount ?? 0} layer(s), expected at least 1.`
    )
  }
}

function writePreviewSurfaceGateReport(summary) {
  mkdirSync(outputDirectory, { recursive: true })
  const reportPath = join(outputDirectory, 'preview-surface-gate.json')
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        expectedSurfaceTransport,
        expectedSurfaceBacking,
        automated: {
          initial: measurementSummary(summary.firstMeasurement, summary.firstStatus),
          resized: measurementSummary(summary.resizedMeasurement, summary.resizedStatus),
          moved: statusSummary(summary.movedStatus),
          restored: measurementSummary(summary.restoredMeasurement, summary.restoredStatus),
          reattached: statusSummary(summary.reattachedStatus),
          reattachedMain: statusSummary(summary.reattachedMainStatus),
          mainPumpReconnect: summary.pumpReconnect,
          resizeCount: summary.resizedDiagnostics.previewSurfaceResizeCount,
          sceneUpdateLatencyMs: summary.sceneExercise.updateLatencyMs,
          sceneReattachLatencyMs: summary.sceneReattach.updateLatencyMs
        },
        manualByEyeChecks: [
          {
            name: 'hand-wave currentness',
            status: 'pending-operator',
            acceptance:
              'Fast hand/cursor motion stays current, without rubber-banding or smooth-but-delayed playback.'
          },
          {
            name: 'screen-scroll sharpness',
            status: 'pending-operator',
            acceptance:
              '4K screen text and cursor edges remain sharp while scrolling, matching OBS side-by-side.'
          }
        ]
      },
      null,
      2
    )}\n`
  )
  return reportPath
}

function measurementSummary(measurement, status) {
  return {
    measuredFps: measurement.measuredFps,
    intervalP95Ms: measurement.intervalP95Ms,
    inputToPresentLatencyP95Ms: measurement.inputToPresentLatencyP95Ms,
    compositorFrameLag: measurement.compositorFrameLag,
    blankFrames: measurement.blankFrames,
    ...statusSummary(status)
  }
}

function statusSummary(status) {
  return {
    state: status.state,
    transport: status.transport,
    backing: status.backing,
    width: status.width,
    height: status.height,
    framesRendered: status.framesRendered,
    droppedFrames: status.droppedFrames,
    bounds: status.bounds
  }
}

function assertMainPumpReconnect(result) {
  if (result.watchdogDetected !== true) {
    throw new Error(
      `Main present pump watchdog did not detect the stalled event lane: ${JSON.stringify(result)}`
    )
  }
  if (result.fallback?.observed !== true) {
    throw new Error(`Renderer fallback ownership was not observed: ${JSON.stringify(result)}`)
  }
  if ((result.fallback?.frameDelta ?? 0) < 10) {
    throw new Error(
      `Renderer fallback advanced only ${result.fallback?.frameDelta ?? 'missing'} native frames; expected at least 10.`
    )
  }
  if (result.reconnected !== true) {
    throw new Error(`Main present pump did not reconnect: ${JSON.stringify(result)}`)
  }
  if ((result.finalFrameDelta ?? 0) <= result.fallback.frameDelta) {
    throw new Error(`Native frames stopped after main retook ownership: ${JSON.stringify(result)}`)
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
      const message = String(error?.message ?? error)
      if (
        !message.includes('Main window is not ready') &&
        !message.includes('Could not find tab ')
      ) {
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
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${smoke.capability}`
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
            rejectCommand(
              new Error(`${command} smoke command returned invalid JSON: ${text.slice(0, 200)}`)
            )
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

    const env = smokeAppEnv({
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: join(outputDirectory, 'user-data'),
      VIDEORC_NATIVE_PREVIEW_SURFACE: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      ...(packagedSmokeCapability
        ? {
            VIDEORC_PACKAGED_SMOKE_TEST: '1',
            VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCapability
          }
        : {}),
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
    })
    const spawnSpec = usePackagedApp
      ? appSpawnSpec({
          command: packagedAppExecutable,
          cwd: dirname(packagedAppExecutable),
          env
        })
      : devAppSpawnSpec({ env })
    appProcess = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options)

    const maybeResolve = () => {
      if (connections.backend && connections.smoke) {
        clearTimeout(timer)
        resolveConnections(connections)
      }
    }
    const handleOutput = (text) =>
      handleAppOutput(text, connections, maybeResolve, packagedSmokeCapability)

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
      rejectConnections(
        new Error(
          `Preview surface ${usePackagedApp ? 'packaged ' : ''}app exited before smoke completed: code=${code} signal=${signal}`
        )
      )
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

function handleAppOutput(text, connections, maybeResolve, expectedPackagedCapability = null) {
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
      if (expectedPackagedCapability) {
        connections.smoke.capability = expectedPackagedCapability
      }
      maybeResolve()
    }
  }
}

async function stopApp() {
  if (!appProcess?.pid || appProcess.killed) {
    appProcess = null
    stopping = false
    return
  }
  stopping = true
  await stopProcess(appProcess)
  appProcess = null
  stopping = false
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function format(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'n/a'
}
