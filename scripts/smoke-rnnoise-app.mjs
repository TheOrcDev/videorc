import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { evaluateRnnoiseArtifact, measureFloatPcmWindow } from './lib/rnnoise-artifact-gate.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// The debug-only native fixture uses the same paced capture, bus, DSP, writer,
// AAC encoder and muxer as a microphone. No captions service or physical input.
// The steady 440 Hz tone proves suppression wiring, not voice preservation.
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180_000)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-rnnoise-${Date.now()}`)
)
const reportPath = join(outputDirectory, 'rnnoise-artifact.json')
const speechFixturePath = process.env.VIDEORC_RNNOISE_TEST_PCM_PATH
const speechFixture = speechFixturePath ? readFileSync(speechFixturePath) : null
const microphoneId = 'microphone:coreaudio:4294967295'
const injectionMs = 3_000
const report = {
  pass: false,
  stimulus: speechFixture
    ? 'paced supplied speech PCM, normalized raw peak 0.12'
    : 'paced 440 Hz native fixture, raw peak 0.12',
  fixture: speechFixture
    ? {
        path: speechFixturePath,
        sha256: createHash('sha256').update(speechFixture).digest('hex'),
        bytes: speechFixture.length
      }
    : null,
  scope: 'DSP/control/encoded-file wiring; no speech-quality or device-permission claim',
  recordings: [],
  windows: {}
}
let launched
let backend
let activeSessionId
const statuses = []
const health = []

if (process.platform !== 'darwin')
  throw new Error('The RNNoise artifact smoke currently requires the macOS debug native fixture.')
mkdirSync(outputDirectory, { recursive: true })
try {
  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_SMOKE_VERBOSE === '1') console.log(line)
    },
    timeoutMs,
    env: {
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_APP_DATA_DIR: join(outputDirectory, 'app-state'),
      VIDEORC_USER_DATA_DIR: join(outputDirectory, 'user-state')
    }
  })
  const smoke = launched.connections['preview-motion-ready']
  backend = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  backend.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.event === 'recording.status')
      statuses.push({ ...message.payload, receivedAt: Date.now() })
    if (message.event === 'health.event')
      health.push({ ...message.payload, receivedAt: Date.now() })
  })
  const phases = [
    { name: 'dry', microphoneNoiseSuppression: 'off', microphoneGainDb: 0, microphoneMuted: false },
    {
      name: 'gain',
      microphoneNoiseSuppression: 'off',
      microphoneGainDb: 6,
      microphoneMuted: false
    },
    {
      name: 'rnnoise',
      microphoneNoiseSuppression: 'rnnoise',
      microphoneGainDb: 6,
      microphoneMuted: false
    },
    {
      name: 'muted',
      microphoneNoiseSuppression: speechFixture ? 'rnnoise' : 'off',
      microphoneGainDb: 6,
      microphoneMuted: true
    },
    ...(speechFixture
      ? [
          {
            name: 'unmuted',
            microphoneNoiseSuppression: 'rnnoise',
            microphoneGainDb: 6,
            microphoneMuted: false
          }
        ]
      : []),
    {
      name: 'bypass',
      microphoneNoiseSuppression: 'off',
      microphoneGainDb: 0,
      microphoneMuted: false
    }
  ]
  await recordTake(smoke, 'off', phases)
  await recordTake(smoke, 'rnnoise', [
    {
      name: 'startEnabled',
      update: false,
      microphoneNoiseSuppression: 'rnnoise',
      microphoneGainDb: 0,
      microphoneMuted: false
    }
  ])
  await recordTake(
    smoke,
    'rnnoise',
    [
      {
        name: 'attachedEnabled',
        update: false,
        microphoneNoiseSuppression: 'rnnoise',
        microphoneGainDb: 0,
        microphoneMuted: false
      }
    ],
    { attachMicrophone: true }
  )
  report.gates = evaluateRnnoiseArtifact(report.windows, { speech: Boolean(speechFixture) })
  if (!report.gates.pass) throw new Error(report.gates.failures.join(' '))
  report.pass = true
  console.log(`RNNoise artifact smoke PASS. Evidence: ${reportPath}`)
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  if (backend) {
    if (activeSessionId)
      await request(backend, 10_000, 'session.stop', { sessionId: activeSessionId }).catch(() => {})
    backend.close()
  }
  await launched?.stop()
}

async function command(smoke, name, params) {
  const result = await requestSmokeCommand(smoke, name, params, { timeoutMs })
  // eval-js's result is itself a renderer execution envelope.
  return result
}

async function seedRenderer(smoke, mode, selectedMicrophoneId) {
  await command(smoke, 'eval-js', {
    code: `
    const current = JSON.parse(localStorage.getItem('videorc.captureConfig') ?? '{}')
    localStorage.setItem('videorc.captureConfig', JSON.stringify({ ...current,
      recordEnabled: true, streamEnabled: false,
      captions: { ...current.captions, enabled: false },
      audio: { ...current.audio, microphoneGainDb: 0, microphoneMuted: false, microphoneNoiseSuppression: ${JSON.stringify(mode)}, systemAudioEnabled: false },
      sources: { testPattern: true, microphoneId: ${JSON.stringify(selectedMicrophoneId)} }
    }))
    localStorage.setItem('videorc.onboardingComplete', 'permissions-v1')
    setTimeout(() => location.reload(), 100)
    return true
  `
  })
  await new Promise((resolveWait) => setTimeout(resolveWait, 700))
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await command(smoke, 'eval-js', {
        code: `return document.readyState === 'complete' && typeof window.__videorcSmokeHydrateRecordingStatus === 'function'`
      })
      if (response?.result === true || response === true) {
        // This backend-started probe must not be repaired by the renderer's
        // reconnect/live-settings effect before the first encoded samples.
        await command(smoke, 'eval-js', {
          code: `
          const send = WebSocket.prototype.send
          window.__rnnoiseBlockedRendererUpdates = []
          WebSocket.prototype.send = function(data) {
            let message
            try { message = JSON.parse(data) } catch {}
            if (message?.method === 'audio.processing.update') {
              window.__rnnoiseBlockedRendererUpdates.push(message)
              return
            }
            return send.call(this, data)
          }
          return true
        `
        })
        return
      }
    } catch {
      /* The window is expected to reject while reloading. */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error('Renderer did not become ready after seeding RNNoise settings.')
}

async function recordTake(smoke, initialMode, phases, { attachMicrophone = false } = {}) {
  await seedRenderer(smoke, initialMode, attachMicrophone ? null : microphoneId)
  // Session start consumes this capability. Each recording needs its own.
  const authorization = await command(smoke, 'authorize-smoke-resource', {
    kind: 'output-directory',
    path: outputDirectory
  })
  const started = await request(backend, timeoutMs, 'session.start', {
    sources: { testPattern: true, microphoneId: attachMicrophone ? null : microphoneId },
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
      streamEnabled: false,
      outputDirectoryCapability: authorization.capabilityId,
      video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    },
    audio: {
      microphoneGainDb: 0,
      microphoneMuted: false,
      microphoneNoiseSuppression: initialMode,
      microphoneSyncOffsetMs: 0,
      systemAudioEnabled: false,
      systemAudioGainDb: -6
    }
  })
  if (started.state !== 'recording' || !started.sessionId || !started.outputPath)
    throw new Error(`Native RNNoise session did not start: ${JSON.stringify(started)}`)
  activeSessionId = started.sessionId
  const epoch = Date.parse(started.startedAt)
  if (!Number.isFinite(epoch)) throw new Error('Recording did not report its start clock.')
  const take = {
    initialMode,
    sessionId: started.sessionId,
    phases: [],
    startedWithoutMicrophone: attachMicrophone
  }
  report.recordings.push(take)
  if (attachMicrophone) {
    const snapshot = await request(backend, timeoutMs, 'session.sources.get', {
      sessionId: started.sessionId
    })
    if (snapshot.confirmed.microphoneId !== null)
      throw new Error('No-microphone startup unexpectedly selected a microphone.')
    await new Promise((resolveWait) => setTimeout(resolveWait, 1800))
    const attached = await request(backend, timeoutMs, 'session.source.switch', {
      sessionId: started.sessionId,
      requestId: 'rnnoise-attach-microphone',
      expectedSourceRevision: snapshot.sourceRevision,
      kind: 'microphone',
      deviceId: microphoneId
    })
    if (
      attached.lastOperation?.stage !== 'applied' ||
      attached.confirmed.microphoneId !== microphoneId ||
      attached.outputProcessId !== snapshot.outputProcessId
    )
      throw new Error(`No-microphone source attach failed: ${JSON.stringify(attached)}`)
    take.sourceAttach = attached
  }
  for (const { name, update = true, ...settings } of phases) {
    let ack = null
    if (update) {
      ack = await request(backend, timeoutMs, 'audio.processing.update', {
        sessionId: started.sessionId,
        ...settings
      })
      if (!ack.applied || Object.entries(settings).some(([key, value]) => ack[key] !== value))
        throw new Error(`RNNoise controls were not applied: ${JSON.stringify(ack)}`)
    }
    const injectionStartedAt = Date.now()
    const injection = await command(smoke, 'backend-debug-rpc', {
      method: 'audio.test.inject-pcm',
      params: { sessionId: started.sessionId, durationMs: injectionMs, rawPeak: 0.12 },
      timeoutMs
    })
    if (
      !Number.isInteger(injection.packetsGenerated) ||
      injection.packetsGenerated !== Math.ceil(injectionMs / 20)
    )
      throw new Error(`Native source bypassed or incomplete: ${JSON.stringify(injection)}`)
    take.phases.push({
      name,
      ack,
      injection,
      startSeconds: (injectionStartedAt - epoch) / 1000 + 0.8,
      durationSeconds: 1.4
    })
  }
  // Drain the session's existing bus lookahead before finalization.
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  const stopRequestedAt = Date.now()
  const stopped = await request(backend, timeoutMs, 'session.stop', {
    sessionId: started.sessionId
  })
  activeSessionId = null
  const path = await resolveFinalRecordingPath({
    started,
    stopped,
    recordingStatusEvents: statuses,
    healthEvents: health,
    stopRequestedAt,
    timeoutMs
  })
  if (!path) throw new Error('RNNoise recording did not finalize.')
  take.blockedRendererUpdates = await command(smoke, 'eval-js', {
    code: 'return window.__rnnoiseBlockedRendererUpdates'
  })
  take.path = path
  const probe = JSON.parse(
    execFileSync(
      ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type,duration,sample_rate',
        '-of',
        'json',
        path
      ],
      { encoding: 'utf8', timeout: 30_000 }
    )
  )
  take.probe = probe
  const video = probe.streams?.find((stream) => stream.codec_type === 'video')
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio')
  const duration = Number(probe.format?.duration)
  const expectedDuration = (stopRequestedAt - epoch) / 1000
  if (
    !video ||
    Number(audio?.sample_rate) !== 48_000 ||
    !Number.isFinite(duration) ||
    Math.abs(duration - expectedDuration) > 1
  )
    throw new Error(
      `Recording duration or native audio stream is wrong: ${JSON.stringify(probe)}, expected ${expectedDuration}s`
    )
  if (
    Number.isFinite(Number(video.duration)) &&
    Number.isFinite(Number(audio.duration)) &&
    Math.abs(Number(video.duration) - Number(audio.duration)) > 0.35
  )
    throw new Error('Recorded audio and video durations differ by more than 350 ms.')
  const pcm = execFileSync(
    ffmpegPath,
    [
      '-v',
      'error',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1'
    ],
    { maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }
  )
  take.decoded = measureFloatPcmWindow(pcm, 0, Math.floor(pcm.length / 4) / 48_000)
  if (take.decoded.peak > 1.01)
    throw new Error('Recording exceeded full scale outside a measured phase.')
  if (attachMicrophone) {
    take.noMicrophoneWindow = measureFloatPcmWindow(pcm, 0.4, 1)
    if (take.noMicrophoneWindow.peak > 0.001)
      throw new Error('No-microphone startup produced audible audio.')
  }
  for (const phase of take.phases)
    report.windows[phase.name] = measureFloatPcmWindow(
      pcm,
      phase.startSeconds,
      phase.durationSeconds
    )
}
