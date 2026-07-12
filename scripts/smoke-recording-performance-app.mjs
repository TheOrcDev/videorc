import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { resolveExistingSiblingFfprobe } from './lib/ffmpeg-sibling-paths.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  collectPerformanceMetadata,
  createPerformanceReport,
  failingChecks,
  passingCheck,
  performanceMode,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import {
  evaluateRecordingArtifact,
  evaluateRecordingPerformance,
  summarizeRecordingDiagnostics
} from './lib/recording-performance-gate.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const repoRoot = resolve(import.meta.dirname, '..')
const mode = performanceMode()
const explicitOutputDirectory = Boolean(process.env.VIDEORC_SMOKE_OUTPUT_DIR)
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    join(tmpdir(), `videorc-recording-performance-${Date.now()}`)
)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath =
  process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? resolveExistingSiblingFfprobe(ffmpegPath) ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const recordingMs = Number(process.env.VIDEORC_PERF_RECORDING_MS ?? 20000)
const warmupMs = Number(process.env.VIDEORC_PERF_WARMUP_MS ?? 12000)
const previewPollMs = Number(process.env.VIDEORC_PERF_PREVIEW_POLL_MS ?? 250)
const minSpeed = Number(process.env.VIDEORC_PERF_MIN_SPEED ?? 0.98)
const maxSkewMs = Number(process.env.VIDEORC_PERF_MAX_AV_SKEW_MS ?? 250)
const thresholds = {
  minSteadySamples: Number(process.env.VIDEORC_PERF_MIN_STEADY_SAMPLES ?? 1),
  minSpeed,
  minFpsRatio: Number(process.env.VIDEORC_PERF_MIN_FPS_RATIO ?? 0.9),
  maxBackendRssMb: Number(process.env.VIDEORC_PERF_MAX_BACKEND_RSS_MB ?? 1024),
  maxActiveFfmpegProcesses: Number(process.env.VIDEORC_PERF_MAX_FFMPEG_PROCESSES ?? 2),
  maxActiveFfprobeProcesses: Number(process.env.VIDEORC_PERF_MAX_FFPROBE_PROCESSES ?? 0),
  minPreviewPollRatio: Number(process.env.VIDEORC_PERF_MIN_PREVIEW_POLL_RATIO ?? 0.5)
}

const scenarios = [
  { label: '1440p30', width: 2560, height: 1440, fps: 30, bitrateKbps: 8000 },
  { label: '1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
]

let stopApp = async () => {}
let results = []
let runError = null

mkdirSync(outputDirectory, { recursive: true })

try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => console.log(line)
  })
  stopApp = launch.stop
  results = await runPerformanceSmoke(
    launch.connections['backend-ready'],
    launch.connections['preview-motion-ready']
  )
} catch (error) {
  runError = error
} finally {
  await stopApp()
}

const report = createPerformanceReport({
  scenario: 'synthetic-recording-performance',
  mode,
  metadata: await collectPerformanceMetadata({ cwd: repoRoot }),
  timing: { warmupMs, measurementMs: recordingMs },
  metrics: { thresholds, scenarios: results },
  checks: runError
    ? failingChecks([runError.message])
    : [
        passingCheck(
          'recordings had video and audio streams, frame progress, and healthy diagnostics'
        )
      ]
})
const reportPath = await writePerformanceReport(report)
console.log(`Recording performance report: ${reportPath}`)
if (!runError && !explicitOutputDirectory && process.env.VIDEORC_PERF_RETAIN_ARTIFACTS !== '1') {
  await rm(outputDirectory, { recursive: true, force: true })
} else if (runError) {
  console.log(`Recording performance scratch retained: ${outputDirectory}`)
}
if (runError) throw runError

async function runPerformanceSmoke(connection, smoke) {
  const ws = await connectBackend(connection, timeoutMs)
  const samples = []
  const scenarioResults = []
  try {
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.event === 'diagnostics.stats') {
          samples.push({ ...message.payload, receivedAt: Date.now() })
        }
      } catch {
        // Ignore non-JSON noise from the socket.
      }
    })

    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for performance smoke.')
    }
    await assertFfprobeAvailable()
    console.log(`Recording performance smoke using FFmpeg: ${ffmpegPath}`)
    console.log(`Recording performance smoke using FFprobe: ${ffprobePath}`)

    for (const scenario of scenarios) {
      scenarioResults.push(await runScenario(ws, connection, smoke, samples, scenario))
    }
    return scenarioResults
  } finally {
    ws.close()
  }
}

async function runScenario(ws, connection, smoke, samples, scenario) {
  samples.length = 0
  await request(ws, timeoutMs, 'preview.live.start', previewParams(scenario))

  const scenarioStartedAt = Date.now()
  const recordingDirectory = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs }
  )
  const started = await request(
    ws,
    timeoutMs,
    'session.start',
    sessionParams(scenario, recordingDirectory.capabilityId)
  )
  if (started.state !== 'recording') {
    throw new Error(
      `[${scenario.label}] Expected recording state after start, got ${started.state}.`
    )
  }

  const previewPolling = pollPreviewFrames(connection)
  await sleep(recordingMs)
  previewPolling.stop()
  const polls = await previewPolling.done

  const stopRequestedAt = Date.now()
  const stopped = await request(ws, timeoutMs, 'session.stop')
  const outputPath = stopped.outputPath ?? started.outputPath
  if (!outputPath || !existsSync(outputPath)) {
    throw new Error(
      `[${scenario.label}] Recording output was not created: ${outputPath ?? 'missing path'}`
    )
  }
  const size = statSync(outputPath).size
  if (size <= 0) {
    throw new Error(`[${scenario.label}] Recording output is empty: ${outputPath}`)
  }

  const stats = summarizeRecordingDiagnostics(samples, {
    targetFps: scenario.fps,
    scenarioStartedAt,
    stopRequestedAt,
    warmupMs
  })
  const diagnosticFailures = evaluateRecordingPerformance({ scenario, stats, polls, thresholds })
  if (diagnosticFailures.length > 0) {
    throw new Error(diagnosticFailures.join('\n'))
  }
  const artifact = await analyzeRecording(outputPath, {
    ffmpegPath,
    ffprobePath,
    intendedFps: scenario.fps,
    expectAudio: true,
    gates: { avSyncHardFailMs: maxSkewMs }
  })
  const analyzerPaths = writeReports(artifact)
  const artifactFailures = evaluateRecordingArtifact({ scenario, report: artifact })
  if (artifactFailures.length > 0) {
    throw new Error(artifactFailures.join('\n'))
  }

  console.log(
    `Recording performance [${scenario.label}] OK: ${outputPath} (${size} bytes), min speed ${format(stats.minSpeed)}x, capture/render FPS ${format(stats.minCaptureFps)}/${format(stats.minRenderFps)}, decoded ${artifact.metrics.observedFrames} frames at ${format(artifact.metrics.observedFps)}fps, longest freeze ${format(artifact.metrics.longestFreezeMs)}ms, A/V skew ${format(artifact.metrics.avSkewMs)}ms, preview polls ${polls.successes}/${polls.attempts}, maintenance samples ${stats.maintenanceSamples}, duplicate samples ${stats.duplicateCaptureSamples}, max RSS ${formatBytes(stats.maxBackendRssBytes)}, max FFmpeg procs ${stats.maxActiveFfmpegProcesses}, max FFprobe procs ${stats.maxActiveFfprobeProcesses}`
  )
  return {
    scenario,
    outputPath,
    size,
    stats,
    polls,
    artifact: {
      verdict: artifact.verdict,
      metrics: artifact.metrics,
      analyzerPaths
    }
  }
}

function sessionParams(scenario, outputDirectoryCapability) {
  return {
    sources: { testPattern: true },
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
      video: {
        preset: 'custom',
        width: scenario.width,
        height: scenario.height,
        fps: scenario.fps,
        bitrateKbps: scenario.bitrateKbps
      },
      rtmp: {
        preset: 'custom',
        serverUrl: '',
        streamKey: ''
      }
    },
    audio: {
      microphoneGainDb: 0,
      microphoneMuted: false,
      microphoneSyncOffsetMs: 0
    }
  }
}

function previewParams(scenario) {
  const { sources, layout, output } = sessionParams(scenario)
  return { sources, layout, ffmpegPath, video: output.video }
}

function pollPreviewFrames(connection) {
  let stopped = false
  let attempts = 0
  let successes = 0
  async function poll() {
    while (!stopped) {
      attempts += 1
      const url = `http://${connection.host}:${connection.port}/preview/live.jpg?token=${encodeURIComponent(connection.token)}&t=${Date.now()}`
      try {
        const response = await fetch(url)
        if (response.ok && (await response.arrayBuffer()).byteLength > 0) successes += 1
      } catch {
        // Failed fetches remain visible in the success-ratio gate.
      }
      await sleep(previewPollMs)
    }
    return { attempts, successes }
  }
  const done = poll()
  return {
    done,
    stop() {
      stopped = true
    }
  }
}
async function assertFfprobeAvailable() {
  try {
    const result = await run(ffprobePath, ['-version'])
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `exit ${result.status}`)
    }
  } catch (error) {
    throw new Error(
      `FFprobe is required for final-artifact cadence and A/V checks. Set VIDEORC_SMOKE_FFPROBE_PATH. ${error.message}`
    )
  }
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repoRoot })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      stdout += text
    })
    child.stderr.on('data', (text) => {
      stderr += text
    })
    child.on('error', rejectRun)
    child.on('exit', (code) => resolveRun({ status: code ?? 1, stdout, stderr }))
  })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function format(value) {
  return typeof value === 'number' ? value.toFixed(2) : 'n/a'
}

function formatBytes(value) {
  if (typeof value !== 'number') {
    return 'n/a'
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(0)}KiB`
  }
  return `${(value / (1024 * 1024)).toFixed(1)}MiB`
}
