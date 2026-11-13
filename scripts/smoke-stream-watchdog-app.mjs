// The stream watchdog smoke (plan 223 A8, B3): the dev app goes live to two
// local RTMP sinks with the synthetic tone microphone and dev thresholds,
// and every check that can be driven locally is driven, each asserted on
// the `watchdog.alerts` event and the `watchdog-*` health events:
//
//   1. mute → `mic-muted` opens within the threshold + 1 s, with
//      `program-silent` folded into it (one alert); unmute → cleared;
//   2. a mid-grey takeover → no `mic-muted` (the guard), `program-silent`
//      as a notice while the mic stays muted behind it;
//   3. a stall of the stream's output (the VideoToolbox FIFO pause seam,
//      macOS only; SKIP elsewhere) → `picture-stopped` opens, then clears;
//   4. one sink's socket closed → `destination-down` for that leg only, the
//      other stays live; the sink back → cleared; both closed → the all-down
//      critical fold;
//   5. a black takeover → `picture-black` (A7 shipped the desktop check);
//   6. acknowledge stops the repeat: no second `lastRepeatAt` inside the dev
//      repeat window;
//   7. a leak scan over every event: no stream URL, no key;
//   8. (B3) two fake chatters say "no sound??" and "sin audio" → `chat-says`
//      (audio) with both quotes; one chatter asking "can you hear me?" three
//      times → nothing; the streamer's own "no sound today, sorry" →
//      nothing.
//
// Then Stop within the record-latency gate's budget. Nothing goes live
// anywhere: the sinks are `ffmpeg -listen 1` on loopback.
//
//   pnpm smoke:stream-watchdog

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  connectBackend,
  request,
  startSessionWhenScreenSettles
} from './smoke-recording-session.mjs'

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-watchdog-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-watchdog-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 240000)
const basePort = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 14935)
const warmMs = Number(process.env.VIDEORC_SMOKE_WARM_MS ?? 12000)
const listenerBindMs = Number(process.env.VIDEORC_SMOKE_LISTENER_BIND_MS ?? 2500)
const stopBudgetMs = Number(process.env.VIDEORC_SMOKE_STOP_BUDGET_MS ?? 15000)
// VIDEORC_WATCHDOG_SHOTS_DIR=<dir>: the Studio with a mic-muted card, dark
// and light (the by-eye check, A5), through the dev app's DevTools port.
const shotsDir = process.env.VIDEORC_WATCHDOG_SHOTS_DIR
  ? resolve(process.env.VIDEORC_WATCHDOG_SHOTS_DIR)
  : null
const appLines = []

// Dev thresholds (D4): seconds in the plan become a few seconds here.
const MIC_MUTED_AFTER_MS = 3000
const PROGRAM_SILENT_AFTER_MS = 3000
const PICTURE_STOPPED_AFTER_MS = 3000
const PICTURE_BLACK_AFTER_MS = 3000
const DESTINATION_DOWN_AFTER_MS = 5000
const REPEAT_WINDOW_MS = 6000
const PAUSE_MS = Number(process.env.VIDEORC_SMOKE_STALL_PAUSE_MS ?? 4500)
const PAUSE_AFTER_FRAMES = 900

const targets = [
  { id: 'youtube', label: 'YouTube' },
  { id: 'twitch', label: 'Twitch' }
].map((platform, index) => {
  const listenPort = basePort + index
  const streamKey = `watchdog${index}SECRET`
  return {
    ...platform,
    listenPort,
    streamKey,
    serverUrl: `rtmp://127.0.0.1:${listenPort}/live`,
    listenUrl: `rtmp://127.0.0.1:${listenPort}/live/${streamKey}`,
    recvPath: join(outputDirectory, `recv-${listenPort}.flv`)
  }
})

mkdirSync(outputDirectory, { recursive: true })

let stopping = false
let stopApp = async () => {}
const listeners = new Map()
const healthEvents = []
const alertViews = []
const everyEvent = []
const failures = []
const skips = []
const report = { scenarios: {} }

function pass(name, detail) {
  report.scenarios[name] = { pass: true, detail }
  console.log(`  ✓ ${name}${detail ? `: ${detail}` : ''}`)
}
function fail(name, detail) {
  report.scenarios[name] = { pass: false, detail }
  failures.push(`${name}: ${detail}`)
  console.log(`  ✗ ${name}: ${detail}`)
}
function skip(name, detail) {
  report.scenarios[name] = { skip: true, detail }
  skips.push(`${name}: ${detail}`)
  console.log(`  • ${name} SKIPPED: ${detail}`)
}

try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      // The synthetic 440 Hz microphone (as smoke:output-stall).
      VIDEORC_CAPTION_CONTRACT_TEST: '1',
      VIDEORC_LIVE_SOURCE_SWITCH_TEST: '1',
      // One stall of the recording video writer, after the warm-up frames.
      VIDEORC_TEST_VT_FIFO_PAUSE_AFTER_FRAMES: String(PAUSE_AFTER_FRAMES),
      VIDEORC_TEST_VT_FIFO_PAUSE_MS: String(PAUSE_MS),
      VIDEORC_TEST_VT_FIFO_PAUSE_REPEAT: '1',
      VIDEORC_WATCHDOG_MIC_MUTED_AFTER_MS: String(MIC_MUTED_AFTER_MS),
      VIDEORC_WATCHDOG_PROGRAM_SILENT_AFTER_MS: String(PROGRAM_SILENT_AFTER_MS),
      VIDEORC_WATCHDOG_PICTURE_STOPPED_AFTER_MS: String(PICTURE_STOPPED_AFTER_MS),
      VIDEORC_WATCHDOG_PICTURE_BLACK_AFTER_MS: String(PICTURE_BLACK_AFTER_MS),
      VIDEORC_WATCHDOG_DESTINATION_DOWN_AFTER_MS: String(DESTINATION_DOWN_AFTER_MS),
      ...(shotsDir ? { VIDEORC_REMOTE_DEBUG_PORT: '0' } : {})
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      appLines.push(line)
      console.log(line)
    }
  })
  stopApp = launch.stop
  const connection = launch.connections['backend-ready']
  const smoke = launch.connections['preview-motion-ready']

  const ws = await connectBackend(connection, timeoutMs)
  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (!message?.event) return
    everyEvent.push(event.data)
    if (message.event === 'health.event' && message.payload?.code) {
      healthEvents.push({ ...message.payload, atMs: Date.now() })
      if (String(message.payload.code).startsWith('watchdog-')) {
        console.log(`  [health] ${message.payload.code}: ${message.payload.message}`)
      }
    }
    if (message.event === 'watchdog.alerts' && Array.isArray(message.payload?.alerts)) {
      alertViews.push({ atMs: Date.now(), alerts: message.payload.alerts })
    }
  })

  try {
    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the watchdog smoke.')
    }
    for (const target of targets) {
      listeners.set(target.id, spawnListener(target))
    }
    await sleep(listenerBindMs)

    // The settings round trip (A6): the defaults, then a patch, then back.
    const defaults = await request(ws, timeoutMs, 'watchdog.settings.get')
    if (defaults.micMutedAfterSeconds !== 30 || !defaults.checks['mic-muted']?.enabled) {
      fail('settings', `unexpected defaults ${JSON.stringify(defaults)}`)
    } else {
      const patched = await request(ws, timeoutMs, 'watchdog.settings.set', {
        checks: { 'still-there': { enabled: false } },
        micMutedAfterSeconds: 60
      })
      const restored = await request(ws, timeoutMs, 'watchdog.settings.set', {
        checks: { 'still-there': { enabled: true } },
        micMutedAfterSeconds: 30
      })
      if (patched.micMutedAfterSeconds === 60 && !patched.checks['still-there'].enabled &&
          restored.micMutedAfterSeconds === 30) {
        pass('settings', 'watchdog.settings.set round-trips')
      } else {
        fail('settings', `patch did not round-trip: ${JSON.stringify(patched)}`)
      }
    }

    const started = await startSessionWhenScreenSettles(ws, timeoutMs, async () => {
      const directory = await requestSmokeCommand(
        smoke,
        'authorize-smoke-resource',
        { kind: 'output-directory', path: outputDirectory },
        { timeoutMs }
      )
      return sessionParams(directory.capabilityId)
    })
    if (started.state !== 'recording') {
      throw new Error(`Expected recording state after start, got ${started.state}.`)
    }
    const sessionId = started.sessionId
    console.log(`Session ${sessionId} up; streaming ${warmMs} ms before the scenarios.`)
    await sleep(warmMs)
    await assertSessionRunning(ws, 'before the scenarios')
    if (openAlerts().length > 0) {
      fail('quiet start', `alerts open before any scenario: ${alertNames()}`)
    } else {
      pass('quiet start', 'no alert while the stream is healthy')
    }

    // 1. Mute → mic-muted (critical) with program-silent folded in; unmute → cleared.
    {
      const mutedAt = Date.now()
      await setMuted(ws, sessionId, true)
      const opened = await waitFor(
        () => openAlerts().find((alert) => alert.check === 'mic-muted'),
        MIC_MUTED_AFTER_MS + 2500
      )
      const sinceMute = Date.now() - mutedAt
      if (!opened) {
        fail('mic-muted', `no alert within ${MIC_MUTED_AFTER_MS + 2500} ms (${alertNames()})`)
      } else if (opened.severity !== 'critical') {
        fail('mic-muted', `severity ${opened.severity}, expected critical`)
      } else if (openAlerts().some((alert) => alert.check === 'program-silent')) {
        fail('mic-muted', 'program-silent opened beside the mic card instead of folding into it')
      } else if (!/Nothing else is playing\./.test(opened.detail)) {
        // The fold lands once the silence clock passes its own threshold.
        const folded = await waitFor(
          () => openAlerts().find((alert) => alert.check === 'mic-muted' && /Nothing else is playing\./.test(alert.detail)),
          PROGRAM_SILENT_AFTER_MS + 2500
        )
        if (folded) pass('mic-muted', `opened ${sinceMute} ms after the mute; the silence folded into it`)
        else fail('mic-muted', `the detail never folded the silence in: ${opened.detail}`)
      } else {
        pass('mic-muted', `opened ${sinceMute} ms after the mute, silence folded in`)
      }
      if (!healthEvents.some((event) => event.code === 'watchdog-mic-muted' && event.level === 'error')) {
        fail('mic-muted health event', `no watchdog-mic-muted error event (${healthCodes()})`)
      } else {
        pass('mic-muted health event', 'watchdog-mic-muted persisted as error')
      }
      // 6. Acknowledge: no repeat inside the dev repeat window.
      const alertId = opened?.id
      if (alertId) {
        const acknowledged0 = await request(ws, timeoutMs, 'watchdog.alert.acknowledge', {
          id: alertId
        }).catch((error) => ({ error: String(error?.message ?? error) }))
        if (acknowledged0?.error) fail('acknowledge', `refused: ${acknowledged0.error}`)
        await sleep(REPEAT_WINDOW_MS)
        const repeated = alertViews.some((view) =>
          view.alerts.some((alert) => alert.id === alertId && alert.lastRepeatAt)
        )
        const acknowledged = openAlerts().find((alert) => alert.id === alertId)?.state
        if (repeated) fail('acknowledge', 'the alert repeated after Got it')
        else if (acknowledged !== 'acknowledged') fail('acknowledge', `state ${acknowledged}, expected acknowledged`)
        else pass('acknowledge', 'no repeat after Got it; the card stays')
      }
      await setMuted(ws, sessionId, false)
      const cleared = await waitFor(
        () => !openAlerts().some((alert) => alert.check === 'mic-muted') &&
          healthEvents.some((event) => event.code === 'watchdog-mic-muted-cleared'),
        4000
      )
      if (cleared) pass('mic-muted cleared', 'unmute cleared the alert within a tick')
      else fail('mic-muted cleared', `still open after the unmute: ${alertNames()}`)
    }

    // 2. A mid-grey takeover: no mic-muted behind it, program-silent as a notice.
    {
      const greyPath = join(outputDirectory, 'takeover-grey.png')
      makePng(greyPath, 'gray')
      const imported = await importTakeover(ws, smoke, greyPath)
      const screenId = imported?.screen?.id ?? imported?.id
      if (!screenId) {
        fail('takeover guard', `could not import the takeover: ${JSON.stringify(imported)}`)
      } else {
        await request(ws, timeoutMs, 'screens.activate', { screenId })
        await setMuted(ws, sessionId, true)
        const notice = await waitFor(
          () => openAlerts().find((alert) => alert.check === 'program-silent'),
          PROGRAM_SILENT_AFTER_MS + 3500
        )
        const micBehind = openAlerts().some((alert) => alert.check === 'mic-muted')
        if (micBehind) fail('takeover guard', 'mic-muted opened behind a takeover')
        else if (!notice) fail('takeover guard', `program-silent never opened behind the takeover (${alertNames()})`)
        else if (notice.severity !== 'notice') fail('takeover guard', `program-silent severity ${notice.severity}, expected notice`)
        else if (!/Be right back has been silent/.test(notice.detail)) fail('takeover guard', `unexpected detail: ${notice.detail}`)
        else pass('takeover guard', 'no mic-muted behind the takeover; the silence is a notice')
        await setMuted(ws, sessionId, false)
        await request(ws, timeoutMs, 'screens.clear', {})
        await waitFor(() => !openAlerts().some((alert) => alert.check === 'program-silent'), 4000)
      }
    }

    // 5. A black takeover → picture-black (A7 shipped the desktop check).
    {
      const blackPath = join(outputDirectory, 'takeover-black.png')
      makePng(blackPath, 'black')
      const imported = await importTakeover(ws, smoke, blackPath)
      const screenId = imported?.screen?.id ?? imported?.id
      if (!screenId) {
        fail('picture-black', `could not import the black takeover: ${JSON.stringify(imported)}`)
      } else {
        await request(ws, timeoutMs, 'screens.activate', { screenId })
        const black = await waitFor(
          () => openAlerts().find((alert) => alert.check === 'picture-black'),
          PICTURE_BLACK_AFTER_MS + 6000
        )
        if (!black) fail('picture-black', `never opened on a black takeover (${alertNames()})`)
        else if (black.fixes?.[0]?.kind !== 'end-takeover') fail('picture-black', `fix ${black.fixes?.[0]?.kind}, expected end-takeover`)
        else pass('picture-black', `opened with End takeover; detail "${black.detail}"`)
        await request(ws, timeoutMs, 'screens.clear', {})
        const cleared = await waitFor(
          () => !openAlerts().some((alert) => alert.check === 'picture-black'),
          6000
        )
        if (cleared) pass('picture-black cleared', 'the picture came back')
        else fail('picture-black cleared', 'still open after the takeover ended')
      }
    }

    // 3. The stall: the FIFO pause fires once PAUSE_AFTER_FRAMES frames in,
    //    which may land during an earlier scenario, so the health events
    //    (persisted, D13) are the evidence: opened, then cleared.
    if (process.platform !== 'darwin') {
      skip('picture-stopped', 'the VideoToolbox FIFO pause seam is macOS only')
    } else {
      const stalled = await waitFor(
        () => healthEvents.find((event) => event.code === 'watchdog-picture-stopped'),
        45000
      )
      if (!stalled) {
        const stallSeen = healthEvents.some((event) => event.code === 'stream-output-stalled')
        fail(
          'picture-stopped',
          stallSeen
            ? `stream-output-stalled fired but no alert opened (${alertNames()})`
            : `the FIFO pause never stalled the output (frames ${PAUSE_AFTER_FRAMES}, pause ${PAUSE_MS} ms)`
        )
      } else {
        const cleared = await waitFor(
          () => healthEvents.find((event) => event.code === 'watchdog-picture-stopped-cleared'),
          15000
        )
        if (cleared) pass('picture-stopped', `opened on the stall ("${stalled.message}"), then cleared`)
        else fail('picture-stopped', 'opened but never cleared after the pause')
      }
      await assertSessionRunning(ws, 'after the stall')
    }

    // 4. One sink closes → that leg only; back → cleared; both → the fold.
    {
      const [victim, other] = targets
      await stopListener(listeners.get(victim.id), 'SIGKILL')
      listeners.delete(victim.id)
      const down = await waitFor(
        () => openAlerts().find((alert) => alert.check === 'destination-down' && alert.targetId === victim.id),
        DESTINATION_DOWN_AFTER_MS + 12000
      )
      const otherDown = openAlerts().some((alert) => alert.check === 'destination-down' && alert.targetId === other.id)
      if (!down) fail('destination-down', `no alert for ${victim.label} (${alertNames()})`)
      else if (down.severity !== 'warning') fail('destination-down', `severity ${down.severity}, expected warning`)
      else if (otherDown) fail('destination-down', `${other.label} was flagged too`)
      else pass('destination-down', `${victim.label} only: "${down.title}"`)
      listeners.set(victim.id, spawnListener(victim))
      const back = await waitFor(
        () => !openAlerts().some((alert) => alert.check === 'destination-down'),
        25000
      )
      if (back) pass('destination-down cleared', `${victim.label} reconnected and the alert cleared`)
      else fail('destination-down cleared', `still open after the sink came back: ${alertNames()}`)
      await sleep(3000)
      await stopListener(listeners.get(victim.id), 'SIGKILL')
      await stopListener(listeners.get(other.id), 'SIGKILL')
      listeners.clear()
      const fold = await waitFor(
        () => openAlerts().find((alert) => alert.check === 'destination-down' && alert.targetId === 'all'),
        DESTINATION_DOWN_AFTER_MS + 15000
      )
      const perLeg = openAlerts().filter((alert) => alert.check === 'destination-down' && alert.targetId !== 'all')
      if (!fold) fail('all-down fold', `no critical fold (${alertNames()})`)
      else if (fold.severity !== 'critical') fail('all-down fold', `severity ${fold.severity}`)
      else if (perLeg.length > 0) fail('all-down fold', 'per-destination cards stayed beside the fold')
      else pass('all-down fold', `"${fold.title}"`)
      for (const target of targets) listeners.set(target.id, spawnListener(target))
      await waitFor(() => !openAlerts().some((alert) => alert.check === 'destination-down'), 30000)
    }

    // 8. (B3) Chat says there is a problem.
    {
      const fakeSessionId = sessionId
      await request(ws, timeoutMs, 'liveChat.start', {
        sessionId: fakeSessionId,
        destinations: [{ platform: 'twitch', targetId: 'smoke-twitch', read: 'ready', write: 'ready' }],
        fakes: [
          {
            platform: 'twitch',
            targetId: 'smoke-twitch',
            count: 3,
            intervalMs: 400,
            authors: ['viewer_a'],
            texts: ['can you hear me?']
          }
        ]
      })
      await sleep(3500)
      if (openAlerts().some((alert) => alert.check === 'chat-says')) {
        fail('chat one asker', 'one person asking "can you hear me?" opened chat-says')
      } else {
        pass('chat one asker', 'a question from one person opens nothing')
      }
      // The streamer's own line never counts (echoed back as the broadcaster).
      await request(ws, timeoutMs, 'liveChat.stop', { sessionId: fakeSessionId }).catch(() => {})
      await request(ws, timeoutMs, 'liveChat.start', {
        sessionId: fakeSessionId,
        destinations: [{ platform: 'twitch', targetId: 'smoke-twitch', read: 'ready', write: 'ready' }],
        fakes: [
          {
            platform: 'twitch',
            targetId: 'smoke-twitch',
            count: 1,
            intervalMs: 200,
            authors: ['viewer_b'],
            texts: ['hello'],
            echoSends: true
          }
        ]
      })
      await request(ws, timeoutMs, 'liveChat.send', {
        sessionId: fakeSessionId,
        text: 'no sound today, sorry',
        targetIds: ['smoke-twitch']
      }).catch(() => {})
      await sleep(3000)
      if (openAlerts().some((alert) => alert.check === 'chat-says')) {
        fail('chat own line', "the streamer's own line opened chat-says")
      } else {
        pass('chat own line', "the streamer's own line never counts")
      }
      await request(ws, timeoutMs, 'liveChat.stop', { sessionId: fakeSessionId }).catch(() => {})
      await request(ws, timeoutMs, 'liveChat.start', {
        sessionId: fakeSessionId,
        destinations: [{ platform: 'twitch', targetId: 'smoke-twitch', read: 'ready', write: 'ready' }],
        fakes: [
          {
            platform: 'twitch',
            targetId: 'smoke-twitch',
            count: 2,
            intervalMs: 800,
            authors: ['viewer_c', 'viewer_d'],
            texts: ['no sound??', 'sin audio']
          }
        ]
      })
      const chat = await waitFor(
        () => openAlerts().find((alert) => alert.check === 'chat-says' && alert.targetId === 'audio'),
        12000
      )
      if (!chat) fail('chat-says', `two chatters did not open it (${alertNames()})`)
      else if (!chat.detail.includes('no sound??') || !chat.detail.includes('sin audio')) fail('chat-says', `quotes missing: ${chat.detail}`)
      else if (!/^2 people/.test(chat.detail)) fail('chat-says', `people count wrong: ${chat.detail}`)
      else pass('chat-says', `"${chat.title}" / ${chat.detail}`)
      await request(ws, timeoutMs, 'liveChat.stop', { sessionId: fakeSessionId }).catch(() => {})
    }

    // 7. The leak scan: no stream URL with a key, no key, in any event.
    {
      const leaks = []
      for (const text of everyEvent) {
        for (const target of targets) {
          if (text.includes(target.streamKey)) leaks.push(`${target.label}'s key`)
          if (text.includes(target.listenUrl)) leaks.push(`${target.label}'s ingest URL`)
        }
      }
      if (leaks.length > 0) fail('leak scan', `${[...new Set(leaks)].join(', ')} reached an event`)
      else pass('leak scan', `${everyEvent.length} events, no key and no ingest URL`)
    }

    // The by-eye check (A5): a mic-muted card in dark and light. Last, because
    // the renderer reload it needs re-applies the renderer's own audio
    // settings (the mute is the renderer's), which would disturb a scenario.
    if (shotsDir) {
      await captureStudioShots(smoke, 'mic-muted', async () => {
        await setMuted(ws, sessionId, true)
        return waitFor(
          () => openAlerts().find((alert) => alert.check === 'mic-muted'),
          MIC_MUTED_AFTER_MS + 4000
        )
      }).catch((error) => console.log(`  • screenshots skipped: ${error?.message ?? error}`))
      await setMuted(ws, sessionId, false)
      await sleep(2000)
    }

    // Stop inside the budget.
    const stopStartedAt = Date.now()
    const stopped = await request(ws, timeoutMs, 'session.stop')
    const stopMs = Date.now() - stopStartedAt
    if (stopMs <= stopBudgetMs) pass('stop', `${stopMs} ms`)
    else fail('stop', `Stop took ${stopMs} ms (budget ${stopBudgetMs} ms)`)
    if (stopped.state === 'failed') fail('stop', `the session was marked failed: ${stopped.message ?? ''}`)
    const emptied = await waitFor(
      () => alertViews.at(-1)?.alerts.length === 0 || alertViews.length === 0,
      5000
    )
    if (emptied) pass('alerts die with the session', 'the list emptied at Stop')
    else fail('alerts die with the session', `alerts still listed: ${alertNames()}`)
  } finally {
    ws.close()
  }
} finally {
  stopping = true
  for (const listener of listeners.values()) {
    await stopListener(listener, 'SIGTERM')
  }
  await stopApp()
  report.pass = failures.length === 0
  report.failures = failures
  report.skips = skips
  writeFileSync(join(outputDirectory, 'stream-watchdog-evidence.json'), JSON.stringify(report, null, 2))
}

if (failures.length > 0) {
  console.error(`Stream watchdog smoke failed:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`Stream watchdog smoke passed${skips.length ? ` (${skips.length} skipped)` : ''}.`)

function openAlerts() {
  return alertViews.at(-1)?.alerts ?? []
}
function alertNames() {
  return openAlerts().map((alert) => `${alert.check}${alert.targetId ? `:${alert.targetId}` : ''}`).join(', ') || 'none'
}
function healthCodes() {
  return healthEvents.map((event) => event.code).filter((code) => code.startsWith('watchdog')).join(', ') || 'none'
}

async function setMuted(ws, sessionId, muted) {
  await request(ws, timeoutMs, 'audio.processing.update', {
    sessionId,
    microphoneGainDb: 0,
    microphoneMuted: muted
  })
}

async function assertSessionRunning(ws, when) {
  const status = await request(ws, timeoutMs, 'recording.status')
  if (status.state !== 'recording' && status.state !== 'streaming') {
    throw new Error(`The session ended ${when} (state ${status.state}): ${status.message ?? ''}`)
  }
}

async function waitFor(predicate, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(200)
  }
  return predicate()
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

// A takeover import takes main's single-use input-file capability, never a
// raw path (plan 186): the smoke command server issues one for the file.
async function importTakeover(ws, smoke, path) {
  const authorized = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'input-file', path },
    { timeoutMs }
  )
  return request(ws, timeoutMs, 'screens.importImage', {
    sourceCapability: authorized.capabilityId
  }).catch((error) => ({ error: String(error?.message ?? error) }))
}

function makePng(path, color) {
  execFileSync(
    ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180`, '-frames:v', '1', path],
    { stdio: 'ignore' }
  )
  if (!existsSync(path)) throw new Error(`ffmpeg did not write ${path}`)
}

function sessionParams(outputDirectoryCapability) {
  const timestamp = '2026-01-01T00:00:00.000Z'
  return {
    // The synthetic 440 Hz tone microphone (VIDEORC_CAPTION_CONTRACT_TEST +
    // VIDEORC_LIVE_SOURCE_SWITCH_TEST, as smoke:output-stall): without a
    // microphone the program is digital silence from the first frame.
    sources: { testPattern: true, microphoneId: 'microphone:coreaudio:4294967295' },
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
      streamEnabled: true,
      outputDirectoryCapability,
      video: { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 },
      rtmp: { preset: 'custom', serverUrl: targets[0].serverUrl, streamKey: targets[0].streamKey }
    },
    streaming: {
      enabled: true,
      mode: 'multi',
      targets: targets.map((target) => ({
        id: target.id,
        platform: target.id,
        label: target.label,
        enabled: true,
        serverUrl: target.serverUrl,
        urlMode: 'server-and-key',
        streamKey: target.streamKey,
        streamKeyPresent: true,
        authMode: 'manual-rtmp',
        createdAt: timestamp,
        updatedAt: timestamp
      })),
      defaultOutputPreset: 'stream-safe-1080p30',
      defaultBitrateKbps: 6000,
      enabledTargetIds: targets.map((target) => target.id)
    }
  }
}

function spawnListener(target) {
  const proc = spawn(
    ffmpegPath,
    ['-y', '-hide_banner', '-loglevel', 'error', '-listen', '1', '-i', target.listenUrl, '-c', 'copy', '-f', 'flv', target.recvPath],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (text) => {
    if (stopping) return
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) console.error(`[listener :${target.listenPort}] ${line}`)
    }
  })
  return proc
}

function stopListener(proc, signal) {
  return new Promise((resolveStop) => {
    if (!proc?.pid || proc.exitCode !== null) {
      resolveStop()
      return
    }
    proc.once('exit', () => resolveStop())
    proc.kill(signal)
    setTimeout(resolveStop, 3000)
  })
}

// --- Screenshots (A5's by-eye check) ---------------------------------------

async function captureStudioShots(smoke, stage, raise) {
  mkdirSync(shotsDir, { recursive: true })
  const devtools = await waitFor(
    () =>
      appLines.map((line) => /DevTools listening on (ws:\/\/\S+)/.exec(line)?.[1]).findLast(Boolean),
    10000
  )
  if (!devtools) throw new Error('no DevTools url in the app log (VIDEORC_REMOTE_DEBUG_PORT)')
  const { host } = new URL(devtools.replace('ws://', 'http://'))
  await cdpEvaluate(
    host,
    `localStorage.setItem('videorc.onboardingComplete', 'creator-ux-v1'); location.reload(); 'ok'`
  )
  await waitFor(
    async () =>
      (await cdpEvaluate(
        host,
        `document.readyState === 'complete' && Boolean(document.querySelector('[aria-label="Toggle color theme"]'))`
      ).catch(() => false)) || null,
    30000
  )
  await requestSmokeCommand(
    smoke,
    'open-tab',
    { tab: 'studio', waitFor: '[data-testid="session-stream-health"]' },
    { timeoutMs: 30000 }
  )
  // The reload re-applied the renderer's own audio settings (the mute is
  // the renderer's): raise the alert only now, and wait for its card.
  if (!(await raise())) throw new Error(`no ${stage} card to shoot`)
  await sleep(1500)
  const theme = () =>
    cdpEvaluate(host, `document.documentElement.classList.contains('dark') ? 'dark' : 'light'`)
  const setTheme = async (wanted) => {
    if ((await theme()) === wanted) return
    await cdpEvaluate(host, `document.querySelector('[aria-label="Toggle color theme"]').click(); 'ok'`)
    await waitFor(async () => ((await theme()) === wanted ? true : null), 5000)
    await sleep(250)
  }
  for (const wanted of ['dark', 'light']) {
    await setTheme(wanted)
    await cdpEvaluate(
      host,
      `document.querySelector('[data-testid="watchdog-alert"][data-check="${stage}"]')?.scrollIntoView({ block: 'center' }); 'ok'`
    )
    await sleep(200)
    const shot = await cdpCall(host, 'Page.captureScreenshot', { format: 'png' })
    const file = join(shotsDir, `watchdog-${stage}-${wanted}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    const words = await cdpEvaluate(
      host,
      `document.querySelector('[data-testid="watchdog-alert"][data-check="${stage}"]')?.innerText ?? ''`
    )
    console.log(`  [shots] ${stage} ${wanted}: ${file} (${JSON.stringify(words)})`)
  }
  await setTheme('dark')
}

async function cdpCall(host, method, params) {
  const targets = await (await fetch(`http://${host}/json/list`)).json()
  const mainTarget = targets.find(
    (target) => target.type === 'page' && /^https?:\/\/localhost/.test(target.url ?? '')
  )
  if (!mainTarget) throw new Error('Main window CDP target not found.')
  return new Promise((resolveCall, rejectCall) => {
    const ws = new WebSocket(mainTarget.webSocketDebuggerUrl)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== 1) return
      ws.close()
      if (message.error) rejectCall(new Error(message.error.message))
      else resolveCall(message.result)
    })
    ws.addEventListener('error', () => rejectCall(new Error('CDP connect failed')))
  })
}

async function cdpEvaluate(host, expression) {
  const result = await cdpCall(host, 'Runtime.evaluate', { expression, returnByValue: true })
  return result?.result?.value
}

