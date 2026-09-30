// Linux microphone (L2) + camera (L3) box smoke: launch the dev app on the
// named box and prove real devices end to end.
//
//   mic leg:    devices.list lists a PulseAudio/PipeWire mic; audio.meter.sample
//               measures it; a test-pattern session recording that mic carries
//               an audio track above digital silence.
//   camera leg: devices.list lists a V4L2 camera; preview.camera.start goes live
//               with frames; a camera-only session (with the mic) finalizes a
//               video file at the requested size.
//
//   VIDEORC_LINUX_AV_LEGS            comma list, default "mic,camera"
//   VIDEORC_LINUX_AV_MICROPHONE_ID   optional available microphone id
//   VIDEORC_LINUX_AV_RECORDING_MS    take length (default 6000)
//   VIDEORC_LINUX_AV_STEP_TIMEOUT_MS every backend request (default 45000)
//   VIDEORC_SMOKE_OUTPUT_DIR         evidence + recordings
//   VIDEORC_LINUX_AV_TONE=1          play a 1 kHz tone on the default sink during the
//                                    mic take and require the recording to carry it
//                                    (peak above -40 dB), proving an acoustic path
//
// Safe GPU: the encoder defaults to OpenH264.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import {
  assessCameraPreview,
  assessLinuxDeviceList,
  assessMicMeter,
  assessMicRecordingAudio,
  parseVolumedetect
} from './lib/linux-av-device-gates.mjs'
import { assessPortalRecording } from './lib/linux-portal-capture-gates.mjs'
import { isLinuxSmokeEvidenceLine } from './lib/linux-smoke-evidence.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const launchTimeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const stepTimeoutMs = Number(process.env.VIDEORC_LINUX_AV_STEP_TIMEOUT_MS ?? 45000)
const recordingMs = Number(process.env.VIDEORC_LINUX_AV_RECORDING_MS ?? 6000)
const legs = new Set(
  (process.env.VIDEORC_LINUX_AV_LEGS ?? 'mic,camera').split(',').map((leg) => leg.trim())
)
const encoder = process.env.VIDEORC_LINUX_H264_ENCODER ?? 'openh264'
const toneEnabled = process.env.VIDEORC_LINUX_AV_TONE === '1'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-linux-av-'))
)
mkdirSync(outputDirectory, { recursive: true })
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  join(resolve(import.meta.dirname, '..'), 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffmpeg')
const ffprobePath = siblingFfprobePath(ffmpegPath) ?? 'ffprobe'

const video = { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 6000 }
const layoutFor = (layoutPreset) => ({
  layoutPreset,
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
})

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  contract: 'linux-l2-l3-mic-camera',
  legs: [...legs],
  encoder,
  steps: [],
  failures: []
}
const saveEvidence = () =>
  writeFileSync(join(outputDirectory, 'linux-av-devices.json'), JSON.stringify(evidence, null, 2))

function step(name, detail) {
  evidence.steps.push({ name, at: new Date().toISOString(), ...detail })
  console.log(`[linux-av] ${name}: ${JSON.stringify(detail).slice(0, 500)}`)
  saveEvidence()
}

function check(label, assessment) {
  if (!assessment.ok) {
    for (const failure of assessment.failures) evidence.failures.push(`${label}: ${failure}`)
    console.error(`[linux-av] FAIL ${label}: ${assessment.failures.join('; ')}`)
  }
  saveEvidence()
  return assessment.ok
}

function audioLevels(path) {
  const result = spawnSync(
    ffmpegPath,
    ['-hide_banner', '-i', path, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf8', timeout: 60000 }
  )
  return parseVolumedetect(result.stderr)
}

async function record(ws, smoke, label, { sources, layoutPreset, playTone = false }) {
  const { capabilityId } = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs: stepTimeoutMs }
  )
  const startedAt = Date.now()
  const started = await request(ws, stepTimeoutMs, 'session.start', {
    sources,
    layout: layoutFor(layoutPreset),
    output: {
      recordEnabled: true,
      streamEnabled: false,
      outputDirectoryCapability: capabilityId,
      video,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  })
  step(`${label} session.start`, {
    state: started.state,
    ms: Date.now() - startedAt,
    message: started.message ?? null
  })
  if (started.state !== 'recording') {
    throw new Error(`${label} session.start state ${started.state}: ${started.message ?? ''}`)
  }
  const tone = playTone
    ? spawn(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-re',
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=1000:sample_rate=48000:duration=${Math.max(1, recordingMs / 1000 - 2)}`,
          '-f',
          'pulse',
          'videorc-linux-av-tone'
        ],
        { stdio: 'ignore' }
      )
    : null
  await sleep(recordingMs)
  tone?.kill('SIGKILL')
  const stopped = await request(ws, stepTimeoutMs, 'session.stop')
  const health = await request(ws, stepTimeoutMs, 'sessions.healthEvents.list', {
    sessionId: started.sessionId,
    limit: 120
  })
  writeFileSync(join(outputDirectory, `${label}-health.json`), JSON.stringify(health, null, 2))
  const outputPath = await resolveFinalRecordingPath({ started, stopped, timeoutMs: stepTimeoutMs })
  if (!outputPath || !existsSync(outputPath)) throw new Error(`${label}: no output file`)
  const quality = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: video.fps,
    expectAudio: true
  })
  writeReports(quality)
  const levels = audioLevels(outputPath)
  const summary = {
    outputPath,
    sizeBytes: statSync(outputPath).size,
    codec: quality.metrics.codec,
    width: quality.metrics.width,
    height: quality.metrics.height,
    durationSeconds: quality.metrics.durationSeconds,
    hasAudio: quality.metrics.hasAudio,
    ...levels,
    healthCodes: (health.events ?? []).map((event) => event.code)
  }
  step(`${label} recording`, summary)
  return { summary, metrics: quality.metrics }
}

if (process.platform !== 'linux') {
  console.error('Linux AV devices smoke FAILED: this smoke only runs on Linux')
  process.exit(1)
}

let stopApp = async () => {}
try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_LINUX_H264_ENCODER: encoder,
      // The smoke drives every device itself. The renderer's own source
      // previews re-opened the camera and requested portal consent after
      // each take; the unanswered picker then held the next session.start
      // until it timed out (L3, ogre 2026-09-30).
      VIDEORC_DISABLE_AUTO_SOURCE_PREVIEW: '1'
    },
    timeoutMs: launchTimeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (
        process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1' ||
        isLinuxSmokeEvidenceLine(line) ||
        /camera|microphone|pulse|v4l2|command-lane/i.test(line)
      ) {
        console.log(line)
      }
    }
  })
  stopApp = launch.stop
  const ws = await connectBackend(launch.connections['backend-ready'], launchTimeoutMs)
  const smoke = launch.connections['preview-motion-ready']

  const list = await request(ws, stepTimeoutMs, 'devices.list', { ffmpegPath })
  writeFileSync(join(outputDirectory, 'devices-list.json'), JSON.stringify(list, null, 2))
  step('devices.list', {
    devices: (list.devices ?? []).map((device) => [device.id, device.kind, device.status]),
    warnings: list.warnings ?? []
  })
  const mics = assessLinuxDeviceList(list.devices, 'microphone')
  const requestedMicrophoneId = process.env.VIDEORC_LINUX_AV_MICROPHONE_ID
  const microphoneId = requestedMicrophoneId ?? mics.devices[0]?.id ?? null
  if (
    requestedMicrophoneId &&
    !mics.devices.some((device) => device.id === requestedMicrophoneId)
  ) {
    throw new Error('The requested Linux microphone is not available.')
  }

  if (legs.has('mic')) {
    check('mic devices.list', mics)
    if (microphoneId) {
      const meter = await request(ws, stepTimeoutMs, 'audio.meter.sample', {
        microphoneId,
        ffmpegPath
      })
      step('mic audio.meter.sample', meter)
      check('mic meter', assessMicMeter(meter))
      // The live Pulse/PCM startup regression is timing-sensitive: a cold
      // closed-preview recording can pass while the next open-preview start
      // stalls in FFmpeg's shortest queue. Exercise both and a warm retry.
      for (const [label, previewOpen] of [
        ['mic-test-pattern', false],
        ['mic-preview-open', true],
        ['mic-preview-closed-again', false]
      ]) {
        await requestSmokeCommand(
          smoke,
          previewOpen ? 'preview-window-open' : 'preview-window-close',
          {},
          { timeoutMs: stepTimeoutMs }
        )
        const { summary, metrics } = await record(ws, smoke, label, {
          sources: {
            screenId: null,
            windowId: null,
            cameraId: null,
            microphoneId,
            testPattern: true
          },
          layoutPreset: 'screen-camera',
          playTone: toneEnabled
        })
        check(
          `${label} audio`,
          assessMicRecordingAudio(summary, toneEnabled ? { minPeakDb: -40 } : undefined)
        )
        check(
          `${label} video`,
          assessPortalRecording(
            { metrics, sizeBytes: summary.sizeBytes },
            { width: video.width, height: video.height, recordingMs }
          )
        )
      }
    }
  }

  if (legs.has('camera')) {
    const cams = assessLinuxDeviceList(list.devices, 'camera')
    check('camera devices.list', cams)
    const cameraId = cams.devices[0]?.id
    if (cameraId) {
      const sources = { screenId: null, windowId: null, cameraId, microphoneId, testPattern: false }
      const startedAt = Date.now()
      let status = await request(ws, stepTimeoutMs, 'preview.camera.start', {
        sources,
        layout: layoutFor('camera-only'),
        video,
        ffmpegPath
      })
      const deadline = Date.now() + stepTimeoutMs
      while (
        Date.now() < deadline &&
        (status.state === 'starting' ||
          (status.state === 'live' && (status.framesCaptured ?? 0) < 30))
      ) {
        await sleep(500)
        status = await request(ws, stepTimeoutMs, 'preview.camera.status')
      }
      step('camera preview', {
        ms: Date.now() - startedAt,
        state: status.state,
        framesCaptured: status.framesCaptured ?? 0,
        width: status.width ?? null,
        height: status.height ?? null,
        sourceFps: status.sourceFps ?? null,
        message: status.message ?? null
      })
      if (check('camera preview', assessCameraPreview(status))) {
        const { summary, metrics } = await record(ws, smoke, 'camera-only', {
          sources,
          layoutPreset: 'camera-only'
        })
        check(
          'camera recording video',
          assessPortalRecording(
            { metrics, sizeBytes: summary.sizeBytes },
            { width: video.width, height: video.height, recordingMs }
          )
        )
        if (microphoneId) check('camera recording audio', assessMicRecordingAudio(summary))
      }
      const stopped = await request(ws, stepTimeoutMs, 'preview.camera.stop')
      step('camera preview stop', { state: stopped.state })
    }
  }
  ws.close()
} catch (error) {
  evidence.failures.push(String(error?.stack ?? error))
  console.error(`[linux-av] ${error?.stack ?? error}`)
} finally {
  evidence.outcome = evidence.failures.length === 0 ? 'pass' : 'fail'
  saveEvidence()
  await stopApp()
}
if (evidence.outcome === 'pass') {
  console.log(
    `Linux AV devices smoke PASS (${[...legs].join(', ')}); evidence in ${outputDirectory}`
  )
} else {
  console.error(`Linux AV devices smoke FAILED:\n- ${evidence.failures.join('\n- ')}`)
  process.exitCode = 1
}
