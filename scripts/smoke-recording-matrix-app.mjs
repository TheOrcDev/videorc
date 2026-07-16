// Recording resolution × fps matrix smoke (recording-quality plan Q5).
//
// Records every shipping-relevant recording profile through the REAL dev app
// and backend (testPattern source), then holds each artifact to the strict
// analyzer gates PLUS the quality-law gates the 2026-07 audit added:
//
//   - colorimetry tagged BT.709 video-range (requireColorTags)
//   - spec-valid H.264 level for the real macroblock rate (requireValidLevel)
//   - 2s keyframe cadence (keyframeMaxIntervalSeconds)
//   - bounded A/V stop tail (maxTailMismatchMs)
//   - exact requested dimensions and fps
//
// The 640×360 layout smoke cannot see any of these regressions — this matrix
// is the gate that would have caught the 60fps second-class pipeline, the
// under-spec level tags, and the untagged color that shipped before it.
//
// Usage: pnpm smoke:recording-matrix
//   VIDEORC_MATRIX_ONLY=1080p60,4K30   run a subset by label
//   VIDEORC_MATRIX_RECORDING_MS=6000   per-combo capture length
//   VIDEORC_SMOKE_OUTPUT_DIR=...       artifact + report directory

import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-recording-matrix-${Date.now()}`)
)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-recording-matrix-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = siblingFfprobePath(ffmpegPath) ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90000)
const recordingMs = Number(process.env.VIDEORC_MATRIX_RECORDING_MS ?? 6000)

// Every shipping recording profile plus the 60fps combos the encoder bridge
// now serves. 4K60 must use its experimental preset at the EXACT pinned
// values (validate_video_profile_policy rejects any deviation).
const MATRIX = [
  { label: '1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
  { label: '1080p60', width: 1920, height: 1080, fps: 60, bitrateKbps: 12000 },
  { label: '1440p30', width: 2560, height: 1440, fps: 30, bitrateKbps: 8000 },
  { label: '1440p60', width: 2560, height: 1440, fps: 60, bitrateKbps: 16000 },
  { label: '4K30', width: 3840, height: 2160, fps: 30, bitrateKbps: 30000 },
  {
    label: '4K60',
    width: 3840,
    height: 2160,
    fps: 60,
    bitrateKbps: 50000,
    preset: 'record-4k60-experimental'
  },
  { label: 'vertical-1080p30', width: 1080, height: 1920, fps: 30, bitrateKbps: 6000 },
  { label: 'vertical-1440p30', width: 1440, height: 2560, fps: 30, bitrateKbps: 8000 },
  { label: 'vertical-4K30', width: 2160, height: 3840, fps: 30, bitrateKbps: 30000 },
  { label: 'floor-360p24', width: 640, height: 360, fps: 24, bitrateKbps: 2000 }
].filter(
  (combo) =>
    !process.env.VIDEORC_MATRIX_ONLY ||
    process.env.VIDEORC_MATRIX_ONLY.split(',').includes(combo.label)
)

// The strict quality-law gates. requireMotion stays off: the test pattern is
// deliberately reused from the layout smoke and can be near-static.
const MATRIX_GATES = Object.freeze({
  requireMotion: false,
  requireColorTags: true,
  requireValidLevel: true,
  keyframeMaxIntervalSeconds: 2.5,
  maxTailMismatchMs: 100
})

function sessionParams({ outputDirectoryCapability, combo }) {
  return {
    sources: { testPattern: true },
    layout: {
      layoutPreset: combo.width >= combo.height ? 'screen-camera' : 'vertical-camera-top',
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
      video: {
        preset: combo.preset ?? 'custom',
        width: combo.width,
        height: combo.height,
        fps: combo.fps,
        bitrateKbps: combo.bitrateKbps
      },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    }
  }
}

// Stress combos (full-canvas incompressible noise at 4K) make the encoder
// deliberately encoder-bound: the contract is SURVIVAL (no mid-recording
// death), preview liveness, colorimetry, and level — not frame cadence. A
// slideshow under impossible content is the designed degradation; dying is
// the 0.9.44 bug.
const STRESS_GATES = Object.freeze({
  ...MATRIX_GATES,
  frameCountTolerance: Number.POSITIVE_INFINITY,
  maxDurationStretchRatio: Number.POSITIVE_INFINITY,
  keyframeMaxIntervalSeconds: null,
  maxTailMismatchMs: null
})

async function recordCombo({ ws, smoke, combo, assertPreviewLiveness = false, stress = false }) {
  // The output-directory capability is single-use: one grant per session.start.
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
    sessionParams({ outputDirectoryCapability: capabilityId, combo })
  )
  if (started.state !== 'recording') {
    throw new Error(`session.start state ${started.state}: ${started.message ?? ''}`)
  }
  let livenessFailure = null
  if (assertPreviewLiveness) {
    // The 0.9.44 regression starved the compositor mid-recording (encoder
    // held the whole target ring): the preview froze while the session ran.
    // Prove the compositor keeps rendering DURING the recording.
    const sampleGapMs = Math.min(2000, Math.max(1000, recordingMs / 3))
    await new Promise((resolveSleep) => setTimeout(resolveSleep, sampleGapMs))
    const first = await request(ws, timeoutMs, 'compositor.status')
    await new Promise((resolveSleep) => setTimeout(resolveSleep, sampleGapMs))
    const second = await request(ws, timeoutMs, 'compositor.status')
    const advanced = (second.framesRendered ?? 0) - (first.framesRendered ?? 0)
    const expected = (combo.fps * sampleGapMs) / 1000
    if (!(advanced >= expected * 0.25)) {
      livenessFailure =
        `compositor stalled during recording: ${advanced} frames rendered in ` +
        `${sampleGapMs}ms (expected ≈${expected.toFixed(0)})`
    }
    await new Promise((resolveSleep) =>
      setTimeout(resolveSleep, Math.max(0, recordingMs - 2 * sampleGapMs))
    )
  } else {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, recordingMs))
  }
  const stopped = await request(ws, timeoutMs, 'session.stop')
  const outputPath = stopped.outputPath ?? started.outputPath
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error('recording produced no output file')
  }

  const quality = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: combo.fps,
    expectAudio: true,
    gates: stress ? STRESS_GATES : MATRIX_GATES
  })
  writeReports(quality)

  const failures = [...quality.verdict.failures]
  if (livenessFailure) {
    failures.push(livenessFailure)
  }
  const { width, height } = quality.metrics
  if (width !== combo.width || height !== combo.height) {
    failures.push(`dimensions ${width}x${height} != requested ${combo.width}x${combo.height}`)
  }
  const observedFps = quality.metrics.observedFps
  if (!stress && observedFps != null && Math.abs(observedFps - combo.fps) > combo.fps * 0.02) {
    failures.push(`observed fps ${observedFps.toFixed(2)} != requested ${combo.fps}`)
  }
  return {
    combo: combo.label,
    outputPath,
    sizeBytes: statSync(outputPath).size,
    failures,
    warnings: quality.verdict.warnings,
    metrics: quality.metrics
  }
}

async function runPass({ passLabel, combos, extraEnv = {}, assertPreviewLiveness = false }) {
  const passResults = []
  let stopApp = async () => {}
  try {
    const launch = await launchDevApp({
      env: {
        VIDEORC_SMOKE_COMMAND_SERVER: '1',
        VIDEORC_SMOKE_STATE_DIR: outputDirectory,
        VIDEORC_USER_DATA_DIR: userDataDir,
        ...extraEnv
      },
      timeoutMs,
      requiredMarkers: ['backend-ready', 'preview-motion-ready'],
      onLine: () => {}
    })
    stopApp = launch.stop
    const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
    const smoke = launch.connections['preview-motion-ready']

    for (const combo of combos) {
      const label = `${combo.label}${passLabel ? `:${passLabel}` : ''}`
      try {
        const result = await recordCombo({
          ws,
          smoke,
          combo,
          assertPreviewLiveness,
          stress: combo.stress ?? false
        })
        result.combo = label
        passResults.push(result)
        const status = result.failures.length === 0 ? 'PASS' : 'FAIL'
        console.log(
          `Recording matrix [${label}] ${status}: ${(result.sizeBytes / 1024).toFixed(0)}KB, ` +
            `level ${result.metrics.level != null ? (result.metrics.level / 10).toFixed(1) : '?'}, ` +
            `color ${result.metrics.colorSpace ?? 'unknown'}/${result.metrics.colorRange ?? 'unknown'}, ` +
            `tail ${result.metrics.tailMismatchMs == null ? 'n/a' : `${result.metrics.tailMismatchMs.toFixed(0)}ms`}`
        )
        for (const failure of result.failures) {
          console.error(`  ❌ ${failure}`)
        }
      } catch (error) {
        passResults.push({ combo: label, failures: [String(error?.message ?? error)] })
        console.error(`Recording matrix [${label}] FAIL: ${String(error?.message ?? error)}`)
        // A start-time refusal leaves no live session; a mid-recording error may.
        try {
          await request(ws, timeoutMs, 'session.stop')
        } catch {
          // No live session to stop — expected for start-time refusals.
        }
      }
    }
  } finally {
    await stopApp()
  }
  return passResults
}

const results = []
let launchedOk = false
try {
  results.push(...(await runPass({ passLabel: '', combos: MATRIX })))
  launchedOk = true
  // Hard-content pass: per-frame noise makes the encoder do real-content
  // work, surfacing bridge-pressure defects (encoder behind realtime, ring
  // starvation, latency-contract kills) that the easy 64x64 pattern hides —
  // 0.9.44 shipped its mid-recording-crash regression through green gates
  // exactly that way. Preview must stay live THROUGH the recording.
  // 1080p60 must hold FULL cadence under noise (proven headroom); 4K noise is
  // beyond any real content, so 4K30 runs as a survival stress combo.
  const hardCombos = MATRIX.filter((combo) => ['4K30', '1080p60'].includes(combo.label)).map(
    (combo) => (combo.label === '4K30' ? { ...combo, stress: true } : combo)
  )
  if (hardCombos.length > 0) {
    results.push(
      ...(await runPass({
        passLabel: 'hard',
        combos: hardCombos,
        extraEnv: { VIDEORC_SYNTHETIC_HARD_CONTENT: '1' },
        assertPreviewLiveness: true
      }))
    )
  }
} catch (error) {
  console.error(`Recording matrix pass failed to launch: ${String(error?.message ?? error)}`)
}

const resultsPath = join(outputDirectory, 'recording-matrix-results.json')
try {
  writeFileSync(resultsPath, JSON.stringify(results, null, 1))
} catch {
  // The console summary below is the primary output.
}

const failed = results.filter((result) => result.failures.length > 0)
if (!launchedOk || results.length === 0) {
  console.error('Recording matrix smoke did not produce any results.')
  process.exit(1)
}
console.log(
  `\nRecording matrix: ${results.length - failed.length}/${results.length} combos PASS ` +
    `(reports in ${outputDirectory})`
)
if (failed.length > 0) {
  console.error(`Failing combos: ${failed.map((result) => result.combo).join(', ')}`)
  process.exit(1)
}
