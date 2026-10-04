import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'

import { devAppSpawnOptions, repoRoot, stopProcess } from './lib/app-launcher.mjs'
import {
  CLEAN_CUT_SMOKE_TIMELINE,
  compareRemovals,
  compareShapes,
  countByKind,
  detectSpeechBursts,
  expectedCleanCutRemovals,
  frameDurationMs,
  frameToMs,
  joinFrameIndices,
  keptFrameCount,
  keptRangesFromEdl,
  layScriptOverBursts,
  measuredShape,
  parseSrtCues,
  readCleanCutRules,
  scenarioProblems,
  streamCounts,
  timelineShape
} from './lib/clean-cut-smoke.mjs'
import { startFakeTranscriptService } from './lib/fake-transcript-service.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import { analyzeRecording, normalizeProbe, runFramemd5 } from './lib/recording-analyzer.mjs'
import { assertFinalizedRecordingStop } from './lib/recording-smoke-guards.mjs'
import { connectBackend, loadSessionListItem } from './smoke-recording-session.mjs'

// Clean cut end-to-end smoke (plan 119 S16): "Stop recording, and the edited
// version is already there", without a real provider.
//
// It launches the real debug backend against an isolated profile and the
// local fake Clean cut service (`scripts/lib/fake-transcript-service.mjs`:
// capabilities, verbatim transcript chunks and the `post-recording-clean-cut`
// analysis job, docs/clean-cut-contract.md). Sign-in is a fake session token
// in the isolated secrets file; Premium is the debug build's developer
// entitlement (VIDEORC_PREMIUM_FEATURES is removed, it can only downgrade).
//
// 1. Record a real `record` session: the test pattern, plus the debug-only
//    synthetic CoreAudio microphone (VIDEORC_CAPTION_CONTRACT_TEST=1). Its
//    speech is a tone injected with `audio.test.inject-pcm` (admin socket,
//    smoke RPCs on); its silences are digital zero. The take is
//    CLEAN_CUT_SMOKE_TIMELINE: a long lead, a retaken sentence, three long
//    pauses, an "um" and a long tail.
// 2. Stop. Wait for the background MP4 and for the post-recording quality
//    check to be queued. Measure the speech bursts in the MP4 and lay the
//    script's words over them, so the fake "hears" exactly that audio.
// 3. `cleanCut.start` without consent is refused before any cloud call;
//    with consent it queues; a second start is refused as already running.
// 4. The job waits for the quality check (S15), then runs
//    queued -> transcribing -> analyzing -> ready -> rendering -> validating
//    -> completed.
// 5. Check, against decision 16 and 17: the stitched transcript equals the
//    words the fake served; the cut list holds exactly the head, the retake
//    the fake analysis dropped, the three long silences, the filler and the
//    tail, each within a frame of where the rules in `clean_cut/rules.rs`
//    put it; one chunk upload and one analysis job reached the fake; the
//    derived session is in the Library with `cleanCutOfSessionId` and no
//    `processingKind`; "<stem> (Clean cut).mp4" lasts the kept duration
//    within a frame, every audio track lasts the video within a frame, its
//    streams match the recording's, it holds every kept frame and no frame
//    repeats across a join; "<stem> (Clean cut).srt" is re-timed (no retake,
//    no "um", the last cue ends inside the file); the recording is untouched.
// 6. `cleanCut.updateEdl` keeps the retake (a stale revision is refused) and
//    `cleanCut.render` renders the same derived session again in place, with
//    no upload and no analysis: the file grows by exactly the retake.
//
// macOS only: the synthetic microphone id is CoreAudio's. Needs `ffmpeg` and
// `ffprobe` on PATH, or VIDEORC_SMOKE_FFMPEG_PATH / VIDEORC_SMOKE_FFPROBE_PATH;
// an explicit VIDEORC_SMOKE_FFMPEG_PATH is also the backend's FFmpeg (for
// example the bundled build, to prove it can render a clean cut). No
// production bearer, account, provider key or network is involved. About two
// minutes: the quality check alone waits 30 s after Stop.
//
//   pnpm smoke:clean-cut
//   VIDEORC_SMOKE_KEEP_ARTIFACTS=1 pnpm smoke:clean-cut   # keep the files
//
// Timeouts: VIDEORC_SMOKE_TIMEOUT_MS (launch and each RPC, default 90 s),
// VIDEORC_CLEAN_CUT_SMOKE_JOB_TIMEOUT_MS (start to first completion, default
// 240 s), VIDEORC_CLEAN_CUT_SMOKE_RENDER_TIMEOUT_MS (re-render, default 120 s).

if (process.platform !== 'darwin') {
  console.log(
    'Clean cut smoke SKIPPED: the synthetic microphone it records from is CoreAudio only. ' +
      'Windows and Linux renders are checked on the named machines (plan 119 S17).'
  )
  process.exit(0)
}

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 90_000)
const jobTimeoutMs = Number(process.env.VIDEORC_CLEAN_CUT_SMOKE_JOB_TIMEOUT_MS ?? 240_000)
const rerenderTimeoutMs = Number(process.env.VIDEORC_CLEAN_CUT_SMOKE_RENDER_TIMEOUT_MS ?? 120_000)
const keepArtifacts = process.env.VIDEORC_SMOKE_KEEP_ARTIFACTS === '1'
const ffmpegOverride = process.env.VIDEORC_SMOKE_FFMPEG_PATH?.trim() || null
const ffmpegPath = ffmpegOverride ?? 'ffmpeg'
const ffprobePath =
  process.env.VIDEORC_SMOKE_FFPROBE_PATH?.trim() || (siblingFfprobePath(ffmpegPath) ?? 'ffprobe')

// `audio.rs`: CAPTION_CONTRACT_TEST_DEVICE_ID is u32::MAX, 20 ms packets.
const SYNTHETIC_MICROPHONE_ID = 'microphone:coreaudio:4294967295'
const SYNTHETIC_PACKET_MS = 20
// A 440 Hz tone at this peak is about -21 dBFS: speech level, far above the
// -45 dBFS silence floor of decision 16.
const RAW_TONE_PEAK = 0.12
const PCM_SAMPLE_RATE = 16_000
const VIDEO = Object.freeze({
  preset: 'custom',
  width: 640,
  height: 360,
  fps: 30,
  bitrateKbps: 2_000
})
// `recording.rs` `emit_gate_health`: the quality check has run.
const QUALITY_GATE_CODES = new Set([
  'recording-quality-passed',
  'recording-quality-repaired',
  'recording-quality-not-100',
  'recording-quality-check-failed'
])
const FIRST_RUN_STATES = [
  'queued',
  'transcribing',
  'analyzing',
  'ready',
  'rendering',
  'validating',
  'completed'
]
const RERENDER_STATES = ['queued', 'rendering', 'validating', 'completed']
const KEPT_EVENTS = new Set(['cleanCut.status', 'health.event', 'log', 'recording.finalization'])

// The take must still prove the cut list under the current decision 16
// numbers; fail before launching anything when a retune broke it.
const rules = readCleanCutRules(
  readFileSync(join(repoRoot, 'crates', 'videorc-backend', 'src', 'clean_cut', 'rules.rs'), 'utf8')
)
const scripted = timelineShape(CLEAN_CUT_SMOKE_TIMELINE)
const scriptProblems = scenarioProblems(scripted, rules)
if (scriptProblems.length > 0) {
  throw new Error(
    'The scripted take no longer fits crates/videorc-backend/src/clean_cut/rules.rs; retune ' +
      `CLEAN_CUT_SMOKE_TIMELINE in scripts/lib/clean-cut-smoke.mjs: ${scriptProblems.join('; ')}`
  )
}

const targetDir = process.env.CARGO_TARGET_DIR
  ? resolve(repoRoot, process.env.CARGO_TARGET_DIR)
  : join(repoRoot, 'target')
const backendBinary = join(targetDir, 'debug', 'videorc-backend')
if (!existsSync(backendBinary)) {
  throw new Error(
    `${backendBinary} is missing; build the debug backend first ` +
      '(pnpm smoke:clean-cut runs cargo build -p videorc-backend).'
  )
}

const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-clean-cut-smoke-'))
const appDataDir = join(stateRoot, 'app-data')
const recordingsDir = join(stateRoot, 'recordings')
const reportPath = join(stateRoot, 'clean-cut-smoke-report.json')
const smokeSessionToken = `clean-cut-smoke-session-${randomUUID()}`
mkdirSync(appDataDir, { recursive: true })
mkdirSync(recordingsDir, { recursive: true })
const secretsPath = join(appDataDir, 'videorc-secrets.json')
writeFileSync(
  secretsPath,
  JSON.stringify({ 'account:videorc:session': smokeSessionToken }, null, 2)
)
chmodSync(secretsPath, 0o600)

const fake = await startFakeTranscriptService({ smokeSessionToken })
const startedAt = Date.now()
const evidence = { stimulus: [], phases: [], bursts: null }
const backendStderrTail = []
let backendProcess = null
let backend = null
let admin = null
let events = { list: [] }
let sessionActive = false
let sourceId = null
let jobId = null
let passed = false

try {
  phase('launch the debug backend against the fake Clean cut service')
  const env = { ...process.env }
  delete env.VIDEORC_PREMIUM_FEATURES
  if (ffmpegOverride) {
    env.VIDEORC_BUNDLED_FFMPEG_PATH = ffmpegPath
    env.VIDEORC_BUNDLED_FFPROBE_PATH = ffprobePath
  }
  backendProcess = spawn(backendBinary, [], {
    ...devAppSpawnOptions({
      env: {
        ...env,
        VIDEORC_API_BASE_URL: fake.httpOrigin,
        // Debug-only seams: the synthetic microphone and its PCM injection.
        VIDEORC_CAPTION_CONTRACT_TEST: '1',
        VIDEORC_ENABLE_SMOKE_RPC: '1',
        VIDEORC_DISABLE_AUTO_PREVIEW: '1',
        VIDEORC_DISABLE_BACKEND_REAP: '1',
        VIDEORC_APP_DATA_DIR: appDataDir,
        VIDEORC_DATABASE_PATH: join(appDataDir, 'videorc.sqlite3'),
        VIDEORC_SECRETS_PATH: secretsPath,
        VIDEORC_SMOKE_STATE_DIR: stateRoot
      }
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const ready = await waitForBackendReady(backendProcess, timeoutMs)
  expect(
    typeof ready.adminToken === 'string' && ready.adminToken.length >= 32,
    'The debug backend READY line carries no admin credential.'
  )
  backend = await connectBackend({ ...ready, adminToken: undefined }, timeoutMs)
  admin = await connectBackend(
    { ...ready, token: ready.adminToken, adminToken: undefined },
    timeoutMs
  )
  events = collectEvents(backend)

  // --- 1. Record the scripted take ------------------------------------------
  phase('record: test pattern and synthetic microphone, scripted speech and silence')
  const health = await rpc(admin, 'health.ping', { ffmpegPath })
  expect(
    health?.ffmpeg?.available === true,
    health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the Clean cut smoke.'
  )
  const capability = await rpc(admin, 'resource.capability.issue', {
    kind: 'output-directory',
    path: recordingsDir
  })
  expect(
    typeof capability?.capabilityId === 'string',
    `resource.capability.issue returned no capability: ${JSON.stringify(capability)}`
  )
  const started = await rpc(admin, 'session.start', recordSessionParams(capability.capabilityId))
  expect(
    started?.state === 'recording' && typeof started.sessionId === 'string',
    `session.start did not start a recording: ${JSON.stringify(started)}`
  )
  sessionActive = true
  sourceId = started.sessionId
  await playTimeline(sourceId)

  // --- 2. Stop, finalize, measure --------------------------------------------
  phase('stop and wait for the MP4')
  const stopped = await rpc(admin, 'session.stop', {})
  sessionActive = false
  const sourceMp4 = await assertFinalizedRecordingStop({
    scenarioLabel: 'Clean cut source',
    started,
    stopped,
    loadHealthEvents: async (sessionId) =>
      (await rpc(backend, 'sessions.healthEvents.list', { sessionId, limit: 120 }))?.events ?? [],
    loadSessionItem: (sessionId) => loadSessionListItem(backend, timeoutMs, sessionId),
    finalizationTimeoutMs: 90_000
  })
  expect(
    typeof sourceMp4 === 'string' &&
      extname(sourceMp4).toLowerCase() === '.mp4' &&
      existsSync(sourceMp4),
    `The recording has no MP4 on disk: ${sourceMp4}`
  )
  const sourceItem = await loadSessionListItem(backend, timeoutMs, sourceId)
  expect(
    sourceItem?.status === 'completed' &&
      ['record', 'record+stream'].includes(sourceItem.mode) &&
      (sourceItem.durationMs ?? 0) >= 10_000 &&
      !sourceItem.derivedFromSessionId &&
      sourceItem.processingKind === undefined,
    `The recording is not an eligible Clean cut source: ${JSON.stringify(sourceItem)}`
  )

  phase('wait for the post-recording quality check to be queued')
  await waitForEntry(
    (entry) =>
      entry.event === 'log' &&
      typeof entry.payload?.message === 'string' &&
      entry.payload.message.startsWith('Queued post-recording quality check for ') &&
      entry.payload.message.includes(basename(sourceMp4)),
    { label: 'the queued post-recording quality check', deadlineMs: 30_000 }
  )

  phase('measure the speech in the MP4 and script the fake transcript over it')
  const pcm = await decodeMonoPcm16(sourceMp4)
  const audioMs = Math.round((pcm.length / 2 / PCM_SAMPLE_RATE) * 1_000)
  const bursts = detectSpeechBursts(pcm, { sampleRate: PCM_SAMPLE_RATE })
  evidence.bursts = bursts
  const measured = measuredShape(bursts, audioMs, scripted.sentences)
  const takeProblems = [
    ...compareShapes(measured, scripted, { toleranceMs: 300 }),
    ...scenarioProblems(measured, rules)
  ]
  expect(
    takeProblems.length === 0,
    `The recorded take does not match the script: ${takeProblems.join('; ')}. ` +
      `Measured bursts: ${JSON.stringify(bursts)}`
  )
  const sentences = scripted.sentences
  const words = layScriptOverBursts(sentences, bursts)
  fake.setWords(words)

  // --- 3. Start -----------------------------------------------------------------
  phase('cleanCut.start without consent is refused before any cloud call')
  const cloudBeforeRefusal = cloudCounters()
  const refused = await rpcOutcome(backend, 'cleanCut.start', {
    sessionId: sourceId,
    mode: 'clean',
    consentToUploadAudio: false
  })
  expect(
    !refused.ok && refused.error?.code === 'consent-required',
    `cleanCut.start without consent must be refused with consent-required: ${JSON.stringify(refused)}`
  )
  expect(
    JSON.stringify(cloudCounters()) === JSON.stringify(cloudBeforeRefusal),
    `A refused start reached the fake cloud: ${JSON.stringify({
      before: cloudBeforeRefusal,
      after: cloudCounters()
    })}`
  )

  phase('cleanCut.start {mode: clean}')
  const startIndex = events.list.length
  const queued = await rpc(backend, 'cleanCut.start', {
    sessionId: sourceId,
    mode: 'clean',
    consentToUploadAudio: true
  })
  expect(
    typeof queued?.id === 'string' &&
      queued.sourceSessionId === sourceId &&
      queued.mode === 'clean' &&
      queued.state === 'queued' &&
      queued.edlRevision === 0,
    `cleanCut.start did not queue a clean job: ${JSON.stringify(queued)}`
  )
  jobId = queued.id
  const duplicate = await rpcOutcome(backend, 'cleanCut.start', {
    sessionId: sourceId,
    mode: 'clean',
    consentToUploadAudio: true
  })
  expect(
    !duplicate.ok && duplicate.error?.code === 'already-running',
    `A second start for the same recording and mode must be refused with already-running: ${JSON.stringify(duplicate)}`
  )

  // --- 4. The job ------------------------------------------------------------------
  phase('wait: quality check, transcript, analysis, cut list, render')
  const done = await waitForJobState(jobId, 'completed', {
    fromIndex: startIndex,
    deadlineMs: jobTimeoutMs
  })
  const firstRun = jobEntries(jobId, startIndex, done.index)
  assertStateOrder(firstRun, FIRST_RUN_STATES, 'The first run')
  const qualityCheck = firstRun.find((entry) => entry.payload.step === 'quality-check')
  const firstTranscribing = firstRun.find((entry) => entry.payload.state === 'transcribing')
  const gateEvent = events.list.find(
    (entry) =>
      entry.event === 'health.event' &&
      entry.payload?.sessionId === sourceId &&
      QUALITY_GATE_CODES.has(entry.payload?.code)
  )
  expect(
    qualityCheck && qualityCheck.index < firstTranscribing.index,
    `The job never reported waiting for the quality check before transcribing (S15): ${describeStates(firstRun)}`
  )
  expect(
    gateEvent && gateEvent.index < firstTranscribing.index,
    `The job transcribed before the quality check had run (S15): ${JSON.stringify({
      gate: gateEvent?.payload?.code ?? null,
      gateEvent: gateEvent?.index ?? null,
      firstTranscribing: firstTranscribing.index
    })}`
  )
  const completedJob = done.payload

  // --- 5a. The transcript and the cut list -------------------------------------
  phase('check the transcript and the cut list against decision 16')
  const detail = await jobDetail(sourceId, jobId)
  const edl = detail.edl
  expect(
    edl?.version === 1 &&
      Array.isArray(edl.removals) &&
      edl.frameRate?.num > 0 &&
      edl.frameRate?.den > 0 &&
      edl.durationMs > 0,
    `cleanCut.get returned no usable cut list: ${JSON.stringify(detail)}`
  )
  expect(
    detail.job.state === 'completed' &&
      detail.job.outputSessionId === completedJob.outputSessionId &&
      detail.job.edlRevision === completedJob.edlRevision,
    `cleanCut.get disagrees with the completed status: ${JSON.stringify(detail.job)}`
  )
  const listed = await rpc(backend, 'cleanCut.list', {})
  expect(
    Array.isArray(listed) && listed.some((job) => job.id === jobId && job.state === 'completed'),
    `cleanCut.list does not show the completed job: ${JSON.stringify(listed)}`
  )

  const transcript = await rpc(backend, 'cleanCut.transcript', { jobId })
  const served = words.map(wordKey)
  const stitched = (transcript?.words ?? []).map(wordKey)
  expect(
    JSON.stringify(stitched) === JSON.stringify(served),
    `The stitched transcript differs from the words the fake served: ${firstDifference(stitched, served)}`
  )
  expect(transcript.language === 'en', `The transcript lost its language: ${transcript.language}`)
  expect(
    Array.isArray(transcript.segments) &&
      transcript.segments.length === sentences.length &&
      transcript.segments.every(
        (segment, index) =>
          segment.id === `s${index + 1}` &&
          segment.startMs === bursts[index].startMs &&
          segment.endMs === bursts[index].endMs
      ),
    `The transcript's sentences are not one per speech burst: ${JSON.stringify(transcript.segments)}`
  )

  const frameRate = edl.frameRate
  const frameMs = frameDurationMs(frameRate)
  const toleranceMs = frameMs + 1
  const expectedRemovals = expectedCleanCutRemovals({
    words,
    sentences,
    bursts,
    durationMs: edl.durationMs,
    rules
  })
  console.log(`[clean-cut-smoke] cut list: ${describeRemovals(edl.removals)}`)
  const removalProblems = compareRemovals(edl.removals, expectedRemovals, { toleranceMs })
  expect(
    removalProblems.length === 0,
    `The cut list does not follow decision 16: ${removalProblems.join('; ')}`
  )
  expect(
    edl.removals.every((removal) => removal.enabled),
    `No removal should be a switched-off suggestion here: ${JSON.stringify(
      edl.removals.filter((removal) => !removal.enabled)
    )}`
  )
  const expectedCounts = countByKind(expectedRemovals)
  const byKind = new Map((edl.stats?.byKind ?? []).map((entry) => [entry.kind, entry]))
  expect(
    byKind.size === expectedCounts.length &&
      expectedCounts.every(({ kind, count }) => byKind.get(kind)?.count === count),
    `The cut list's counts by kind are wrong: expected ${JSON.stringify(expectedCounts)}, got ${JSON.stringify(edl.stats?.byKind)}`
  )
  const longPauses = sentences.filter(
    (sentence) => sentence.gapAfterMs !== null && sentence.gapAfterMs > rules.SILENCE_MIN_GAP_MS
  ).length
  const expectedSilenceMs = expectedRemovals
    .filter((removal) => removal.kind === 'silence')
    .reduce((sum, removal) => sum + (removal.endMs - removal.startMs), 0)
  expect(
    byKind.get('silence')?.count === longPauses &&
      Math.abs(byKind.get('silence').ms - expectedSilenceMs) <= toleranceMs * longPauses,
    `The ${longPauses} long silences should each shrink to ${rules.SILENCE_KEEP_MS} ms ` +
      `(${expectedSilenceMs} ms removed): ${JSON.stringify(byKind.get('silence'))}`
  )
  const retakeRemoval = edl.removals.find((removal) => removal.kind === 'retake')
  expect(
    retakeRemoval?.enabled === true &&
      retakeRemoval.confidence === 0.9 &&
      /later take is kept/.test(retakeRemoval.reason),
    `The fake analysis job's retake drop was not applied: ${JSON.stringify(retakeRemoval)}`
  )
  const ranges = keptRangesFromEdl(edl)
  const keptFrames = keptFrameCount(ranges)
  expect(
    edl.stats.keptMs === frameToMs(keptFrames, frameRate) &&
      completedJob.edlSummary?.keptMs === edl.stats.keptMs &&
      completedJob.edlSummary.durationMs === edl.durationMs &&
      completedJob.edlSummary.removalCount === edl.removals.length,
    `The kept duration does not add up: ${JSON.stringify({
      keptMs: edl.stats.keptMs,
      fromFrames: frameToMs(keptFrames, frameRate),
      summary: completedJob.edlSummary
    })}`
  )
  expect(
    Math.abs(edl.durationMs - audioMs) <= 1_000,
    `The cut list's duration (${edl.durationMs} ms) is far from the recording's audio (${audioMs} ms).`
  )

  phase('check what reached the fake cloud')
  expect(
    fake.state.chunkRequests === 1 && fake.state.chunks.length === 1,
    `A ${(audioMs / 1_000).toFixed(1)} s recording is one transcript chunk; the fake saw ${fake.state.chunkRequests}.`
  )
  const [chunk] = fake.state.chunks
  expect(
    chunk.chunkIndex === 0 &&
      chunk.chunkStartMs === 0 &&
      chunk.sessionClientId === sourceId &&
      Math.abs(chunk.chunkSeconds * 1_000 - audioMs) <= 250 &&
      chunk.peak >= 0.05,
    `The chunk was not the whole recording at speech level: ${JSON.stringify(chunk)}`
  )
  expect(
    fake.state.jobCreates === 1 && fake.state.jobs.size === 1,
    `Exactly one analysis job should reach the fake: ${fake.state.jobCreates} create(s).`
  )
  const [cloudJob] = [...fake.state.jobs.values()]
  expect(
    cloudJob.sessionClientId === sourceId &&
      cloudJob.clientRequestId.startsWith(`cleancut:${sourceId}:clean:`) &&
      cloudJob.status === 'completed' &&
      cloudJob.input?.segmentCount === sentences.length,
    `The analysis job is not this recording's ${sentences.length} sentences: ${JSON.stringify({
      sessionClientId: cloudJob.sessionClientId,
      clientRequestId: cloudJob.clientRequestId,
      status: cloudJob.status,
      segmentCount: cloudJob.input?.segmentCount
    })}`
  )

  // --- 5b. The derived session and its files -------------------------------------
  phase('check the derived session in the Library')
  const outputSessionId = completedJob.outputSessionId
  expect(
    typeof outputSessionId === 'string' && outputSessionId !== sourceId,
    `The completed job names no derived session: ${JSON.stringify(completedJob)}`
  )
  const derived = await loadSessionListItem(backend, timeoutMs, outputSessionId)
  const expectedTitle = `${String(sourceItem.title).trim()} (Clean cut)`
  expect(
    derived?.cleanCutOfSessionId === sourceId &&
      derived.cleanCutMode === 'clean' &&
      derived.derivedFromSessionId === sourceId &&
      derived.processingKind === undefined &&
      derived.status === 'completed' &&
      derived.mode === sourceItem.mode &&
      derived.title === expectedTitle &&
      derived.durationMs === edl.stats.keptMs,
    `The derived session is not a clean cut of the recording: ${JSON.stringify(derived)}`
  )
  const outputMp4 = derived.mp4Path
  const expectedName = `${basename(sourceMp4, extname(sourceMp4))} (Clean cut).mp4`
  expect(
    typeof outputMp4 === 'string' &&
      dirname(outputMp4) === dirname(sourceMp4) &&
      basename(outputMp4) === expectedName &&
      existsSync(outputMp4),
    `The clean cut is not "${expectedName}" next to the recording: ${outputMp4}`
  )
  assertSourceUntouched(sourceMp4, edl.sourceIdentity)

  phase('check the clean cut file: durations, streams, frames, joins, captions')
  const sourceFacts = await probeFile(sourceMp4)
  const first = await verifyRender({ label: 'clean cut', sourceFacts, outputMp4, edl })
  const firstText = first.cues.map((cue) => cue.text).join(' ')
  expect(
    firstText.includes('Welcome back') &&
      firstText.includes('Thanks for watching') &&
      !/\bwrong\b/i.test(firstText) &&
      !/\bum\b/i.test(firstText),
    `The re-timed captions should drop the retake and the "um" and keep the rest: ${JSON.stringify(first.cues)}`
  )

  // --- 6. Edit and render again ------------------------------------------------------
  phase('cleanCut.updateEdl: keep the retaken sentence after all')
  const updated = await rpc(backend, 'cleanCut.updateEdl', {
    jobId,
    revision: completedJob.edlRevision,
    removals: [{ id: retakeRemoval.id, enabled: false }]
  })
  const nextEdl = updated?.edl
  const retakeFrames = retakeRemoval.endFrame - retakeRemoval.startFrame
  expect(
    updated?.job?.edlRevision === completedJob.edlRevision + 1 &&
      nextEdl?.removals?.find((removal) => removal.id === retakeRemoval.id)?.enabled === false &&
      nextEdl.removals
        .filter((removal) => removal.id !== retakeRemoval.id)
        .every((r) => r.enabled) &&
      nextEdl.stats.keptMs === frameToMs(keptFrames + retakeFrames, frameRate),
    `cleanCut.updateEdl did not switch the retake off: ${JSON.stringify({
      job: updated?.job,
      stats: nextEdl?.stats
    })}`
  )
  const stale = await rpcOutcome(backend, 'cleanCut.updateEdl', {
    jobId,
    revision: completedJob.edlRevision,
    removals: [{ id: retakeRemoval.id, enabled: true }]
  })
  expect(
    !stale.ok && stale.error?.code === 'edl-revision-conflict',
    `An edit on a stale revision must be refused with edl-revision-conflict: ${JSON.stringify(stale)}`
  )

  phase('cleanCut.render: the same derived session, rendered again in place')
  const cloudBeforeRender = cloudCounters()
  const renderIndex = events.list.length
  const rerender = await rpc(backend, 'cleanCut.render', { jobId })
  expect(
    rerender?.id === jobId && rerender.state === 'queued' && rerender.step === 'render',
    `cleanCut.render did not queue a render: ${JSON.stringify(rerender)}`
  )
  const redone = await waitForJobState(jobId, 'completed', {
    fromIndex: renderIndex,
    deadlineMs: rerenderTimeoutMs
  })
  assertStateOrder(jobEntries(jobId, renderIndex, redone.index), RERENDER_STATES, 'The re-render')
  expect(
    redone.payload.outputSessionId === outputSessionId &&
      redone.payload.edlRevision === updated.job.edlRevision &&
      redone.payload.edlSummary?.keptMs === nextEdl.stats.keptMs,
    `The re-render did not complete the same derived session at the new revision: ${JSON.stringify(redone.payload)}`
  )
  expect(
    JSON.stringify(cloudCounters()) === JSON.stringify(cloudBeforeRender),
    `A re-render must not upload audio or start an analysis again: ${JSON.stringify({
      before: cloudBeforeRender,
      after: cloudCounters()
    })}`
  )
  const derivedAgain = await loadSessionListItem(backend, timeoutMs, outputSessionId)
  expect(
    derivedAgain?.mp4Path === outputMp4 &&
      derivedAgain.cleanCutOfSessionId === sourceId &&
      derivedAgain.durationMs === nextEdl.stats.keptMs,
    `The re-render did not update the derived session in place: ${JSON.stringify(derivedAgain)}`
  )
  const page = await rpc(backend, 'sessions.list', { limit: 50 })
  const cuts = (page?.items ?? []).filter((item) => item.cleanCutOfSessionId === sourceId)
  expect(
    cuts.length === 1 && cuts[0].id === outputSessionId,
    `Rendering again must replace the derived session, not add one: ${JSON.stringify(
      cuts.map((item) => ({ id: item.id, mp4Path: item.mp4Path }))
    )}`
  )
  const second = await verifyRender({
    label: 'clean cut, retake kept',
    sourceFacts,
    outputMp4,
    edl: nextEdl
  })
  const grownMs = second.videoMs - first.videoMs
  const retakeMs = frameToMs(retakeFrames, frameRate)
  expect(
    Math.abs(grownMs - retakeMs) <= frameMs + 2,
    `Keeping the retake should add ${retakeMs} ms; the file grew by ${grownMs.toFixed(1)} ms.`
  )
  const secondText = second.cues.map((cue) => cue.text).join(' ')
  expect(
    /\bwrong way\b/i.test(secondText) && !/\bum\b/i.test(secondText),
    `The re-timed captions should now hold the retake and still drop the "um": ${JSON.stringify(second.cues)}`
  )
  assertSourceUntouched(sourceMp4, edl.sourceIdentity)

  passed = true
  console.log(
    `Clean cut smoke PASS in ${elapsedSeconds()} s: a ${(edl.durationMs / 1_000).toFixed(1)} s ` +
      `recording of ${sentences.length} sentences became ${(edl.stats.keptMs / 1_000).toFixed(1)} s ` +
      `with ${edl.removals.length} cuts (${expectedCounts.map(({ kind, count }) => `${count} ${kind}`).join(', ')}) ` +
      `after the quality check (${gateEvent.payload.code}); the stitched transcript matched the fake's ` +
      `words; the file matched the cut list within a frame, kept all ${first.frames} frames with no ` +
      `repeat across ${first.joins} joins, and carried ${first.cues.length} re-timed captions; keeping ` +
      `the retake rendered the same session again to ${(second.videoMs / 1_000).toFixed(1)} s with no ` +
      'new upload.'
  )
} catch (error) {
  await writeFailureReport(error).catch((reportError) =>
    console.log(`Could not write the Clean cut smoke failure report: ${reportError.message}`)
  )
  throw error
} finally {
  try {
    if (!passed && backend && jobId) {
      await rpcOutcome(backend, 'cleanCut.cancel', { jobId }, 15_000).catch(() => {})
    }
    if (sessionActive && admin) {
      await rpcOutcome(admin, 'session.stop', {}, 30_000).catch(() => {})
    }
    backend?.close()
    admin?.close()
  } finally {
    if (backendProcess) {
      await stopProcess(backendProcess).catch(() => {})
    }
    await fake.close()
    if (passed && !keepArtifacts) {
      rmSync(stateRoot, { force: true, recursive: true })
    } else {
      console.log(`Clean cut smoke evidence: ${stateRoot}`)
    }
  }
}

// --- Steps ------------------------------------------------------------------------

function recordSessionParams(outputDirectoryCapability) {
  return {
    sources: { testPattern: true, microphoneId: SYNTHETIC_MICROPHONE_ID },
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
      outputDirectoryCapability,
      video: { ...VIDEO },
      rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
    },
    audio: { microphoneGainDb: 0, microphoneMuted: false, microphoneSyncOffsetMs: 0 }
  }
}

/** Speak and pause as the timeline says: speech is injected tone, pauses are waits. */
async function playTimeline(sessionId) {
  const takeStartedAt = Date.now()
  for (const step of CLEAN_CUT_SMOKE_TIMELINE) {
    const at = Date.now() - takeStartedAt
    if (typeof step.text === 'string') {
      const injection = await rpc(admin, 'audio.test.inject-pcm', {
        sessionId,
        durationMs: step.speechMs,
        rawPeak: RAW_TONE_PEAK
      })
      expect(
        injection?.packetsGenerated >= Math.ceil(step.speechMs / SYNTHETIC_PACKET_MS),
        `The synthetic microphone spoke too little of "${step.text}": ${JSON.stringify(injection)}`
      )
      evidence.stimulus.push({ at, speechMs: step.speechMs, packets: injection.packetsGenerated })
    } else {
      await sleep(step.silenceMs)
      evidence.stimulus.push({ at, silenceMs: step.silenceMs })
    }
  }
}

async function verifyRender({ label, sourceFacts, outputMp4, edl }) {
  const facts = await probeFile(outputMp4)
  const video = facts.probe.video
  const sourceVideo = sourceFacts.probe.video
  const frameRate = edl.frameRate
  const frameMs = frameDurationMs(frameRate)
  const keptMs = edl.stats.keptMs
  const ranges = keptRangesFromEdl(edl)
  const keptFrames = keptFrameCount(ranges)
  expect(video, `[${label}] the file has no video stream.`)
  // Decision 17: every video and audio stream of the recording is carried.
  expect(
    JSON.stringify(avCounts(facts.counts)) === JSON.stringify(avCounts(sourceFacts.counts)),
    `[${label}] streams ${JSON.stringify(facts.counts)} differ from the recording's ${JSON.stringify(sourceFacts.counts)}.`
  )
  expect(
    video.width === sourceVideo?.width && video.height === sourceVideo?.height,
    `[${label}] the file is ${video.width}x${video.height}, the recording ${sourceVideo?.width}x${sourceVideo?.height}.`
  )
  const videoMs = Number.isFinite(video.duration)
    ? video.duration * 1_000
    : (video.nbFrames ?? 0) * frameMs
  expect(
    Math.abs(videoMs - keptMs) <= frameMs + 2,
    `[${label}] the video lasts ${videoMs.toFixed(1)} ms; the cut list keeps ${keptMs} ms ` +
      `(one frame is ${frameMs.toFixed(1)} ms).`
  )
  facts.probe.audio.forEach((track, index) => {
    const trackMs = Number.isFinite(track.duration) ? track.duration * 1_000 : NaN
    expect(
      Number.isFinite(trackMs) && Math.abs(trackMs - videoMs) <= frameMs + 2,
      `[${label}] audio track ${index} lasts ${trackMs.toFixed(1)} ms against ${videoMs.toFixed(1)} ms of video.`
    )
  })

  // Every kept frame is there, and none repeats across a join.
  const hashes = await runFramemd5(outputMp4, { ffmpegPath })
  expect(
    Math.abs(hashes.length - keptFrames) <= 1,
    `[${label}] ${hashes.length} frames decode; the cut list keeps ${keptFrames}.`
  )
  const joins = joinFrameIndices(ranges)
  const repeated = joins.filter((join) => join < hashes.length && hashes[join] === hashes[join - 1])
  expect(
    repeated.length === 0,
    `[${label}] the frame repeats across the join at output frame(s) ${repeated.join(', ')}.`
  )
  const analysis = await analyzeRecording(outputMp4, {
    ffmpegPath,
    ffprobePath,
    intendedFps: frameRate.num / frameRate.den,
    expectAudio: true,
    // A stutter the recording already had is not Clean cut's; joins are
    // judged below and by the frame hashes above.
    gates: { requireMotion: false }
  })
  expect(
    analysis.verdict.pass,
    `[${label}] the recording analyzer failed: ${analysis.verdict.failures.join('; ')}`
  )
  const joinSeconds = joins.map((join) => (join * frameMs) / 1_000)
  const frameSeconds = frameMs / 1_000
  const frozenJoins = (analysis.findings?.freezes ?? []).filter((freeze) =>
    joinSeconds.some(
      (at) =>
        at >= freeze.start - frameSeconds && at <= freeze.start + freeze.duration + frameSeconds
    )
  )
  expect(
    frozenJoins.length === 0,
    `[${label}] frozen video across a join: ${JSON.stringify(frozenJoins)}`
  )

  // The re-timed captions beside it.
  const srtPath = outputMp4.replace(/\.mp4$/i, '.srt')
  expect(existsSync(srtPath), `[${label}] no re-timed captions beside the clean cut: ${srtPath}`)
  const cues = parseSrtCues(readFileSync(srtPath, 'utf8'))
  const fileMs = Number.isFinite(facts.probe.formatDuration)
    ? facts.probe.formatDuration * 1_000
    : videoMs
  expect(cues.length > 0, `[${label}] the re-timed captions are empty: ${srtPath}`)
  expect(
    cues.every(
      (cue, index) =>
        cue.endMs > cue.startMs && (index === 0 || cue.startMs >= cues[index - 1].startMs)
    ),
    `[${label}] the re-timed captions are out of order: ${JSON.stringify(cues)}`
  )
  expect(
    cues[cues.length - 1].endMs <= fileMs,
    `[${label}] the last caption ends at ${cues[cues.length - 1].endMs} ms, after the file's ${fileMs.toFixed(0)} ms.`
  )
  console.log(
    `[clean-cut-smoke] ${label}: ${videoMs.toFixed(0)} ms of video, ${hashes.length} frames, ` +
      `${joins.length} joins, ${cues.length} captions, ${analysis.verdict.warnings.length} analyzer warning(s)`
  )
  return { videoMs, frames: hashes.length, joins: joins.length, cues }
}

/** Decision 11: the source is never modified; it still matches the cut list's identity. */
function assertSourceUntouched(sourceMp4, identity) {
  const stats = statSync(sourceMp4)
  expect(
    stats.size === identity?.sizeBytes &&
      (identity.modifiedUnixMs === undefined ||
        Math.floor(stats.mtimeMs) === identity.modifiedUnixMs),
    `The recording changed under Clean cut: ${JSON.stringify({
      size: stats.size,
      mtimeMs: Math.floor(stats.mtimeMs),
      identity
    })}`
  )
}

// --- Backend plumbing ------------------------------------------------------------

function phase(label) {
  evidence.phases.push({ atMs: Date.now() - startedAt, label })
  console.log(`[clean-cut-smoke +${elapsedSeconds()}s] ${label}`)
}

function elapsedSeconds() {
  return ((Date.now() - startedAt) / 1_000).toFixed(1)
}

function cloudCounters() {
  return {
    capabilities: fake.state.capabilityRequests,
    chunks: fake.state.chunkRequests,
    jobs: fake.state.jobCreates
  }
}

async function jobDetail(sessionId, id) {
  const result = await rpc(backend, 'cleanCut.get', { sessionId })
  const detail = (result?.jobs ?? []).find((entry) => entry?.job?.id === id)
  expect(detail, `cleanCut.get has no job ${id}: ${JSON.stringify(result)}`)
  return detail
}

function jobEntries(id, fromIndex, toIndex) {
  return events.list
    .slice(fromIndex, toIndex + 1)
    .filter((entry) => entry.event === 'cleanCut.status' && entry.payload?.id === id)
}

/** Every state in `states` is reported, first appearances in that order. */
function assertStateOrder(entries, states, label) {
  const firstIndex = states.map((state) =>
    entries.findIndex((entry) => entry.payload.state === state)
  )
  const missing = states.filter((_, position) => firstIndex[position] < 0)
  expect(
    missing.length === 0,
    `${label} never reported ${missing.join(', ')}: ${describeStates(entries)}`
  )
  expect(
    firstIndex.every((value, position) => position === 0 || value > firstIndex[position - 1]),
    `${label} reported its states out of order: ${describeStates(entries)}`
  )
}

function describeStates(entries) {
  const steps = []
  for (const entry of entries) {
    const label = `${entry.payload.state}${entry.payload.step ? `(${entry.payload.step})` : ''}`
    if (steps[steps.length - 1] !== label) steps.push(label)
  }
  return steps.join(' -> ') || 'nothing'
}

function describeRemovals(removals) {
  return removals
    .map(
      (removal) =>
        `${removal.kind}${removal.enabled ? '' : ' (off)'} ` +
        `${(removal.startMs / 1_000).toFixed(2)}-${(removal.endMs / 1_000).toFixed(2)} s`
    )
    .join(', ')
}

function wordKey(word) {
  return `${word.text}@${word.startMs}-${word.endMs}${word.filler === true ? ' filler' : ''}`
}

function firstDifference(actual, expected) {
  const length = Math.max(actual.length, expected.length)
  for (let index = 0; index < length; index += 1) {
    if (actual[index] !== expected[index]) {
      return (
        `word ${index + 1} is ${actual[index] ?? 'missing'}, the fake served ` +
        `${expected[index] ?? 'nothing'} (${actual.length} vs ${expected.length} words)`
      )
    }
  }
  return 'none'
}

function avCounts(counts) {
  return { video: counts?.video ?? 0, audio: counts?.audio ?? 0 }
}

async function waitForJobState(id, wanted, { fromIndex, deadlineMs }) {
  const deadline = Date.now() + deadlineMs
  let cursor = fromIndex
  let last = null
  for (;;) {
    for (; cursor < events.list.length; cursor += 1) {
      const entry = events.list[cursor]
      if (entry.event !== 'cleanCut.status' || entry.payload?.id !== id) continue
      last = entry.payload
      if (last.state === wanted) return entry
      if (last.state === 'failed' || last.state === 'cancelled') {
        throw new Error(
          `The Clean cut job ended ${last.state} with ${last.errorCode ?? 'no code'}: ` +
            `${last.errorMessage ?? 'no message'}. Last snapshot: ${JSON.stringify(last)}`
        )
      }
    }
    if (Date.now() >= deadline) {
      const snapshot = sourceId
        ? await rpc(backend, 'cleanCut.get', { sessionId: sourceId }, 10_000).catch((error) => ({
            error: error.message
          }))
        : null
      throw new Error(
        `Timed out after ${deadlineMs} ms waiting for the Clean cut job to reach ${wanted}. ` +
          `Last status: ${JSON.stringify(last)}. cleanCut.get: ${JSON.stringify(snapshot)}`
      )
    }
    await sleep(100)
  }
}

async function waitForEntry(predicate, { fromIndex = 0, deadlineMs, label }) {
  const deadline = Date.now() + deadlineMs
  let cursor = fromIndex
  for (;;) {
    for (; cursor < events.list.length; cursor += 1) {
      if (predicate(events.list[cursor])) return events.list[cursor]
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${deadlineMs} ms waiting for ${label}.`)
    }
    await sleep(100)
  }
}

function collectEvents(ws) {
  const collection = { list: [] }
  let lastJobLine = null
  ws.addEventListener('message', (message) => {
    let parsed
    try {
      parsed = JSON.parse(message.data)
    } catch {
      return
    }
    if (typeof parsed?.event !== 'string' || !KEPT_EVENTS.has(parsed.event)) return
    const entry = {
      event: parsed.event,
      payload: parsed.payload,
      at: Date.now(),
      index: collection.list.length
    }
    collection.list.push(entry)
    if (parsed.event === 'cleanCut.status') {
      const job = parsed.payload ?? {}
      const line =
        `${job.state}${job.step ? ` (${job.step})` : ''}` +
        `${job.errorCode ? `: ${job.errorCode} ${job.errorMessage ?? ''}` : ''}`
      if (line !== lastJobLine) {
        lastJobLine = line
        console.log(`[clean-cut-smoke +${elapsedSeconds()}s] job ${line}`)
      }
    } else if (
      parsed.event === 'log' &&
      /clean cut|quality check/i.test(String(parsed.payload?.message ?? ''))
    ) {
      console.log(`[backend ${parsed.payload.level}] ${parsed.payload.message}`)
    }
  })
  return collection
}

/** One RPC; resolves `{ok, payload, error}` and never throws on a refusal. */
function rpcOutcome(ws, method, params, deadlineMs = timeoutMs) {
  const id = `clean-cut-smoke-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return new Promise((resolveOutcome, rejectOutcome) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      rejectOutcome(new Error(`Timed out waiting for ${method}.`))
    }, deadlineMs)
    const onMessage = (message) => {
      let parsed
      try {
        parsed = JSON.parse(message.data)
      } catch {
        return
      }
      if (parsed?.id !== id) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      resolveOutcome({
        ok: parsed.ok === true,
        payload: parsed.payload,
        error: parsed.error ?? null
      })
    }
    ws.addEventListener('message', onMessage)
    try {
      ws.send(JSON.stringify({ id, method, params }))
    } catch (error) {
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      rejectOutcome(error)
    }
  })
}

/** One RPC; throws with the refusal code and message. */
async function rpc(ws, method, params, deadlineMs = timeoutMs) {
  const outcome = await rpcOutcome(ws, method, params, deadlineMs)
  if (!outcome.ok) {
    throw new Error(
      `${method} failed (${outcome.error?.code ?? 'unknown'}): ${outcome.error?.message ?? 'no message'}`
    )
  }
  return outcome.payload
}

function waitForBackendReady(child, deadlineMs) {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => finish(rejectReady, new Error('The backend did not print READY in time.')),
      deadlineMs
    )
    let stdout = ''
    let settled = false
    let printedStderrLines = 0
    function finish(callback, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    // Both listeners stay attached for the whole run: an unread pipe would
    // block the backend's logging once it fills.
    child.stdout.on('data', (chunk) => {
      if (settled) return
      stdout += chunk
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('READY '))
      if (!line) return
      try {
        finish(resolveReady, JSON.parse(line.slice('READY '.length)))
      } catch {
        finish(rejectReady, new Error('The backend printed an invalid READY payload.'))
      }
    })
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue
        backendStderrTail.push(line)
        if (backendStderrTail.length > 200) backendStderrTail.shift()
        if (/ERROR|WARN/.test(line) && printedStderrLines < 200) {
          printedStderrLines += 1
          console.log(`[backend stderr] ${line}`)
        }
      }
    })
    child.on('error', (error) => finish(rejectReady, error))
    child.on('exit', (code, signal) =>
      finish(
        rejectReady,
        new Error(`The backend exited before READY: code=${code} signal=${signal}`)
      )
    )
  })
}

// --- Media ------------------------------------------------------------------------

/** The recording's first audio track as s16le mono 16 kHz, as Clean cut extracts it. */
function decodeMonoPcm16(path) {
  return runBinary(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    path,
    '-map',
    '0:a:0',
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(PCM_SAMPLE_RATE),
    '-f',
    's16le',
    'pipe:1'
  ])
}

async function probeFile(path) {
  const stdout = await runBinary(ffprobePath, [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    path
  ])
  const json = JSON.parse(stdout.toString('utf8'))
  return { probe: normalizeProbe(json), counts: streamCounts(json) }
}

function runBinary(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', rejectRun)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolveRun(Buffer.concat(stdout))
        return
      }
      rejectRun(
        new Error(`${command} failed: code=${code} signal=${signal} ${stderr.join('').trim()}`)
      )
    })
  })
}

// --- Failure evidence -------------------------------------------------------------

async function writeFailureReport(error) {
  const attempt = async (label, action) => {
    try {
      return await action()
    } catch (cause) {
      return { error: `${label}: ${cause?.message ?? String(cause)}` }
    }
  }
  const snapshot = backend
    ? {
        cleanCutList: await attempt('cleanCut.list', () =>
          rpc(backend, 'cleanCut.list', {}, 10_000)
        ),
        cleanCutGet: sourceId
          ? await attempt('cleanCut.get', () =>
              rpc(backend, 'cleanCut.get', { sessionId: sourceId }, 10_000)
            )
          : null,
        sourceHealth: sourceId
          ? await attempt('sessions.healthEvents.list', () =>
              rpc(
                backend,
                'sessions.healthEvents.list',
                { sessionId: sourceId, limit: 120 },
                10_000
              )
            )
          : null
      }
    : null
  const report = {
    pass: false,
    error: { message: error?.message ?? String(error), stack: error?.stack ?? null },
    elapsedSeconds: Number(elapsedSeconds()),
    sourceId,
    jobId,
    evidence,
    jobStatuses: events.list
      .filter((entry) => entry.event === 'cleanCut.status')
      .map((entry) => ({ atMs: entry.at - startedAt, ...entry.payload })),
    backendWarnings: events.list
      .filter((entry) => entry.event === 'log' && ['warn', 'error'].includes(entry.payload?.level))
      .slice(-80)
      .map((entry) => entry.payload),
    fake: {
      capabilityRequests: fake.state.capabilityRequests,
      chunkRequests: fake.state.chunkRequests,
      chunks: fake.state.chunks,
      usedSeconds: fake.state.usedSeconds,
      jobCreates: fake.state.jobCreates,
      jobPolls: fake.state.jobPolls,
      unknownRoutes: fake.state.unknownRoutes,
      jobs: [...fake.state.jobs.values()].map((job) => ({
        id: job.id,
        status: job.status,
        polls: job.polls,
        clientRequestId: job.clientRequestId,
        segmentCount: job.input?.segmentCount ?? job.input?.segments?.length ?? null
      }))
    },
    backendStderrTail,
    snapshot
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`Clean cut smoke failure report: ${reportPath}`)
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
