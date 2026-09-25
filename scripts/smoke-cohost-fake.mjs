import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devAppSpawnOptions, repoRoot, stopProcess } from './lib/app-launcher.mjs'
import { captionStimulusPngBase64 } from './lib/comment-highlight-artifact.mjs'
import { startFakeApiRouter } from './lib/fake-api-router.mjs'
import { startFakeCaptionService } from './lib/fake-caption-service.mjs'
import {
  COHOST_SPOTLIGHT_CANDIDATES_CAP,
  COHOST_SPOTLIGHT_PATH,
  COHOST_SPOTLIGHT_REQUEST_KEYS,
  COHOST_SPOTLIGHT_TRANSCRIPT_MAX_CHARS,
  COHOST_TICK_MESSAGE_CAP,
  COHOST_TICK_MESSAGE_KEYS,
  COHOST_TICK_PATH,
  COHOST_TICK_REQUEST_KEYS,
  startFakeCohostService
} from './lib/fake-cohost-service.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Live Co-host offline smoke. Launches the real debug backend against an
// isolated profile and a local fake videorc-web (`POST /api/ai/cohost/tick`),
// drives the fake live-chat connector as scripted "lanes", and proves the
// engine end to end without the cloud:
//
//   settings gate -> off-shaped status with default presence fields -> start
//   requires the active chat session -> queued chat announces itself
//   (pendingMessages bucket emit + nextTickAt) -> tickInFlight toggles around
//   the request -> first tick has
//   the exact wire shape -> repeated text groups into ONE question whose
//   askers/messageIds grow across ticks -> marker message is flagged ->
//   429 quota pauses and resumes after Retry-After -> 403 pauses
//   premium-required -> 503 errors server-unconfigured with an escalating
//   backoff -> dismiss removes a question for good -> a single trickle message
//   ticks by the 20 s rule -> liveChat.send with inReplyToQuestionId marks the
//   question answered -> idle chat sends NO tick for 30 s -> stop.
//
// A second scenario (plan 060 S5) then proves the caption-fed spotlight lane
// and the automatic on-stream card on a real stream session:
//
//   headless stream session (test pattern -> local RTMP listener) -> fake
//   chat -> tick 1 suggests every message INCLUDING the flagged one -> live
//   captions through the fake caption service (scripted realtime finals, the
//   debug caption-contract audio seam instead of a microphone) -> a final that
//   mentions a comment puts it in `spotlight` within 4 s, with a valid request
//   body (<= 20 candidates, never the flagged one, consent, <= 800 chars) ->
//   voice mode emits autoHighlight {source: voice} and the card goes live with
//   always-set semantics (this smoke plays the renderer's executor) -> a
//   question resolves only on the SECOND "answered" hit and
//   `cohost.question.restore` puts it back -> a queued 404 opens the lane's
//   breaker (no spotlight request for 5 s+) -> picks mode fires nothing for
//   45 s after the previous card left the stream, then a pick that is never
//   the flagged message, the shown one, or the previous author.
//
// No production bearer, real account, or external network is involved. The
// API base override is honored by debug backends only; a local router puts
// the fake co-host and the fake caption service behind that one origin.

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 300_000)
const TICK_MIN_GAP_MS = 8_000
const TICK_IDLE_RULE_MS = 20_000
const QUOTA_RETRY_AFTER_SECONDS = 12
const SECOND_BACKOFF_STEP_MS = 10_000
const IDLE_PROOF_MS = 30_000
// Request timestamps are taken at the fake on arrival, so a gap measured there
// can undershoot the engine's own gap by the network jitter of two requests.
const GAP_TOLERANCE_MS = 250
const FLAG_MARKER = '#2'
const DUP_TEXT = 'Fake chat message #0'
const STREAM_TITLE = 'Co-host smoke'
const NOTES = 'Smoke notes: the keyboard is a fake.'

// Spotlight scenario (plan 060 S5). The engine's own clocks are hardcoded, so
// these mirror them: SPOTLIGHT_* and AUTO_HIGHLIGHT_* in cohost.rs.
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const RTMP_PORT = Number(process.env.VIDEORC_COHOST_SMOKE_RTMP_PORT ?? 19781)
const RTMP_LISTENER_BIND_MS = 1_500
const SPOTLIGHT_DEADLINE_MS = 4_000
const SPOTLIGHT_MIN_GAP_MS = 2_500
const AUTO_HIGHLIGHT_COOLDOWN_MS = 45_000
// The engine anchors the cooldown on its own 1 s observation of the overlay.
const COOLDOWN_TOLERANCE_MS = 1_500
const PICK_AFTER_COOLDOWN_DEADLINE_MS = 8_000
const BREAKER_PROOF_MS = 6_000
const CAPTION_AUDIO_PUMP_MS = 1_000
const SPOTLIGHT_LANE = {
  platform: 'twitch',
  targetId: 'spotlight-main',
  count: 5,
  intervalMs: 400,
  send: 'sent'
}
const MENTION_PHRASE = 'mechanical keyboard'
const ANSWER_PHRASE = 'sixty percent layout'
const SPOTLIGHT_FINALS = Object.freeze({
  mention: `Somebody in chat wants to know about my ${MENTION_PHRASE}, it clicks a lot.`,
  answerOnce: `So yes, it is a ${ANSWER_PHRASE} with brown switches.`,
  answerTwice: `Right, the ${ANSWER_PHRASE}, no number pad on it.`,
  breaker: ['Okay, back to the code for a second.', 'Let me scroll down here.', 'And save.']
})

const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-cohost-smoke-'))
const appDataDir = join(stateRoot, 'app-data')
const backendBinaryName = process.platform === 'win32' ? 'videorc-backend.exe' : 'videorc-backend'
const backendBinary = join(repoRoot, 'target', 'debug', backendBinaryName)
const smokeSessionToken = `cohost-smoke-session-${randomUUID()}`
// No colons: the fake parses destinations out of `<session>:<platform>:<target>:<id>`.
const sessionId = `cohost-smoke-${Date.now()}`

// Every lane is one fake destination. The fake connector emits
// `Fake chat message #<seq>` for seq in 0..count, one message every intervalMs
// starting at liveChat.start. A count=1 lane is therefore ONE message saying
// "#0" at `intervalMs` - the repeated question - while the main lane supplies a
// steady stream of distinct texts so bursts (>= 5 new) keep ticking through the
// error modes. The main lane ends at 60 s; afterwards only single trickle
// messages arrive (20 s rule), then nothing (idle proof).
const lanes = [
  { platform: 'twitch', targetId: 'cohost-main', count: 40, intervalMs: 1_500, send: 'sent' },
  { platform: 'youtube', targetId: 'cohost-dup-a', count: 1, intervalMs: 2_500, send: 'sent' },
  { platform: 'youtube', targetId: 'cohost-dup-b', count: 1, intervalMs: 3_500, send: 'sent' },
  { platform: 'twitch', targetId: 'cohost-dup-c', count: 1, intervalMs: 70_000, send: 'sent' },
  { platform: 'x', targetId: 'cohost-dup-d', count: 1, intervalMs: 90_000 }
]
const totalMessages = lanes.reduce((sum, lane) => sum + lane.count, 0)

mkdirSync(appDataDir, { recursive: true })
const secretsPath = join(appDataDir, 'videorc-secrets.json')
writeFileSync(
  secretsPath,
  JSON.stringify({ 'account:videorc:session': smokeSessionToken }, null, 2)
)
chmodSync(secretsPath, 0o600)

const fake = await startFakeCohostService({ smokeSessionToken, flagMarker: FLAG_MARKER })
const captionFake = await startFakeCaptionService({
  smokeSessionToken,
  smokeRealtimeToken: `cohost-smoke-realtime-${randomUUID()}`,
  autoTranscript: false
})
const router = await startFakeApiRouter({
  routes: [
    { prefix: COHOST_TICK_PATH, origin: fake.httpOrigin },
    { prefix: COHOST_SPOTLIGHT_PATH, origin: fake.httpOrigin },
    { prefix: '/api/ai/captions/', origin: captionFake.httpOrigin }
  ],
  fallback: fake.httpOrigin
})
let backendProcess
let backend

try {
  if (!existsSync(backendBinary)) {
    throw new Error(`target/debug/${backendBinaryName} is missing; build the debug backend first.`)
  }
  const env = { ...process.env }
  // The env override is downgrade-only (forces Basic); a developer shell must
  // not turn this run into a premium-required pause.
  delete env.VIDEORC_PREMIUM_FEATURES
  backendProcess = spawn(backendBinary, [], {
    ...devAppSpawnOptions({
      env: {
        ...env,
        VIDEORC_API_BASE_URL: router.httpOrigin,
        // Debug-only caption seam for the spotlight scenario: captions run
        // without a microphone and take injected audio (never in release).
        VIDEORC_CAPTION_CONTRACT_TEST: '1',
        VIDEORC_CAPTION_CONTRACT_ALLOW_IDLE: '1',
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
  backend = await connectBackend({ ...ready, adminToken: undefined }, timeoutMs)
  const observed = collectCohostStates(backend)
  const startedAt = Date.now()
  const phase = (label) =>
    console.log(`[cohost-smoke +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${label}`)

  // --- Settings gate + session guard ---------------------------------------
  phase('settings')
  const settings = await request(backend, timeoutMs, 'cohost.settings.set', {
    enabled: true,
    tone: 'short',
    notes: NOTES
  })
  expect(
    settings.enabled === true && settings.tone === 'short' && settings.notes === NOTES,
    `cohost.settings.set did not echo the patch: ${JSON.stringify(settings)}`
  )
  const settingsRead = await request(backend, timeoutMs, 'cohost.settings.get', {})
  expect(
    JSON.stringify(settingsRead) === JSON.stringify(settings),
    `cohost.settings.get drifted from set: ${JSON.stringify(settingsRead)}`
  )
  const off = await request(backend, timeoutMs, 'cohost.status', {})
  expect(
    off.status === 'off' && off.sessionId === null,
    `Engine should be off before a chat session: ${JSON.stringify(off)}`
  )
  // Presence W1: cohost.status is ALWAYS a concrete state; before any session
  // it is the off shape with every presence field at its default.
  expect(
    off.tickInFlight === false &&
      off.pendingMessages === 0 &&
      off.nextTickAt === null &&
      off.messagesSeen === 0 &&
      off.questionsTotal === 0,
    `Off state should carry default presence fields: ${JSON.stringify(off)}`
  )
  await expectRejected(
    () => request(backend, timeoutMs, 'cohost.start', { sessionId, consentToProcessChat: true }),
    'cohost.start without an active Comments session'
  )

  // --- Chat session + engine start ----------------------------------------
  phase(`liveChat.start with ${lanes.length} fake lanes (${totalMessages} scripted messages)`)
  await request(backend, timeoutMs, 'liveChat.start', {
    sessionId,
    destinations: lanes.map(({ platform, targetId }) => ({
      platform,
      targetId,
      read: 'ready',
      write: platform === 'x' ? 'read-only' : 'ready'
    })),
    fakes: lanes
  })
  const started = await request(backend, timeoutMs, 'cohost.start', {
    sessionId,
    consentToProcessChat: true,
    streamTitle: STREAM_TITLE
  })
  expect(
    started.status === 'listening' && started.sessionId === sessionId && started.tickSeq === 0,
    `cohost.start did not report listening: ${JSON.stringify(started)}`
  )
  expect(
    started.tickInFlight === false && started.pendingMessages === 0 && started.messagesSeen === 0,
    `Fresh session should start with empty presence counters: ${JSON.stringify(started)}`
  )
  const again = await request(backend, timeoutMs, 'cohost.start', {
    sessionId,
    consentToProcessChat: true
  })
  expect(
    again.status === 'listening' && again.tickSeq === 0,
    'Repeated cohost.start was not a no-op.'
  )

  // --- Presence W1: queued chat is announced before the first tick -----------
  phase('presence: pending bucket emit before tick 1')
  const pendingState = await waitForState(
    observed,
    (state) => state.tickSeq === 0 && (state.pendingMessages ?? 0) >= 1,
    'a pending-bucket cohost.state before the first tick'
  )
  expect(
    pendingState.tickInFlight === false &&
      typeof pendingState.nextTickAt === 'string' &&
      !Number.isNaN(Date.parse(pendingState.nextTickAt)),
    `Pending messages must announce the next pass: ${JSON.stringify({ pendingMessages: pendingState.pendingMessages, nextTickAt: pendingState.nextTickAt })}`
  )
  expect(
    pendingState.messagesSeen >= pendingState.pendingMessages,
    `messagesSeen should count every noted message: ${JSON.stringify({ messagesSeen: pendingState.messagesSeen, pendingMessages: pendingState.pendingMessages })}`
  )

  // --- Tick 1: burst, exact wire shape, grouped question, flag ---------------
  phase('tick 1: burst (>= 5 new messages)')
  const inFlight1 = await waitForState(
    observed,
    (state) => state.tickSeq === 1 && state.tickInFlight === true,
    'the tick-in-flight cohost.state for tick 1'
  )
  expect(
    inFlight1.pendingMessages === 0,
    `Sending a tick drains the pending delta: ${JSON.stringify({ pendingMessages: inFlight1.pendingMessages })}`
  )
  const s1 = await waitForTick(observed, 1)
  expect(
    s1.status === 'listening' && s1.reason === null,
    `Tick 1 should leave the engine listening: ${JSON.stringify(s1)}`
  )
  expect(
    typeof s1.lastTickAt === 'string' && s1.partial === false && typeof s1.mood === 'string',
    `Tick 1 state lacks lastTickAt/partial/mood: ${JSON.stringify(s1)}`
  )
  // Presence W1: the merged tick clears the in-flight flag; pending stays at
  // whatever arrived since the request went out (0 unless a message raced in).
  expect(
    s1.tickInFlight === false && s1.messagesSeen >= 5 && s1.questionsTotal >= 1,
    `Merged tick 1 should reset in-flight and grow the session counters: ${JSON.stringify({ tickInFlight: s1.tickInFlight, messagesSeen: s1.messagesSeen, questionsTotal: s1.questionsTotal })}`
  )
  const r1 = requireRequest(1)
  assertRequestShape(r1.body)
  expect(
    r1.body.tickSeq === 1 && r1.body.openQuestions.length === 0 && r1.body.messages.length >= 5,
    `First tick request should be a fresh burst: ${JSON.stringify({ tickSeq: r1.body.tickSeq, open: r1.body.openQuestions.length, messages: r1.body.messages.length })}`
  )
  expect(
    r1.body.streamTitle === STREAM_TITLE && r1.body.notes === NOTES && r1.body.tone === 'short',
    'First tick did not carry the settings/title the smoke configured.'
  )
  const dup1 = s1.questions.find((question) => question.text === DUP_TEXT)
  expect(
    dup1 && dup1.askers.length === 3 && dup1.messageIds.length === 3,
    `Repeated question should group three askers in tick 1: ${JSON.stringify(s1.questions)}`
  )
  expect(
    typeof dup1.suggestedReply === 'string' &&
      dup1.suggestedReply.length > 0 &&
      dup1.fromNotes === false,
    'Grouped question is missing its suggested reply.'
  )
  const flag = s1.flags.find(
    (entry) => entry.messageId.includes(':cohost-main:') && entry.messageId.endsWith(':fake-2')
  )
  expect(
    flag && flag.kind === 'spam' && typeof flag.at === 'string',
    `Marker message was not flagged after tick 1: ${JSON.stringify(s1.flags)}`
  )

  // --- Tick 2: 429 quota-exhausted with Retry-After --------------------------
  phase(`tick 2: 429 quota-exhausted (Retry-After ${QUOTA_RETRY_AFTER_SECONDS}s)`)
  fake.queueFailure({
    status: 429,
    code: 'quota-exhausted',
    retryAfterSeconds: QUOTA_RETRY_AFTER_SECONDS
  })
  const s2 = await waitForTick(observed, 2)
  expect(
    s2.status === 'paused' && s2.reason === 'quota-exhausted',
    `429 should pause with quota-exhausted: ${JSON.stringify({ status: s2.status, reason: s2.reason })}`
  )
  expect(
    s2.questions.some((question) => question.id === dup1.id),
    'Quota pause must keep the open questions.'
  )
  const r2 = requireRequest(2)
  expect(r2.status === 429, 'Fake did not serve the scripted 429.')
  assertGap(r1, r2, TICK_MIN_GAP_MS, 'minimum 8 s tick gap')
  const echoed = r2.body.openQuestions.find((question) => question.id === dup1.id)
  expect(
    echoed && echoed.count === 3 && echoed.text === DUP_TEXT,
    `Open question echo should carry id/text/count: ${JSON.stringify(r2.body.openQuestions)}`
  )

  // --- Tick 3: resumes after Retry-After --------------------------------------
  phase('tick 3: resume after Retry-After')
  const s3 = await waitForTick(observed, 3)
  expect(
    s3.status === 'listening' && s3.reason === null,
    `Engine did not resume after Retry-After: ${JSON.stringify(s3)}`
  )
  const r3 = requireRequest(3)
  assertGap(r2, r3, QUOTA_RETRY_AFTER_SECONDS * 1_000, 'Retry-After window')
  const dup3 = s3.questions.find((question) => question.id === dup1.id)
  expect(
    dup3 &&
      dup3.askers.length === 3 &&
      dup3.messageIds.length === 3 &&
      dup3.firstSeenAt === dup1.firstSeenAt,
    `Grouped question lost state across the pause: ${JSON.stringify(dup3)}`
  )

  // --- Tick 4: 403 premium-required -------------------------------------------
  phase('tick 4: 403 premium-required')
  fake.queueFailure({ status: 403, code: 'premium-required' })
  const s4 = await waitForTick(observed, 4)
  expect(
    s4.status === 'paused' && s4.reason === 'premium-required',
    `403 should pause with premium-required: ${JSON.stringify({ status: s4.status, reason: s4.reason })}`
  )
  requireRequest(4)

  // --- Ticks 5 + 6: 503 cohost-disabled, escalating backoff -------------------
  phase('tick 5: 503 cohost-disabled')
  fake.queueFailure({ status: 503, code: 'cohost-disabled' })
  const s5 = await waitForTick(observed, 5)
  expect(
    s5.status === 'error' && s5.reason === 'server-unconfigured',
    `503 should error with server-unconfigured: ${JSON.stringify({ status: s5.status, reason: s5.reason })}`
  )
  const r5 = requireRequest(5)
  phase('tick 6: second 503 (backoff ladder step 2)')
  fake.queueFailure({ status: 503, code: 'cohost-disabled' })
  const s6 = await waitForTick(observed, 6)
  expect(
    s6.status === 'error' && s6.reason === 'server-unconfigured',
    'Second 503 should stay in error.'
  )
  const r6 = requireRequest(6)
  assertGap(r5, r6, TICK_MIN_GAP_MS, 'tick gap after the first 503')

  // --- Tick 7: recovery honors the 10 s backoff -------------------------------
  phase('tick 7: recovery after backoff')
  const s7 = await waitForTick(observed, 7)
  expect(
    s7.status === 'listening' && s7.reason === null,
    `Engine did not recover after 503s: ${JSON.stringify(s7)}`
  )
  const r7 = requireRequest(7)
  assertGap(r6, r7, SECOND_BACKOFF_STEP_MS, 'second backoff step (10 s)')

  // --- Dismiss: the question leaves and never returns ------------------------
  phase('dismiss a question + a flag')
  const victim = s7.questions.find((question) => question.id !== dup1.id)
  expect(victim, `Need a second open question to dismiss: ${JSON.stringify(s7.questions)}`)
  const dismissed = await request(backend, timeoutMs, 'cohost.question.dismiss', {
    sessionId,
    questionId: victim.id
  })
  expect(
    !dismissed.questions.some((question) => question.id === victim.id) &&
      dismissed.questions.some((question) => question.id === dup1.id),
    'Dismiss did not remove exactly the chosen question.'
  )
  const flagDismissed = await request(backend, timeoutMs, 'cohost.flag.dismiss', {
    sessionId,
    messageId: flag.messageId
  })
  expect(
    !flagDismissed.flags.some((entry) => entry.messageId === flag.messageId),
    'Flag dismiss did not remove the flag.'
  )

  // --- Tick 8: single trickle message ticks by the 20 s rule ------------------
  phase('tick 8: trickle (20 s rule)')
  const s8 = await waitForTick(observed, 8)
  const r8 = requireRequest(8)
  expect(
    r8.body.messages.length >= 1 && r8.body.messages.length < 5,
    `Trickle tick should carry fewer than five messages: ${r8.body.messages.length}`
  )
  assertGap(r7, r8, TICK_IDLE_RULE_MS, '20 s idle rule')
  expect(
    !r8.body.openQuestions.some((question) => question.id === victim.id),
    'Dismissed question was echoed back to the server.'
  )
  expect(
    !s8.questions.some((question) => question.id === victim.id),
    'Dismissed question returned after a tick.'
  )
  const dup8 = s8.questions.find((question) => question.id === dup1.id)
  expect(
    dup8 && dup8.askers.length === 4 && dup8.messageIds.length === 4,
    `Trickle duplicate should grow the grouped question to four: ${JSON.stringify(dup8)}`
  )

  // --- Tick 9: fifth duplicate, ids unioned across ticks ---------------------
  phase('tick 9: fifth duplicate')
  const s9 = await waitForTick(observed, 9)
  const r9 = requireRequest(9)
  assertGap(r8, r9, TICK_IDLE_RULE_MS, '20 s idle rule (second trickle)')
  const dup9 = s9.questions.find((question) => question.id === dup1.id)
  expect(
    dup9 && dup9.askers.length === 5 && new Set(dup9.messageIds).size === 5,
    `Grouped question should reach five askers / five message ids: ${JSON.stringify(dup9)}`
  )
  const contributingTicks = new Set()
  for (const record of fake.state.requests) {
    for (const message of record.body.messages) {
      if (dup9.messageIds.includes(message.id)) contributingTicks.add(record.body.tickSeq)
    }
  }
  expect(
    contributingTicks.size >= 3,
    `messageIds should be unioned across ticks, got ticks ${[...contributingTicks].join(',')}`
  )
  expect(
    dup9.platforms.includes('x') &&
      dup9.platforms.includes('twitch') &&
      dup9.platforms.includes('youtube'),
    `Grouped question should span every lane platform: ${JSON.stringify(dup9.platforms)}`
  )
  expect(
    !s9.questions.some((question) => question.id === victim.id),
    'Dismissed question returned on a later tick.'
  )

  // --- Reply via liveChat.send marks the question answered -------------------
  phase('liveChat.send with inReplyToQuestionId')
  const operationId = randomUUID()
  const sent = await request(backend, timeoutMs, 'liveChat.send', {
    operationId,
    sessionId,
    text: dup9.suggestedReply,
    inReplyToQuestionId: dup9.id
  })
  expect(
    sent.phase === 'sent' || sent.phase === 'partial',
    `Reply send did not reach a terminal delivered phase: ${JSON.stringify(sent)}`
  )
  const answered = await waitForState(
    observed,
    (state) => state.tickSeq === 9 && !state.questions.some((question) => question.id === dup9.id),
    'answered question leaving the open set'
  )
  expect(answered.status === 'listening', 'Answering must not change the engine status.')
  const statusAfterReply = await request(backend, timeoutMs, 'cohost.status', {})
  expect(
    !statusAfterReply.questions.some((question) => question.id === dup9.id),
    'cohost.status still lists the answered question.'
  )

  // --- Idle: no tick for 30 s --------------------------------------------------
  phase(`idle proof: ${IDLE_PROOF_MS / 1000}s without chat`)
  const requestsBeforeIdle = fake.state.requests.length
  await sleep(IDLE_PROOF_MS)
  const idle = await request(backend, timeoutMs, 'cohost.status', {})
  expect(
    fake.state.requests.length === requestsBeforeIdle &&
      idle.tickSeq === 9 &&
      idle.status === 'listening',
    `Idle chat must not tick: ${JSON.stringify({ requests: fake.state.requests.length, before: requestsBeforeIdle, tickSeq: idle.tickSeq, status: idle.status })}`
  )

  // --- Whole-run invariants ----------------------------------------------------
  const seen = new Set()
  let previousSeq = 0
  for (const record of fake.state.requests) {
    expect(
      record.body.tickSeq === previousSeq + 1,
      `tickSeq must be contiguous, got ${record.body.tickSeq} after ${previousSeq}`
    )
    previousSeq = record.body.tickSeq
    expect(
      record.body.sessionClientId === sessionId &&
        record.body.droppedMessages === 0 &&
        record.body.messages.length <= COHOST_TICK_MESSAGE_CAP,
      `Request ${record.body.tickSeq} broke a wire invariant.`
    )
    for (const message of record.body.messages) {
      expect(!seen.has(message.id), `Message ${message.id} was sent twice.`)
      seen.add(message.id)
    }
  }
  expect(
    seen.size === totalMessages,
    `Every scripted message should reach the server exactly once: ${seen.size}/${totalMessages}`
  )
  expect(
    fake.state.unauthorized === 0,
    'A tick reached the fake without the stored session bearer.'
  )

  // --- Stop -------------------------------------------------------------------
  phase('stop')
  const stopped = await request(backend, timeoutMs, 'cohost.stop', {})
  expect(
    stopped.status === 'off' && stopped.sessionId === null,
    `cohost.stop should report off: ${JSON.stringify(stopped)}`
  )
  await request(backend, timeoutMs, 'liveChat.stop', {})

  console.log(
    `Live Co-host fake smoke PASS - ${fake.state.requests.length} ticks over ${totalMessages} messages: ` +
      `off-shaped presence defaults, pending-bucket emit with nextTickAt, tickInFlight toggle, ` +
      `wire shape, 5-asker grouping across ${contributingTicks.size} ticks, flag, ` +
      `429/403/503 status+reason mapping with Retry-After and backoff honored, dismiss, ` +
      `20 s trickle rule, reply-answered, and ${IDLE_PROOF_MS / 1000} s idle without a tick.`
  )

  await runSpotlightScenario({ ready, startedAt })
} finally {
  try {
    if (backend) {
      await request(backend, 5_000, 'cohost.stop', {}).catch(() => {})
      await request(backend, 5_000, 'liveChat.stop', {}).catch(() => {})
      backend.close()
    }
  } finally {
    if (backendProcess) {
      await stopProcess(backendProcess).catch(() => {})
    }
    await router.close()
    await captionFake.close()
    await fake.close()
    rmSync(stateRoot, { force: true, recursive: true })
  }
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function expectRejected(action, label) {
  let rejected = false
  try {
    await action()
  } catch {
    rejected = true
  }
  expect(rejected, `${label} should have been rejected.`)
}

function requireRequest(tickSeq) {
  const record = fake.state.requests[tickSeq - 1]
  expect(
    record && record.body.tickSeq === tickSeq,
    `Expected tick request ${tickSeq}, fake recorded ${fake.state.requests.length} request(s).`
  )
  return record
}

function assertGap(earlier, later, minimumMs, label) {
  const gap = later.at - earlier.at
  expect(
    gap >= minimumMs - GAP_TOLERANCE_MS,
    `Ticks ${earlier.body.tickSeq}->${later.body.tickSeq} arrived ${gap}ms apart; ${label} requires >= ${minimumMs}ms.`
  )
}

function assertRequestShape(body) {
  // Wire v2 adds `rules`; everything else is the v1 key set.
  const keys = Object.keys(body)
    .filter((key) => key !== 'rules')
    .sort()
  expect(Array.isArray(body.rules), 'A v2 tick request must carry the rules array.')
  expect(
    JSON.stringify(keys) === JSON.stringify([...COHOST_TICK_REQUEST_KEYS]),
    `Tick request keys drifted from the contract: ${keys.join(',')}`
  )
  expect(
    body.promptVersion === 2 &&
      body.consentToProcessChat === true &&
      typeof body.clientVersion === 'string' &&
      body.clientVersion.startsWith('videorc-desktop/'),
    'Tick request header fields are wrong.'
  )
  expect(
    body.messages.length <= COHOST_TICK_MESSAGE_CAP && body.droppedMessages === 0,
    'Delta cap/dropped count violated.'
  )
  for (const message of body.messages) {
    const messageKeys = Object.keys(message)
    expect(
      messageKeys.every((key) => COHOST_TICK_MESSAGE_KEYS.includes(key)),
      `Tick message carries unknown keys: ${messageKeys.join(',')}`
    )
    for (const required of ['id', 'platform', 'author', 'text', 'at']) {
      expect(required in message, `Tick message is missing ${required}.`)
    }
    expect(
      message.text.length <= 500 && !Number.isNaN(Date.parse(message.at)),
      'Tick message text/at violate the contract.'
    )
  }
}

function collectCohostStates(ws) {
  const collection = { states: [], waiters: [] }
  ws.addEventListener('message', (event) => {
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (parsed.event === 'cohost.state') {
      collection.states.push(parsed.payload)
      for (const waiter of [...collection.waiters]) {
        waiter(parsed.payload)
      }
    } else if (parsed.event === 'backend.log' && /\borcle\b/i.test(parsed.payload?.message ?? '')) {
      console.log(`[backend] ${parsed.payload.level}: ${parsed.payload.message}`)
    }
  })
  return collection
}

function waitForTick(observed, tickSeq) {
  // tickSeq increments when the request is BUILT, so each tick emits twice:
  // once in flight ("thinking") and once merged. Wait for the merged one.
  return waitForState(
    observed,
    (state) => state.tickSeq === tickSeq && state.tickInFlight !== true,
    `cohost.state for tick ${tickSeq}`
  )
}

function waitForState(observed, predicate, label, deadlineMs = 60_000) {
  const existing = observed.states.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => {
      observed.waiters.splice(observed.waiters.indexOf(onState), 1)
      rejectWait(new Error(`Timed out after ${deadlineMs}ms waiting for ${label}.`))
    }, deadlineMs)
    const onState = (state) => {
      if (!predicate(state)) return
      clearTimeout(timer)
      observed.waiters.splice(observed.waiters.indexOf(onState), 1)
      resolveWait(state)
    }
    observed.waiters.push(onState)
  })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function waitForBackendReady(child, deadlineMs) {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error('Backend did not print READY in time.')),
      deadlineMs
    )
    let stdout = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('READY '))
      if (!line) return
      try {
        finish(resolveReady, JSON.parse(line.slice('READY '.length)))
      } catch {
        finish(rejectReady, new Error('Backend printed an invalid READY payload.'))
      }
    })
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (/WARN|ERROR/.test(line)) console.log(`[backend stderr] ${line}`)
      }
    })
    child.on('error', (error) => finish(rejectReady, error))
    child.on('exit', (code, signal) =>
      finish(rejectReady, new Error(`Backend exited before READY: code=${code} signal=${signal}`))
    )
  })
}

// --- Spotlight scenario (plan 060 S5) -----------------------------------------

async function runSpotlightScenario({ ready, startedAt }) {
  const phase = (label) =>
    console.log(
      `[cohost-smoke spotlight +${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${label}`
    )
  const events = collectEvents(backend)
  const admin = await connectBackend(
    { ...ready, token: ready.adminToken, adminToken: undefined },
    timeoutMs
  )
  const listener = spawnRtmpListener(join(stateRoot, 'spotlight-stream.flv'))
  let streamSessionId = null
  let sessionActive = false
  let executor = null
  let pump = null
  try {
    const health = await request(admin, timeoutMs, 'health.ping', { ffmpegPath })
    expect(
      health?.ffmpeg?.available === true,
      health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the spotlight stream session.'
    )
    await sleep(RTMP_LISTENER_BIND_MS)
    expect(
      listener.process.exitCode === null,
      `Local RTMP listener exited before the stream started: ${listener.stderr.join('').trim()}`
    )

    // --- "What I talk about": voice only ------------------------------------
    phase('settings: voice highlight on, picks off')
    const voiceSettings = await request(backend, timeoutMs, 'cohost.settings.set', {
      autoHighlight: false,
      voiceHighlight: true
    })
    expect(
      voiceSettings.enabled === true &&
        voiceSettings.voiceHighlight === true &&
        voiceSettings.autoHighlight === false,
      `Voice-only settings did not apply: ${JSON.stringify(voiceSettings)}`
    )
    fake.setTickHighlights({ score: 0.9, type: 'insight' })
    fake.setSpotlightMatches([])

    phase('stream session: test pattern to the local RTMP listener')
    // One-shot output capability, like the renderer: never a raw directory.
    const outputCapability = await request(admin, timeoutMs, 'resource.capability.issue', {
      kind: 'output-directory',
      path: stateRoot
    })
    const started = await request(
      admin,
      timeoutMs,
      'session.start',
      streamSessionParams(outputCapability.capabilityId)
    )
    expect(
      started.state === 'streaming' && typeof started.sessionId === 'string',
      `Expected an active stream session: ${JSON.stringify(started)}`
    )
    streamSessionId = started.sessionId
    sessionActive = true
    executor = startAutoHighlightExecutor(backend, streamSessionId)

    await request(backend, timeoutMs, 'liveChat.start', {
      sessionId: streamSessionId,
      destinations: [
        {
          platform: SPOTLIGHT_LANE.platform,
          targetId: SPOTLIGHT_LANE.targetId,
          read: 'ready',
          write: 'ready'
        }
      ],
      fakes: [SPOTLIGHT_LANE]
    })
    const cohostStarted = await request(backend, timeoutMs, 'cohost.start', {
      sessionId: streamSessionId,
      consentToProcessChat: true,
      streamTitle: STREAM_TITLE
    })
    expect(
      cohostStarted.status === 'listening' && cohostStarted.sessionId === streamSessionId,
      `cohost.start did not listen on the stream session: ${JSON.stringify(cohostStarted)}`
    )

    // --- Tick 1 suggests every message, the flagged one first ----------------
    phase('tick 1: every message suggested, the flagged one ranked first')
    const tickState = await waitForEvent(
      events,
      'cohost.state',
      (state) =>
        state.sessionId === streamSessionId &&
        state.tickInFlight !== true &&
        state.messagesSeen >= SPOTLIGHT_LANE.count &&
        state.flags.some((flag) => flag.messageId.endsWith(':fake-2')) &&
        state.questions.length >= SPOTLIGHT_LANE.count - 1,
      'the merged spotlight-session tick with a flag',
      30_000
    )
    const sessionTicks = fake.state.requests.filter(
      (record) => record.body.sessionClientId === streamSessionId
    )
    const tickedMessages = sessionTicks.flatMap((record) => record.body.messages)
    const idFor = (seq) => {
      const message = tickedMessages.find((candidate) => candidate.id.endsWith(`:fake-${seq}`))
      expect(message, `Fake message #${seq} never reached a tick.`)
      return message.id
    }
    const ids = [0, 1, 2, 3, 4].map(idFor)
    const [, mentionId, flaggedId, answerId, sameAuthorId] = ids
    expect(
      sessionTicks.some((record) => record.highlightIds?.[0] === flaggedId),
      `The fake must suggest the flagged message first: ${JSON.stringify(sessionTicks.map((record) => record.highlightIds))}`
    )
    expect(
      tickState.highlights.length > 0 &&
        !tickState.highlights.some((highlight) => highlight.messageId === flaggedId),
      `Merged highlights must drop the flagged suggestion: ${JSON.stringify(tickState.highlights)}`
    )
    const answerQuestion = tickState.questions.find((question) =>
      question.messageIds.includes(answerId)
    )
    expect(
      answerQuestion,
      `No open question for ${answerId}: ${JSON.stringify(tickState.questions)}`
    )
    fake.setSpotlightMatches([
      { whenTranscriptIncludes: MENTION_PHRASE, messageId: mentionId, about: 0.92 },
      // Never a candidate (flagged), so this rule can never fire.
      { whenTranscriptIncludes: MENTION_PHRASE, messageId: flaggedId, about: 0.99 },
      {
        whenTranscriptIncludes: ANSWER_PHRASE,
        messageId: answerId,
        about: 0.4,
        questionId: answerQuestion.id,
        answered: 0.9
      }
    ])

    // --- Live captions through the fake caption service ---------------------
    phase('captions: fake realtime transcription, injected audio')
    const configurationsBefore = captionFake.state.configurations.length
    await request(backend, timeoutMs, 'captions.start', { language: 'en' })
    pump = startCaptionAudioPump(admin)
    await waitUntil(
      () =>
        captionFake.state.configurations.length > configurationsBefore &&
        captionFake.state.audioAppends > 0,
      20_000,
      'the realtime caption session to configure and receive audio'
    )

    // --- A final mentions a comment: spotlight within 4 s -------------------
    phase('final 1 mentions a comment in other words')
    const mention = await emitFinal(events, SPOTLIGHT_FINALS.mention)
    const spotlightState = await waitForEvent(
      events,
      'cohost.state',
      (state) => state.sessionId === streamSessionId && state.spotlight?.messageId === mentionId,
      `spotlight on ${mentionId}`,
      Math.max(0, mention.emittedAt + SPOTLIGHT_DEADLINE_MS - Date.now())
    )
    const spotlightLatencyMs = Date.now() - mention.emittedAt
    expect(
      typeof spotlightState.spotlight.expiresAt === 'string' &&
        spotlightState.spotlight.score >= 0.75,
      `Spotlight lacks score/expiry: ${JSON.stringify(spotlightState.spotlight)}`
    )
    const mentionCall = fake.state.spotlightRequests.find((record) =>
      record.body?.transcript?.includes(MENTION_PHRASE)
    )
    expect(mentionCall, 'No spotlight request carried the mention.')
    assertSpotlightRequestShape(mentionCall.body, { streamSessionId, flaggedId })

    // --- Voice mode puts it on stream, always-set --------------------------
    phase('voice: autoHighlight {source: voice} and the card goes live')
    const voiceCommandState = await waitForEvent(
      events,
      'cohost.state',
      (state) =>
        state.sessionId === streamSessionId &&
        state.autoHighlight?.source === 'voice' &&
        state.autoHighlight?.messageId === mentionId,
      'the voice autoHighlight command',
      10_000
    )
    const firstVoiceGeneration = voiceCommandState.autoHighlight.generation
    expect(
      voiceCommandState.autoHighlight.refresh === false,
      `The first voice card is not a refresh: ${JSON.stringify(voiceCommandState.autoHighlight)}`
    )
    const firstLive = await waitForEvent(
      events,
      'comments.highlight.status',
      (status) => status.phase === 'live' && status.messageId === mentionId,
      'the voice card live on the stream overlay',
      10_000,
      0
    )
    // The overlay status event can beat the RPC response; wait for both.
    const firstExecution = await waitUntil(
      () =>
        executor.executions.find(
          (execution) =>
            execution.generation === firstVoiceGeneration && (execution.result || execution.error)
        ),
      10_000,
      'the voice comments.highlight.set response'
    )
    expect(
      firstExecution?.result?.phase === 'live' && !firstExecution.error,
      `comments.highlight.set did not take the voice card live: ${JSON.stringify(firstExecution)}`
    )

    // --- The question resolves on the SECOND answered hit -------------------
    phase('final 2 answers the question once: still open')
    await waitUntil(
      () => Date.now() - lastSpotlightCallAt() >= SPOTLIGHT_MIN_GAP_MS,
      10_000,
      'the spotlight min gap'
    )
    await emitFinal(events, SPOTLIGHT_FINALS.answerOnce)
    const firstAnswerCall = await waitForSpotlightCall(
      (record) => record.body?.transcript?.includes(ANSWER_PHRASE),
      'the first answered spotlight call'
    )
    expect(firstAnswerCall.status === 200, 'The first answered call must succeed.')
    expect(
      firstAnswerCall.body.candidates.some(
        (candidate) => candidate.id === answerId && candidate.questionId === answerQuestion.id
      ),
      `The answered question must ride as a question candidate: ${JSON.stringify(firstAnswerCall.body.candidates)}`
    )
    await sleep(500)
    const afterOneHit = await request(backend, timeoutMs, 'cohost.status', {})
    expect(
      afterOneHit.questions.some((question) => question.id === answerQuestion.id) &&
        (afterOneHit.recentlyResolved ?? []).length === 0,
      `One answered hit must not resolve: ${JSON.stringify({ open: afterOneHit.questions.map((question) => question.id), recentlyResolved: afterOneHit.recentlyResolved })}`
    )

    phase('final 3 answers it again: resolved by voice')
    await waitUntil(
      () => Date.now() - lastSpotlightCallAt() >= SPOTLIGHT_MIN_GAP_MS,
      10_000,
      'the spotlight min gap'
    )
    await emitFinal(events, SPOTLIGHT_FINALS.answerTwice)
    const resolvedState = await waitForEvent(
      events,
      'cohost.state',
      (state) =>
        state.sessionId === streamSessionId &&
        (state.recentlyResolved ?? []).some(
          (entry) => entry.question?.id === answerQuestion.id && entry.reason === 'voice'
        ),
      'the voice-resolved question in recentlyResolved',
      10_000
    )
    const answeredCalls = fake.state.spotlightRequests.filter(
      (record) => record.status === 200 && record.body?.transcript?.includes(ANSWER_PHRASE)
    )
    expect(
      answeredCalls.length === 2,
      `The question must resolve on exactly the second answered hit, saw ${answeredCalls.length}.`
    )
    expect(
      !resolvedState.questions.some((question) => question.id === answerQuestion.id) &&
        typeof resolvedState.recentlyResolved[0].resolvedAt === 'string',
      'A voice-resolved question must leave the open set with a resolvedAt.'
    )

    // Nothing may re-resolve it: the answer phrase stays in the 20 s window.
    fake.setSpotlightMatches([])
    phase('cohost.question.restore puts it back')
    const restored = await request(backend, timeoutMs, 'cohost.question.restore', {
      sessionId: streamSessionId,
      questionId: answerQuestion.id
    })
    expect(
      restored.questions.some((question) => question.id === answerQuestion.id) &&
        (restored.recentlyResolved ?? []).length === 0,
      `Restore must reopen the question and empty recentlyResolved: ${JSON.stringify({ open: restored.questions.map((question) => question.id), recentlyResolved: restored.recentlyResolved })}`
    )

    // --- "What I talk about and Orcle's picks" -------------------------------
    phase("settings: What I talk about and Orcle's picks")
    const picksSettings = await request(backend, timeoutMs, 'cohost.settings.set', {
      autoHighlight: true,
      voiceHighlight: true
    })
    expect(
      picksSettings.autoHighlight === true && picksSettings.voiceHighlight === true,
      `Picks settings did not apply: ${JSON.stringify(picksSettings)}`
    )

    // --- A 404 opens the lane's breaker ---------------------------------------
    phase('breaker: a 404 closes the spotlight lane')
    await waitUntil(
      () => Date.now() - lastSpotlightCallAt() >= SPOTLIGHT_MIN_GAP_MS,
      10_000,
      'the spotlight min gap'
    )
    fake.queueSpotlightFailure({ status: 404 })
    await emitFinal(events, SPOTLIGHT_FINALS.breaker[0])
    const notFoundCall = await waitForSpotlightCall(
      (record) => record.status === 404,
      'the scripted 404 spotlight call'
    )
    const callsAfter404 = () =>
      fake.state.spotlightRequests.filter((record) => record.at > notFoundCall.at)
    for (const text of SPOTLIGHT_FINALS.breaker.slice(1)) {
      await sleep(1_500)
      await emitFinal(events, text)
    }
    await sleep(Math.max(0, notFoundCall.at + BREAKER_PROOF_MS - Date.now()))
    expect(
      callsAfter404().length === 0,
      `The 404 must close the lane for 5 min; saw ${callsAfter404().length} call(s) within ${BREAKER_PROOF_MS} ms.`
    )
    const afterBreaker = await request(backend, timeoutMs, 'cohost.status', {})
    expect(
      afterBreaker.status === 'listening' && afterBreaker.reason === null,
      `The spotlight breaker must never touch the tick status: ${JSON.stringify({ status: afterBreaker.status, reason: afterBreaker.reason })}`
    )

    // --- The voice card leaves the stream without a clear --------------------
    phase('voice card: at most one refresh, then it expires')
    const cardEnd = await waitForEvent(
      events,
      'comments.highlight.status',
      (status) => status.phase !== 'live' && status.phase !== 'applying',
      'the voice card leaving the stream',
      40_000,
      firstLive.at
    )
    expect(
      cardEnd.payload.reason === 'expired',
      `The voice card must leave by expiry, never a clear: ${JSON.stringify(cardEnd.payload)}`
    )
    const voiceCommands = distinctCommands(events).filter((command) => command.source === 'voice')
    const refreshes = voiceCommands.filter((command) => command.refresh)
    expect(
      voiceCommands.every((command) => command.messageId === mentionId) && refreshes.length <= 1,
      `Voice commands must target the spotlight and refresh at most once: ${JSON.stringify(voiceCommands)}`
    )
    const lastLive = [...events.list]
      .reverse()
      .find(
        (entry) =>
          entry.event === 'comments.highlight.status' &&
          entry.at < cardEnd.at &&
          entry.payload.phase === 'live'
      )
    const cardEndAt = Math.min(
      cardEnd.at,
      Date.parse(lastLive?.payload.expiresAt ?? '') || cardEnd.at
    )
    const lastVoiceGeneration = Math.max(...voiceCommands.map((command) => command.generation))

    // --- Picks mode: nothing within 45 s of the previous card's end ---------
    const quietUntil = cardEndAt + AUTO_HIGHLIGHT_COOLDOWN_MS - COOLDOWN_TOLERANCE_MS
    phase(`picks: no card for ${AUTO_HIGHLIGHT_COOLDOWN_MS / 1000} s after the voice card left`)
    await sleep(Math.max(0, quietUntil - Date.now()))
    const early = distinctCommands(events).filter(
      (command) => command.generation > lastVoiceGeneration
    )
    expect(
      early.length === 0,
      `Picks mode fired within the 45 s cooldown: ${JSON.stringify(early)}`
    )
    phase('picks: the first pick after the cooldown')
    const pickState = await waitForEvent(
      events,
      'cohost.state',
      (state) =>
        state.sessionId === streamSessionId &&
        (state.autoHighlight?.generation ?? 0) > lastVoiceGeneration,
      'the first pick after the cooldown',
      Math.max(
        0,
        cardEndAt + AUTO_HIGHLIGHT_COOLDOWN_MS + PICK_AFTER_COOLDOWN_DEADLINE_MS - Date.now()
      )
    )
    const pick = pickState.autoHighlight
    const pickDelayMs = Date.now() - cardEndAt
    expect(
      pick.source === 'pick' &&
        ![flaggedId, mentionId, sameAuthorId].includes(pick.messageId) &&
        ids.includes(pick.messageId),
      `The pick must be a fresh, unflagged message by another author: ${JSON.stringify({ pick, flaggedId, mentionId, sameAuthorId })}`
    )

    // --- Whole-scenario safety invariants ---------------------------------------
    const sessionStates = events.list
      .filter((entry) => entry.event === 'cohost.state')
      .map((entry) => entry.payload)
      .filter((state) => state.sessionId === streamSessionId)
    expect(
      sessionStates.every(
        (state) =>
          state.autoHighlight?.messageId !== flaggedId &&
          state.spotlight?.messageId !== flaggedId &&
          !(state.highlights ?? []).some((highlight) => highlight.messageId === flaggedId)
      ),
      'A flagged message reached autoHighlight, spotlight or highlights.'
    )
    const sessionCalls = fake.state.spotlightRequests.filter(
      (record) => record.body?.sessionClientId === streamSessionId
    )
    for (const record of sessionCalls) {
      assertSpotlightRequestShape(record.body, { streamSessionId, flaggedId })
    }

    phase('stop')
    await stopSpotlightResources()
    console.log(
      `Spotlight fake smoke PASS - spotlight ${spotlightLatencyMs} ms after the final, ` +
        `${sessionCalls.length} valid spotlight request(s) without the flagged message, ` +
        `voice card live (${refreshes.length} refresh, left by expiry), question resolved on hit 2 ` +
        `and restored, 404 breaker held ${BREAKER_PROOF_MS / 1000} s, first pick ` +
        `${(pickDelayMs / 1000).toFixed(1)} s after the previous card left (cooldown 45 s), ` +
        `flagged suggestion never shown.`
    )
  } finally {
    await stopSpotlightResources().catch(() => {})
    admin.close()
    events.close()
  }

  async function stopSpotlightResources() {
    pump?.stop()
    pump = null
    executor?.stop()
    executor = null
    await request(backend, 5_000, 'captions.stop', {}).catch(() => {})
    await request(backend, 5_000, 'cohost.stop', {}).catch(() => {})
    await request(backend, 5_000, 'liveChat.stop', {}).catch(() => {})
    if (streamSessionId) {
      await request(backend, 5_000, 'comments.highlight.clear', {
        sessionId: streamSessionId
      }).catch(() => {})
    }
    if (sessionActive) {
      sessionActive = false
      await request(admin, timeoutMs, 'session.stop', {}).catch(() => {})
    }
    await stopRtmpListener(listener)
  }

  async function emitFinal(collection, text) {
    const emittedAt = Date.now()
    const reached = await captionFake.emitRealtimeFinal(text)
    expect(reached > 0, 'No realtime caption client was connected for a scripted final.')
    await waitForEvent(
      collection,
      'captions.update',
      (update) => update.kind === 'final' && update.text === text,
      `the caption final "${text}"`,
      5_000,
      emittedAt
    )
    return { emittedAt }
  }

  function lastSpotlightCallAt() {
    const calls = fake.state.spotlightRequests
    return calls.length > 0 ? calls[calls.length - 1].at : 0
  }

  function waitForSpotlightCall(predicate, label, deadlineMs = 10_000) {
    return waitUntil(() => fake.state.spotlightRequests.find(predicate), deadlineMs, label)
  }
}

function assertSpotlightRequestShape(body, { streamSessionId, flaggedId }) {
  const keys = Object.keys(body).sort()
  expect(
    JSON.stringify(keys) === JSON.stringify([...COHOST_SPOTLIGHT_REQUEST_KEYS]),
    `Spotlight request keys drifted from the contract: ${keys.join(',')}`
  )
  expect(
    body.consentToProcessChat === true &&
      body.sessionClientId === streamSessionId &&
      typeof body.clientVersion === 'string' &&
      body.clientVersion.startsWith('videorc-desktop/') &&
      Number.isInteger(body.seq) &&
      body.seq >= 1,
    `Spotlight request header fields are wrong: ${JSON.stringify({ ...body, candidates: body.candidates?.length })}`
  )
  expect(
    typeof body.transcript === 'string' &&
      body.transcript.length >= 1 &&
      body.transcript.length <= COHOST_SPOTLIGHT_TRANSCRIPT_MAX_CHARS,
    `Spotlight transcript must be 1-${COHOST_SPOTLIGHT_TRANSCRIPT_MAX_CHARS} chars: ${body.transcript?.length}`
  )
  expect(
    Array.isArray(body.candidates) &&
      body.candidates.length >= 1 &&
      body.candidates.length <= COHOST_SPOTLIGHT_CANDIDATES_CAP,
    `Spotlight candidates must be 1-${COHOST_SPOTLIGHT_CANDIDATES_CAP}: ${body.candidates?.length}`
  )
  expect(
    !body.candidates.some((candidate) => candidate.id === flaggedId),
    `A flagged message was sent as a spotlight candidate: ${flaggedId}`
  )
}

function streamSessionParams(outputDirectoryCapability) {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const serverUrl = `rtmp://127.0.0.1:${RTMP_PORT}/live`
  const target = {
    id: 'cohost-smoke-rtmp',
    platform: 'custom',
    label: 'Local co-host smoke',
    enabled: true,
    serverUrl,
    urlMode: 'server-and-key',
    streamKey: 'cohost-smoke',
    streamKeyPresent: true,
    authMode: 'manual-rtmp',
    outputPreset: 'stream-safe-1080p30',
    outputBitrateKbps: 6000,
    createdAt: timestamp,
    updatedAt: timestamp
  }
  return {
    sources: { testPattern: true },
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
      recordEnabled: false,
      streamEnabled: true,
      outputDirectoryCapability,
      video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
      rtmp: { preset: 'custom', serverUrl, streamKey: target.streamKey }
    },
    streaming: {
      enabled: true,
      mode: 'single',
      targets: [target],
      selectedTargetId: target.id,
      defaultOutputPreset: target.outputPreset,
      defaultBitrateKbps: target.outputBitrateKbps,
      enabledTargetIds: [target.id]
    },
    audio: { microphoneGainDb: 0, microphoneMuted: true, microphoneSyncOffsetMs: 0 }
  }
}

// Plays the renderer's executor (use-studio.tsx): every new autoHighlight
// generation becomes ONE comments.highlight.set (always-set: never a clear,
// never a toggle), and the engine alone decides what and when.
function startAutoHighlightExecutor(ws, sessionId) {
  const pngBase64 = captionStimulusPngBase64({ width: 600, height: 120 })
  const executions = []
  let executedGeneration = 0
  let stopped = false
  const onMessage = (event) => {
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (stopped || parsed.event !== 'cohost.state') return
    const command = parsed.payload?.autoHighlight
    if (parsed.payload?.sessionId !== sessionId || !command) return
    if (command.generation <= executedGeneration) return
    executedGeneration = command.generation
    const execution = { ...command, at: Date.now(), result: null, error: null }
    executions.push(execution)
    request(ws, timeoutMs, 'comments.highlight.set', {
      sessionId,
      messageId: command.messageId,
      pngBase64
    }).then(
      (result) => {
        execution.result = result
      },
      (error) => {
        execution.error = error.message
      }
    )
  }
  ws.addEventListener('message', onMessage)
  return {
    executions,
    stop() {
      stopped = true
      ws.removeEventListener('message', onMessage)
    }
  }
}

// Captions stall after 8 s without audio; the debug seam keeps the bus fed.
function startCaptionAudioPump(ws) {
  let stopped = false
  const tick = () => {
    if (stopped) return
    request(ws, 5_000, 'captions.test.inject-audio', { durationMs: 200 }).catch(() => {})
  }
  tick()
  const timer = setInterval(tick, CAPTION_AUDIO_PUMP_MS)
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    }
  }
}

function collectEvents(ws) {
  const collection = { list: [], waiters: [] }
  const onMessage = (event) => {
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    if (typeof parsed.event !== 'string') return
    const entry = { event: parsed.event, payload: parsed.payload, at: Date.now() }
    collection.list.push(entry)
    for (const waiter of [...collection.waiters]) waiter(entry)
  }
  ws.addEventListener('message', onMessage)
  collection.close = () => ws.removeEventListener('message', onMessage)
  return collection
}

function distinctCommands(collection) {
  const byGeneration = new Map()
  for (const entry of collection.list) {
    const command = entry.event === 'cohost.state' ? entry.payload?.autoHighlight : null
    if (command && !byGeneration.has(command.generation)) {
      byGeneration.set(command.generation, { ...command, at: entry.at })
    }
  }
  return [...byGeneration.values()]
}

// Resolves with the payload; `since` narrows to events at or after a time and
// then resolves with the whole entry ({ event, payload, at }).
function waitForEvent(collection, name, predicate, label, deadlineMs, since) {
  const matches = (entry) =>
    entry.event === name && (since === undefined || entry.at >= since) && predicate(entry.payload)
  const shape = (entry) => (since === undefined ? entry.payload : entry)
  const existing = collection.list.find(matches)
  if (existing) return Promise.resolve(shape(existing))
  return new Promise((resolveWait, rejectWait) => {
    const onEntry = (entry) => {
      if (!matches(entry)) return
      clearTimeout(timer)
      collection.waiters.splice(collection.waiters.indexOf(onEntry), 1)
      resolveWait(shape(entry))
    }
    const timer = setTimeout(() => {
      collection.waiters.splice(collection.waiters.indexOf(onEntry), 1)
      rejectWait(new Error(`Timed out after ${deadlineMs}ms waiting for ${label}.`))
    }, deadlineMs)
    collection.waiters.push(onEntry)
  })
}

async function waitUntil(probe, deadlineMs, label) {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() >= deadline)
      throw new Error(`Timed out after ${deadlineMs}ms waiting for ${label}.`)
    await sleep(100)
  }
}

function spawnRtmpListener(receivedPath) {
  const stderr = []
  const child = spawn(
    ffmpegPath,
    [
      '-y',
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      `rtmp://127.0.0.1:${RTMP_PORT}/live/cohost-smoke`,
      '-c',
      'copy',
      '-f',
      'flv',
      receivedPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text) => stderr.push(text))
  return { process: child, stderr }
}

async function stopRtmpListener(listener) {
  const child = listener?.process
  if (!child?.pid || child.exitCode !== null) return
  await waitForChildExit(child, 1_500)
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await waitForChildExit(child, 1_000)
  if (child.exitCode === null) child.kill('SIGKILL')
  await waitForChildExit(child, 1_000)
}

function waitForChildExit(child, timeout) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, timeout)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveWait()
    })
  })
}
