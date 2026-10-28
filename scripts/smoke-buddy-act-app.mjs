// Buddy uses the agent tools, end to end (plan 209 S21).
//
// Launches the REAL dev app with an isolated profile against local fakes:
// Buddy's planner and the AI capabilities with `buddy.act: 1`
// (scripts/lib/fake-cohost-service.mjs), the caption service for the spoken
// step (scripts/lib/fake-caption-service.mjs) and the desktop service flags.
// No production bearer, account or network, and it never goes live.
//
//   1. `/buddy switch to screen only and play the drum roll`, typed in the
//      Stream Manager: the planner request carries Buddy's subset of the
//      catalog and nothing else, the names (the scene, the "Drum roll" sound
//      this smoke imports) and no comments; the backend scene becomes
//      Screen only, the sound is pressed (`sounds.playback`), and Activity
//      shows both calls as Buddy's.
//   2. The planner answers tools outside Buddy's subset (`open_window`,
//      `notify`) and one that does not exist: each is refused before it
//      runs (the Notes window stays closed), the composer says so, and
//      Activity shows the refusals as Buddy's.
//   3. `/buddy move yourself to the top left` through `move_on_scene` (plan
//      209 S11b): Buddy's rect lands top left. SKIPPED with a message while
//      the catalog has no `move_on_scene` (the orchestrator re-runs it after
//      PR B merges).
//   4. By voice, while recording: "Buddy, stop the recording." The planner
//      answers `stop`; Buddy asks 'Stop the recording? Say "Buddy, yes".'
//      and the recording runs on through a bare "Yes." (review fix 17: a yes
//      to going live or stopping must name Buddy) until "Buddy, yes.", then
//      stops (D14).

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp, repoRoot } from './lib/app-launcher.mjs'
import { startFakeApiRouter } from './lib/fake-api-router.mjs'
import { startFakeCaptionService } from './lib/fake-caption-service.mjs'
import {
  AI_CAPABILITIES_PATH,
  BUDDY_ACT_PATH,
  startFakeCohostService
} from './lib/fake-cohost-service.mjs'
import { BackendEventRecorder } from './lib/record-latency-events.mjs'
import { syntheticCompositorReady } from './lib/remote-control-smoke-gates.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120_000)
const debug = process.env.VIDEORC_BUDDY_ACT_SMOKE_DEBUG === '1'
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-buddy-act-'))
)
const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-buddy-act-user-data-'))
const appDataDir = join(outputDirectory, 'app-data')
const fixturesDir = join(outputDirectory, 'fixtures')
const catalog = JSON.parse(
  readFileSync(join(repoRoot, 'protocol-fixtures', 'agent-tools.json'), 'utf8')
)
const BUDDY_TOOLS = catalog.tools.filter((tool) => tool.buddy).map((tool) => tool.name)
const smokeSessionToken = `buddy-act-smoke-${randomUUID()}`
const chatSessionId = `buddy-act-smoke-${Date.now()}`
const SOUND_NAME = 'Drum roll'
const STOP_QUESTION = 'Stop the recording? Say "Buddy, yes".'

function fail(message) {
  throw new Error(`buddy-act smoke FAIL: ${message}`)
}

function log(message) {
  console.log(`buddy-act smoke: ${message}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function waitUntil(label, probe, { timeout = timeoutMs, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = await probe()
    if (last?.done) return last.value
    if (Date.now() > deadline) {
      fail(`timed out waiting for ${label}; last: ${JSON.stringify(last?.value ?? last)}`)
    }
    await sleep(everyMs)
  }
}

async function startServiceFlagsServer() {
  const server = createServer((req, res) => {
    req.resume()
    const body = JSON.stringify({ orcle: { voiceCommands: true, remove: true } })
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    })
    res.end(body)
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  return {
    httpOrigin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose()))
  }
}

/** A short tone named for the sound the sentence asks for. */
function drumRollFixture() {
  const path = join(fixturesDir, `${SOUND_NAME}.wav`)
  const made = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.6',
      '-ar',
      '48000',
      '-ac',
      '2',
      path
    ],
    { encoding: 'utf8' }
  )
  if (made.status !== 0 || !existsSync(path)) fail(`could not make the fixture: ${made.stderr}`)
  return path
}

mkdirSync(appDataDir, { recursive: true })
mkdirSync(fixturesDir, { recursive: true })
// A signed-in smoke account: the capability read, the planner and captions
// all take this bearer, and only the local fakes ever see it.
const secretsPath = join(appDataDir, 'videorc-secrets.json')
writeFileSync(
  secretsPath,
  JSON.stringify({ 'account:videorc:session': smokeSessionToken }, null, 2)
)
chmodSync(secretsPath, 0o600)

const fakeCohost = await startFakeCohostService({ smokeSessionToken, buddyAct: true })
const captionFake = await startFakeCaptionService({
  smokeSessionToken,
  smokeRealtimeToken: `buddy-act-realtime-${randomUUID()}`,
  autoTranscript: false
})
const serviceFlags = await startServiceFlagsServer()
const router = await startFakeApiRouter({
  routes: [
    { prefix: BUDDY_ACT_PATH, origin: fakeCohost.httpOrigin },
    { prefix: AI_CAPABILITIES_PATH, origin: fakeCohost.httpOrigin },
    { prefix: '/api/ai/captions/', origin: captionFake.httpOrigin },
    { prefix: '/api/desktop/service-flags', origin: serviceFlags.httpOrigin }
  ],
  fallback: fakeCohost.httpOrigin
})

let stopApp = async () => {}
let passed = false
const results = []
try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_API_BASE_URL: router.httpOrigin,
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_ENABLE_SMOKE_RPC: '1',
      VIDEORC_COMMENTS_WINDOW: '1',
      // Debug-only caption seams for the spoken step (never in release).
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_CAPTION_CONTRACT_ALLOW_IDLE: '1',
      // The dev app has no microphone grant (smoke:record-latency).
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
  const events = new BackendEventRecorder(renderer, { timeoutMs })
  const command = (name, params = {}) => requestSmokeCommand(smoke, name, params, { timeoutMs })

  const health = await request(renderer, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) fail(health?.ffmpeg?.message ?? 'FFmpeg is unavailable')

  // Record-only, the synthetic source, Cloud AI consent: one reload.
  await command('eval-js', {
    code: `
      const key = 'videorc.captureConfig';
      let current = {};
      try { current = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch {}
      localStorage.setItem(key, JSON.stringify({ ...current, video: params.video, recordEnabled: true, streamEnabled: false }));
      localStorage.setItem('videorc.aiConsent', '1');
      setTimeout(() => location.reload(), 50);
      return true;
    `,
    video: { preset: 'tutorial-1080p30', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 }
  })
  await sleep(2500)
  const compositorBefore = await request(renderer, timeoutMs, 'compositor.status')
  await command('enable-synthetic-source', { settleMs: 500 })
  await waitUntil('the synthetic source on the compositor', async () => {
    const compositor = await request(renderer, timeoutMs, 'compositor.status')
    return { done: syntheticCompositorReady(compositor, compositorBefore), value: compositor }
  })
  await waitUntil('the capability read with buddy.act', async () => ({
    done: fakeCohost.state.capabilityRequests > 0,
    value: fakeCohost.state.capabilityRequests
  }))
  const capability = (
    await command('authorize-smoke-resource', { path: drumRollFixture(), kind: 'input-file' })
  ).capabilityId
  const sound = await request(renderer, timeoutMs, 'sounds.import', {
    sourceCapability: capability
  })
  if (sound?.name !== SOUND_NAME) fail(`the fixture sound is named ${JSON.stringify(sound?.name)}`)
  await command('comments-window-open')
  await waitUntil('the Stream Manager composer', async () => {
    const view = await command('comments-window-reader-state')
    return { done: view?.composerCount === 1, value: view }
  })
  log(`dev app up: synthetic source, "${SOUND_NAME}" imported, Stream Manager open`)

  async function typeBuddy(sentence) {
    const typed = await command('comments-window-submit-message', { text: `/buddy ${sentence}` })
    if (!typed?.submitted) fail(`the composer did not take /buddy: ${JSON.stringify(typed)}`)
  }

  async function nextPlannerRequest(after, label) {
    return waitUntil(`the planner request for ${label}`, async () => ({
      done: fakeCohost.state.actRequests.length > after,
      value: fakeCohost.state.actRequests[after]
    }))
  }

  async function composerSays(text, label) {
    return waitUntil(`the composer saying ${label}`, async () => {
      const view = await command('comments-window-reader-state')
      return { done: String(view?.text ?? '').includes(text), value: view?.text?.slice(-400) }
    })
  }

  async function buddyActivity(since) {
    const page = await request(renderer, timeoutMs, 'agents.activity.list', { limit: 100 })
    return (page?.entries ?? []).filter(
      (entry) => entry.agentId === 'buddy' && Date.parse(entry.at) >= since
    )
  }

  // 1. Typed: a scene and a sound, by name.
  {
    const since = Date.now()
    const before = fakeCohost.state.actRequests.length
    const sentence = 'switch to screen only and play the drum roll'
    const pressed = events.createWait(
      'the drum roll press',
      (event) =>
        event.event === 'sounds.playback' &&
        event.payload?.voices?.some((voice) => voice.soundId === sound.id)
    )
    await typeBuddy(sentence)
    const record = await nextPlannerRequest(before, sentence)
    const body = record.body
    const sentTools = body.tools.map((tool) => tool.name)
    if (JSON.stringify(sentTools) !== JSON.stringify(BUDDY_TOOLS)) {
      fail(`the planner got tools outside Buddy's subset: ${JSON.stringify(sentTools)}`)
    }
    if (body.comments !== undefined) fail('a sentence about no comment carried comments')
    if (!body.names.sounds.includes(SOUND_NAME)) {
      fail(`the planner names have no "${SOUND_NAME}": ${JSON.stringify(body.names)}`)
    }
    if (!body.names.scenes.some((name) => /screen only/i.test(name))) {
      fail(`the planner names have no Screen only scene: ${JSON.stringify(body.names.scenes)}`)
    }
    if (body.sentence !== sentence || body.consentToProcessChat !== true) {
      fail(`the planner request: ${JSON.stringify({ sentence: body.sentence })}`)
    }
    if (record.answer?.calls?.length !== 2) {
      fail(`the fake planner did not plan two calls: ${JSON.stringify(record.answer)}`)
    }
    await pressed.promise
    await waitUntil('the backend scene to be Screen only', async () => {
      const scene = await request(renderer, timeoutMs, 'scene.get')
      const camera = scene?.sources?.some(
        (source) => source.kind === 'camera' && source.visible !== false
      )
      return { done: !camera, value: scene?.sources }
    })
    await composerSays('Switched to', 'what Buddy did')
    const rows = await waitUntil('both calls in Activity as Buddy', async () => {
      const rows = await buddyActivity(since)
      return {
        done: ['switch_scene', 'play_sound'].every((tool) =>
          rows.some((row) => row.tool === tool && row.outcome === 'ok')
        ),
        value: rows
      }
    })
    if (rows.some((row) => row.agentName !== 'Buddy')) fail('an Activity row was not Buddy')
    results.push('1 typed: switch_scene + play_sound by name, Buddy in Activity')
    log('step 1: /buddy switched the scene and pressed the drum roll')
  }

  // 2. Outside Buddy's subset: refused before anything runs.
  {
    const since = Date.now()
    const before = fakeCohost.state.actRequests.length
    fakeCohost.queueActAnswer({
      answer: {
        calls: [
          { tool: 'open_window', args: { window: 'notes' } },
          { tool: 'notify', args: { message: 'Buddy was here' } },
          { tool: 'delete_everything', args: {} }
        ],
        line: 'Opening your notes.'
      }
    })
    await typeBuddy('open my notes and tell me something')
    await nextPlannerRequest(before, 'the refusal step')
    await composerSays("Buddy can't use open_window.", 'the refusal')
    const notes = await command('notes-window-state')
    if (notes?.open) fail("the Notes window opened: a tool outside Buddy's subset ran")
    const refused = await waitUntil('three refusals in Activity as Buddy', async () => {
      const rows = await buddyActivity(since)
      return {
        done:
          ['open_window', 'notify', 'delete_everything'].every((tool) =>
            rows.some((row) => row.tool === tool && row.outcome === 'refused')
          ) && !rows.some((row) => row.outcome === 'ok'),
        value: rows
      }
    })
    results.push(`2 refused: ${refused.map((row) => row.tool).join(', ')} never ran`)
    log("step 2: a planned tool outside Buddy's subset was refused")
  }

  // 3. `move_on_scene` (plan 209 S11b), guarded.
  {
    const move = catalog.tools.find((tool) => tool.name === 'move_on_scene')
    const properties = Object.keys(move?.inputSchema?.properties ?? {})
    if (!move) {
      results.push('3 SKIPPED: the catalog has no move_on_scene yet (plan 209 S11b, PR B)')
      log('step 3: SKIPPED, the catalog has no move_on_scene yet; re-run after PR B merges')
    } else if (!move.buddy || !properties.includes('item') || !properties.includes('place')) {
      fail(
        `move_on_scene changed shape (buddy ${move.buddy}, properties ${properties.join(', ')}); update step 3`
      )
    } else {
      const before = fakeCohost.state.actRequests.length
      fakeCohost.queueActAnswer({
        answer: {
          calls: [{ tool: 'move_on_scene', args: { item: 'buddy', place: 'top-left' } }],
          line: 'Moving to the top left.'
        }
      })
      await typeBuddy('move yourself to the top left')
      await nextPlannerRequest(before, 'move yourself to the top left')
      const rect = await waitUntil("Buddy's rect at the top left", async () => {
        const layout = await request(renderer, timeoutMs, 'overlays.layout.get')
        const horizontal = layout?.buddy?.horizontal
        return {
          done: Boolean(horizontal) && horizontal.x <= 0.1 && horizontal.y <= 0.15,
          value: horizontal
        }
      })
      results.push(`3 move_on_scene: Buddy at ${JSON.stringify(rect)}`)
      log('step 3: /buddy moved Buddy to the top left')
    }
  }

  // 4. By voice while recording: `stop` waits for a spoken yes (D14).
  {
    const recording = events.createWait(
      'recording.status(recording)',
      (event) =>
        event.event === 'recording.status' &&
        event.payload?.state === 'recording' &&
        typeof event.payload?.sessionId === 'string'
    )
    fakeCohost.queueActAnswer({
      answer: { calls: [{ tool: 'start_recording', args: {} }], line: 'Recording.' }
    })
    await typeBuddy('start recording')
    const captureSessionId = (await recording.promise).payload.sessionId
    log(`step 4: recording ${captureSessionId}, started by /buddy (typed: no spoken yes)`)

    // Buddy listens: a fake chat session, captions, Buddy with consent.
    await request(renderer, timeoutMs, 'cohost.settings.set', {
      enabled: true,
      listen: true,
      wakeWordRequired: false
    })
    await request(renderer, timeoutMs, 'liveChat.start', {
      sessionId: chatSessionId,
      destinations: [{ platform: 'twitch', targetId: 'buddy-act', read: 'ready', write: 'ready' }],
      fakes: [
        {
          platform: 'twitch',
          targetId: 'buddy-act',
          count: 2,
          intervalMs: 250,
          send: 'sent',
          authors: ['ana_dev']
        }
      ]
    })
    await request(renderer, timeoutMs, 'captions.start', { language: 'en' })
    const started = await request(renderer, timeoutMs, 'cohost.start', {
      sessionId: chatSessionId,
      consentToProcessChat: true,
      streamTitle: 'Buddy act smoke'
    })
    if (started?.status !== 'listening') fail(`cohost.start: ${JSON.stringify(started)}`)
    // Audio for the caption session, through main's debug bridge.
    let pumping = true
    const pump = (async () => {
      captionFake.state.realtimePartialProgress = true
      while (pumping) {
        await command('backend-debug-rpc', {
          method: 'audio.test.inject-pcm',
          params: { sessionId: captureSessionId, durationMs: 200, rawPeak: 0.12 },
          timeoutMs: 5_000
        }).catch(() => undefined)
        await sleep(1_000)
      }
    })()
    try {
      const say = async (text) => {
        const reached = await waitUntil(`a caption client to hear "${text}"`, async () => {
          const count = await captionFake.emitRealtimeFinal(text)
          return { done: count > 0, value: count }
        })
        if (!reached) fail(`no caption client heard "${text}"`)
      }
      const before = fakeCohost.state.actRequests.length
      fakeCohost.queueActAnswer({
        answer: { calls: [{ tool: 'stop', args: {} }], line: 'Stopping the recording.' }
      })
      const asked = events.createWait(
        'the D14 card',
        (event) =>
          event.event === 'cohost.state' &&
          event.payload?.command?.kind === 'act' &&
          event.payload.command.status === 'confirm' &&
          String(event.payload.command.message).includes(STOP_QUESTION),
        30_000
      )
      await say('Buddy, stop the recording.')
      const record = await nextPlannerRequest(before, 'the spoken stop')
      if (record.body.state?.activity !== 'recording') {
        fail(`the planner state while recording: ${JSON.stringify(record.body.state)}`)
      }
      const card = (await asked.promise).payload.command
      // Nothing stops before the yes.
      await sleep(3_000)
      const status = await request(renderer, timeoutMs, 'recording.status')
      if (status?.state !== 'recording' || status?.sessionId !== captureSessionId) {
        fail(`the recording stopped before a spoken yes: ${JSON.stringify(status)}`)
      }
      const stopped = events.createWait(
        'the recording to stop after the yes',
        (event) =>
          event.event === 'recording.status' &&
          event.payload?.sessionId === captureSessionId &&
          ['idle', 'stopping'].includes(event.payload?.state),
        60_000
      )
      // The card never stays open asking: it finishes in place, or, when the
      // stop ends the session Buddy runs with (here: the recording), Buddy
      // stops and the card goes with it.
      const finished = events.createWait(
        'the card finishing or leaving with Buddy after the yes',
        (event) =>
          event.event === 'cohost.state' &&
          ((event.payload?.command?.id === card.id &&
            event.payload.command.status !== 'confirm') ||
            (event.payload?.status === 'off' && event.payload?.command?.id !== card.id)),
        60_000
      )
      // Review fix 17: a bare yes (a text-to-speech alert could say it)
      // leaves the question open and the recording running.
      await say('Yes.')
      await sleep(3_000)
      const afterBareYes = await request(renderer, timeoutMs, 'recording.status')
      if (afterBareYes?.state !== 'recording' || afterBareYes?.sessionId !== captureSessionId) {
        fail(`a bare "Yes." stopped the recording: ${JSON.stringify(afterBareYes)}`)
      }
      await say('Buddy, yes.')
      await stopped.promise
      const answered = (await finished.promise).payload
      const ending =
        answered.command?.id === card.id
          ? answered.command.message
          : 'the stop ended the session, Buddy stopped and the card went with it'
      results.push(
        `4 voice: "${STOP_QUESTION}" held the recording through "Yes." until "Buddy, yes." (${ending})`
      )
      log('step 4: a spoken stop waited for a spoken yes')
    } finally {
      pumping = false
      await pump
    }
  }

  passed = true
} finally {
  await stopApp().catch(() => undefined)
  await router.close().catch(() => undefined)
  await serviceFlags.close().catch(() => undefined)
  await captionFake.close().catch(() => undefined)
  await fakeCohost.close().catch(() => undefined)
}

if (passed) {
  console.log(
    `buddy-act smoke PASS\n${results.map((line) => `  ${line}`).join('\n')}\n  output: ${outputDirectory}`
  )
}
