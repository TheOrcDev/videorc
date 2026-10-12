// Replay buffer smoke (plan 181 S6).
//
// Drives the REAL dev app through the Studio's own switch and Save replay:
//
//   1. arms the replay buffer (a buffer-only session: recording.status says
//      replayOnly, no Library row, the status bar never says Recording);
//   2. watches the ring for 3 × N seconds: the backend's segment count never
//      passes ceil(N/2) + 3 (the disk bound), and the ring fills to N;
//   3. saves a replay from the Studio button, then from a remote replaySave
//      intent, then from a clipMark intent (S8: no recording, so a mark
//      saves a replay);
//   4. checks every replay with ffprobe and the recording analyzer: H.264 +
//      AAC, a length of N to N + 2.5 s, no audio gap, a 2 s keyframe cadence,
//      and a Library row whose mp4Path is the file;
//   5. records while armed: the backend hands over, the ring rides the
//      recording (S7), a replay saves mid-recording, the recording itself
//      passes the analyzer, and the ring re-arms after Stop;
//   6. turns the switch off: the ring reports off and no session runs.
//
// The dev binary has no microphone or Screen Recording grant, so the
// session's audio is its silent bus: the analyzer proves the AAC stream's
// continuity and the stop tail, not an audible offset. The A/V offset of the
// copied packets is the recording's (same clock, same packets); the
// real-game acceptance checks it by ear.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { launchDevApp } from './lib/app-launcher.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import {
  BackendEventRecorder,
  disposeRecordLatencyRun,
  startRecordLatencyCycle,
  stopRecordLatencyCycle,
  waitForPublishedMp4
} from './lib/record-latency-events.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import {
  connectRemote,
  enableRemoteControl,
  remoteRequest,
  waitForRemoteDescribe,
  waitForRemoteEvent
} from './lib/remote-control-client.mjs'
import { syntheticCompositorReady } from './lib/remote-control-smoke-gates.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const { values: args } = parseArgs({
  options: {
    // The ring's length. 30 s is the shipping default; a shorter ring keeps
    // an investigative run quick.
    seconds: { type: 'string', default: '30' },
    report: { type: 'string' },
    debug: { type: 'boolean', default: false }
  },
  strict: true
})

const seconds = Number(args.seconds)
if (!Number.isInteger(seconds) || seconds < 5) fail('--seconds must be an integer of at least 5')
const SEGMENT_SECONDS = 2
const MAX_OVERSHOOT_SECONDS = 2.5
/** The backend's bound: ceil(N/2) + 2 listed segments plus the one being written. */
const maxSegmentFiles = Math.ceil(seconds / SEGMENT_SECONDS) + 2 + 1
const debug = args.debug || process.env.VIDEORC_REPLAY_SMOKE_DEBUG === '1'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-replay-buffer-${Date.now()}`)
)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-replay-buffer-user-data-'))
const reportPath = resolve(args.report ?? join(outputDirectory, 'replay-buffer-report.json'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = siblingFfprobePath(ffmpegPath) ?? 'ffprobe'
const VIDEO_PROFILE = Object.freeze({
  preset: 'tutorial-1080p30',
  width: 1920,
  height: 1080,
  fps: 30,
  bitrateKbps: 6000
})

function fail(message) {
  throw new Error(`replay-buffer smoke FAIL: ${message}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function log(message) {
  console.log(`replay-buffer: ${message}`)
}

let stopApp = null
let renderer = null
let remote = null
let recorder = null

async function seedRendererProfile(smoke) {
  await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `
        const key = 'videorc.captureConfig';
        let current = {};
        try { current = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch {}
        const layout = { ...(current.layout ?? {}), layoutPreset: 'screen-only' };
        const seeded = {
          ...current,
          video: params.video,
          layout,
          recordEnabled: true,
          streamEnabled: false,
          replayBuffer: { seconds: params.seconds, startOnLaunch: false }
        };
        localStorage.setItem(key, JSON.stringify(seeded));
        setTimeout(() => location.reload(), 50);
        return true;
      `,
      video: VIDEO_PROFILE,
      seconds
    },
    { timeoutMs }
  )
  await sleep(2500)
}

async function waitForBackendState(method, predicate, label, waitMs = timeoutMs) {
  const deadline = Date.now() + waitMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(renderer, timeoutMs, method)
    if (predicate(last)) return last
    await sleep(250)
  }
  fail(`timed out waiting for ${label}; last ${method}: ${JSON.stringify(last)}`)
}

async function setReplayBuffer(smoke, armed) {
  const outcome = await requestSmokeCommand(
    smoke,
    'eval-js',
    { code: `return window.__videorcSmokeSetReplayBuffer?.(${armed}, ${seconds}) ?? null` },
    { timeoutMs }
  )
  if (outcome?.result !== true) fail('the renderer has no replay buffer smoke hook')
}

/** Every replay.saved / replay.saveFailed the renderer socket saw. */
function replayOutcome(saveLabel, predicate = () => true) {
  return recorder.waitFor(
    `replay outcome for ${saveLabel}`,
    (record) =>
      (record.event === 'replay.saved' || record.event === 'replay.saveFailed') &&
      predicate(record.payload),
    timeoutMs
  )
}

async function verifyReplay(event, label) {
  if (event.event === 'replay.saveFailed') {
    fail(`${label} failed: ${JSON.stringify(event.payload)}`)
  }
  const saved = event.payload
  const path = saved.path
  if (!path || !existsSync(path)) fail(`${label}: replay missing on disk: ${path}`)
  // The smoke's recordings folder is the harness's isolated one
  // (smokeAppEnv: <state>/app-data/recordings); replays go under its Replays.
  if (!path.startsWith(outputDirectory) || !path.includes(join('recordings', 'Replays') + '/')) {
    fail(`${label}: replay is outside <recordings>/Replays: ${path}`)
  }
  if (!/\/Replay \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}( \(\d+\))?\.mp4$/.test(path)) {
    fail(`${label}: replay is not named Replay YYYY-MM-DD HH-MM-SS.mp4: ${path}`)
  }
  if (saved.seconds !== seconds) fail(`${label}: event seconds ${saved.seconds} != ${seconds}`)
  const analysis = await analyzeRecording(path, {
    ffmpegPath,
    ffprobePath,
    intendedFps: VIDEO_PROFILE.fps,
    expectAudio: true,
    gates: {
      requireMotion: true,
      requireColorTags: true,
      keyframeMaxIntervalSeconds: SEGMENT_SECONDS + 0.5,
      requireKeyframeEvidence: true,
      maxTailMismatchMs: 500
    }
  })
  const reports = writeReports(analysis, { outDir: join(outputDirectory, 'reports') })
  if (!analysis.verdict.pass) {
    fail(`${label}: analyzer failed: ${analysis.verdict.failures.join('; ')} (${reports.mdPath})`)
  }
  const { durationSeconds, width, height, hasAudio } = analysis.metrics
  const videoCodec = analysis.probe?.video?.codec_name ?? analysis.metrics.videoCodec
  const audioCodec = analysis.probe?.audio?.[0]?.codec_name ?? analysis.metrics.audioCodec
  if (!hasAudio) fail(`${label}: no audio stream in ${path}`)
  if (videoCodec && videoCodec !== 'h264') fail(`${label}: video codec ${videoCodec} != h264`)
  if (audioCodec && audioCodec !== 'aac') fail(`${label}: audio codec ${audioCodec} != aac`)
  if (width !== VIDEO_PROFILE.width || height !== VIDEO_PROFILE.height) {
    fail(
      `${label}: replay is ${width}x${height}, expected ${VIDEO_PROFILE.width}x${VIDEO_PROFILE.height}`
    )
  }
  const expected = saved.complete ? seconds : saved.coveredSeconds
  if (durationSeconds < expected - 0.75 || durationSeconds > expected + MAX_OVERSHOOT_SECONDS) {
    fail(
      `${label}: replay runs ${durationSeconds.toFixed(2)} s, expected ${expected} to ${expected + MAX_OVERSHOOT_SECONDS} s`
    )
  }
  // The Library row (D7): completed, playable, no processing kind.
  const page = await request(renderer, timeoutMs, 'sessions.list', { limit: 50 })
  const row = page?.items?.find((item) => item.id === saved.replaySessionId)
  if (!row) fail(`${label}: no Library row ${saved.replaySessionId}`)
  if (row.title !== 'Replay') fail(`${label}: Library row title ${row.title} != Replay`)
  if (row.mp4Path !== path) fail(`${label}: Library row mp4Path ${row.mp4Path} != ${path}`)
  if (row.status !== 'completed') fail(`${label}: Library row status ${row.status}`)
  if (row.processingKind) fail(`${label}: Library row has processingKind ${row.processingKind}`)
  log(
    `${label}: ${path.split('/').pop()} · ${durationSeconds.toFixed(2)} s · ${width}x${height} · ${statSync(path).size} bytes · complete=${saved.complete} · row ${row.id}`
  )
  return {
    path,
    durationSeconds,
    width,
    height,
    bytes: statSync(path).size,
    complete: saved.complete,
    coveredSeconds: saved.coveredSeconds,
    source: saved.source ?? null,
    rowId: row.id,
    analyzerReport: reports.mdPath
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  seconds,
  maxSegmentFiles,
  ring: { samples: 0, maxSegmentFilesSeen: 0, filledAfterMs: null },
  replays: [],
  recording: null,
  handover: null
}

try {
  mkdirSync(outputDirectory, { recursive: true })
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: '1'
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      if (debug) console.log('[app]', line)
    }
  })
  stopApp = launch.stop
  renderer = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  const smoke = launch.connections['preview-motion-ready']
  recorder = new BackendEventRecorder(renderer, { debug, timeoutMs })

  const health = await request(renderer, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) fail(health?.ffmpeg?.message ?? 'FFmpeg is unavailable.')

  await seedRendererProfile(smoke)
  const compositorBefore = await request(renderer, timeoutMs, 'compositor.status')
  await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 500 }, { timeoutMs })
  await waitForBackendState(
    'compositor.status',
    (compositor) => syntheticCompositorReady(compositor, compositorBefore),
    'synthetic compositor readiness'
  )
  log('synthetic source live; preview compositor rendering')

  const { discovery } = await enableRemoteControl(renderer, { timeoutMs })
  remote = await connectRemote(discovery.host, discovery.port, discovery.token, { timeoutMs })
  await waitForRemoteDescribe(remote, { timeoutMs })

  // 1. Arm: a buffer-only session, marked as such, with no Library row.
  const ringOff = await request(renderer, timeoutMs, 'replay.status')
  if (ringOff?.state !== 'off') fail(`ring is not off before arming: ${JSON.stringify(ringOff)}`)
  const armedAt = Date.now()
  await setReplayBuffer(smoke, true)
  const ringOn = await waitForBackendState(
    'replay.status',
    (ring) => ring?.state === 'on' && ring?.replayOnly === true,
    'the buffer-only session'
  )
  const status = await request(renderer, timeoutMs, 'recording.status')
  if (status?.replayOnly !== true || status?.sessionId !== ringOn.sessionId) {
    fail(`recording.status is not the buffer-only session: ${JSON.stringify(status)}`)
  }
  const rows = await request(renderer, timeoutMs, 'sessions.list', { limit: 50 })
  if (rows?.items?.some((item) => item.id === ringOn.sessionId)) {
    fail(`the buffer-only session ${ringOn.sessionId} has a Library row`)
  }
  const statusBar = await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `
        const state = document.querySelector('[data-slot="status-bar-state"]')?.textContent ?? '';
        const replay = document.querySelector('[data-testid="status-bar-replay"]')?.textContent ?? '';
        return { state, replay };
      `
    },
    { timeoutMs }
  )
  if (/Recording|On air/.test(statusBar?.result?.state ?? '')) {
    fail(`the status bar calls the ring a session: ${JSON.stringify(statusBar.result)}`)
  }
  log(
    `armed: session ${ringOn.sessionId}, status bar "${statusBar?.result?.state}" / "${statusBar?.result?.replay}"`
  )

  // 2. The disk bound over 3 × N, and the ring fills to N by N + 10 s.
  const watchUntil = armedAt + 3 * seconds * 1000
  let filledAt = null
  while (Date.now() < watchUntil) {
    const ring = await request(renderer, timeoutMs, 'replay.status')
    if (ring?.state !== 'on') fail(`ring left the on state while armed: ${JSON.stringify(ring)}`)
    report.ring.samples += 1
    if (typeof ring.segmentFiles === 'number') {
      report.ring.maxSegmentFilesSeen = Math.max(report.ring.maxSegmentFilesSeen, ring.segmentFiles)
      if (ring.segmentFiles > maxSegmentFiles) {
        fail(`ring holds ${ring.segmentFiles} segment files, bound is ${maxSegmentFiles}`)
      }
    }
    if (filledAt === null && ring.bufferedSeconds >= seconds) {
      filledAt = Date.now()
      report.ring.filledAfterMs = filledAt - armedAt
      log(`ring full (${ring.bufferedSeconds} s) after ${report.ring.filledAfterMs} ms`)
    }
    if (filledAt === null && Date.now() > armedAt + (seconds + 10) * 1000) {
      fail(`ring holds ${ring.bufferedSeconds} s after ${seconds + 10} s; expected ${seconds} s`)
    }
    if (filledAt !== null && Date.now() >= watchUntil) break
    await sleep(1000)
  }
  log(
    `disk bound held: at most ${report.ring.maxSegmentFilesSeen} segment files (bound ${maxSegmentFiles}) over ${report.ring.samples} samples`
  )

  // 3a. Save replay from the Studio button (the same action the global key
  // runs). The synthetic-source command leaves the renderer on Sources; the
  // row lives on the Studio page.
  await requestSmokeCommand(smoke, 'open-tab', { tab: 'studio' }, { timeoutMs })
  await sleep(1000)
  const buttonOutcome = replayOutcome('the Studio button')
  const clicked = await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `
        const button = document.querySelector('[data-testid="replay-save-button"]');
        if (!button) return { clicked: false };
        button.click();
        return { clicked: true };
      `
    },
    { timeoutMs }
  )
  if (clicked?.result?.clicked !== true)
    fail('the Studio has no Save replay button while the ring is on')
  report.replays.push(await verifyReplay(await buttonOutcome, 'save from the Studio button'))

  // 3b. Save replay from a remote intent (a Stream Deck key).
  const remoteOutcome = replayOutcome('the remote intent')
  const remoteAck = waitForRemoteEvent(remote, 'remote.ack', () => true, { timeoutMs })
  const ticket = await remoteRequest(remote, 'remote.intent', { kind: 'replaySave' }, { timeoutMs })
  if (!ticket.payload?.accepted) fail('replaySave intent was not accepted')
  const ack = await remoteAck
  if (ack?.intentId !== ticket.payload.intentId || ack?.ok !== true) {
    fail(`replaySave was not acknowledged: ${JSON.stringify(ack)}`)
  }
  report.replays.push(await verifyReplay(await remoteOutcome, 'save from the remote intent'))

  // 3c. S8: with no recording, a clip mark saves a replay.
  const markOutcome = replayOutcome(
    'the clipMark intent',
    (payload) => payload?.source === 'manual'
  )
  const markAck = waitForRemoteEvent(remote, 'remote.ack', () => true, { timeoutMs })
  const markTicket = await remoteRequest(
    remote,
    'remote.intent',
    { kind: 'clipMark' },
    { timeoutMs }
  )
  if (!markTicket.payload?.accepted) fail('clipMark intent was not accepted')
  const markAcked = await markAck
  if (markAcked?.intentId !== markTicket.payload.intentId || markAcked?.ok !== true) {
    fail(`clipMark with the ring on was not acknowledged: ${JSON.stringify(markAcked)}`)
  }
  const marked = await verifyReplay(await markOutcome, 'save from a clip mark (S8)')
  if (marked.source !== 'manual') fail(`the clip-mark replay carries source ${marked.source}`)
  report.replays.push(marked)

  // 5. Record while armed: the handover, the ride-along, a mid-recording save,
  // the recording itself, and the re-arm after Stop.
  const handoverAt = Date.now()
  const cycle = await startRecordLatencyCycle({
    remote,
    recorder,
    smoke,
    timeoutMs,
    describeRendererFailure: async () => '',
    fail,
    sleep
  })
  if (cycle.sessionId === ringOn.sessionId) fail('Record did not hand over to a new session')
  const riding = await waitForBackendState(
    'replay.status',
    (ring) =>
      ring?.state === 'on' && ring?.replayOnly !== true && ring?.sessionId === cycle.sessionId,
    'the ring riding the recording',
    30_000
  )
  report.handover = {
    bufferSessionId: ringOn.sessionId,
    recordingSessionId: cycle.sessionId,
    clickToRecordingMs: Math.round(cycle.recordingRecord.at - cycle.clickAt),
    ringRidingAfterMs: Date.now() - handoverAt,
    ringSegmentFiles: riding.segmentFiles ?? null
  }
  log(
    `Record handed over: ${ringOn.sessionId} → ${cycle.sessionId}; click→recording ${report.handover.clickToRecordingMs} ms; ring riding the recording`
  )
  await sleep((seconds + 6) * 1000)
  const midOutcome = replayOutcome('the mid-recording save')
  const midAck = waitForRemoteEvent(remote, 'remote.ack', () => true, { timeoutMs })
  const midTicket = await remoteRequest(
    remote,
    'remote.intent',
    { kind: 'replaySave' },
    { timeoutMs }
  )
  if (!midTicket.payload?.accepted) fail('mid-recording replaySave intent was not accepted')
  const midAcked = await midAck
  if (midAcked?.ok !== true) fail(`mid-recording replaySave refused: ${JSON.stringify(midAcked)}`)
  const midRecording = await verifyReplay(await midOutcome, 'save during a recording (S7)')
  report.replays.push(midRecording)

  const stop = await stopRecordLatencyCycle({
    remote,
    recorder,
    smoke,
    sessionId: cycle.sessionId,
    timeoutMs,
    describeRendererFailure: async () => '',
    fail,
    sleep
  })
  const finalization = await waitForPublishedMp4({
    ws: renderer,
    recorder,
    sessionId: cycle.sessionId,
    idleRecord: stop.terminalRecord,
    finalizationTimeoutMs: 60_000,
    timeoutMs,
    fail,
    sleep
  })
  const recordingAnalysis = await analyzeRecording(finalization.mp4Path, {
    ffmpegPath,
    ffprobePath,
    intendedFps: VIDEO_PROFILE.fps,
    expectAudio: false,
    gates: { requireMotion: false }
  })
  const recordingReports = writeReports(recordingAnalysis, {
    outDir: join(outputDirectory, 'reports')
  })
  if (!recordingAnalysis.verdict.pass) {
    fail(
      `the recording beside the ring failed the analyzer: ${recordingAnalysis.verdict.failures.join('; ')} (${recordingReports.mdPath})`
    )
  }
  report.recording = {
    sessionId: cycle.sessionId,
    mp4Path: finalization.mp4Path,
    durationSeconds: recordingAnalysis.metrics.durationSeconds,
    stopClickToIdleMs: Math.round(stop.terminalRecord.at - stop.stopClickAt),
    analyzerReport: recordingReports.mdPath
  }
  log(
    `recording ${cycle.sessionId} published ${finalization.mp4Path} (${recordingAnalysis.metrics.durationSeconds.toFixed(2)} s), analyzer OK`
  )
  const rearmed = await waitForBackendState(
    'replay.status',
    (ring) => ring?.state === 'on' && ring?.replayOnly === true,
    'the re-armed ring after Stop',
    45_000
  )
  log(`ring re-armed after Stop: session ${rearmed.sessionId}`)

  // 6. Off: the ring stops and no session runs.
  await setReplayBuffer(smoke, false)
  await waitForBackendState(
    'replay.status',
    (ring) => ring?.state === 'off',
    'the ring off',
    30_000
  )
  await waitForBackendState(
    'recording.status',
    (current) => current?.state === 'idle',
    'an idle session after the switch went off',
    30_000
  )
  const after = await request(renderer, timeoutMs, 'replay.status')
  if (after?.sessionId) fail(`the ring still names a session: ${JSON.stringify(after)}`)
  log('switch off: ring off, session idle')

  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  log(`report written to ${reportPath}`)
  log('PASS')
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  const cleanup = await disposeRecordLatencyRun({
    recorder,
    renderer,
    remote,
    stopApp,
    removeProfile: () => rmSync(userDataDir, { recursive: true, force: true })
  })
  for (const failure of cleanup.failures) {
    console.error(`replay-buffer: cleanup failed for ${failure.owner}.`)
    process.exitCode = 1
  }
}
