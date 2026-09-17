import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { performanceAppSpawnSpec, launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { nativeWindowsScreenCandidates } from './lib/windows-native-screen-gates.mjs'
import {
  assertLiveAudioUpdate,
  evaluateLiveAudioEvidence,
  liveAudioEvidenceWindows,
  parseCaptureMediaClock,
  parseFfmpegMaxVolume,
  projectWallTimeToMediaSeconds,
  selectWindowsDshowCamera,
  selectWindowsDshowMicrophone
} from './lib/windows-live-audio-gates.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

if (process.platform !== 'win32') {
  throw new Error('The physical Windows live-microphone smoke must run on Windows.')
}

const spawnSpec = performanceAppSpawnSpec()
if (!spawnSpec) {
  throw new Error('Set VIDEORC_PERF_APP_EXECUTABLE to the packaged Videorc.exe.')
}

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-windows-live-audio-${Date.now()}`)
)
const supportBundleEvidencePath = resolve(
  process.env.VIDEORC_WINDOWS_SUPPORT_BUNDLE_PATH ?? join(outputDirectory, 'support-bundle.json')
)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 240_000)
const untouchedMs = Number(process.env.VIDEORC_WINDOWS_LIVE_AUDIO_UNTOUCHED_MS ?? 10_000)
const holdMs = Number(process.env.VIDEORC_WINDOWS_LIVE_AUDIO_HOLD_MS ?? 3_500)
const listenerBindMs = Number(process.env.VIDEORC_SMOKE_LISTENER_BIND_MS ?? 1_500)
const sourceWarmupMs = Number(process.env.VIDEORC_WINDOWS_SOURCE_WARMUP_MS ?? 30_000)
const stopRaceTimeoutMs = Number(process.env.VIDEORC_WINDOWS_LIVE_AUDIO_STOP_RACE_MS ?? 15_000)
const basePort = Number(process.env.VIDEORC_WINDOWS_LIVE_AUDIO_RTMP_PORT ?? 12935)
const preferredMicrophoneId = process.env.VIDEORC_WINDOWS_LIVE_AUDIO_MICROPHONE_ID
const preferredCameraId = process.env.VIDEORC_WINDOWS_LIVE_AUDIO_CAMERA_ID
const video = {
  preset: 'custom',
  width: Number(process.env.VIDEORC_SMOKE_VIDEO_WIDTH ?? 1280),
  height: Number(process.env.VIDEORC_SMOKE_VIDEO_HEIGHT ?? 720),
  fps: Number(process.env.VIDEORC_SMOKE_VIDEO_FPS ?? 30),
  bitrateKbps: Number(process.env.VIDEORC_SMOKE_VIDEO_BITRATE_KBPS ?? 2_000)
}
const scenarios = [
  { label: 'record-only', record: true, stream: false },
  { label: 'record-and-stream', record: true, stream: true },
  { label: 'stream-only', record: false, stream: true }
]
const diagnosticSessionLogCodes = new Set([
  'windows-directshow-audio-shape',
  'capture-media-clock-ready',
  'live-audio-command-ready',
  'live-audio-command-dispatched',
  'live-audio-command-terminal',
  'live-audio-control-failed',
  'ffmpeg-first-fatal-line'
])

mkdirSync(outputDirectory, { recursive: true })
console.log(
  'Windows live microphone smoke requires a steady, unclipped calibration tone at the selected physical microphone.'
)

const packagedSmokeCommandCapability = randomBytes(32).toString('base64url')
const launched = await launchDevApp({
  spawnSpec,
  timeoutMs,
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  packagedSmokeCommandCapability,
  env: {
    VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
    VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
    VIDEORC_DISABLE_AUTO_PREVIEW: '1',
    VIDEORC_SMOKE_COMMAND_SERVER: '1',
    VIDEORC_PACKAGED_SMOKE_TEST: '1',
    VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCommandCapability,
    VIDEORC_WINDOWS_LIVE_AUDIO_SMOKE: '1'
  }
})

let ws
const listeners = new Set()
const recordingStatusEvents = []
const healthEvents = []
const report = {
  schemaVersion: 1,
  kind: 'windows-live-audio-controls',
  startedAt: new Date().toISOString(),
  sources: null,
  sessionLogs: [],
  scenarios: [],
  stopRace: null,
  supportBundle: null
}

try {
  const connection = launched.connections['backend-ready']
  const rendererSmoke = launched.connections['preview-motion-ready']
  ws = await connectBackend(connection, timeoutMs)
  ws.addEventListener('message', captureBackendEvent)
  const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(health?.ffmpeg?.message ?? 'Bundled FFmpeg is unavailable.')
  }
  const deviceList = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const devices = deviceList?.devices ?? []
  const microphone = selectWindowsDshowMicrophone(devices, preferredMicrophoneId)
  if (!microphone) {
    const discovered = devices
      .filter((device) => device?.kind === 'microphone')
      .map((device) => `${device.id}:${device.status}`)
    throw new Error(
      `BLOCKED: no available physical Windows DirectShow microphone. Discovered: ${discovered.join(', ') || 'none'}`
    )
  }
  const camera = selectWindowsDshowCamera(devices, preferredCameraId)
  if (!camera) {
    const discovered = devices
      .filter((device) => device?.kind === 'camera')
      .map((device) => `${device.id}:${device.status}`)
    throw new Error(
      `BLOCKED: no available physical Windows DirectShow camera for the Screen + Cam acceptance scenario. Discovered: ${discovered.join(', ') || 'none'}`
    )
  }
  const screenCandidates = nativeWindowsScreenCandidates(devices)
  if (screenCandidates.length === 0) {
    throw new Error(
      'BLOCKED: no available Windows DXGI or gdigrab screen for the Screen + Cam acceptance scenario.'
    )
  }
  const sources = await warmPhysicalSources(ws, screenCandidates, camera, microphone)
  const rendererDriver = await configureRendererDriver(rendererSmoke, sources)
  report.sources = {
    screen: deviceSummary(sources.screen),
    camera: deviceSummary(camera),
    microphone: deviceSummary(microphone)
  }
  console.log(
    `Selected Screen + Cam sources: ${sources.screen.name}, ${camera.name}, ${microphone.name}`
  )

  for (const [index, scenario] of scenarios.entries()) {
    report.scenarios.push(
      await runScenario(
        ws,
        sources,
        scenario,
        index,
        scenario.label === 'record-only' ? rendererDriver : null
      )
    )
  }
  report.stopRace = await runStopRace(ws, sources)
  report.supportBundle = await exportSupportBundleEvidence('passed')
  report.status = 'passed'
  report.finishedAt = new Date().toISOString()
  writeReport()
  console.log(
    `Windows physical live microphone PASS: ${scenarios.map((scenario) => scenario.label).join(', ')}, plus stop-during-update. Evidence: ${reportPath()}`
  )
} catch (error) {
  const blocked = String(error?.message ?? error).startsWith('BLOCKED:')
  report.status = blocked ? 'blocked' : 'failed'
  report.error = { message: error?.message ?? String(error) }
  if (ws && !report.supportBundle) {
    try {
      report.supportBundle = await exportSupportBundleEvidence(report.status)
    } catch (bundleError) {
      report.supportBundle = { error: bundleError?.message ?? String(bundleError) }
    }
  }
  report.finishedAt = new Date().toISOString()
  writeReport()
  if (blocked) {
    console.error(`Windows physical live microphone BLOCKED: ${error?.message ?? String(error)}`)
    process.exitCode = 2
  } else {
    throw error
  }
} finally {
  if (ws) {
    await request(ws, 10_000, 'preview.camera.stop').catch(() => null)
    await request(ws, 10_000, 'preview.screen.stop').catch(() => null)
    ws.close()
  }
  for (const listener of listeners) await stopListener(listener)
  await launched.stop()
}

async function warmPhysicalSources(ws, screenCandidates, camera, microphone) {
  const failures = []
  let screen = null
  for (const candidate of screenCandidates) {
    const candidateSources = sourceSelection(candidate, camera, microphone)
    try {
      await request(ws, timeoutMs, 'preview.screen.start', {
        sources: candidateSources,
        video,
        protectedOverlayWindowIds: [],
        ffmpegPath
      })
      await waitForPreviewStatus(
        ws,
        'preview.screen.status',
        (status) =>
          status?.state === 'live' &&
          status.sourceId === candidate.id &&
          ((status.framesCaptured ?? 0) > 0 || status.sequence != null),
        `screen ${candidate.id}`
      )
      screen = candidate
      break
    } catch (error) {
      failures.push(`${candidate.id}: ${error?.message ?? error}`)
      await request(ws, 10_000, 'preview.screen.stop').catch(() => null)
    }
  }
  if (!screen) {
    throw new Error(`No Windows screen source became live: ${failures.join('; ')}`)
  }

  const sources = sourceSelection(screen, camera, microphone)
  await request(ws, timeoutMs, 'preview.camera.start', {
    sources,
    layout: layoutSettings(),
    video,
    ffmpegPath
  })
  await waitForPreviewStatus(
    ws,
    'preview.camera.status',
    (status) =>
      status?.state === 'live' &&
      status.cameraId === camera.id &&
      ((status.framesCaptured ?? 0) > 0 || status.sequence != null),
    `camera ${camera.id}`
  )
  return { screen, camera, microphone }
}

async function waitForPreviewStatus(ws, method, predicate, label) {
  const deadline = Date.now() + sourceWarmupMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, method)
    if (predicate(last)) return last
    if (['failed', 'source-missing', 'device-missing', 'permission-needed'].includes(last?.state)) {
      break
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for live ${label}: ${JSON.stringify(last)}`)
}

async function configureRendererDriver(smoke, sources) {
  const deadline = Date.now() + sourceWarmupMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const state = await rendererCommand(
        smoke,
        {
          action: 'configure',
          screenId: sources.screen.id,
          cameraId: sources.camera.id,
          microphoneId: sources.microphone.id
        },
        20_000
      )
      if (
        state.sources?.screenId === sources.screen.id &&
        state.sources?.cameraId === sources.camera.id &&
        state.sources?.microphoneId === sources.microphone.id &&
        state.sources?.testPattern === false &&
        state.layout?.layoutPreset === 'screen-camera' &&
        state.video?.width === 1280 &&
        state.video?.height === 720 &&
        state.video?.fps === 30 &&
        state.output?.recordEnabled === true &&
        state.output?.streamEnabled === false
      ) {
        return { smoke }
      }
      lastError = new Error(`Renderer returned the wrong capture profile: ${JSON.stringify(state)}`)
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(
    `Renderer Windows live-audio harness could not configure physical sources: ${lastError?.message ?? lastError ?? 'unknown error'}`
  )
}

async function runScenario(ws, sources, scenario, index, rendererDriver) {
  const target = scenario.stream ? streamTarget(scenario.label, basePort + index) : null
  const listener = target ? spawnListener(target) : null
  if (listener) {
    listeners.add(listener)
    await sleep(listenerBindMs)
  }

  const rendererBaseline = rendererDriver
    ? await rendererCommand(rendererDriver.smoke, { action: 'state' })
    : null
  if (rendererBaseline?.lastError) {
    throw new Error(
      `[${scenario.label}] renderer was already reporting: ${rendererBaseline.lastError}`
    )
  }
  let started
  if (rendererDriver) {
    const rendererStarted = await rendererCommand(
      rendererDriver.smoke,
      { action: 'start' },
      timeoutMs
    )
    if (rendererStarted.lastError) {
      throw new Error(`[${scenario.label}] renderer start failed: ${rendererStarted.lastError}`)
    }
    started = await request(ws, timeoutMs, 'recording.status')
    if (
      rendererStarted.recording?.sessionId !== started?.sessionId ||
      rendererStarted.recording?.state !== started?.state
    ) {
      throw new Error(
        `[${scenario.label}] renderer/backend start state diverged: renderer=${JSON.stringify(rendererStarted.recording)} backend=${JSON.stringify(started)}`
      )
    }
  } else {
    started = await request(
      ws,
      timeoutMs,
      'session.start',
      sessionParams(sources, scenario, target)
    )
  }
  const expectedState = scenario.record ? 'recording' : 'streaming'
  if (started?.state !== expectedState || !started.sessionId) {
    throw new Error(`[${scenario.label}] expected ${expectedState}, got ${JSON.stringify(started)}`)
  }
  const sessionId = started.sessionId
  await sleep(untouchedMs)
  await assertSessionActive(ws, sessionId, expectedState, `${scenario.label} untouched interval`)
  if (rendererDriver) {
    const untouchedState = await rendererCommand(rendererDriver.smoke, { action: 'state' })
    if (
      untouchedState.recording?.sessionId !== sessionId ||
      untouchedState.recording?.state !== expectedState ||
      untouchedState.telemetry?.requestedCount !== rendererBaseline.telemetry?.requestedCount ||
      untouchedState.lastError
    ) {
      throw new Error(
        `[${scenario.label}] untouched renderer start mutated live audio or warned: baseline=${JSON.stringify(rendererBaseline)} current=${JSON.stringify(untouchedState)}`
      )
    }
  }

  const acknowledgements = []
  acknowledgements.push(
    await applyAndHold(ws, rendererDriver, {
      sessionId,
      microphoneGainDb: 6,
      microphoneMuted: false,
      label: '+6 dB'
    })
  )
  acknowledgements.push(
    await applyAndHold(ws, rendererDriver, {
      sessionId,
      microphoneGainDb: 6,
      microphoneMuted: true,
      label: 'mute'
    })
  )
  acknowledgements.push(
    await applyAndHold(ws, rendererDriver, {
      sessionId,
      microphoneGainDb: 0,
      microphoneMuted: false,
      label: 'unmute'
    })
  )
  if (rendererDriver) {
    acknowledgements.push(await applyRendererRapidBurst(rendererDriver, sessionId))
  }
  const stopRequestedAt = Date.now()
  let stopped
  if (rendererDriver) {
    const rendererStopped = await rendererCommand(
      rendererDriver.smoke,
      { action: 'stop' },
      timeoutMs
    )
    if (rendererStopped.lastError) {
      throw new Error(`[${scenario.label}] renderer stop failed: ${rendererStopped.lastError}`)
    }
    stopped = await request(ws, timeoutMs, 'recording.status')
  } else {
    stopped = await request(ws, timeoutMs, 'session.stop')
  }
  if (listener) {
    const exited = await waitForExit(listener, 5_000)
    if (!exited) await stopListener(listener)
    listeners.delete(listener)
  }

  const artifacts = []
  if (scenario.record) {
    const recordingPath = await resolveFinalRecordingPath({
      started,
      stopped,
      recordingStatusEvents,
      healthEvents,
      stopRequestedAt,
      timeoutMs
    })
    if (!recordingPath) {
      throw new Error(`[${scenario.label}] no finalized recording artifact became available.`)
    }
    artifacts.push({ role: 'recording', path: recordingPath })
  }
  if (target) artifacts.push({ role: 'stream', path: target.recvPath })
  const mediaClock = await captureMediaClockForSession(sessionId)
  const acknowledgementsWithMediaTime = acknowledgements.map((acknowledgement) => ({
    ...acknowledgement,
    mediaSeconds: projectWallTimeToMediaSeconds(mediaClock, acknowledgement.acknowledgedAtMs)
  }))
  const stopSeconds = projectWallTimeToMediaSeconds(mediaClock, stopRequestedAt)
  const windows = liveAudioEvidenceWindows({
    gainAckSeconds: acknowledgementsWithMediaTime[0].mediaSeconds,
    muteAckSeconds: acknowledgementsWithMediaTime[1].mediaSeconds,
    unmuteAckSeconds: acknowledgementsWithMediaTime.at(-1).mediaSeconds,
    stopSeconds
  })
  const artifactEvidence = []
  for (const artifact of artifacts) {
    assertArtifact(artifact.path, scenario.label, artifact.role)
    const quality = await analyzeRecording(artifact.path, {
      ffmpegPath,
      ffprobePath,
      intendedFps: video.fps,
      expectAudio: true,
      gates: { requireMotion: false }
    })
    const qualityPaths = writeReports(quality, {
      outDir: join(outputDirectory, scenario.label, artifact.role)
    })
    if (!quality.verdict.pass) {
      throw new Error(
        `[${scenario.label}] ${artifact.role} quality failed: ${quality.verdict.failures.join('; ')} (report: ${qualityPaths.mdPath})`
      )
    }
    if (!Number.isFinite(quality.metrics.durationSeconds) || quality.metrics.durationSeconds < 15) {
      throw new Error(
        `[${scenario.label}] ${artifact.role} duration ${quality.metrics.durationSeconds ?? 'unknown'}s is below the 15s Windows acceptance floor.`
      )
    }
    const levels = {
      baselineDb: await detectMaxVolume(artifact.path, windows.baseline),
      gainedDb: await detectMaxVolume(artifact.path, windows.gained),
      mutedDb: await detectMaxVolume(artifact.path, windows.muted),
      restoredDb: await detectMaxVolume(artifact.path, windows.restored)
    }
    const failures = evaluateLiveAudioEvidence(levels)
    if (failures.length > 0) {
      throw new Error(
        `[${scenario.label}] ${artifact.role} live microphone artifact failed: ${failures.join('; ')}`
      )
    }
    artifactEvidence.push({ ...artifact, qualityReport: qualityPaths.mdPath, levels })
  }
  const diagnostics = await requireSessionDiagnostics(sessionId, [
    'windows-directshow-audio-shape',
    'capture-media-clock-ready',
    'live-audio-command-ready'
  ])
  console.log(
    `[${scenario.label}] PASS acknowledgements=${acknowledgements.map((ack) => `${ack.label}:${ack.latencyMs}ms`).join(', ')}`
  )
  return {
    label: scenario.label,
    sessionId,
    untouchedMs,
    acknowledgements: acknowledgementsWithMediaTime,
    stopSeconds,
    windows,
    artifacts: artifactEvidence,
    diagnostics
  }
}

async function applyAndHold(ws, rendererDriver, requested) {
  if (rendererDriver) {
    return applyRendererAndHold(rendererDriver, requested)
  }
  const { label, ...params } = requested
  const sentAt = Date.now()
  const result = await request(ws, timeoutMs, 'audio.processing.update', params)
  const acknowledgedAt = Date.now()
  assertLiveAudioUpdate(result, params)
  const evidence = {
    label,
    latencyMs: acknowledgedAt - sentAt,
    acknowledgedAtMs: acknowledgedAt,
    result
  }
  await sleep(holdMs)
  await assertSessionActive(ws, requested.sessionId, null, `${label} hold`)
  return evidence
}

async function applyRendererAndHold(rendererDriver, requested) {
  const { label, ...params } = requested
  const before = await rendererCommand(rendererDriver.smoke, { action: 'state' })
  const sentAt = Date.now()
  await rendererCommand(rendererDriver.smoke, {
    action: 'set-audio',
    microphoneGainDb: params.microphoneGainDb,
    microphoneMuted: params.microphoneMuted
  })
  const state = await waitForRendererState(rendererDriver, (candidate) => {
    const settled = candidate.telemetry?.lastSettled
    return (
      candidate.telemetry?.requestedCount === before.telemetry?.requestedCount + 1 &&
      candidate.telemetry?.settledCount === before.telemetry?.settledCount + 1 &&
      settled?.requested?.sessionId === params.sessionId &&
      settled.requested.microphoneGainDb === params.microphoneGainDb &&
      settled.requested.microphoneMuted === params.microphoneMuted
    )
  })
  const acknowledgedAt = Date.now()
  assertRendererAppliedState(state, params, label)
  await sleep(holdMs)
  await assertSessionActiveRenderer(rendererDriver, params.sessionId, `${label} hold`)
  return {
    label,
    latencyMs: acknowledgedAt - sentAt,
    acknowledgedAtMs: acknowledgedAt,
    result: rendererAppliedResult(state)
  }
}

async function applyRendererRapidBurst(rendererDriver, sessionId) {
  const before = await rendererCommand(rendererDriver.smoke, { action: 'state' })
  const sentAt = Date.now()
  await rendererCommand(rendererDriver.smoke, { action: 'rapid-burst' })
  const state = await waitForRendererState(rendererDriver, (candidate) => {
    const settled = candidate.telemetry?.lastSettled
    return (
      candidate.telemetry?.settledCount > before.telemetry?.settledCount &&
      settled?.requested?.sessionId === sessionId &&
      settled.requested.microphoneGainDb === 0 &&
      settled.requested.microphoneMuted === false
    )
  })
  const acknowledgedAt = Date.now()
  const requestDelta = state.telemetry.requestedCount - before.telemetry.requestedCount
  if (requestDelta < 1 || requestDelta > 2) {
    throw new Error(
      `Renderer rapid slider burst sent ${requestDelta} live-audio RPCs; expected one in flight plus at most the newest pending state.`
    )
  }
  assertRendererAppliedState(
    state,
    { sessionId, microphoneGainDb: 0, microphoneMuted: false },
    'rapid slider burst'
  )
  await sleep(holdMs)
  await assertSessionActiveRenderer(rendererDriver, sessionId, 'rapid slider burst hold')
  return {
    label: 'rapid burst settled',
    latencyMs: acknowledgedAt - sentAt,
    acknowledgedAtMs: acknowledgedAt,
    coalescedRequestCount: requestDelta,
    result: rendererAppliedResult(state)
  }
}

function assertRendererAppliedState(state, expected, label) {
  const result = rendererAppliedResult(state)
  assertLiveAudioUpdate(result, expected)
  if (state.lastError) {
    throw new Error(`[${label}] renderer reported a microphone warning: ${state.lastError}`)
  }
}

function rendererAppliedResult(state) {
  const settled = state.telemetry?.lastSettled
  return {
    applied: settled?.applied === true,
    sessionId: settled?.requested?.sessionId,
    microphoneGainDb: settled?.settings?.microphoneGainDb,
    microphoneMuted: settled?.settings?.microphoneMuted,
    ...(settled?.reasonCode ? { reasonCode: settled.reasonCode } : {})
  }
}

async function assertSessionActiveRenderer(rendererDriver, sessionId, label) {
  const state = await rendererCommand(rendererDriver.smoke, { action: 'state' })
  if (
    state.recording?.sessionId !== sessionId ||
    !['recording', 'streaming'].includes(state.recording?.state) ||
    state.lastError
  ) {
    throw new Error(
      `[${label}] renderer capture state was not trustworthy: ${JSON.stringify(state)}`
    )
  }
}

async function waitForRendererState(rendererDriver, predicate) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await rendererCommand(rendererDriver.smoke, { action: 'state' })
    if (predicate(last)) return last
    if (last?.lastError) {
      throw new Error(
        `Renderer reported an error while awaiting live-audio state: ${last.lastError}`
      )
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for renderer live-audio state: ${JSON.stringify(last)}`)
}

function rendererCommand(smoke, request, commandTimeoutMs = 15_000) {
  return requestSmokeCommand(smoke, 'windows-live-audio-harness', request, {
    timeoutMs: commandTimeoutMs
  })
}

async function runStopRace(ws, sources) {
  const scenario = { label: 'stop-race', record: true, stream: false }
  const started = await request(ws, timeoutMs, 'session.start', sessionParams(sources, scenario))
  if (started?.state !== 'recording' || !started.sessionId) {
    throw new Error(`[stop-race] could not start: ${JSON.stringify(started)}`)
  }
  await sleep(3_000)
  const requested = {
    sessionId: started.sessionId,
    microphoneGainDb: -6,
    microphoneMuted: false
  }
  const dispatchCountBefore = report.sessionLogs.filter(
    (entry) =>
      entry.sessionId === started.sessionId && entry.code === 'live-audio-command-dispatched'
  ).length
  const updatePromise = request(ws, timeoutMs, 'audio.processing.update', requested)
  let dispatchEvidence
  try {
    dispatchEvidence = await waitForSessionDiagnosticCount(
      started.sessionId,
      'live-audio-command-dispatched',
      dispatchCountBefore + 1,
      stopRaceTimeoutMs
    )
  } catch (error) {
    await request(ws, timeoutMs, 'session.stop').catch(() => null)
    await updatePromise.catch(() => null)
    throw error
  }
  const stopRequestedAt = Date.now()
  const stopPromise = request(ws, timeoutMs, 'session.stop')
  const [update, stopped] = await withTimeout(
    Promise.all([updatePromise, stopPromise]),
    stopRaceTimeoutMs,
    `stop and in-flight microphone update did not settle within ${stopRaceTimeoutMs}ms`
  )
  const elapsedMs = Date.now() - stopRequestedAt
  if (update?.applied !== false || update?.reasonCode !== 'session-ended') {
    throw new Error(
      `[stop-race] the dispatched in-flight update was not interrupted as session-ended: ${JSON.stringify(update)}`
    )
  }
  const outputPath = await resolveFinalRecordingPath({
    started,
    stopped,
    recordingStatusEvents,
    healthEvents,
    stopRequestedAt,
    timeoutMs
  })
  if (!outputPath) {
    throw new Error('[stop-race] no finalized recording artifact became available.')
  }
  assertArtifact(outputPath, 'stop-race', 'recording')
  const quality = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: video.fps,
    expectAudio: true,
    gates: { requireMotion: false }
  })
  const qualityPaths = writeReports(quality, { outDir: join(outputDirectory, 'stop-race') })
  if (!quality.verdict.pass) {
    throw new Error(
      `[stop-race] final artifact failed: ${quality.verdict.failures.join('; ')} (report: ${qualityPaths.mdPath})`
    )
  }
  const diagnostics = await requireSessionDiagnostics(started.sessionId, [
    'windows-directshow-audio-shape',
    'capture-media-clock-ready',
    'live-audio-command-ready',
    'live-audio-command-dispatched',
    'live-audio-command-terminal'
  ])
  console.log(
    `[stop-race] PASS update=${update.applied ? 'applied' : update.reasonCode} elapsed=${elapsedMs}ms`
  )
  return {
    sessionId: started.sessionId,
    update,
    elapsedMs,
    timeoutMs: stopRaceTimeoutMs,
    dispatchEvidence,
    outputPath,
    qualityReport: qualityPaths.mdPath,
    diagnostics
  }
}

function sessionParams(sources, scenario, target = null) {
  const timestamp = new Date().toISOString()
  const streaming = target
    ? {
        enabled: true,
        mode: 'single',
        targets: [
          {
            id: `custom-${scenario.label}`,
            platform: 'custom',
            label: `Local ${scenario.label}`,
            enabled: true,
            serverUrl: target.serverUrl,
            urlMode: 'server-and-key',
            streamKey: target.streamKey,
            streamKeyPresent: true,
            authMode: 'manual-rtmp',
            createdAt: timestamp,
            updatedAt: timestamp
          }
        ],
        defaultOutputPreset: 'tutorial-1080p30',
        defaultBitrateKbps: video.bitrateKbps,
        enabledTargetIds: [`custom-${scenario.label}`]
      }
    : undefined
  return {
    sources: sourceSelection(sources.screen, sources.camera, sources.microphone),
    layout: layoutSettings(),
    output: {
      recordEnabled: scenario.record,
      streamEnabled: scenario.stream,
      video,
      rtmp: target
        ? { preset: 'custom', serverUrl: target.serverUrl, streamKey: target.streamKey }
        : { preset: 'custom', serverUrl: '', streamKey: '' }
    },
    ...(streaming ? { streaming } : {}),
    audio: { microphoneGainDb: 0, microphoneMuted: false, microphoneSyncOffsetMs: 0 }
  }
}

function sourceSelection(screen, camera, microphone) {
  return {
    screenId: screen.id,
    cameraId: camera.id,
    microphoneId: microphone.id,
    testPattern: false
  }
}

function layoutSettings() {
  return {
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
  }
}

function deviceSummary(device) {
  return { id: device.id, name: device.name, detail: device.detail ?? null }
}

function captureBackendEvent(event) {
  try {
    const message = JSON.parse(event.data)
    const receivedAt = Date.now()
    if (message?.event === 'recording.status') {
      recordingStatusEvents.push({ ...message.payload, receivedAt })
    }
    if (message?.event === 'health.event') {
      healthEvents.push({ ...message.payload, receivedAt })
    }
    const entry = message?.event === 'session.log' ? message.payload : null
    if (!diagnosticSessionLogCodes.has(entry?.code)) return
    report.sessionLogs.push({
      sessionId: entry.sessionId,
      level: entry.level,
      code: entry.code,
      message: entry.message,
      createdAt: entry.createdAt,
      receivedAtMs: receivedAt
    })
  } catch {
    // Non-JSON websocket traffic is irrelevant to the evidence report.
  }
}

async function captureMediaClockForSession(sessionId) {
  const entries = await requireSessionDiagnostics(sessionId, ['capture-media-clock-ready'])
  const entry = entries.find((candidate) => candidate.code === 'capture-media-clock-ready')
  return parseCaptureMediaClock(entry.message, entry.receivedAtMs)
}

async function requireSessionDiagnostics(sessionId, requiredCodes) {
  const deadline = Date.now() + 5_000
  let entries = []
  while (Date.now() < deadline) {
    entries = report.sessionLogs.filter((entry) => entry.sessionId === sessionId)
    if (requiredCodes.every((code) => entries.some((entry) => entry.code === code))) break
    await sleep(50)
  }
  const missing = requiredCodes.filter((code) => !entries.some((entry) => entry.code === code))
  if (missing.length > 0) {
    throw new Error(
      `[${sessionId}] required sanitized diagnostics were not emitted: ${missing.join(', ')}`
    )
  }
  const shape = entries.find((entry) => entry.code === 'windows-directshow-audio-shape')
  if (!/inputShape=device-default\s+outputShape=48000Hz\/stereo/.test(shape?.message ?? '')) {
    throw new Error(`[${sessionId}] DirectShow audio shape diagnostic was invalid.`)
  }
  return entries
}

async function waitForSessionDiagnosticCount(sessionId, code, minimumCount, waitMs) {
  const deadline = Date.now() + waitMs
  let matches = []
  while (Date.now() < deadline) {
    matches = report.sessionLogs.filter(
      (entry) => entry.sessionId === sessionId && entry.code === code
    )
    if (matches.length >= minimumCount) return matches.at(-1)
    await sleep(25)
  }
  throw new Error(
    `[${sessionId}] ${code} did not reach count ${minimumCount}; observed ${matches.length}.`
  )
}

async function exportSupportBundleEvidence(status) {
  const result = await request(ws, timeoutMs, 'diagnostics.supportBundle.export', {
    ffmpegPath,
    rendererDiagnostics: {
      windowsLiveAudioSmoke: {
        status,
        sessionIds: [
          ...report.scenarios.map((scenario) => scenario.sessionId),
          ...(report.stopRace?.sessionId ? [report.stopRace.sessionId] : [])
        ]
      }
    }
  })
  if (!result?.path || !existsSync(result.path)) {
    throw new Error('Support bundle export did not produce a readable artifact.')
  }
  copyFileSync(result.path, supportBundleEvidencePath)
  return {
    path: supportBundleEvidencePath,
    includedSections: result.includedSections,
    redactionSummary: result.redactionSummary
  }
}

function streamTarget(label, port) {
  const streamKey = `videorc-${label}`
  return {
    port,
    streamKey,
    serverUrl: `rtmp://127.0.0.1:${port}/live`,
    listenUrl: `rtmp://127.0.0.1:${port}/live/${streamKey}`,
    recvPath: join(outputDirectory, `${label}.flv`)
  }
}

function spawnListener(target) {
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
      target.listenUrl,
      '-c',
      'copy',
      '-f',
      'flv',
      target.recvPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text) => {
    if (text.trim()) console.error(`[listener :${target.port}] ${text.trim()}`)
  })
  return child
}

async function detectMaxVolume(filePath, window) {
  const stderr = await runFfmpeg([
    '-hide_banner',
    '-loglevel',
    'info',
    '-nostats',
    '-nostdin',
    '-ss',
    String(window.startSeconds),
    '-t',
    String(window.durationSeconds),
    '-i',
    filePath,
    '-map',
    '0:a:0',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-'
  ])
  return parseFfmpegMaxVolume(stderr)
}

function runFfmpeg(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const stderr = []
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', rejectRun)
    child.on('exit', (code, signal) => {
      if (code === 0) resolveRun(stderr.join(''))
      else
        rejectRun(
          new Error(`FFmpeg failed: code=${code} signal=${signal} ${stderr.join('').slice(-1000)}`)
        )
    })
  })
}

async function assertSessionActive(ws, sessionId, expectedState, label) {
  const status = await request(ws, timeoutMs, 'recording.status')
  if (
    status?.sessionId !== sessionId ||
    !['recording', 'streaming'].includes(status?.state) ||
    (expectedState && status.state !== expectedState)
  ) {
    throw new Error(`[${label}] capture did not remain active: ${JSON.stringify(status)}`)
  }
}

function assertArtifact(filePath, scenario, role) {
  if (!filePath || !existsSync(filePath) || statSync(filePath).size <= 0) {
    throw new Error(`[${scenario}] ${role} artifact is missing or empty: ${filePath ?? 'none'}`)
  }
}

function waitForExit(child, waitMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) return resolveExit(true)
    const timer = setTimeout(() => resolveExit(false), waitMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}

function stopListener(child) {
  return new Promise((resolveStop) => {
    if (!child || child.exitCode !== null) return resolveStop()
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already stopped
      }
      resolveStop()
    }, 2_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveStop()
    })
    try {
      child.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      resolveStop()
    }
  })
}

function reportPath() {
  return join(outputDirectory, 'windows-live-audio-controls.json')
}

function writeReport() {
  writeFileSync(reportPath(), `${JSON.stringify(report, null, 2)}\n`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function withTimeout(promise, waitMs, message) {
  return new Promise((resolveTimed, rejectTimed) => {
    const timer = setTimeout(() => rejectTimed(new Error(message)), waitMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolveTimed(value)
      },
      (error) => {
        clearTimeout(timer)
        rejectTimed(error)
      }
    )
  })
}
