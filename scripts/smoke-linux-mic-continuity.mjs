// Linux microphone continuity + clean Stop smoke (plan 257 S1).
//
// The 2026-11-21 audit lost the microphone 3.5-6 s into both of its takes on
// ogre (tone, then -inf for the rest of the take) and both Stops ended in
// SIGKILL. This smoke repeats that shape on purpose: one app launch, N takes
// of a real session (microphone + camera and/or the portal screen), a
// continuous tone playing into the microphone for the whole of every take,
// and per take it requires:
//
//   - every whole second of the file inside the tone carries the tone
//     (per-second RMS, no second under -60 dB),
//   - the recording analyzer passes (A/V skew inside its hard-fail budget),
//   - Stop ends FFmpeg without TERM/KILL (no forced-stop health code) and
//     reaches idle inside the budget.
//
// Optional load: --load-cpus N runs N owned busy-loop processes for the
// whole run (stress-ng --cpu N without needing stress-ng on the box).
//
//   node scripts/smoke-linux-mic-continuity.mjs [--takes 10] [--recording-ms 60000]
//     [--sources camera,screen] [--load-cpus 0] [--tone-sink videorc_lab_speech]
//     [--microphone videorc_lab_mic] [--stop-budget-ms 15000]
//
//   VIDEORC_SMOKE_OUTPUT_DIR          evidence + recordings
//   VIDEORC_PACKAGED_APP_EXECUTABLE   run a packaged build instead of the dev app
//   VIDEORC_LINUX_H264_ENCODER        default openh264 (safe GPU)
//   VIDEORC_SMOKE_FFMPEG_PATH         FFmpeg for the tone and the analysis
//
// The portal screen needs a restore token (or a picker answer) the first time
// on a fresh profile; reuse one output directory across runs to keep it.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { launchDevApp } from './lib/app-launcher.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import { resolveFinalRecordingPath } from './lib/final-recording-path.mjs'
import { linuxDevices } from './lib/linux-av-device-gates.mjs'
import {
  assessCleanStop,
  assessToneContinuity,
  describeHostLoad,
  parseWindowRms,
  windowRmsArgs
} from './lib/linux-mic-continuity-gates.mjs'
import { PORTAL_MONITOR_SOURCE_ID } from './lib/linux-portal-capture-gates.mjs'
import { isLinuxSmokeEvidenceLine } from './lib/linux-smoke-evidence.mjs'
import { packagedSmokeLaunchOptions } from './lib/packaged-smoke-paths.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const { values: args } = parseArgs({
  options: {
    takes: { type: 'string', default: '10' },
    'recording-ms': { type: 'string', default: '60000' },
    sources: { type: 'string', default: 'camera,screen' },
    'load-cpus': { type: 'string', default: '0' },
    'tone-sink': { type: 'string', default: 'videorc_lab_speech' },
    microphone: { type: 'string', default: 'videorc_lab_mic' },
    'stop-budget-ms': { type: 'string', default: '15000' },
    'idle-gap-ms': { type: 'string', default: '3000' }
  },
  strict: true
})

const takes = Number(args.takes)
const recordingMs = Number(args['recording-ms'])
const loadCpus = Number(args['load-cpus'])
const stopBudgetMs = Number(args['stop-budget-ms'])
const idleGapMs = Number(args['idle-gap-ms'])
const wanted = new Set(args.sources.split(',').map((source) => source.trim()))
const launchTimeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const stepTimeoutMs = Number(process.env.VIDEORC_MIC_CONTINUITY_STEP_TIMEOUT_MS ?? 60000)
const encoder = process.env.VIDEORC_LINUX_H264_ENCODER ?? 'openh264'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-mic-continuity-'))
)
mkdirSync(outputDirectory, { recursive: true })
const ffmpegPath =
  process.env.VIDEORC_SMOKE_FFMPEG_PATH ??
  join(resolve(import.meta.dirname, '..'), 'vendor', 'ffmpeg', 'linux-x64', 'bin', 'ffmpeg')
const ffprobePath = siblingFfprobePath(ffmpegPath) ?? 'ffprobe'
const appExecutable = process.env.VIDEORC_PACKAGED_APP_EXECUTABLE || undefined
const packagedLaunch = packagedSmokeLaunchOptions({
  appExecutable,
  capability: appExecutable ? randomBytes(32).toString('base64url') : undefined
})

// The audit's shape: 1080p30 at the shipping bitrate.
const video = { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
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
  contract: 'linux-mic-continuity-clean-stop',
  encoder,
  video,
  recordingMs,
  takes,
  sources: [...wanted],
  loadCpus,
  appExecutable: appExecutable ?? null,
  host: describeHostLoad(loadavg(), cpus().length),
  results: [],
  failures: []
}
const saveEvidence = () =>
  writeFileSync(join(outputDirectory, 'mic-continuity.json'), JSON.stringify(evidence, null, 2))

function log(message, detail) {
  console.log(
    `[mic-continuity] ${message}${detail ? `: ${JSON.stringify(detail).slice(0, 600)}` : ''}`
  )
}

// Owned children only: every PID here was spawned by this script.
const owned = new Set()
function own(child) {
  owned.add(child)
  child.once('exit', () => owned.delete(child))
  return child
}
async function stopOwned() {
  for (const child of [...owned]) child.kill('SIGKILL')
  await sleep(200)
}

function startLoad(count) {
  for (let index = 0; index < count; index += 1) {
    own(spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }))
  }
}

function startTone() {
  return own(
    spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-re',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=1000:sample_rate=48000',
        '-f',
        'pulse',
        '-device',
        args['tone-sink'],
        'videorc-s1-mic-continuity-tone'
      ],
      { stdio: 'ignore' }
    )
  )
}

function windowRms(path) {
  const result = spawnSync(ffmpegPath, windowRmsArgs(path), {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024
  })
  return parseWindowRms(result.stdout)
}

// Backend lines that explain a dropout or a forced Stop, per take.
const takeLines = []
const EXPLAINING_LINE =
  /Session audio bus ended|Native microphone capture ended|could not place|none could be placed|re-anchored|output fell behind|FFmpeg did not|SIGTERM|SIGKILL|draining|overloaded|Recovered a recording|recording timeline mark kind="stop"/

async function waitForLiveScreen(ws) {
  const deadline = Date.now() + stepTimeoutMs
  let status = await request(ws, stepTimeoutMs, 'preview.screen.start', {
    sources: {
      screenId: PORTAL_MONITOR_SOURCE_ID,
      windowId: null,
      cameraId: null,
      microphoneId: null,
      testPattern: false
    },
    video,
    ffmpegPath
  })
  while (Date.now() < deadline) {
    // A static output (the lab output under a lock) repaints only on damage:
    // one frame proves the portal stream is up.
    if (status.state === 'live' && (status.framesCaptured ?? 0) >= 1) return status
    if (status.state !== 'live' && status.state !== 'starting') break
    await sleep(500)
    status = await request(ws, stepTimeoutMs, 'preview.screen.status')
  }
  throw new Error(`the portal screen did not go live: ${status.state} ${status.message ?? ''}`)
}

// Record refuses a camera whose preview produced no frames: start it first.
async function waitForLiveCamera(ws, cameraId, microphoneId) {
  let status = await request(ws, stepTimeoutMs, 'preview.camera.start', {
    sources: { screenId: null, windowId: null, cameraId, microphoneId, testPattern: false },
    layout: layoutFor('camera-only'),
    video,
    ffmpegPath
  })
  const deadline = Date.now() + stepTimeoutMs
  while (
    Date.now() < deadline &&
    (status.state === 'starting' || (status.state === 'live' && (status.framesCaptured ?? 0) < 30))
  ) {
    await sleep(500)
    status = await request(ws, stepTimeoutMs, 'preview.camera.status')
  }
  if (status.state !== 'live') {
    throw new Error(`the camera preview did not go live: ${status.state} ${status.message ?? ''}`)
  }
  return status
}

async function takeOnce(ws, smoke, index, sources, layoutPreset) {
  const label = `take-${String(index + 1).padStart(2, '0')}`
  const capabilityId = appExecutable
    ? undefined
    : (
        await requestSmokeCommand(
          smoke,
          'authorize-smoke-resource',
          { kind: 'output-directory', path: outputDirectory },
          { timeoutMs: stepTimeoutMs }
        )
      ).capabilityId
  const loadBefore = describeHostLoad(loadavg(), cpus().length)
  takeLines.length = 0
  const tone = startTone()
  // The tone reaches the microphone before the first sample is recorded, so
  // the whole file must carry it.
  await sleep(1500)
  const startAt = Date.now()
  const started = await request(ws, stepTimeoutMs, 'session.start', {
    sources,
    layout: layoutFor(layoutPreset),
    output: {
      recordEnabled: true,
      streamEnabled: false,
      ...(capabilityId ? { outputDirectoryCapability: capabilityId } : {}),
      video,
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  })
  const startMs = Date.now() - startAt
  if (started.state !== 'recording') {
    tone.kill('SIGKILL')
    throw new Error(`${label} session.start state ${started.state}: ${started.message ?? ''}`)
  }
  await sleep(recordingMs)
  const loadDuring = describeHostLoad(loadavg(), cpus().length)
  const stopAt = Date.now()
  const stopped = await request(ws, stepTimeoutMs, 'session.stop')
  const stopMs = Date.now() - stopAt
  tone.kill('SIGKILL')
  const health = await request(ws, stepTimeoutMs, 'sessions.healthEvents.list', {
    sessionId: started.sessionId,
    limit: 200
  })
  const healthCodes = (health.events ?? []).map((event) => event.code)
  writeFileSync(join(outputDirectory, `${label}-health.json`), JSON.stringify(health, null, 2))
  const outputPath = await resolveFinalRecordingPath({ started, stopped, timeoutMs: stepTimeoutMs })
  const result = {
    label,
    sessionId: started.sessionId,
    startMs,
    stopMs,
    loadBefore,
    loadDuring,
    outputPath,
    healthCodes: [...new Set(healthCodes)],
    backendLines: [...takeLines],
    failures: []
  }
  const stop = assessCleanStop({ healthCodes, stopMs, outputPath, stopBudgetMs })
  result.failures.push(...stop.failures.map((failure) => `stop: ${failure}`))
  if (outputPath && existsSync(outputPath)) {
    result.sizeBytes = statSync(outputPath).size
    const quality = await analyzeRecording(outputPath, {
      ffmpegPath,
      ffprobePath,
      intendedFps: video.fps,
      expectAudio: true
    })
    writeReports(quality)
    const metrics = quality.metrics
    result.analyzer = {
      pass: quality.verdict.pass,
      failures: quality.verdict.failures,
      warnings: quality.verdict.warnings,
      durationSeconds: metrics.durationSeconds,
      observedFrames: metrics.observedFrames,
      expectedFrames: metrics.expectedFrames,
      avSkewMs: metrics.avSkewMs,
      startSkewMs: metrics.startSkewMs,
      tailMismatchMs: metrics.tailMismatchMs,
      longestDigitalZeroMs: metrics.longestDigitalZeroMs,
      maxAudioGapMs: metrics.maxAudioGapMs
    }
    // The lab scene is static (a closed-lid camera, the lab output under a
    // lock), so it repeats frames by design: freeze and repeat findings are
    // advisory here, as in smoke:linux-portal-record without motion. Every
    // other analyzer gate (A/V skew, audio, duration, cadence) still fails.
    const staticScene = /repeated-frame|freeze|unique-frame/i
    result.analyzer.advisory = quality.verdict.failures.filter((failure) =>
      staticScene.test(failure)
    )
    result.failures.push(
      ...quality.verdict.failures
        .filter((failure) => !staticScene.test(failure))
        .map((failure) => `analyzer: ${failure}`)
    )
    const windows = windowRms(outputPath)
    writeFileSync(join(outputDirectory, `${label}-rms.json`), JSON.stringify(windows))
    // The tone played from before the first sample until after Stop, so the
    // whole file is the window: its video length, which the audio must match.
    const tone = assessToneContinuity(windows, {
      toneStartSeconds: 0,
      toneEndSeconds: Number.isFinite(metrics.durationSeconds)
        ? metrics.durationSeconds
        : recordingMs / 1000
    })
    result.tone = {
      window: tone.window,
      silentSeconds: tone.silentSeconds,
      silentMs: tone.silentMs,
      minRmsDb: tone.minRmsDb,
      // Sub-window holes (a stale chunk's zeroed tail) the analyzer saw.
      analyzerSilences: (quality.findings?.silences ?? []).map((entry) => [
        Number(entry.start.toFixed(2)),
        Math.round(entry.duration * 1000)
      ])
    }
    result.failures.push(...tone.failures.map((failure) => `tone: ${failure}`))
    const wallSeconds = recordingMs / 1000
    if (Number.isFinite(metrics.durationSeconds) && metrics.durationSeconds < wallSeconds * 0.9) {
      result.failures.push(
        `duration: ${metrics.durationSeconds.toFixed(1)} s for a ${wallSeconds} s take`
      )
    }
  }
  result.ok = result.failures.length === 0
  evidence.results.push(result)
  if (!result.ok) evidence.failures.push(...result.failures.map((failure) => `${label} ${failure}`))
  saveEvidence()
  log(`${label} ${result.ok ? 'PASS' : 'FAIL'}`, {
    startMs,
    stopMs,
    load: loadDuring.load1,
    durationSeconds: result.analyzer?.durationSeconds,
    avSkewMs: result.analyzer?.avSkewMs,
    silentMs: result.tone?.silentMs,
    silentSeconds: result.tone?.silentSeconds,
    failures: result.failures
  })
  return result
}

if (process.platform !== 'linux') {
  console.error('Linux mic continuity smoke FAILED: this smoke only runs on Linux')
  process.exit(1)
}

let stopApp = async () => {}
try {
  if (loadCpus > 0) startLoad(loadCpus)
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_LINUX_H264_ENCODER: encoder,
      // The smoke owns every source; the renderer's previews must not reopen
      // the camera or ask the portal between takes.
      VIDEORC_DISABLE_AUTO_SOURCE_PREVIEW: '1',
      ...packagedLaunch.env
    },
    packagedSmokeCommandCapability: packagedLaunch.packagedSmokeCommandCapability,
    spawnSpec: packagedLaunch.spawnSpec,
    timeoutMs: launchTimeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (EXPLAINING_LINE.test(line)) takeLines.push(line.slice(0, 600))
      if (process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1' || isLinuxSmokeEvidenceLine(line)) {
        console.log(line)
      }
    }
  })
  stopApp = launch.stop
  const ws = await connectBackend(launch.connections['backend-ready'], launchTimeoutMs)
  const smoke = launch.connections['preview-motion-ready']
  const list = await request(ws, stepTimeoutMs, 'devices.list', { ffmpegPath })
  writeFileSync(join(outputDirectory, 'devices-list.json'), JSON.stringify(list, null, 2))
  const mics = linuxDevices(list.devices, 'microphone')
  const microphone =
    mics.find((device) =>
      `${device.name ?? ''} ${Buffer.from(device.id.split(':').at(-1), 'hex').toString()}`.includes(
        args.microphone
      )
    ) ?? null
  if (!microphone) {
    throw new Error(
      `no available microphone matches "${args.microphone}": ${mics.map((device) => device.name).join(', ')}`
    )
  }
  const camera = wanted.has('camera') ? (linuxDevices(list.devices, 'camera')[0] ?? null) : null
  if (wanted.has('camera') && !camera) throw new Error('no available V4L2 camera')
  if (wanted.has('screen')) await waitForLiveScreen(ws)
  if (camera) await waitForLiveCamera(ws, camera.id, microphone.id)
  const sources = {
    screenId: wanted.has('screen') ? PORTAL_MONITOR_SOURCE_ID : null,
    windowId: null,
    cameraId: camera?.id ?? null,
    microphoneId: microphone.id,
    testPattern: !wanted.has('screen') && !camera
  }
  const layoutPreset = wanted.has('screen')
    ? camera
      ? 'screen-camera'
      : 'screen-only'
    : camera
      ? 'camera-only'
      : 'screen-camera'
  evidence.devices = { microphone: microphone.name, camera: camera?.name ?? null, layoutPreset }
  log('sources', evidence.devices)
  for (let index = 0; index < takes; index += 1) {
    try {
      await takeOnce(ws, smoke, index, sources, layoutPreset)
    } catch (error) {
      evidence.failures.push(`take-${index + 1}: ${error.message}`)
      saveEvidence()
      log(`take-${index + 1} ERROR`, { message: error.message })
    }
    if (index + 1 < takes) await sleep(idleGapMs)
  }
} catch (error) {
  evidence.failures.push(error.message)
  console.error(`Linux mic continuity smoke FAILED: ${error.message}`)
} finally {
  evidence.hostAfter = describeHostLoad(loadavg(), cpus().length)
  saveEvidence()
  await stopApp().catch(() => {})
  await stopOwned()
}

const passed = evidence.results.filter((result) => result.ok).length
console.log(
  `[mic-continuity] ${passed}/${takes} takes passed; evidence ${join(outputDirectory, 'mic-continuity.json')}`
)
if (evidence.failures.length > 0 || passed !== takes) {
  for (const failure of evidence.failures) console.error(`[mic-continuity] FAIL ${failure}`)
  process.exitCode = 1
}
