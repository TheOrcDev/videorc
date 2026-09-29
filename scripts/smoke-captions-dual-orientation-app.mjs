import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import {
  analyzeCaptionsLiveArtifact,
  formatCaptionsLiveArtifactSummary
} from './lib/captions-live-artifact.mjs'
import { startFakeCaptionService } from './lib/fake-caption-service.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Plan 077 gate: live captions on BOTH legs of a dual-orientation stream.
//
// A record+stream session with a vertical destination armed: the vertical
// simulcast leg owns the auxiliary compositor output and the horizontal
// destination shares the primary leg with the recording. The real renderer
// consumes caption updates and rasterizes one bar per leg (landscape and
// portrait); the smoke never calls captions.overlay.set.
//
// Passing means: the horizontal received stream, the vertical received
// stream (which must be the portrait leg) and the recording all carry the
// High Contrast caption plate, and no second captioned copy is rendered.

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 240_000)
const baselineMs = Number(process.env.VIDEORC_CAPTIONS_DUAL_BASELINE_MS ?? 1_800)
const captionCaptureMs = Number(process.env.VIDEORC_CAPTIONS_DUAL_CAPTURE_MS ?? 3_000)
const listenerBindMs = Number(process.env.VIDEORC_CAPTIONS_DUAL_LISTENER_BIND_MS ?? 1_200)
const basePort = Number(process.env.VIDEORC_CAPTIONS_DUAL_RTMP_PORT ?? 19861)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-captions-dual-orientation-${Date.now()}`)
)
const stateRoot = join(outputDirectory, 'app-state')
const appDataDir = join(stateRoot, 'app-data')
const reportPath = join(outputDirectory, 'captions-dual-orientation-artifact.json')
const smokeSessionToken = 'captions-dual-session-token'
const smokeRealtimeToken = 'captions-dual-realtime-token'
const finalText = 'VIDEORC DUAL ORIENTATION CAPTION PROOF'
const captionTestMicrophoneId = 'microphone:coreaudio:4294967295'
const injectionMs = 3_000
const video = Object.freeze({
  preset: 'custom',
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 2500
})
const verticalVideo = Object.freeze({ ...video, width: 720, height: 1280 })
const timestamp = '2026-01-01T00:00:00.000Z'
const captionsProfile = Object.freeze({
  enabled: true,
  burnTarget: 'stream',
  styleId: 'high-contrast',
  language: 'en',
  styleRevision: 1,
  position: 'bottom',
  textSize: 'm'
})

mkdirSync(appDataDir, { recursive: true })
const secretsPath = join(appDataDir, 'videorc-secrets.json')
writeFileSync(
  secretsPath,
  JSON.stringify({ 'account:videorc:session': smokeSessionToken }, null, 2)
)
chmodSync(secretsPath, 0o600)

// Built-in target ids: the renderer rebuilds its target list from its fixed
// definitions and drops unknown ids, so both sides use `custom` and
// `youtube-vertical`.
const horizontalTarget = rtmpTarget('custom', 'custom', basePort, 'horizontal')
const verticalTarget = rtmpTarget('youtube-vertical', 'youtube', basePort + 1, 'vertical')

const fake = await startFakeCaptionService({
  smokeSessionToken,
  smokeRealtimeToken,
  provisionalFinalText: 'VIDEORC DUAL ORIENTATION',
  finalText,
  chunkText: finalText,
  itemId: 'captions-dual-orientation-proof',
  minSpeechPeak: 0.01
})
let launched
let backend
const listeners = []
let sessionActive = false

try {
  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_API_BASE_URL: fake.httpOrigin,
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_APP_DATA_DIR: appDataDir,
      VIDEORC_USER_DATA_DIR: join(stateRoot, 'user-data')
    }
  })
  backend = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  const smoke = launched.connections['preview-motion-ready']

  fake.state.realtimeAvailable = false
  fake.state.realtimeFailureCode = 'captions-realtime-disabled'
  await seedRendererDualProfile(smoke)
  await waitForCaptionStatus(
    backend,
    (status) => status.state === 'ready' && status.desiredEnabled === true
  )
  const health = await request(backend, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the dual captions smoke.')
  }

  for (const target of [horizontalTarget, verticalTarget]) {
    listeners.push(spawnRtmpListener(target))
  }
  await sleep(listenerBindMs)
  for (const listener of listeners) assertListenerRunning(listener)

  const outputAuthorization = await smokeCommand(smoke, 'authorize-smoke-resource', {
    kind: 'output-directory',
    path: outputDirectory
  })
  const started = await request(
    backend,
    timeoutMs,
    'session.start',
    sessionParams(outputAuthorization.capabilityId)
  )
  if (started.state !== 'recording' || !started.sessionId) {
    throw new Error(`Dual captions smoke did not enter record+stream: ${JSON.stringify(started)}`)
  }
  sessionActive = true
  await hydrateRendererActiveSession(smoke)

  await waitFor(
    () => fake.state.realtimeTokenRequests >= 1,
    Math.min(timeoutMs, 30_000),
    'session-started caption fallback'
  )
  await waitForCaptionStatus(
    backend,
    (status) => status.state === 'degraded' && status.transport === 'chunked'
  )
  // Clean frames before the caption, so the analyzer can prove the plate
  // arrived after the caption update instead of existing in the source.
  await sleep(baselineMs)
  const injection = await requestDebugBackend(smoke, 'audio.test.inject-pcm', {
    sessionId: started.sessionId,
    durationMs: injectionMs,
    rawPeak: 0.12
  })
  const overlays = await waitForBothCaptionOverlays(smoke)
  await sleep(captionCaptureMs)

  const stopRequestedAt = Date.now()
  const stopped = await request(backend, timeoutMs, 'session.stop', {})
  sessionActive = false
  for (const listener of listeners) await stopRtmpListener(listener)

  for (const target of [horizontalTarget, verticalTarget]) assertArtifactFile(target.receivedPath)
  const recordingPath = await resolveFinalRecordingPath({
    started,
    stopped,
    stopRequestedAt,
    timeoutMs: 120_000
  })
  if (!recordingPath) throw new Error('Dual captions smoke produced no recording path.')
  assertArtifactFile(recordingPath)

  const [horizontalProbe, verticalProbe] = await Promise.all([
    probeVideoSize(horizontalTarget.receivedPath),
    probeVideoSize(verticalTarget.receivedPath)
  ])
  if (horizontalProbe.width !== video.width || horizontalProbe.height !== video.height) {
    throw new Error(`Horizontal destination received ${JSON.stringify(horizontalProbe)}`)
  }
  if (
    verticalProbe.width !== verticalVideo.width ||
    verticalProbe.height !== verticalVideo.height
  ) {
    throw new Error(
      `Vertical destination did not receive the portrait leg: ${JSON.stringify(verticalProbe)}`
    )
  }

  const [horizontal, vertical, recording] = await Promise.all([
    analyzeCaptionsLiveArtifact(horizontalTarget.receivedPath, { ffmpegPath }),
    analyzeCaptionsLiveArtifact(verticalTarget.receivedPath, {
      ffmpegPath,
      sampleWidth: 360,
      sampleHeight: 640
    }),
    // The recording shares the horizontal leg's pixels (plan 077).
    analyzeCaptionsLiveArtifact(recordingPath, { ffmpegPath })
  ])
  // Frames for a by-eye check of both legs.
  await Promise.all([
    extractFrame(horizontalTarget.receivedPath, join(outputDirectory, 'horizontal-frame.png')),
    extractFrame(verticalTarget.receivedPath, join(outputDirectory, 'vertical-frame.png'))
  ])
  const captionedCopyPath = captionedPath(recordingPath)
  const failures = [
    ...horizontal.failures.map((failure) => `horizontal: ${failure}`),
    ...vertical.failures.map((failure) => `vertical: ${failure}`),
    ...recording.failures.map((failure) => `recording: ${failure}`)
  ]
  if (existsSync(captionedCopyPath)) {
    failures.push(`a second captioned copy was rendered: ${captionedCopyPath}`)
  }
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        pass: failures.length === 0,
        failures,
        overlays,
        injection,
        probes: { horizontal: horizontalProbe, vertical: verticalProbe },
        artifacts: { horizontal, vertical, recording }
      },
      null,
      2
    )
  )
  console.log(`[horizontal] ${formatCaptionsLiveArtifactSummary(horizontal)}`)
  console.log(`[vertical] ${formatCaptionsLiveArtifactSummary(vertical)}`)
  console.log(`[recording] ${formatCaptionsLiveArtifactSummary(recording)}`)
  if (failures.length > 0) {
    throw new Error(`Dual-orientation caption routing failed: ${failures.join('; ')}`)
  }
  console.log(
    `Dual-orientation captions smoke PASS — the renderer published a landscape bar to the ` +
      `horizontal stream and recording and a portrait bar to the ${verticalVideo.width}x` +
      `${verticalVideo.height} vertical stream, with no second captioned copy. ` +
      `Evidence: ${outputDirectory}`
  )
} catch (error) {
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        pass: false,
        error: error instanceof Error ? error.message : String(error),
        captionsStatus: backend ? await requestSafe(backend, 'captions.status.get', {}) : null,
        recordingStatus: backend ? await requestSafe(backend, 'recording.status', {}) : null
      },
      null,
      2
    )
  )
  throw new Error(
    `${error instanceof Error ? error.message : String(error)} Evidence: ${reportPath}`,
    { cause: error }
  )
} finally {
  try {
    if (backend) {
      if (sessionActive) await requestSafe(backend, 'session.stop', {})
      await requestSafe(backend, 'captions.stop', {})
      backend.close()
    }
    for (const listener of listeners) await stopRtmpListener(listener)
  } finally {
    await launched?.stop().catch(() => {})
    await fake.close()
  }
}

function rtmpTarget(id, platform, port, orientation) {
  return {
    id,
    platform,
    orientation,
    serverUrl: `rtmp://127.0.0.1:${port}/live`,
    streamKey: `captions-dual-${id}`,
    listenUrl: `rtmp://127.0.0.1:${port}/live/captions-dual-${id}`,
    receivedPath: join(outputDirectory, `${id}.flv`)
  }
}

function streamingSettings() {
  const target = (entry) => ({
    id: entry.id,
    platform: entry.platform,
    label: `Local ${entry.orientation}`,
    enabled: true,
    serverUrl: entry.serverUrl,
    urlMode: 'server-and-key',
    streamKey: entry.streamKey,
    streamKeyPresent: true,
    authMode: 'manual-rtmp',
    ...(entry.orientation === 'vertical' ? { outputOrientation: 'vertical' } : {}),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  return {
    enabled: true,
    mode: 'multi',
    targets: [target(horizontalTarget), target(verticalTarget)],
    selectedTargetId: horizontalTarget.id,
    enabledTargetIds: [horizontalTarget.id, verticalTarget.id],
    // Targets carry no preset of their own: horizontal ones share the
    // session profile, which dual orientation requires anyway.
    defaultOutputPreset: 'tutorial-1080p30',
    defaultBitrateKbps: 6000
  }
}

function sessionParams(outputDirectoryCapability) {
  const layout = {
    layoutPreset: 'screen-only',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraCornerRadiusPct: 12,
    cameraAspect: 'source',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right'
  }
  return {
    sources: { testPattern: true, microphoneId: captionTestMicrophoneId },
    layout,
    output: {
      recordEnabled: true,
      streamEnabled: true,
      outputDirectoryCapability,
      video,
      rtmp: {
        preset: 'custom',
        serverUrl: horizontalTarget.serverUrl,
        streamKey: horizontalTarget.streamKey
      }
    },
    streaming: streamingSettings(),
    simulcast: {
      layout: { ...layout, layoutPreset: 'vertical-screen-only', verticalScreenFraming: 'fit' },
      video: verticalVideo
    },
    captions: captionsProfile,
    audio: { microphoneGainDb: 0, microphoneMuted: false, microphoneSyncOffsetMs: 0 }
  }
}

async function seedRendererDualProfile(smoke) {
  // The renderer derives its caption rasters from the saved capture config,
  // exactly as for a user-started session, so it must see the same shape:
  // record + stream, a horizontal canvas, and an armed vertical destination.
  await smokeCommand(smoke, 'eval-js', {
    code: `
      let current = {}
      try { current = JSON.parse(localStorage.getItem('videorc.captureConfig') ?? '{}') } catch {}
      const next = {
        ...current,
        recordEnabled: true,
        streamEnabled: true,
        video: ${JSON.stringify(video)},
        streaming: { ...current.streaming, ...${JSON.stringify(streamingSettings())} },
        captions: ${JSON.stringify(captionsProfile)}
      }
      localStorage.setItem('videorc.captureConfig', JSON.stringify(next))
      localStorage.setItem('videorc.onboardingComplete', 'permissions-v1')
      window.setTimeout(() => window.location.reload(), 150)
      return true
    `
  })
  await sleep(750)
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    try {
      latest = await smokeCommand(smoke, 'eval-js', {
        code: `
          const stored = JSON.parse(localStorage.getItem('videorc.captureConfig') ?? '{}')
          return {
            ready: document.readyState === 'complete',
            burnTarget: stored.captions?.burnTarget,
            vertical: (stored.streaming?.targets ?? []).some(
              (target) => target.outputOrientation === 'vertical' &&
                (stored.streaming?.enabledTargetIds ?? []).includes(target.id)
            ),
            width: stored.video?.width
          }
        `
      })
      const result = latest?.result
      if (
        result?.ready &&
        result.burnTarget === 'stream' &&
        result.vertical &&
        result.width === 1280
      ) {
        return
      }
    } catch {
      // The main window rejects commands briefly while reloading.
    }
    await sleep(100)
  }
  throw new Error(`Renderer did not keep the dual-orientation profile: ${JSON.stringify(latest)}`)
}

async function hydrateRendererActiveSession(smoke) {
  const hydrated = await smokeCommand(smoke, 'eval-js', {
    code: `
      if (typeof window.__videorcSmokeHydrateRecordingStatus !== 'function') {
        throw new Error('Recording-status smoke hydrator is unavailable.')
      }
      const recording = await window.__videorcSmokeHydrateRecordingStatus()
      return { recordingState: recording.state }
    `
  })
  if (hydrated?.result?.recordingState !== 'recording') {
    throw new Error(`Renderer did not hydrate record+stream: ${JSON.stringify(hydrated)}`)
  }
}

async function waitForBothCaptionOverlays(smoke) {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  let latest = null
  while (Date.now() < deadline) {
    latest = await requestDebugBackend(smoke, 'captions.test.snapshot', {})
    const { primary, auxiliary } = latest?.overlays ?? {}
    if (primary?.active && auxiliary?.active) {
      // The auxiliary raster must be the PORTRAIT bar, sized for the
      // vertical canvas, not a landscape bar squeezed onto it.
      if (auxiliary.width > verticalVideo.width || primary.width <= auxiliary.width) {
        throw new Error(`Caption rasters have the wrong geometry: ${JSON.stringify(latest)}`)
      }
      return latest
    }
    await sleep(50)
  }
  throw new Error(`Timed out waiting for both caption overlays: ${JSON.stringify(latest)}`)
}

async function waitForCaptionStatus(connection, predicate) {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  let latest = null
  while (Date.now() < deadline) {
    latest = await request(connection, timeoutMs, 'captions.status.get', {})
    if (predicate(latest)) return latest
    await sleep(50)
  }
  throw new Error(`Timed out waiting for caption status: ${JSON.stringify(latest)}`)
}

function spawnRtmpListener(target) {
  const stderr = []
  const child = spawn(
    ffmpegPath,
    [
      '-y',
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      target.listenUrl,
      '-c',
      'copy',
      '-f',
      'flv',
      target.receivedPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text) => stderr.push(text))
  return { process: child, stderr }
}

function assertListenerRunning(listener) {
  if (listener.process.exitCode !== null) {
    throw new Error(`Local RTMP listener exited before streaming: ${listener.stderr.join('')}`)
  }
}

async function stopRtmpListener(listener) {
  const child = listener?.process
  if (!child?.pid || child.exitCode !== null) return
  await waitForExit(child, 5_000)
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await waitForExit(child, 1_500)
  if (child.exitCode === null) child.kill('SIGKILL')
  await waitForExit(child, 1_000)
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, timeout)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveWait()
    })
  })
}

async function probeVideoSize(filePath) {
  const output = await runProcess(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0:s=x',
    filePath
  ])
  const match = /^(\d+)x(\d+)/.exec(output.trim())
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

function extractFrame(filePath, framePath) {
  return runProcess(ffmpegPath, [
    '-v',
    'error',
    '-y',
    '-sseof',
    '-1.5',
    '-i',
    filePath,
    '-frames:v',
    '1',
    framePath
  ])
}

function runProcess(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text) => stdout.push(text))
    child.stderr.on('data', (text) => stderr.push(text))
    child.on('error', rejectRun)
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun(stdout.join(''))
        return
      }
      rejectRun(new Error(`${command} failed: code=${code} signal=${signal} ${stderr.join('')}`))
    })
  })
}

function assertArtifactFile(filePath) {
  const size = existsSync(filePath) ? statSync(filePath).size : 0
  if (size <= 0) throw new Error(`Caption artifact is missing or empty: ${filePath}`)
}

function captionedPath(filePath) {
  const extension = extname(filePath)
  return `${filePath.slice(0, filePath.length - extension.length)} (captioned)${extension}`
}

function requestDebugBackend(smoke, method, params) {
  return smokeCommand(smoke, 'backend-debug-rpc', { method, params, timeoutMs })
}

async function requestSafe(ws, method, params) {
  try {
    return await request(ws, 10_000, method, params)
  } catch {
    return null
  }
}

async function smokeCommand(smoke, command, params = {}) {
  const response = await fetch(`http://${smoke.host}:${smoke.port}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${smoke.capability}`
    },
    body: JSON.stringify({ command, params }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const payload = await response.json()
  if (!response.ok || !payload.ok) {
    throw new Error(payload?.error ?? `${command} smoke command failed`)
  }
  return payload.result
}

function waitFor(predicate, deadlineMs, label) {
  return new Promise((resolveWait, rejectWait) => {
    const startedAt = Date.now()
    const tick = () => {
      if (predicate()) {
        resolveWait()
        return
      }
      if (Date.now() - startedAt > deadlineMs) {
        rejectWait(new Error(`Timed out waiting for ${label}.`))
        return
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
