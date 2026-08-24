// Multi-session recording decay smoke (second-session lag plan, D1).
//
// The 2026-08-24 owner regression on 0.9.71: the FIRST recording of a backend
// generation is clean, later ones are majority-frozen (compositor re-serves
// held frames at full cadence; preview lags identically). Every existing
// recording smoke records ONCE per app launch (or, like the matrix smoke,
// varies the profile per session and never gates on freshness), so per-session
// decay inside one backend generation was invisible to every gate.
//
// This smoke records N IDENTICAL sessions against ONE dev-app/backend launch
// with hard (per-frame noise) content, so a held frame is a literal duplicate,
// and holds EVERY session — not just the first — to the analyzer's freshness
// gates (freezedetect + exact-repeat), plus the bridge's own fresh/repeat
// accounting from diagnostics.stats.
//
// Usage: pnpm smoke:session-decay
//   VIDEORC_DECAY_SESSIONS=6           session count (default 6)
//   VIDEORC_DECAY_RECORDING_MS=15000   per-session capture length
//   VIDEORC_DECAY_IDLE_MS=8000         idle gap between sessions
//   VIDEORC_DECAY_REAL_SCREEN=1        capture the real screen (needs the
//                                      dev app's Screen Recording TCC grant;
//                                      records your screen — run intentionally)
//   VIDEORC_DECAY_REAL_CAMERA=1        add the first real camera
//   VIDEORC_DECAY_WIDTH/HEIGHT/FPS/BITRATE_KBPS   output profile override
//   VIDEORC_SMOKE_OUTPUT_DIR=...       artifact + report directory
//
// With real sources, screen/camera content may be legitimately static, so
// freezedetect demotes to evidence and the bridge's own fresh/repeat counters
// (content-independent: a repeat means the compositor delivered no new frame
// in time) become the hard freshness gate.

import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import {
  launchScreenMotionStimulus,
  stopScreenMotionStimulus
} from './lib/screen-motion-stimulus.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { pickDevice } from './lib/source-selection.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-session-decay-${Date.now()}`)
)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-session-decay-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = siblingFfprobePath(ffmpegPath) ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const sessionCount = Number(process.env.VIDEORC_DECAY_SESSIONS ?? 6)
const recordingMs = Number(process.env.VIDEORC_DECAY_RECORDING_MS ?? 15000)
const idleMs = Number(process.env.VIDEORC_DECAY_IDLE_MS ?? 8000)

const realScreen = process.env.VIDEORC_DECAY_REAL_SCREEN === '1'
const realCamera = process.env.VIDEORC_DECAY_REAL_CAMERA === '1'
// VIDEORC_DECAY_PACKAGED_APP: drive the INSTALLED app instead of the dev app.
// The packaged bundle carries the user's real TCC camera/screen grants, which
// the ad-hoc dev Electron cannot obtain on this box (macOS refuses to prompt).
const packagedAppExecutable =
  process.env.VIDEORC_DECAY_PACKAGED_APP === '1'
    ? (process.env.VIDEORC_PACKAGED_APP_EXECUTABLE ??
      '/Applications/Videorc.app/Contents/MacOS/Videorc')
    : null
const packagedSmokeCapability = packagedAppExecutable
  ? randomBytes(32).toString('base64url')
  : undefined

// One fixed shipping-shaped profile. 1080p30 holds full cadence under hard
// content on every supported box (matrix smoke proves 1080p60 does), so any
// freeze here is a pipeline defect, not encoder pressure.
const PROFILE = {
  width: Number(process.env.VIDEORC_DECAY_WIDTH ?? 1920),
  height: Number(process.env.VIDEORC_DECAY_HEIGHT ?? 1080),
  fps: Number(process.env.VIDEORC_DECAY_FPS ?? 30),
  bitrateKbps: Number(process.env.VIDEORC_DECAY_BITRATE_KBPS ?? 6000)
}

// Freshness is the whole point: freeze segments and exact-repeat runs are
// hard failures on EVERY session index. The owner's frozen 0.9.71 recording
// had 51 freeze spans up to 1.3s — 400ms is loose enough for encoder jitter
// under noise content and still fails that file on dozens of counts. Real
// sources can be legitimately static, so there freezedetect is evidence only
// and the bridge repeat-ratio gate carries the verdict.
const DECAY_GATES = Object.freeze({
  requireMotion: !realScreen && !realCamera,
  maxFreezeMs: 400,
  requireColorTags: true,
  requireValidLevel: true,
  keyframeMaxIntervalSeconds: 2.5,
  maxTailMismatchMs: 100
})

async function resolveRealSources(ws) {
  if (!realScreen && !realCamera) {
    return { testPattern: true }
  }
  const listed = await request(ws, timeoutMs, 'devices.list', { ffmpegPath })
  const devices = listed?.devices ?? []
  const sources = { testPattern: false }
  if (realScreen) {
    const screen = pickDevice(devices, 'screen', {
      nativePrefix: 'screen:screencapturekit:',
      requireNative: true
    })
    if (!screen) throw new Error('no screen device for VIDEORC_DECAY_REAL_SCREEN=1')
    sources.screenId = screen.id
    console.log(`[session-decay] real screen: ${screen.name} (${screen.id})`)
  }
  if (realCamera) {
    const camera = pickDevice(devices, 'camera', {
      override: process.env.VIDEORC_DECAY_CAMERA_ID,
      nativePrefix: 'camera:avfoundation-native:'
    })
    if (!camera) throw new Error('no camera device for VIDEORC_DECAY_REAL_CAMERA=1')
    sources.cameraId = camera.id
    console.log(`[session-decay] real camera: ${camera.name} (${camera.id}, ${camera.status})`)
  }
  return sources
}

function sessionParams(outputDirectoryCapability, sources) {
  return {
    sources,
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
    output: {
      recordEnabled: true,
      streamEnabled: false,
      ...(outputDirectoryCapability ? { outputDirectoryCapability } : {}),
      video: { preset: 'custom', ...PROFILE },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  }
}

const FRESHNESS_KEYS = [
  'compositorFramesRendered',
  'compositorTickSkipped',
  'encoderBridgeInputFps',
  'encoderBridgeRepeatedFrames',
  'encoderBridgeDroppedFrames',
  'encoderBridgeEncodedOutputFrames',
  'encoderBridgeCompositorWaitP95Ms',
  'compositorCameraSourceFreshServes',
  'compositorCameraSourceHeldServes',
  'compositorCameraSourceServedAgeMaxMs',
  'compositorScreenSourceFreshServes',
  'compositorScreenSourceHeldServes',
  'compositorScreenSourceServedAgeMaxMs'
]

async function recordSession({ ws, smoke, index, sources }) {
  const { capabilityId } = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs }
  )
  const started = await request(
    ws,
    timeoutMs,
    'session.start',
    sessionParams(capabilityId, sources)
  )
  if (started.state !== 'recording') {
    throw new Error(`session.start state ${started.state}: ${started.message ?? ''}`)
  }
  await new Promise((resolveSleep) => setTimeout(resolveSleep, recordingMs))
  const diagnostics = await request(ws, timeoutMs, 'diagnostics.stats')
  const bridge = Object.fromEntries(
    FRESHNESS_KEYS.filter((key) => diagnostics[key] !== undefined).map((key) => [
      key,
      diagnostics[key]
    ])
  )
  const stopped = await request(ws, timeoutMs, 'session.stop')
  const outputPath = stopped.outputPath ?? started.outputPath
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error('recording produced no output file')
  }

  const quality = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: PROFILE.fps,
    expectAudio: true,
    gates: DECAY_GATES
  })
  writeReports(quality)

  const failures = [...quality.verdict.failures]
  const observedFps = quality.metrics.observedFps
  if (observedFps != null && Math.abs(observedFps - PROFILE.fps) > PROFILE.fps * 0.05) {
    failures.push(`observed fps ${observedFps.toFixed(2)} != requested ${PROFILE.fps}`)
  }
  const encoded = bridge.encoderBridgeEncodedOutputFrames
  const repeated = bridge.encoderBridgeRepeatedFrames
  let repeatRatio = null
  if (typeof encoded === 'number' && typeof repeated === 'number' && encoded + repeated >= 60) {
    repeatRatio = repeated / (encoded + repeated)
    // The bridge legitimately repeats a handful of frames around start/stop;
    // a session that is >10% repeats recorded a slideshow. Under 60 frames
    // observed (a stats read racing the bridge ramp-up) there is no verdict.
    if (repeatRatio > 0.1) {
      failures.push(
        `bridge served ${(repeatRatio * 100).toFixed(1)}% repeated frames ` +
          `(${repeated} repeated vs ${encoded} encoded)`
      )
    }
  }
  // The owner's 0.9.71–0.9.73 decay lives UPSTREAM of the bridge: capture
  // producers (ScreenCaptureKit / camera) slow to 6–16 fps while the
  // compositor faithfully re-serves held frames at full cadence — bridge
  // repeats stay near zero, so only the source-serve counters can see it.
  // With the motion stimulus on the real screen, fresh serves must track the
  // session fps; held-serve dominance is the producer-stall signature.
  if (realScreen) {
    const fresh = bridge.compositorScreenSourceFreshServes
    const held = bridge.compositorScreenSourceHeldServes
    if (typeof fresh === 'number' && typeof held === 'number' && fresh + held >= 60) {
      const freshRate = fresh / ((fresh + held) / PROFILE.fps)
      if (held > fresh) {
        failures.push(
          `screen producer stalled: ${fresh} fresh vs ${held} held serves ` +
            `(~${freshRate.toFixed(1)} fresh fps against ${PROFILE.fps} target)`
        )
      }
    }
  }
  if (realCamera) {
    const fresh = bridge.compositorCameraSourceFreshServes
    const held = bridge.compositorCameraSourceHeldServes
    if (
      typeof fresh === 'number' &&
      typeof held === 'number' &&
      fresh + held >= 60 &&
      held > fresh
    ) {
      failures.push(`camera producer stalled: ${fresh} fresh vs ${held} held serves`)
    }
  }
  return {
    session: index + 1,
    outputPath,
    sizeBytes: statSync(outputPath).size,
    failures,
    warnings: quality.verdict.warnings,
    longestFreezeMs: quality.metrics.longestFreezeMs ?? null,
    freezeCount: quality.metrics.freezeCount ?? null,
    observedFps,
    repeatRatio,
    bridge
  }
}

const results = []
let stopApp = async () => {}
let motionStimulus = null
let launchedOk = false
try {
  const launch = await launchDevApp({
    spawnSpec: packagedAppExecutable ? { command: packagedAppExecutable, args: [] } : undefined,
    packagedSmokeCommandCapability: packagedSmokeCapability,
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      ...(packagedAppExecutable
        ? {
            VIDEORC_PACKAGED_SMOKE_TEST: '1',
            VIDEORC_SMOKE_COMMAND_CAPABILITY: packagedSmokeCapability,
            VIDEORC_SMOKE_PRINT_BACKEND_READY: '1'
          }
        : {}),
      // Per-frame noise: every compositor-fresh frame is unique, so a held
      // frame is an exact duplicate and freezedetect sees it immediately.
      VIDEORC_SYNTHETIC_HARD_CONTENT: '1'
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (process.env.VIDEORC_SMOKE_PRINT_APP_OUTPUT === '1') console.log(line)
    }
  })
  stopApp = launch.stop
  launchedOk = true
  const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  const smoke = launch.connections['preview-motion-ready']
  const sources = await resolveRealSources(ws)
  if (realScreen) {
    motionStimulus = await launchScreenMotionStimulus({
      outputDirectory,
      ffmpegPath
    })
    console.log('[session-decay] screen motion stimulus running')
  }

  for (let index = 0; index < sessionCount; index += 1) {
    try {
      const result = await recordSession({ ws, smoke, index, sources })
      results.push(result)
      const status = result.failures.length === 0 ? 'PASS' : 'FAIL'
      const serves = (kind) => {
        const fresh = result.bridge?.[`compositor${kind}SourceFreshServes`]
        const held = result.bridge?.[`compositor${kind}SourceHeldServes`]
        if (typeof fresh !== 'number' || typeof held !== 'number') return 'n/a'
        return `${fresh}f/${held}h`
      }
      console.log(
        `Session decay [${result.session}/${sessionCount}] ${status}: ` +
          `${(result.sizeBytes / 1024).toFixed(0)}KB, ` +
          `fps ${result.observedFps == null ? '?' : result.observedFps.toFixed(2)}, ` +
          `repeats ${result.repeatRatio == null ? 'n/a' : `${(result.repeatRatio * 100).toFixed(1)}%`}, ` +
          `serves screen ${serves('Screen')} camera ${serves('Camera')}`
      )
      for (const failure of result.failures) {
        console.error(`  ❌ ${failure}`)
      }
    } catch (error) {
      results.push({ session: index + 1, failures: [String(error?.message ?? error)] })
      console.error(
        `Session decay [${index + 1}/${sessionCount}] FAIL: ${String(error?.message ?? error)}`
      )
      try {
        await request(ws, timeoutMs, 'session.stop')
      } catch {
        // No live session to stop — expected for start-time refusals.
      }
    }
    if (index + 1 < sessionCount) {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, idleMs))
    }
  }
} catch (error) {
  console.error(`Session decay smoke failed to launch: ${String(error?.message ?? error)}`)
} finally {
  if (motionStimulus) await stopScreenMotionStimulus(motionStimulus)
  await stopApp()
}

const resultsPath = join(outputDirectory, 'session-decay-results.json')
try {
  writeFileSync(resultsPath, JSON.stringify(results, null, 1))
} catch {
  // The console summary below is the primary output.
}

const failed = results.filter((result) => result.failures.length > 0)
if (!launchedOk || results.length !== sessionCount) {
  console.error('Session decay smoke did not run every session.')
  process.exit(1)
}
console.log(
  `\nSession decay: ${results.length - failed.length}/${results.length} sessions PASS ` +
    `(reports in ${outputDirectory})`
)
if (failed.length > 0) {
  console.error(`Failing sessions: ${failed.map((result) => result.session).join(', ')}`)
  process.exit(1)
}
