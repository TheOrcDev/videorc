import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { analyzeMediaAudioAmplitude } from './lib/audio-amplitude.mjs'
import {
  analyzeCaptionsAbsentArtifact,
  analyzeCaptionsLiveArtifact,
  formatCaptionsLiveArtifactSummary
} from './lib/captions-live-artifact.mjs'
import { startFakeCaptionService } from './lib/fake-caption-service.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Maintained viewer-facing live-caption gate. Unlike smoke:captions-contract,
// which proves the backend transport state machine in isolation, this launches
// the real renderer and the real livestream pipeline:
//
// deterministic pre-controls PCM -> live mute/gain -> fake authenticated chunk service ->
// captions.update -> renderer OffscreenCanvas PNG -> backend compositor ->
// local RTMP listener + clean recording + SRT + captioned recording copy ->
// ffprobe metadata + ffmpeg pixel/audio analysis.
//
// The smoke never calls captions.overlay.set. Passing pixels therefore proves
// that the renderer consumed the caption update and generated the PNG itself.

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 240_000)
const baselineMs = Number(process.env.VIDEORC_CAPTIONS_LIVE_BASELINE_MS ?? 1_800)
const captionCaptureMs = Number(process.env.VIDEORC_CAPTIONS_LIVE_CAPTURE_MS ?? 3_000)
const listenerBindMs = Number(process.env.VIDEORC_CAPTIONS_LIVE_LISTENER_BIND_MS ?? 1_200)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-captions-live-${Date.now()}`)
)
const stateRoot = join(outputDirectory, 'app-state')
const appDataDir = join(stateRoot, 'app-data')
const receivedPath = join(outputDirectory, 'captions-live-received.flv')
const reportPath = join(outputDirectory, 'captions-live-artifact.json')
const smokeSessionToken = 'captions-live-session-token'
const smokeRealtimeToken = 'captions-live-realtime-token'
const finalText = 'VIDEORC LIVE CAPTION RENDERER PROOF'
const captionTestMicrophoneId = 'microphone:coreaudio:4294967295'
const rawTonePeak = 0.12
const gainDb = 6
const injectionMs = 3_000

mkdirSync(appDataDir, { recursive: true })
const secretsPath = join(appDataDir, 'videorc-secrets.json')
writeFileSync(
  secretsPath,
  JSON.stringify({ 'account:videorc:session': smokeSessionToken }, null, 2)
)
chmodSync(secretsPath, 0o600)

const fake = await startFakeCaptionService({
  smokeSessionToken,
  smokeRealtimeToken,
  provisionalFinalText: 'VIDEORC LIVE CAPTION',
  finalText,
  chunkText: finalText,
  itemId: 'captions-live-renderer-proof',
  minSpeechPeak: 0.01
})
let launched
let backend
let listener
let sessionActive = false
let observed = { statuses: [], updates: [], recordingStatuses: [], healthEvents: [] }

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
  observed = collectCaptionEvents(backend)

  fake.state.realtimeAvailable = false
  fake.state.realtimeFailureCode = 'captions-realtime-disabled'
  await seedRendererCaptionsProfile(smoke)
  await waitForCaptionStatus(backend, (status) => {
    return status.state === 'ready' && status.desiredEnabled === true
  })
  const health = await request(backend, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for captions live smoke.')
  }

  const port = Number(process.env.VIDEORC_CAPTIONS_LIVE_RTMP_PORT ?? 19841)
  const streamKey = 'captions-live'
  const target = {
    id: 'captions-live-local',
    serverUrl: `rtmp://127.0.0.1:${port}/live`,
    listenUrl: `rtmp://127.0.0.1:${port}/live/${streamKey}`,
    streamKey
  }
  listener = spawnRtmpListener(target)
  await sleep(listenerBindMs)
  assertListenerRunning(listener)

  const outputAuthorization = await smokeCommand(smoke, 'authorize-smoke-resource', {
    kind: 'output-directory',
    path: outputDirectory
  })
  const captureRequestedAt = Date.now()
  const started = await request(
    backend,
    timeoutMs,
    'session.start',
    sessionParams({ outputDirectoryCapability: outputAuthorization.capabilityId, target })
  )
  if (started.state !== 'recording' || !started.sessionId || !started.outputPath) {
    throw new Error(`Caption smoke did not enter record+stream: ${JSON.stringify(started)}`)
  }
  sessionActive = true
  await hydrateRendererActiveSession(smoke)

  // Captions are part of the backend session itself. No harness-side
  // captions.start or overlay RPC is allowed: renderer events must drive both
  // the live compositor PNG and the post-recording cue-frame round trip.
  try {
    await waitFor(
      () => fake.state.realtimeTokenRequests >= 1,
      Math.min(timeoutMs, 30_000),
      'session-started caption fallback'
    )
  } catch (error) {
    const [captionStatus, recordingStatus, rendererState] = await Promise.all([
      request(backend, timeoutMs, 'captions.status.get', {}).catch(() => null),
      request(backend, timeoutMs, 'recording.status', {}).catch(() => null),
      smokeCommand(smoke, 'eval-js', {
        code: `
          const stored = JSON.parse(localStorage.getItem('videorc.captureConfig') ?? '{}')
          return {
            ready: document.readyState,
            captions: stored.captions,
            recordEnabled: stored.recordEnabled,
            streamEnabled: stored.streamEnabled
          }
        `
      }).catch(() => null)
    ])
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        `Fake service counters: ${JSON.stringify(safeFakeCounters(fake.state))}. ` +
        `Caption status: ${JSON.stringify(captionStatus)}. ` +
        `Recording status: ${JSON.stringify(recordingStatus)}. ` +
        `Renderer state: ${JSON.stringify(rendererState?.result ?? null)}.`
    )
  }
  await waitForCaptionStatus(backend, (status) => {
    return status.state === 'degraded' && status.transport === 'chunked'
  })
  await sleep(baselineMs)

  // The session starts muted. Raw tone packets enter the synthetic native
  // source before controls; the fake service must receive a silent WAV and
  // must not emit caption text. This is the privacy assertion the old direct
  // caption-bus injector could not make.
  const muteUpdate = await request(backend, timeoutMs, 'audio.processing.update', {
    sessionId: started.sessionId,
    microphoneGainDb: 0,
    microphoneMuted: true
  })
  if (!muteUpdate.applied) {
    throw new Error(`Could not mute the active native source: ${JSON.stringify(muteUpdate)}`)
  }
  const mutedAudioStart = fake.state.chunkAudio.length
  const mutedInjection = await injectPreControlsPcm(smoke, started.sessionId)
  await waitFor(
    () => fake.state.chunkAudio.length > mutedAudioStart,
    timeoutMs,
    'muted caption WAV inspection'
  )
  const mutedAudio = fake.state.chunkAudio.slice(mutedAudioStart)
  if (mutedAudio.some((audio) => audio.peak > 0.001)) {
    throw new Error(
      `Muted pre-controls PCM reached captions audibly: ${JSON.stringify(mutedAudio)}`
    )
  }
  if (observed.updates.some((update) => update.kind === 'final' && update.text)) {
    throw new Error(`Muted PCM produced caption text: ${JSON.stringify(observed.updates)}`)
  }

  const baselineUpdate = await request(backend, timeoutMs, 'audio.processing.update', {
    sessionId: started.sessionId,
    microphoneGainDb: 0,
    microphoneMuted: false
  })
  if (!baselineUpdate.applied) {
    throw new Error(`Could not unmute the active native source: ${JSON.stringify(baselineUpdate)}`)
  }
  const baselineAudioStart = fake.state.chunkAudio.length
  const baselineInjection = await injectPreControlsPcm(smoke, started.sessionId)
  await waitFor(
    () => observed.updates.some((update) => update.kind === 'final' && update.text === finalText),
    timeoutMs,
    'renderer-proof final caption update'
  )
  await waitFor(
    () => fake.state.chunkAudio.slice(baselineAudioStart).some((audio) => audio.peak > 0.08),
    timeoutMs,
    'zero-gain caption WAV inspection'
  )
  const baselineAudio = fake.state.chunkAudio
    .slice(baselineAudioStart)
    .find((audio) => audio.peak > 0.08)

  const gainUpdate = await request(backend, timeoutMs, 'audio.processing.update', {
    sessionId: started.sessionId,
    microphoneGainDb: gainDb,
    microphoneMuted: false
  })
  if (!gainUpdate.applied) {
    throw new Error(`Could not update active native gain: ${JSON.stringify(gainUpdate)}`)
  }
  const gainedAudioStart = fake.state.chunkAudio.length
  const gainedInjection = await injectPreControlsPcm(smoke, started.sessionId)
  await waitFor(
    () =>
      fake.state.chunkAudio
        .slice(gainedAudioStart)
        .some((audio) => audio.peak > baselineAudio.peak * 1.7),
    timeoutMs,
    'gained caption WAV inspection'
  )
  const gainedAudio = fake.state.chunkAudio
    .slice(gainedAudioStart)
    .find((audio) => audio.peak > baselineAudio.peak * 1.7)
  const gainRatio = gainedAudio.peak / baselineAudio.peak
  if (baselineAudio.peak < 0.1 || baselineAudio.peak > 0.14) {
    throw new Error(`Zero-gain caption WAV peak drifted: ${JSON.stringify(baselineAudio)}`)
  }
  if (gainRatio < 1.85 || gainRatio > 2.15) {
    throw new Error(
      `Caption WAV did not reflect +${gainDb}dB before the tap: ratio=${gainRatio.toFixed(3)} ` +
        `${JSON.stringify({ baselineAudio, gainedAudio })}`
    )
  }
  await waitForCaptionStatus(backend, (status) => {
    return (
      status.state === 'degraded' && status.transport === 'chunked' && status.providerReady === true
    )
  })
  if (fake.state.chunkRequests < 3 || fake.state.audioAppends !== 0) {
    throw new Error(
      `Chunked caption service did not inspect the mute/gain windows: ${JSON.stringify(
        safeFakeCounters(fake.state)
      )}`
    )
  }
  const overlaySnapshot = await waitForCaptionOverlay(smoke)

  // Leave the settled line on screen long enough for multiple independently
  // decoded frames. Its readable dwell is longer than this capture window.
  await sleep(captionCaptureMs)
  const stopRequestedAt = Date.now()
  const stopped = await request(backend, timeoutMs, 'session.stop', {})
  sessionActive = false
  await stopRtmpListener(listener)

  assertArtifactFile(receivedPath)
  const recordingPath = await resolveFinalRecordingPath({
    started,
    stopped,
    recordingStatusEvents: observed.recordingStatuses,
    healthEvents: observed.healthEvents,
    stopRequestedAt,
    timeoutMs
  })
  if (!recordingPath) throw new Error('Record+stream captions smoke produced no recording path.')
  assertArtifactFile(recordingPath)
  const srtPath = replaceExtension(recordingPath, '.srt')
  await waitFor(() => existsSync(srtPath), timeoutMs, 'caption SRT sidecar')
  const captionedCopyPath = captionedPath(recordingPath)
  await waitFor(
    () =>
      observed.healthEvents.some(
        (event) =>
          event.sessionId === started.sessionId && event.code === 'captions-burned-copy-ready'
      ),
    timeoutMs,
    'captioned recording copy finalization'
  )
  assertArtifactFile(captionedCopyPath)

  const [streamProbe, recordingProbe, captionedProbe] = await Promise.all([
    probeVideoArtifact(receivedPath),
    probeVideoArtifact(recordingPath),
    probeVideoArtifact(captionedCopyPath)
  ])
  const minDurationSeconds = Math.max(3, ((stopRequestedAt - captureRequestedAt) / 1_000) * 0.8)
  assertVideoProbe(streamProbe, 'RTMP stream', {
    width: 640,
    height: 360,
    minDurationSeconds
  })
  assertVideoProbe(recordingProbe, 'original recording', {
    width: 640,
    height: 360,
    minDurationSeconds
  })
  assertVideoProbe(captionedProbe, 'captioned recording copy', {
    width: 640,
    height: 360,
    minDurationSeconds
  })
  const [streamArtifact, cleanRecording, captionedArtifact, recordingAudio] = await Promise.all([
    analyzeCaptionsLiveArtifact(receivedPath, { ffmpegPath }),
    analyzeCaptionsAbsentArtifact(recordingPath, { ffmpegPath }),
    analyzeCaptionsLiveArtifact(captionedCopyPath, { ffmpegPath }),
    analyzeMediaAudioAmplitude(recordingPath, { ffmpegPath })
  ])
  const srt = readFileSync(srtPath, 'utf8')
  if (!srt.includes(finalText)) {
    throw new Error(`SRT sidecar omitted the settled caption: ${srtPath}`)
  }
  if (!streamArtifact.pass || !cleanRecording.pass || !captionedArtifact.pass) {
    throw new Error(
      `Caption routing artifact failure: ${JSON.stringify({
        stream: streamArtifact.failures,
        original: cleanRecording.failures,
        captioned: captionedArtifact.failures
      })} (report: ${reportPath})`
    )
  }
  if (recordingAudio.peak < 0.18 || recordingAudio.peak > 0.35) {
    throw new Error(
      `Original recording did not contain the post-gain native PCM: ${JSON.stringify(recordingAudio)}`
    )
  }
  const diagnostics = await request(backend, timeoutMs, 'diagnostics.stats', {})
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        pass: true,
        artifacts: {
          stream: streamArtifact,
          original: cleanRecording,
          captionedCopy: captionedArtifact,
          srt: { file: srtPath, containsExpectedText: true }
        },
        probes: {
          stream: streamProbe,
          original: recordingProbe,
          captionedCopy: captionedProbe
        },
        diagnostics,
        observed,
        proof: {
          injections: { mutedInjection, baselineInjection, gainedInjection },
          captionWavAmplitude: { muted: mutedAudio, baseline: baselineAudio, gained: gainedAudio },
          gainRatio,
          recordingAudio,
          captionFinalObserved: true,
          rendererProfile: {
            styleId: 'high-contrast',
            position: 'bottom',
            textSize: 'l'
          },
          chunkRequests: fake.state.chunkRequests,
          overlayRevision: overlaySnapshot.overlays.auxiliary.revision,
          transport: 'chunked'
        }
      },
      null,
      2
    )
  )
  console.log(formatCaptionsLiveArtifactSummary(streamArtifact))
  console.log(formatCaptionsLiveArtifactSummary(captionedArtifact))

  console.log(
    `Captions live smoke PASS — pre-controls PCM proved mute and +${gainDb}dB ordering, the renderer ` +
      `published captions to RTMP, the original recording stayed clean, and finalization produced ` +
      `both SRT and a captioned copy (${streamProbe.video.width}x${streamProbe.video.height}, ` +
      `${streamProbe.format.durationSeconds.toFixed(2)}s stream). ` +
      `Evidence: ${outputDirectory}`
  )
} catch (error) {
  const [diagnostics, recordingStatus, captionsStatus] = backend
    ? await Promise.all([
        requestSafe(backend, 'diagnostics.stats', {}),
        requestSafe(backend, 'recording.status', {}),
        requestSafe(backend, 'captions.status.get', {})
      ])
    : [null, null, null]
  const failure = {
    pass: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    },
    diagnostics,
    recordingStatus,
    captionsStatus,
    observed,
    fake: {
      ...safeFakeCounters(fake.state),
      chunkAudio: fake.state.chunkAudio
    },
    artifacts: artifactInventory(outputDirectory)
  }
  writeFileSync(reportPath, JSON.stringify(failure, null, 2))
  throw new Error(
    `${error instanceof Error ? error.message : String(error)} Full failure evidence: ${reportPath}`,
    { cause: error }
  )
} finally {
  try {
    if (backend) {
      if (sessionActive) await requestSafe(backend, 'session.stop', {})
      await requestSafe(backend, 'captions.stop', {})
      backend.close()
    }
    await stopRtmpListener(listener)
  } finally {
    await launched?.stop().catch(() => {})
    await fake.close()
  }
}

async function seedRendererCaptionsProfile(smoke) {
  const seeded = await smokeCommand(smoke, 'eval-js', {
    code: `
      let current = {}
      try { current = JSON.parse(localStorage.getItem('videorc.captureConfig') ?? '{}') } catch {}
      const next = {
        ...current,
        // Mirror the direct backend record+stream shape so the renderer owns
        // both the live stream PNG and finalized cue-frame submissions.
        recordEnabled: true,
        streamEnabled: true,
        streaming: { ...current.streaming, enabled: false },
        video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
        captions: {
          enabled: true,
          burnTarget: 'both',
          styleId: 'high-contrast',
          language: 'en',
          styleRevision: 1,
          position: 'bottom',
          textSize: 'l'
        }
      }
      localStorage.setItem('videorc.captureConfig', JSON.stringify(next))
      localStorage.setItem('videorc.onboardingComplete', 'permissions-v1')
      return {
        captions: next.captions,
        video: next.video,
        recordEnabled: next.recordEnabled,
        streamEnabled: next.streamEnabled,
        hasStreamingDefaults: Boolean(next.streaming)
      }
    `
  })
  if (
    seeded?.result?.captions?.styleId !== 'high-contrast' ||
    seeded?.result?.captions?.enabled !== true ||
    seeded?.result?.captions?.burnTarget !== 'both' ||
    seeded?.result?.recordEnabled !== true ||
    seeded?.result?.streamEnabled !== true ||
    seeded?.result?.hasStreamingDefaults !== true
  ) {
    throw new Error(`Could not seed renderer caption profile: ${JSON.stringify(seeded)}`)
  }
  await smokeCommand(smoke, 'eval-js', {
    code: `
      window.setTimeout(() => window.location.reload(), 150)
      return { reloadScheduled: true }
    `
  })
  await sleep(750)

  let latest = null
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      latest = await smokeCommand(smoke, 'eval-js', {
        code: `
          const stored = JSON.parse(localStorage.getItem('videorc.captureConfig') ?? '{}')
          return {
            ready: document.readyState === 'complete',
            styleId: stored.captions?.styleId,
            enabled: stored.captions?.enabled,
            burnTarget: stored.captions?.burnTarget,
            recordEnabled: stored.recordEnabled,
            streamEnabled: stored.streamEnabled,
            hasStreamingDefaults: Boolean(stored.streaming),
            width: stored.video?.width,
            height: stored.video?.height
          }
        `
      })
      const result = latest?.result
      if (
        result?.ready &&
        result.styleId === 'high-contrast' &&
        result.enabled === true &&
        result.burnTarget === 'both' &&
        result.recordEnabled === true &&
        result.streamEnabled === true &&
        result.hasStreamingDefaults === true &&
        result.width === 640 &&
        result.height === 360
      ) {
        return
      }
    } catch {
      // The main window is expected to reject commands briefly while reloading.
    }
    await sleep(100)
  }
  throw new Error(`Renderer did not reload the seeded caption profile: ${JSON.stringify(latest)}`)
}

async function hydrateRendererActiveSession(smoke) {
  const hydrated = await smokeCommand(smoke, 'eval-js', {
    code: `
      if (typeof window.__videorcSmokeHydrateRecordingStatus !== 'function') {
        throw new Error('Recording-status smoke hydrator is unavailable.')
      }
      const recording = await window.__videorcSmokeHydrateRecordingStatus()
      const deadline = Date.now() + 5000
      let sessionStatus = null
      while (Date.now() < deadline) {
        sessionStatus = document.querySelector('[data-videorc-session-status]')?.textContent?.trim() ?? null
        if (sessionStatus === 'Recording') break
        await sleep(50)
      }
      return { recordingState: recording.state, sessionStatus }
    `
  })
  if (
    hydrated?.result?.recordingState !== 'recording' ||
    hydrated.result.sessionStatus !== 'Recording'
  ) {
    throw new Error(`Renderer did not hydrate record+stream: ${JSON.stringify(hydrated)}`)
  }
}

function sessionParams({ outputDirectoryCapability, target }) {
  return {
    sources: { testPattern: true, microphoneId: captionTestMicrophoneId },
    layout: {
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
    },
    output: {
      recordEnabled: true,
      streamEnabled: true,
      outputDirectoryCapability,
      video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
      rtmp: { preset: 'custom', serverUrl: target.serverUrl, streamKey: target.streamKey }
    },
    captions: {
      enabled: true,
      burnTarget: 'both',
      styleId: 'high-contrast',
      language: 'en',
      styleRevision: 1,
      position: 'bottom',
      textSize: 'l'
    },
    audio: { microphoneGainDb: 0, microphoneMuted: true, microphoneSyncOffsetMs: 0 }
  }
}

function collectCaptionEvents(ws) {
  const result = { statuses: [], updates: [], recordingStatuses: [], healthEvents: [] }
  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.event === 'captions.status') result.statuses.push(message.payload)
    if (message.event === 'captions.update') result.updates.push(message.payload)
    if (message.event === 'recording.status') {
      result.recordingStatuses.push({ ...message.payload, receivedAt: Date.now() })
    }
    if (message.event === 'health.event') {
      result.healthEvents.push({ ...message.payload, receivedAt: Date.now() })
    }
  })
  return result
}

async function waitForCaptionStatus(connection, predicate) {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  let latest = null
  while (Date.now() < deadline) {
    latest = await request(connection, timeoutMs, 'captions.status.get', {})
    if (predicate(latest)) return latest
    await sleep(50)
  }
  throw new Error(`Timed out waiting for live caption status: ${JSON.stringify(latest)}`)
}

async function waitForCaptionOverlay(smoke) {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  let latest = null
  while (Date.now() < deadline) {
    latest = await requestDebugBackend(smoke, 'captions.test.snapshot', {})
    if (
      latest?.overlays?.auxiliary?.active &&
      latest.overlays.auxiliary.revision > 0 &&
      !latest.overlays.primary.active
    ) {
      return latest
    }
    await sleep(50)
  }
  throw new Error(`Timed out waiting for renderer caption overlay: ${JSON.stringify(latest)}`)
}

function safeFakeCounters(state) {
  return {
    realtimeTokenRequests: state.realtimeTokenRequests,
    realtimeUpgradeAttempts: state.realtimeUpgradeAttempts,
    realtimeConnections: state.realtimeConnections,
    configurations: state.configurations.length,
    audioAppends: state.audioAppends,
    emptyAudioAppends: state.emptyAudioAppends,
    chunkRequests: state.chunkRequests,
    chunkAudioInspections: state.chunkAudio.length,
    usageReports: state.usageReports
  }
}

function spawnRtmpListener(target) {
  const stderr = []
  const process = spawn(
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
      receivedPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  process.stderr.setEncoding('utf8')
  process.stderr.on('data', (text) => stderr.push(text))
  return { process, stderr }
}

function assertListenerRunning(listener) {
  if (listener.process.exitCode !== null) {
    throw new Error(
      `Local RTMP listener exited before streaming: ${listener.stderr.join('').trim()}`
    )
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

async function probeVideoArtifact(filePath) {
  const payload = await runProcess(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,channels,sample_rate',
    '-of',
    'json',
    filePath
  ])
  const parsed = JSON.parse(payload)
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio')
  return {
    video: {
      codec: video?.codec_name ?? null,
      width: Number(video?.width ?? 0),
      height: Number(video?.height ?? 0),
      averageFrameRate: video?.avg_frame_rate ?? null
    },
    audio: {
      codec: audio?.codec_name ?? null,
      channels: Number(audio?.channels ?? 0),
      sampleRate: Number(audio?.sample_rate ?? 0)
    },
    format: { durationSeconds: Number(parsed.format?.duration ?? 0) }
  }
}

function assertVideoProbe(probe, label, expected) {
  if (probe.video.width !== expected.width || probe.video.height !== expected.height) {
    throw new Error(`Unexpected ${label} video dimensions: ${JSON.stringify(probe)}`)
  }
  if (
    !Number.isFinite(probe.format.durationSeconds) ||
    probe.format.durationSeconds < expected.minDurationSeconds
  ) {
    throw new Error(`${label} artifact was too short: ${JSON.stringify(probe)}`)
  }
  if (!probe.audio.codec || probe.audio.channels < 1 || probe.audio.sampleRate < 16_000) {
    throw new Error(`${label} omitted the native audio leg: ${JSON.stringify(probe)}`)
  }
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
      rejectRun(
        new Error(`${command} failed: code=${code} signal=${signal} ${stderr.join('').trim()}`)
      )
    })
  })
}

function assertArtifactFile(filePath) {
  const size = existsSync(filePath) ? statSync(filePath).size : 0
  if (size <= 0) throw new Error(`Caption artifact is missing or empty: ${filePath}`)
}

function artifactInventory(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(directory, entry.name)
        return { path, bytes: statSync(path).size }
      })
  } catch {
    return []
  }
}

async function injectPreControlsPcm(smoke, sessionId) {
  const injection = await requestDebugBackend(smoke, 'audio.test.inject-pcm', {
    sessionId,
    durationMs: injectionMs,
    rawPeak: rawTonePeak
  })
  const expectedPackets = Math.ceil(injectionMs / 20)
  if (injection.packetsGenerated < expectedPackets) {
    throw new Error(
      `Pre-controls PCM source generated too few packets: ${JSON.stringify(injection)}`
    )
  }
  return injection
}

function requestDebugBackend(smoke, method, params) {
  return smokeCommand(smoke, 'backend-debug-rpc', { method, params, timeoutMs })
}

function replaceExtension(filePath, nextExtension) {
  const extension = extname(filePath)
  return `${filePath.slice(0, filePath.length - extension.length)}${nextExtension}`
}

function captionedPath(filePath) {
  const extension = extname(filePath)
  const stem = filePath.slice(0, filePath.length - extension.length)
  return `${stem} (captioned)${extension}`
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
