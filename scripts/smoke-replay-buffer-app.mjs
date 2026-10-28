// Clip buffer smoke (plan 181 S6, the owner's redesign R1-R4; plan 199's two
// clip lengths).
//
// Drives the REAL dev app through the Output switch's own path and the one
// clip action (clip.mark: the Stream Manager's Clip buttons, their keys, ⌘K,
// a deck key, /clip and the spoken "clip that" all call it):
//
//   1. proves the ring runs by default at launch and keeps the minute (R2,
//      plan 199: a buffer-only session: recording.status says replayOnly, no
//      Library row, the status bar never says Recording), then turns the
//      switch off and on at the requested ring length;
//   2. watches the ring until it is full plus 30 s: the backend's segment
//      count never passes ceil(N/2) + 3 (the disk bound), and the ring fills
//      to N;
//   3. saves clips through clip.mark: no length (today's 30 s) and
//      `seconds: 60` (the minute), each replying clip-saved with nothing
//      marked (no recording runs); then the minute through a remote clipMark
//      intent; a length nobody offers (45) is refused and writes nothing;
//   4. checks every clip with ffprobe and the recording analyzer: H.264 +
//      AAC, a length of L to L + 2.5 s for the press's length L, no audio
//      gap, a 2 s keyframe cadence, and a Library row titled Clip whose
//      mp4Path is the file;
//   5. records while armed: the backend hands over, the ring rides the
//      recording (S7), one 1-minute clip.mark mid-recording saves a clip AND
//      keeps a mark that remembers its 60 s (R4, plan 199 D8), the recording
//      itself passes the analyzer, and the ring re-arms after Stop;
//   6. turns the switch off: the ring reports off and no session runs.
//
// The dev binary has no microphone or Screen Recording grant, so the
// session's audio is its silent bus: the analyzer proves the AAC stream's
// continuity and the stop tail, not an audible offset. The A/V offset of the
// copied packets is the recording's (same clock, same packets); the
// real-game acceptance checks it by ear.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
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
import { requestSmokeCommand, waitForRendererHook } from './lib/smoke-command-client.mjs'
import { FORGET_WORKING_SCENE_JS } from './lib/renderer-profile-seed.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const { values: args } = parseArgs({
  options: {
    // The ring's length. The product's ring always keeps the minute (plan
    // 199); a shorter ring keeps an investigative run quick, and both clip
    // lengths then clamp to it.
    seconds: { type: 'string', default: '60' },
    report: { type: 'string' },
    debug: { type: 'boolean', default: false }
  },
  strict: true
})

const seconds = Number(args.seconds)
if (!Number.isInteger(seconds) || seconds < 5) fail('--seconds must be an integer of at least 5')
const SEGMENT_SECONDS = 2
const MAX_OVERSHOOT_SECONDS = 2.5
/** The ring the app keeps by itself at launch (plan 199: the minute). */
const PRODUCT_RING_SECONDS = 60
/** The two clip lengths (plan 199), clamped to the ring as the backend does. */
const SHORT_CLIP_SECONDS = Math.min(30, seconds)
const LONG_CLIP_SECONDS = Math.min(60, seconds)
/** Watch the disk bound this long after the ring is full. */
const WATCH_AFTER_FULL_MS = 30_000
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
          replayBuffer: { enabled: true, explicit: false }
        };
        localStorage.setItem(key, JSON.stringify(seeded));
        ${FORGET_WORKING_SCENE_JS}
        setTimeout(() => location.reload(), 50);
        return true;
      `,
      video: VIDEO_PROFILE
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
  await waitForRendererHook(smoke, '__videorcSmokeSetReplayBuffer', { timeoutMs })
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

/** The clip files in `<recordings>/Clips`, to prove a refused press wrote nothing. */
function clipFiles() {
  const dir = join(outputDirectory, 'app-data', 'recordings', 'Clips')
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.mp4')) : []
}

/** `clipSeconds` is the press's length (plan 199): 30 or 60, clamped to the ring. */
async function verifyReplay(event, label, clipSeconds) {
  if (event.event === 'replay.saveFailed') {
    fail(`${label} failed: ${JSON.stringify(event.payload)}`)
  }
  const saved = event.payload
  const path = saved.path
  if (!path || !existsSync(path)) fail(`${label}: replay missing on disk: ${path}`)
  // The smoke's recordings folder is the harness's isolated one
  // (smokeAppEnv: <state>/app-data/recordings); clips go under its Clips.
  if (!path.startsWith(outputDirectory) || !path.includes(join('recordings', 'Clips') + '/')) {
    fail(`${label}: clip is outside <recordings>/Clips: ${path}`)
  }
  if (!/\/Clip \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}( \(\d+\))?\.mp4$/.test(path)) {
    fail(`${label}: clip is not named Clip YYYY-MM-DD HH-MM-SS.mp4: ${path}`)
  }
  if (saved.seconds !== clipSeconds) {
    fail(`${label}: event seconds ${saved.seconds} != ${clipSeconds}`)
  }
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
  const expected = saved.complete ? clipSeconds : saved.coveredSeconds
  if (durationSeconds < expected - 0.75 || durationSeconds > expected + MAX_OVERSHOOT_SECONDS) {
    fail(
      `${label}: replay runs ${durationSeconds.toFixed(2)} s, expected ${expected} to ${expected + MAX_OVERSHOOT_SECONDS} s`
    )
  }
  // The Library row (D7): completed, playable, no processing kind.
  const page = await request(renderer, timeoutMs, 'sessions.list', { limit: 50 })
  const row = page?.items?.find((item) => item.id === saved.replaySessionId)
  if (!row) fail(`${label}: no Library row ${saved.replaySessionId}`)
  if (row.title !== 'Clip') fail(`${label}: Library row title ${row.title} != Clip`)
  if (row.mp4Path !== path) fail(`${label}: Library row mp4Path ${row.mp4Path} != ${path}`)
  if (row.status !== 'completed') fail(`${label}: Library row status ${row.status}`)
  if (row.processingKind) fail(`${label}: Library row has processingKind ${row.processingKind}`)
  log(
    `${label}: ${path.split('/').pop()} · ${durationSeconds.toFixed(2)} s · ${width}x${height} · ${statSync(path).size} bytes · complete=${saved.complete} · row ${row.id}`
  )
  return {
    path,
    clipSeconds,
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

  // 1. The default (R2): the ring runs whenever Videorc is open, so the dev
  // app armed itself at launch with nobody touching a switch, keeping the
  // minute (plan 199). Then the Output switch's own path: off, and on again
  // at the requested ring length.
  const defaultRing = await waitForBackendState(
    'replay.status',
    (ring) => ring?.state === 'on' && ring?.replayOnly === true,
    'the default buffer-only session at launch',
    45_000
  )
  if (defaultRing.seconds !== PRODUCT_RING_SECONDS) {
    fail(`the default ring keeps ${defaultRing.seconds} s, expected ${PRODUCT_RING_SECONDS} s`)
  }
  log(`ring on by default at launch: session ${defaultRing.sessionId} (${defaultRing.seconds} s)`)
  await setReplayBuffer(smoke, false)
  await waitForBackendState(
    'replay.status',
    (ring) => ring?.state === 'off',
    'the ring off after the switch',
    30_000
  )
  const armedAt = Date.now()
  await setReplayBuffer(smoke, true)
  const ringOn = await waitForBackendState(
    'replay.status',
    (ring) =>
      ring?.state === 'on' &&
      ring?.replayOnly === true &&
      ring?.sessionId !== defaultRing.sessionId,
    'the buffer-only session'
  )
  if (ringOn.seconds !== seconds) {
    fail(`the re-armed ring keeps ${ringOn.seconds} s, expected ${seconds} s`)
  }
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

  // 2. The ring fills to N by N + 10 s, and the disk bound holds from arming
  // until 30 s after it is full (15 prune passes past full; plan 199 keeps
  // the smoke short now that N is the minute).
  let filledAt = null
  while (filledAt === null || Date.now() < filledAt + WATCH_AFTER_FULL_MS) {
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
    await sleep(1000)
  }
  log(
    `disk bound held: at most ${report.ring.maxSegmentFilesSeen} segment files (bound ${maxSegmentFiles}) over ${report.ring.samples} samples`
  )

  // 3a + 3b. The one clip action (R4): clip.mark is what the Stream
  // Manager's Clip buttons, their keys, ⌘K, /clip and the spoken "clip that"
  // call. No recording runs, so each reply says clip-saved and nothing was
  // marked. Plan 199: no length is today's 30-second clip, `seconds: 60` the
  // minute. Both are pressed back to back, before either clip is analyzed:
  // the second press queues behind the first save, and neither window holds
  // the analyzer's own load (#827).
  const twoSaves = []
  const bothOutcomes = recorder.waitFor(
    'the 30-second and 1-minute clips',
    (record) => {
      if (record.event !== 'replay.saved' && record.event !== 'replay.saveFailed') return false
      twoSaves.push(record)
      return twoSaves.length === 2
    },
    timeoutMs
  )
  const rpcReply = await request(renderer, timeoutMs, 'clip.mark')
  if (rpcReply?.reason !== 'clip-saved' || rpcReply?.saved !== false) {
    fail(`clip.mark with the ring on did not save a clip: ${JSON.stringify(rpcReply)}`)
  }
  const longReply = await request(renderer, timeoutMs, 'clip.mark', { seconds: 60 })
  if (longReply?.reason !== 'clip-saved' || longReply?.saved !== false) {
    fail(`clip.mark seconds 60 did not save a clip: ${JSON.stringify(longReply)}`)
  }
  await bothOutcomes
  // Saves are serialized, so they report in press order.
  report.replays.push(
    await verifyReplay(twoSaves[0], 'save from clip.mark (no length)', SHORT_CLIP_SECONDS)
  )
  report.replays.push(
    await verifyReplay(twoSaves[1], 'save from clip.mark (60 s)', LONG_CLIP_SECONDS)
  )

  // 3c. A length nobody offers is refused before any work, and writes nothing.
  const clipsBefore = clipFiles().length
  const eventsBefore = recorder.events.length
  let refusal = null
  try {
    await request(renderer, timeoutMs, 'clip.mark', { seconds: 45 })
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  }
  if (refusal !== 'A clip is 30 seconds or 1 minute.') {
    fail(`clip.mark seconds 45 was not refused with the length sentence: ${refusal}`)
  }
  await sleep(5000)
  const lateSaves = recorder.events
    .slice(eventsBefore)
    .filter((record) => record.event === 'replay.saved' || record.event === 'replay.saveFailed')
  if (lateSaves.length > 0 || clipFiles().length !== clipsBefore) {
    fail(`the refused length still saved: ${JSON.stringify(lateSaves)}`)
  }
  log('clip.mark seconds 45 refused: "A clip is 30 seconds or 1 minute.", nothing written')

  // The analyzer above (framemd5 + freezedetect on a full clip) competes with
  // the live compositor; on a CPU-composited host (the Linux box) that stalls
  // a few frames, and the next clip would hold the smoke's own load instead of
  // the ring. Let the ring roll a whole window past the analysis first (#827).
  await sleep((LONG_CLIP_SECONDS + SEGMENT_SECONDS) * 1000)

  // 3d. The minute from a remote intent (a Stream Deck key, plan 199's
  // `seconds` on clipMark).
  const markOutcome = replayOutcome(
    'the clipMark intent',
    (payload) => payload?.source === 'manual'
  )
  const markAck = waitForRemoteEvent(remote, 'remote.ack', () => true, { timeoutMs })
  const markTicket = await remoteRequest(
    remote,
    'remote.intent',
    { kind: 'clipMark', seconds: 60 },
    { timeoutMs }
  )
  if (!markTicket.payload?.accepted) fail('clipMark intent was not accepted')
  const markAcked = await markAck
  if (markAcked?.intentId !== markTicket.payload.intentId || markAcked?.ok !== true) {
    fail(`clipMark with the ring on was not acknowledged: ${JSON.stringify(markAcked)}`)
  }
  const marked = await verifyReplay(
    await markOutcome,
    'save from the remote clipMark intent (60 s)',
    LONG_CLIP_SECONDS
  )
  if (marked.source !== 'manual') fail(`the clip-mark clip carries source ${marked.source}`)
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
  // R4 mid-recording: one press saves the clip AND keeps a mark in the
  // recording (the reply says both), with no clip.marked event. The press
  // asks for the minute, so the mark remembers 60 s (plan 199 D8).
  const midOutcome = replayOutcome('the mid-recording clip')
  const midReply = await request(renderer, timeoutMs, 'clip.mark', { seconds: 60 })
  if (midReply?.reason !== 'clip-saved' || midReply?.saved !== true) {
    fail(`clip.mark during a recording did not save a clip and a mark: ${JSON.stringify(midReply)}`)
  }
  const midRecording = await verifyReplay(
    await midOutcome,
    'save during a recording (S7, 60 s)',
    LONG_CLIP_SECONDS
  )
  report.replays.push(midRecording)
  const marks = await request(renderer, timeoutMs, 'clip.marks.list', {
    sessionId: cycle.sessionId
  })
  const manualMarks = (marks ?? []).filter((mark) => mark.source === 'manual')
  if (manualMarks.length !== 1) {
    fail(`the recording keeps ${manualMarks.length} manual marks after one press, expected 1`)
  }
  if (manualMarks[0].lookbackSeconds !== 60) {
    fail(`the 1-minute press's mark remembers ${manualMarks[0].lookbackSeconds} s, expected 60`)
  }
  log(
    `the recording keeps the mark at ${manualMarks[0].atSeconds.toFixed(1)} s (lookback 60 s) beside the clip`
  )

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
