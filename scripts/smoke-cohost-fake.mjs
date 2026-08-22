import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devAppSpawnOptions, repoRoot, stopProcess } from './lib/app-launcher.mjs'
import {
  COHOST_TICK_MESSAGE_CAP,
  COHOST_TICK_MESSAGE_KEYS,
  COHOST_TICK_REQUEST_KEYS,
  startFakeCohostService
} from './lib/fake-cohost-service.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Live Co-host offline smoke. Launches the real debug backend against an
// isolated profile and a local fake videorc-web (`POST /api/ai/cohost/tick`),
// drives the fake live-chat connector as scripted "lanes", and proves the
// engine end to end without the cloud:
//
//   settings gate -> start requires the active chat session -> first tick has
//   the exact wire shape -> repeated text groups into ONE question whose
//   askers/messageIds grow across ticks -> marker message is flagged ->
//   429 quota pauses and resumes after Retry-After -> 403 pauses
//   premium-required -> 503 errors server-unconfigured with an escalating
//   backoff -> dismiss removes a question for good -> a single trickle message
//   ticks by the 20 s rule -> liveChat.send with inReplyToQuestionId marks the
//   question answered -> idle chat sends NO tick for 30 s -> stop.
//
// No production bearer, real account, or external network is involved. The
// API base override is honored by debug backends only.

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
        VIDEORC_API_BASE_URL: fake.httpOrigin,
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
  const again = await request(backend, timeoutMs, 'cohost.start', {
    sessionId,
    consentToProcessChat: true
  })
  expect(
    again.status === 'listening' && again.tickSeq === 0,
    'Repeated cohost.start was not a no-op.'
  )

  // --- Tick 1: burst, exact wire shape, grouped question, flag ---------------
  phase('tick 1: burst (>= 5 new messages)')
  const s1 = await waitForTick(observed, 1)
  expect(
    s1.status === 'listening' && s1.reason === null,
    `Tick 1 should leave the engine listening: ${JSON.stringify(s1)}`
  )
  expect(
    typeof s1.lastTickAt === 'string' && s1.partial === false && typeof s1.mood === 'string',
    `Tick 1 state lacks lastTickAt/partial/mood: ${JSON.stringify(s1)}`
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
      `wire shape, 5-asker grouping across ${contributingTicks.size} ticks, flag, ` +
      `429/403/503 status+reason mapping with Retry-After and backoff honored, dismiss, ` +
      `20 s trickle rule, reply-answered, and ${IDLE_PROOF_MS / 1000} s idle without a tick.`
  )
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
  const keys = Object.keys(body).sort()
  expect(
    JSON.stringify(keys) === JSON.stringify([...COHOST_TICK_REQUEST_KEYS]),
    `Tick request keys drifted from the contract: ${keys.join(',')}`
  )
  expect(
    body.promptVersion === 1 &&
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
    } else if (parsed.event === 'backend.log' && /co-host/i.test(parsed.payload?.message ?? '')) {
      console.log(`[backend] ${parsed.payload.level}: ${parsed.payload.message}`)
    }
  })
  return collection
}

function waitForTick(observed, tickSeq) {
  return waitForState(
    observed,
    (state) => state.tickSeq === tickSeq,
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
