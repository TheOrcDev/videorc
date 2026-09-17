// Record start/stop latency smoke (instant-record plan, Phase 0).
//
// Drives the REAL dev app through the renderer's Record path: a fake Stream
// Deck client sends `recordStart` / `recordStop` remote intents, which the
// renderer executes with the same `startSession` / `stopSession` the Record
// button uses. Per cycle it measures, on the backend socket:
//
//   click → recording.status(starting) → recording.status(recording) → remote.ack
//   stop  → recording.status(stopping) → terminal idle             → remote.ack
//   idle  → MP4 published (finalization)
//
// and verifies every artifact with the recording analyzer, the first-2-seconds
// startup-resolution gate and the wall-duration gate, so speed can never trade
// correctness. Cycle 1 is "cold" (first start in the process); later cycles
// are "warm" and are the ones the OBS-parity budgets apply to.
//
// Default mode is report-only. `--enforce` fails the run against
// RECORD_LATENCY_BUDGETS (scripts/lib/record-latency-gate.mjs); the budgets are
// only meant to be enforced once `calibratedFrom` names a calibration doc.
//
// The isolated profile has no persisted output directory, so the renderer's
// default output falls back to the smoke-owned VIDEORC_RECORDINGS_DIR derived
// by smokeAppEnv from VIDEORC_SMOKE_STATE_DIR. No resource capability is needed.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, hostname, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'

import { launchDevApp } from './lib/app-launcher.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import {
  RECORD_LATENCY_BUDGETS,
  evaluateRecordLatencyBudget,
  formatMs,
  formatSummaryTable,
  nextCycleDelayMs,
  readBudgetOverrides,
  summarizeRecordCycles,
  timelinePhaseDeltas
} from './lib/record-latency-gate.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { evaluateRecordingWallDuration } from './lib/recording-duration-gate.mjs'
import {
  connectRemote,
  enableRemoteControl,
  remoteRequest,
  waitForRemoteDescribe,
  waitForRemoteEvent
} from './lib/remote-control-client.mjs'
import { syntheticCompositorReady } from './lib/remote-control-smoke-gates.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  analyzeStartupResolution,
  writeStartupReports
} from './lib/startup-resolution-analyzer.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const { values: args } = parseArgs({
  options: {
    cycles: { type: 'string', default: '5' },
    'recording-ms': { type: 'string', default: '4000' },
    'idle-gap-ms': { type: 'string', default: '1500' },
    'finalization-timeout-ms': { type: 'string', default: '30000' },
    fps: { type: 'string', default: '30' },
    // Renderer video profile seeded into the isolated profile before the first
    // cycle. The fresh default (1440p30) is above the basic-tier recording
    // limits, which refuses Record before any backend request; 1080p30 records
    // on every tier and is the shipping default output preset.
    profile: { type: 'string', default: 'tutorial-1080p30' },
    'expect-width': { type: 'string' },
    'expect-height': { type: 'string' },
    report: { type: 'string' },
    enforce: { type: 'boolean', default: false },
    debug: { type: 'boolean', default: false }
  },
  strict: true
})

const cycles = positiveInteger(args.cycles, 'cycles')
const recordingMs = positiveInteger(args['recording-ms'], 'recording-ms')
const idleGapMs = positiveInteger(args['idle-gap-ms'], 'idle-gap-ms')
const finalizationTimeoutMs = positiveInteger(
  args['finalization-timeout-ms'],
  'finalization-timeout-ms'
)
const VIDEO_PROFILES = Object.freeze({
  'tutorial-1080p30': {
    preset: 'tutorial-1080p30',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateKbps: 6000
  },
  'tutorial-1440p30': {
    preset: 'tutorial-1440p30',
    width: 2560,
    height: 1440,
    fps: 30,
    bitrateKbps: 8000
  }
})
const videoProfile = VIDEO_PROFILES[args.profile]
if (!videoProfile) fail(`--profile must be one of ${Object.keys(VIDEO_PROFILES).join(', ')}`)
const intendedFps = args.fps === '30' ? videoProfile.fps : positiveInteger(args.fps, 'fps')
const expectedWidth =
  optionalPositiveInteger(args['expect-width'], 'expect-width') ?? videoProfile.width
const expectedHeight =
  optionalPositiveInteger(args['expect-height'], 'expect-height') ?? videoProfile.height
const enforce = args.enforce
const debug = args.debug || process.env.VIDEORC_RECORD_LATENCY_DEBUG === '1'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
// The startup analyzer inspects the first two seconds of the file.
if (recordingMs < 2000) fail('--recording-ms must be at least 2000')

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-record-latency-${Date.now()}`)
)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-record-latency-user-data-'))
const reportPath = resolve(args.report ?? join(outputDirectory, 'record-latency-report.json'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = siblingFfprobePath(ffmpegPath) ?? 'ffprobe'
const budgets = readBudgetOverrides(process.env, RECORD_LATENCY_BUDGETS)

function fail(message) {
  throw new Error(`record-latency smoke FAIL: ${message}`)
}

function positiveInteger(raw, name) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) fail(`--${name} must be a positive integer`)
  return value
}

function optionalPositiveInteger(raw, name) {
  return raw === undefined ? null : positiveInteger(raw, name)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function log(message) {
  console.log(`record-latency: ${message}`)
}

/**
 * Buffers backend events with a monotonic receive time so a waiter registered
 * before an intent is sent can never miss the transition it waits for.
 */
class BackendEventRecorder {
  constructor(ws) {
    this.events = []
    this.waiters = new Set()
    this.latestDiagnostics = null
    ws.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (!message?.event) return
      const record = { event: message.event, payload: message.payload, at: performance.now() }
      if (message.event === 'diagnostics.stats') {
        this.latestDiagnostics = record
        return
      }
      this.events.push(record)
      if (debug && message.event === 'recording.status') {
        console.log(
          `[event] ${message.event} ${message.payload?.state ?? ''} ${message.payload?.sessionId ?? ''}`
        )
      }
      for (const waiter of this.waiters) {
        if (waiter.predicate(record)) {
          this.waiters.delete(waiter)
          waiter.resolve(record)
        }
      }
    })
  }

  waitFor(label, predicate, waitTimeoutMs = timeoutMs) {
    return new Promise((resolveWait, rejectWait) => {
      const waiter = { predicate, resolve: null }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        rejectWait(new Error(`timed out waiting for ${label}`))
      }, waitTimeoutMs)
      waiter.resolve = (record) => {
        clearTimeout(timer)
        resolveWait(record)
      }
      this.waiters.add(waiter)
    })
  }
}

function statusEvent(state, sessionId) {
  return (record) =>
    record.event === 'recording.status' &&
    record.payload?.state === state &&
    (sessionId === undefined || record.payload?.sessionId === sessionId)
}

function terminalStatusEvent(sessionId) {
  return (record) =>
    record.event === 'recording.status' &&
    (record.payload?.state === 'idle' || record.payload?.state === 'failed') &&
    record.payload?.sessionId === sessionId
}

function finalizationEvent(sessionId) {
  return (record) =>
    record.event === 'recording.finalization' &&
    record.payload?.sessionId === sessionId &&
    (record.payload?.state === 'finalized' || record.payload?.state === 'failed')
}

/**
 * The renderer keeps its capture config in localStorage (lib/capture.ts
 * STORAGE_KEYS.captureConfig) and merges it over the defaults on load. Seed the
 * requested video profile and reload so the Record path uses it.
 */
async function seedRendererVideoProfile(smoke) {
  await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `
        const key = 'videorc.captureConfig';
        let current = {};
        try { current = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch {}
        // Screen-only scene: the dev app has no camera permission grant and the
        // renderer auto-selects the first listed camera, which would make the
        // start preflight refuse ("camera preview source produced no frames")
        // whenever any camera device happens to be attached. The synthetic
        // diagnostic pattern replaces the screen, so the scene is fully
        // deterministic.
        const layout = { ...(current.layout ?? {}), layoutPreset: 'screen-only' };
        localStorage.setItem(key, JSON.stringify({ ...current, video: params.video, layout, recordEnabled: true, streamEnabled: false }));
        setTimeout(() => location.reload(), 50);
        return true;
      `,
      video: videoProfile
    },
    { timeoutMs }
  )
  // The reload tears the renderer down; give it a moment before the smoke
  // command server is asked for anything else.
  await sleep(2500)
}

/** Best-effort: the renderer's visible start-failure copy, for diagnostics. */
async function describeRendererFailure(smoke) {
  try {
    const response = await requestSmokeCommand(
      smoke,
      'eval-js',
      {
        code: `
          const nodes = Array.from(document.querySelectorAll('[role="alert"], [data-sonner-toast], [data-videorc-start-failure]'));
          return nodes.map((node) => node.textContent?.trim()).filter(Boolean).slice(0, 4);
        `
      },
      { timeoutMs: 5000 }
    )
    const texts = response?.result
    return Array.isArray(texts) && texts.length > 0 ? ` Renderer says: ${texts.join(' | ')}` : ''
  } catch {
    return ''
  }
}

async function waitForBackendState(ws, method, predicate, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(ws, timeoutMs, method)
    if (predicate(last)) return last
    await sleep(100)
  }
  fail(`timed out waiting for ${label}; last ${method}: ${JSON.stringify(last)}`)
}

async function waitForPublishedMp4({ ws, recorder, sessionId, idleRecord }) {
  const idlePath = idleRecord.payload?.outputPath
  if (typeof idlePath === 'string' && idlePath.toLowerCase().endsWith('.mp4')) {
    return { mp4Path: idlePath, finalizedAt: idleRecord.at, source: 'stop-reply' }
  }
  const eventPromise = recorder
    .waitFor(
      `recording.finalization for ${sessionId}`,
      finalizationEvent(sessionId),
      finalizationTimeoutMs
    )
    .catch(() => null)
  const deadline = performance.now() + finalizationTimeoutMs
  for (;;) {
    const raced = await Promise.race([eventPromise, sleep(250).then(() => 'poll')])
    if (raced && raced !== 'poll') {
      if (raced.payload.state === 'failed') {
        fail(`finalization failed for ${sessionId}: ${raced.payload.error ?? 'unknown error'}`)
      }
      return { mp4Path: raced.payload.mp4Path, finalizedAt: raced.at, source: 'event' }
    }
    const page = await request(ws, timeoutMs, 'sessions.list', { limit: 20 })
    const item = page?.items?.find((entry) => entry.id === sessionId)
    if (item?.mp4Path) {
      return { mp4Path: item.mp4Path, finalizedAt: performance.now(), source: 'sessions.list' }
    }
    if (item?.finalizationState === 'failed') {
      fail(`finalization failed for ${sessionId}: ${item.finalizationError ?? 'unknown error'}`)
    }
    if (performance.now() > deadline) {
      fail(`MP4 for ${sessionId} was not published within ${finalizationTimeoutMs}ms`)
    }
  }
}

async function verifyArtifact({ mp4Path, cycleIndex }) {
  if (!mp4Path || !existsSync(mp4Path)) fail(`artifact missing for cycle ${cycleIndex}: ${mp4Path}`)
  const [startupReport, qualityReport] = await Promise.all([
    analyzeStartupResolution(mp4Path, {
      ffmpegPath,
      ffprobePath,
      intendedFps,
      ...(expectedWidth ? { expectedWidth } : {}),
      ...(expectedHeight ? { expectedHeight } : {})
    }),
    analyzeRecording(mp4Path, {
      ffmpegPath,
      ffprobePath,
      intendedFps,
      expectAudio: false,
      gates: { requireMotion: false }
    })
  ])
  const [startupPaths, qualityPaths] = await Promise.all([
    writeStartupReports(startupReport, { ffmpegPath, outDir: join(outputDirectory, 'reports') }),
    Promise.resolve(writeReports(qualityReport, { outDir: join(outputDirectory, 'reports') }))
  ])
  if (!startupReport.verdict.pass) {
    fail(
      `cycle ${cycleIndex} startup-resolution gate failed: ${startupReport.verdict.failures.join('; ')} (report: ${startupPaths.mdPath})`
    )
  }
  if (!qualityReport.verdict.pass) {
    fail(
      `cycle ${cycleIndex} recording quality gate failed: ${qualityReport.verdict.failures.join('; ')} (report: ${qualityPaths.mdPath})`
    )
  }
  const { width, height, durationSeconds } = qualityReport.metrics
  if (expectedWidth && expectedHeight && (width !== expectedWidth || height !== expectedHeight)) {
    fail(
      `cycle ${cycleIndex} artifact is ${width}x${height}, expected ${expectedWidth}x${expectedHeight}`
    )
  }
  const durationFailures = evaluateRecordingWallDuration({
    expectedDurationMs: recordingMs,
    actualDurationSeconds: durationSeconds
  })
  if (durationFailures.length > 0) {
    fail(`cycle ${cycleIndex} duration gate failed: ${durationFailures.join('; ')}`)
  }
  return { width, height, durationSeconds }
}

function timelineSnapshotFor(recorder, key, sessionId) {
  const snapshot = recorder.latestDiagnostics?.payload?.[key]
  if (!snapshot) return null
  if (snapshot.sessionId && snapshot.sessionId !== sessionId) return null
  return snapshot
}

async function runCycle({ cycleIndex, renderer, remote, recorder, smoke }) {
  const cold = cycleIndex === 0
  const startingPromise = recorder
    .waitFor('recording.status(starting)', statusEvent('starting'), timeoutMs)
    .catch(() => null)
  const recordingPromise = recorder.waitFor(
    'recording.status(recording)',
    (record) =>
      record.event === 'recording.status' &&
      (record.payload?.state === 'recording' || record.payload?.state === 'streaming') &&
      typeof record.payload?.sessionId === 'string',
    timeoutMs
  )
  const startFailurePromise = recorder
    .waitFor(
      'recording.status(failed)',
      (record) => record.event === 'recording.status' && record.payload?.state === 'failed',
      timeoutMs
    )
    .catch(() => null)
  const startAckPromise = waitForRemoteEvent(remote, 'remote.ack', () => true, { timeoutMs }).then(
    (payload) => ({ payload, at: performance.now() })
  )

  const clickAt = performance.now()
  const ticket = await remoteRequest(
    remote,
    'remote.intent',
    { kind: 'recordStart' },
    { timeoutMs }
  )
  if (!ticket.payload?.accepted)
    fail(`recordStart intent was not accepted: ${JSON.stringify(ticket)}`)

  const recordingRecord = await Promise.race([
    recordingPromise,
    startFailurePromise.then((record) => {
      if (record) fail(`start failed: ${record.payload?.message ?? 'no message'}`)
      return new Promise(() => {})
    }),
    // A refused start acks ok=false without ever publishing `recording`.
    startAckPromise.then(async (ack) => {
      if (ack.payload?.ok === false) {
        const detail = await describeRendererFailure(smoke)
        fail(
          `recordStart was refused by the renderer: ${ack.payload?.message ?? 'no message'}.${detail}`
        )
      }
      return new Promise(() => {})
    })
  ])
  const sessionId = recordingRecord.payload.sessionId
  const startAck = await startAckPromise
  if (startAck.payload?.intentId !== ticket.payload.intentId || startAck.payload?.ok !== true) {
    fail(`recordStart was not acknowledged successfully: ${JSON.stringify(startAck.payload)}`)
  }
  const startingRecord = await Promise.race([startingPromise, sleep(0).then(() => null)])
  const startTimeline = timelineSnapshotFor(recorder, 'recordingStartTimeline', sessionId)

  await sleep(recordingMs)

  const stoppingPromise = recorder
    .waitFor('recording.status(stopping)', statusEvent('stopping', sessionId), timeoutMs)
    .catch(() => null)
  const terminalPromise = recorder.waitFor(
    `terminal recording.status for ${sessionId}`,
    terminalStatusEvent(sessionId),
    timeoutMs
  )
  const stopAckPromise = waitForRemoteEvent(remote, 'remote.ack', () => true, { timeoutMs }).then(
    (payload) => ({ payload, at: performance.now() })
  )
  const stopClickAt = performance.now()
  const stopTicket = await remoteRequest(
    remote,
    'remote.intent',
    { kind: 'recordStop' },
    { timeoutMs }
  )
  if (!stopTicket.payload?.accepted) {
    fail(`recordStop intent was not accepted: ${JSON.stringify(stopTicket)}`)
  }
  const terminalRecord = await Promise.race([
    terminalPromise,
    stopAckPromise.then(async (ack) => {
      if (ack.payload?.ok === false) {
        const detail = await describeRendererFailure(smoke)
        fail(
          `recordStop was refused by the renderer: ${ack.payload?.message ?? 'no message'}.${detail}`
        )
      }
      return new Promise(() => {})
    })
  ])
  if (terminalRecord.payload.state !== 'idle') {
    fail(
      `session ${sessionId} ended in ${terminalRecord.payload.state}: ${terminalRecord.payload.message ?? ''}`
    )
  }
  const stopAck = await stopAckPromise
  if (stopAck.payload?.intentId !== stopTicket.payload.intentId || stopAck.payload?.ok !== true) {
    fail(`recordStop was not acknowledged successfully: ${JSON.stringify(stopAck.payload)}`)
  }
  const stoppingRecord = await Promise.race([stoppingPromise, sleep(0).then(() => null)])

  const finalization = await waitForPublishedMp4({
    ws: renderer,
    recorder,
    sessionId,
    idleRecord: terminalRecord
  })
  // Diagnostics publish is asynchronous; give the last stop snapshot a moment.
  await sleep(300)
  const stopTimeline = timelineSnapshotFor(recorder, 'recordingStopTimeline', sessionId)
  const artifact = await verifyArtifact({ mp4Path: finalization.mp4Path, cycleIndex })
  const compositor = compositorPathForSession(recorder, sessionId)

  const cycle = {
    index: cycleIndex,
    cold,
    sessionId,
    clickToStartingMs: startingRecord ? round(startingRecord.at - clickAt) : null,
    clickToRecordingMs: round(recordingRecord.at - clickAt),
    clickToAckMs: round(startAck.at - clickAt),
    stopClickToStoppingMs: stoppingRecord ? round(stoppingRecord.at - stopClickAt) : null,
    stopClickToIdleMs: round(terminalRecord.at - stopClickAt),
    stopClickToAckMs: round(stopAck.at - stopClickAt),
    idleToFinalizedMs: round(finalization.finalizedAt - terminalRecord.at),
    finalizationSource: finalization.source,
    mp4Path: finalization.mp4Path,
    compositorPath: compositor.path,
    compositorPathDetail: compositor.detail,
    artifact,
    backend: {
      startTimeline,
      stopTimeline,
      startPhases: startTimeline ? timelinePhaseDeltas(startTimeline.marks) : null,
      stopPhases: stopTimeline ? timelinePhaseDeltas(stopTimeline.marks) : null
    }
  }
  log(
    `cycle ${cycleIndex + 1}/${cycles} (${cold ? 'cold' : 'warm'}) ` +
      `start click→starting ${formatMs(cycle.clickToStartingMs)} click→recording ${formatMs(cycle.clickToRecordingMs)} · ` +
      `stop click→stopping ${formatMs(cycle.stopClickToStoppingMs)} click→idle ${formatMs(cycle.stopClickToIdleMs)} · ` +
      `idle→mp4 ${formatMs(cycle.idleToFinalizedMs)} (${finalization.source}) · ${artifact.width}x${artifact.height} ${artifact.durationSeconds.toFixed(2)}s · ` +
      `compositor ${compositor.path ?? 'unknown'}`
  )
  return cycle
}

/**
 * Instant-record P4.1: the backend logs whether the live preview compositor
 * was armed in place (`recording-compositor-armed`) or a recording run was
 * started instead (`recording-compositor-restarted`, with the refusal
 * reason). Report-only: both paths are valid, but the armed path is what the
 * warm budget is calibrated against.
 */
function compositorPathForSession(recorder, sessionId) {
  const entry = recorder.events.find(
    (record) =>
      record.event === 'session.log' &&
      record.payload?.sessionId === sessionId &&
      (record.payload?.code === 'recording-compositor-armed' ||
        record.payload?.code === 'recording-compositor-restarted')
  )
  if (!entry) return { path: null, detail: null }
  return {
    path: entry.payload.code === 'recording-compositor-armed' ? 'armed' : 'restarted',
    detail: entry.payload.message ?? null
  }
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value) : null
}

function gitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

let stopApp = async () => {}
try {
  mkdirSync(outputDirectory, { recursive: true })
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      // The dev app has no microphone permission grant; the renderer still
      // auto-selects a microphone and the CoreAudio open would wait on the OS
      // permission check. Measure the video path honestly instead.
      VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: '1'
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (debug) console.log('[app]', line)
    }
  })
  stopApp = launch.stop
  const renderer = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  const smoke = launch.connections['preview-motion-ready']
  const recorder = new BackendEventRecorder(renderer)

  const health = await request(renderer, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    fail(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the latency smoke.')
  }

  await seedRendererVideoProfile(smoke)
  log(
    `seeded renderer video profile ${videoProfile.preset} (${videoProfile.width}x${videoProfile.height}@${videoProfile.fps})`
  )

  // Arm the renderer-owned test pattern so the Record button has a source, and
  // prove the compositor renders it before measuring anything.
  const compositorBefore = await request(renderer, timeoutMs, 'compositor.status')
  await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 500 }, { timeoutMs })
  await waitForBackendState(
    renderer,
    'compositor.status',
    (compositor) => syntheticCompositorReady(compositor, compositorBefore),
    'synthetic compositor readiness'
  )
  log('synthetic source live; preview compositor rendering')

  const { discovery } = await enableRemoteControl(renderer, { timeoutMs })
  const remote = await connectRemote(discovery.host, discovery.port, discovery.token, { timeoutMs })
  await waitForRemoteDescribe(remote, { timeoutMs })
  log(`remote surface paired; running ${cycles} record cycle(s) of ${recordingMs}ms`)

  const measured = []
  for (let cycleIndex = 0; cycleIndex < cycles; cycleIndex += 1) {
    if (cycleIndex > 0) await sleep(nextCycleDelayMs({ idleGapMs }))
    measured.push(await runCycle({ cycleIndex, renderer, remote, recorder, smoke }))
  }

  const summary = summarizeRecordCycles(measured)
  const verdict = evaluateRecordLatencyBudget(summary, budgets)
  const report = {
    generatedAt: new Date().toISOString(),
    commit: gitHead(),
    host: { hostname: hostname(), osRelease: release(), cpu: cpus()[0]?.model ?? null },
    settings: {
      cycles,
      recordingMs,
      idleGapMs,
      profile: videoProfile.preset,
      intendedFps,
      expectedWidth,
      expectedHeight
    },
    budgets,
    enforce,
    verdict,
    summary,
    cycles: measured
  }
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  console.log('')
  console.log(formatSummaryTable(summary))
  console.log('')
  const armedCycles = measured.filter((cycle) => cycle.compositorPath === 'armed').length
  const restartedCycles = measured.filter((cycle) => cycle.compositorPath === 'restarted').length
  log(
    `compositor path: ${armedCycles} armed in place, ${restartedCycles} restarted, ${measured.length - armedCycles - restartedCycles} unknown`
  )
  log(`report written to ${reportPath}`)
  if (!verdict.pass) {
    for (const failure of verdict.failures) log(`budget: ${failure}`)
  }
  if (enforce && !verdict.pass) {
    fail(`budgets exceeded (${verdict.failures.length})`)
  }
  log(
    verdict.pass
      ? `PASS${enforce ? ' in enforce mode' : ' (report-only; budgets also met)'}`
      : 'PASS (report-only; budgets NOT met, see above)'
  )
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  try {
    await stopApp()
  } finally {
    rmSync(userDataDir, { recursive: true, force: true })
  }
}
