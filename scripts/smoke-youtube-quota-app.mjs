import { spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { FAKE_YOUTUBE_ACCESS_TOKEN, startFakeYouTubeApi } from './lib/fake-youtube-api.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Quota-outage drill (plan 094, S4). Drives the dev app through a full
// YouTube Data API outage against a local fake API and proves the streamer
// contract end to end:
//   a. live with chat, viewers and subscribers flowing, then the quota flips:
//      one paused notice (one `youtube.quota` event, no toast storm), chat
//      Waiting with `retryAt`, zero YouTube requests while paused, and the RTMP
//      output still advancing on every destination (G1, G3);
//   b. breaker expiry forced through the smoke hook: the probe succeeds, chat
//      resumes from its page token and new messages arrive (G4);
//   c. Stop during the outage: `complete` is refused with a settled code and
//      a recording starts right after (bug 1);
//   d. Go Live with YouTube OAuth while paused: prepare refused with the
//      stream-key code, a non-YouTube destination still goes live (G5);
//   e. connect YouTube while paused: the callback is terminal (reason
//      `youtube-quota`), zero profile requests, one renderer toast (bug 7).
// The dev-only `VIDEORC_YOUTUBE_API_BASE_URL` routes every YouTube client
// (prepare, bind, transition, chat read, viewers, subscribers, OAuth token and
// profile, the quota probe) at the fake; packaged builds refuse it.

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-youtube-quota-${Date.now()}`)
)
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 180000)
const basePort = Number(process.env.VIDEORC_YOUTUBE_QUOTA_RTMP_PORT ?? 19845)
const listenerBindMs = Number(process.env.VIDEORC_YOUTUBE_QUOTA_LISTENER_BIND_MS ?? 1500)
// Longer than two chat poll floors (5 s) and the breaker's re-check cadence.
const pausedWindowMs = Number(process.env.VIDEORC_YOUTUBE_QUOTA_PAUSED_WINDOW_MS ?? 12000)
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const accountId = 'youtube-quota-smoke-channel'
const youtubeTargetId = 'youtube-quota-smoke'
const customTargetId = 'custom-quota-smoke'
const streamKey = 'smoke-yt-key'

mkdirSync(outputDirectory, { recursive: true })

const fake = await startFakeYouTubeApi({
  ingestUrl: `rtmp://127.0.0.1:${basePort}/live`,
  streamKey
})
let launched
let ws
let listeners = []
const results = []

try {
  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_APP_DATA_DIR: join(outputDirectory, 'app-data'),
      VIDEORC_USER_DATA_DIR: join(outputDirectory, 'user-data'),
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_ENABLE_SMOKE_RPC: '1',
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_YOUTUBE_API_BASE_URL: fake.origin,
      // The connect scenario needs a configured provider; the fake never sees
      // these and the token exchange goes to the fake's /token.
      VIDEORC_YOUTUBE_CLIENT_ID: 'youtube-quota-smoke-client-id',
      VIDEORC_YOUTUBE_CLIENT_SECRET: 'youtube-quota-smoke-client-secret'
    },
    onLine: (line) => {
      if (/youtube-quota|youtube-api-usage|error|panic/i.test(line)) console.log(line)
    }
  })
  const smoke = launched.connections['preview-motion-ready']
  ws = await connectBackend(launched.connections['backend-ready'], timeoutMs)
  const events = collectEvents(ws)

  const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
  if (!health?.ffmpeg?.available) {
    throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the quota smoke.')
  }

  // --- Setup: a connected YouTube OAuth account against the fake. ---------------
  const seeded = await request(ws, timeoutMs, 'test.youtubeQuota.seedAccount', {
    accessToken: FAKE_YOUTUBE_ACCESS_TOKEN,
    accountId,
    accountLabel: 'Quota smoke channel'
  })
  assert(
    seeded?.platform === 'youtube' && seeded.accountId === accountId,
    `seeded ${JSON.stringify(seeded)}`
  )
  await request(ws, timeoutMs, 'streamTargets.metadata.update', {
    title: 'Quota drill',
    description: 'Plan 094 S4 smoke.',
    defaultPrivacy: 'unlisted',
    targetOverrides: [],
    updatedAt: new Date().toISOString()
  })
  const video = { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 }
  const prepared = await request(ws, timeoutMs, 'streamTargets.youtube.prepare', {
    accountId,
    targetId: youtubeTargetId,
    video
  })
  assert(prepared.broadcastId && prepared.streamId, `prepared ${JSON.stringify(prepared)}`)
  assert(prepared.serverUrl === `rtmp://127.0.0.1:${basePort}/live`, `ingest ${prepared.serverUrl}`)
  console.log(`[quota] prepared broadcast ${prepared.broadcastId} on the fake API`)

  const outputAuthorization = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs }
  )

  // --- a. Live with chat, then the quota flips. ------------------------------------
  listeners = [
    spawnRtmpListener(basePort, streamKey, 'a-youtube'),
    spawnRtmpListener(basePort + 1, 'smoke-custom', 'a-custom')
  ]
  await sleep(listenerBindMs)
  fake.startAutoChat(1200)
  const started = await request(
    ws,
    timeoutMs,
    'session.start',
    sessionParams({
      outputDirectoryCapability: outputAuthorization.capabilityId,
      video,
      prepared,
      youtubeServerUrl: prepared.serverUrl,
      customServerUrl: `rtmp://127.0.0.1:${basePort + 1}/live`,
      streamEnabled: true,
      recordEnabled: false
    })
  )
  assert(
    ['streaming', 'recording'].includes(started.state),
    `session.start ${JSON.stringify(started)}`
  )
  const sessionId = started.sessionId
  console.log(
    `[quota] a: session ${sessionId} live to the fake YouTube ingest and a custom RTMP destination`
  )

  await waitFor(
    async () => (await youtubeProvider(ws, sessionId))?.state === 'connected',
    'YouTube chat connected through the fake API'
  )
  await waitFor(
    () =>
      events.messages.some(
        (message) => message.sessionId === sessionId && message.platform === 'youtube'
      ),
    'a YouTube chat message delivered'
  )
  await waitFor(
    () =>
      events.viewers.some((sample) =>
        sample.platforms?.some((entry) => entry.platform === 'youtube' && entry.count === 7)
      ),
    'a YouTube viewer count sample (7)'
  )
  await waitFor(
    () =>
      events.audience.some((snapshot) =>
        snapshot.platforms?.some((entry) => entry.platform === 'youtube' && entry.total === 1234)
      ),
    'the YouTube subscriber count (1234)'
  )
  const messagesBeforeOutage = events.messages.filter(
    (message) => message.platform === 'youtube'
  ).length
  console.log(`[quota] a: chat (${messagesBeforeOutage} messages), viewers and subscribers flowing`)

  const quotaEventsBefore = events.quota.length
  fake.controls.quotaExhausted = true
  await waitFor(
    () => events.quota.slice(quotaEventsBefore).some((status) => status.pausedUntil),
    'the youtube.quota paused event'
  )
  const pausedStatus = await request(ws, timeoutMs, 'youtube.quota.status')
  assert(pausedStatus.pausedUntil, `youtube.quota.status ${JSON.stringify(pausedStatus)}`)
  const pausedUntil = new Date(pausedStatus.pausedUntil)
  assert(
    pausedUntil.getTime() > Date.now() + 60_000,
    `pausedUntil should be a future reset, got ${pausedStatus.pausedUntil}`
  )
  await waitFor(async () => {
    const provider = await youtubeProvider(ws, sessionId)
    return provider?.state === 'waiting' && Boolean(provider.retryAt)
  }, 'the YouTube chat provider Waiting with retryAt')
  const waiting = await youtubeProvider(ws, sessionId)
  assert(
    waiting.retryAt === pausedStatus.pausedUntil,
    `retryAt ${waiting.retryAt} vs pausedUntil ${pausedStatus.pausedUntil}`
  )
  assert(
    /paused/i.test(waiting.message) && !/<|quotaExceeded|{"error"/.test(waiting.message),
    `paused copy ${waiting.message}`
  )

  // Zero YouTube requests while paused, output still advancing on both legs.
  const requestFloor = fake.requests.length
  const sizesBefore = listeners.map((listener) => fileSize(listener.receivedPath))
  await sleep(pausedWindowMs)
  const duringPause = fake.requests.slice(requestFloor).filter((entry) => entry.dataApi)
  assert(duringPause.length === 0, `YouTube requests while paused: ${JSON.stringify(duringPause)}`)
  const sizesAfter = listeners.map((listener) => fileSize(listener.receivedPath))
  listeners.forEach((listener, index) => {
    assert(
      sizesAfter[index] > sizesBefore[index] + 10_000,
      `${listener.label} output did not advance during the outage (${sizesBefore[index]} -> ${sizesAfter[index]} bytes)`
    )
  })
  const pausedEvents = events.quota.slice(quotaEventsBefore).filter((status) => status.pausedUntil)
  assert(pausedEvents.length === 1, `expected one paused notice, got ${pausedEvents.length}`)
  const toastsDuringOutage = await countToasts(smoke, /YouTube/i)
  assert(
    toastsDuringOutage <= 1,
    `toast storm during the outage: ${toastsDuringOutage} YouTube toasts`
  )
  results.push(
    `a: one paused notice (${pausedEvents.length} event, ${toastsDuringOutage} toast), chat waiting until ${pausedStatus.pausedUntil}, ` +
      `0 YouTube requests in ${pausedWindowMs} ms, output advanced ${sizesAfter.map((size, index) => `+${size - sizesBefore[index]} B`).join(' / ')}`
  )
  console.log(`[quota] ${results.at(-1)}`)

  // --- b. Forced breaker expiry: chat resumes by itself. --------------------------
  fake.controls.quotaExhausted = false
  const resumeFloor = fake.requests.length
  const forced = await request(ws, timeoutMs, 'test.youtubeQuota.forceExpiry', {})
  assert(forced.forced === true, `forceExpiry ${JSON.stringify(forced)}`)
  await waitFor(
    async () => !(await request(ws, timeoutMs, 'youtube.quota.status')).pausedUntil,
    'the breaker to clear after the probe'
  )
  const probeCalls = fake.requests
    .slice(resumeFloor)
    .filter((entry) => entry.path === '/youtube/v3/channels')
  assert(probeCalls.length >= 1, 'the expiry probe should spend one channels.list')
  await waitFor(
    async () => (await youtubeProvider(ws, sessionId))?.state === 'connected',
    'YouTube chat connected again'
  )
  const resumedFloor = events.messages.filter((message) => message.platform === 'youtube').length
  fake.postChat('after the reset')
  await waitFor(
    () =>
      events.messages.some(
        (message) =>
          message.platform === 'youtube' && message.messageText?.includes('after the reset')
      ),
    'a chat message delivered after the resume'
  )
  const clearedEvents = events.quota.filter((status) => !status.pausedUntil).length
  assert(clearedEvents >= 1, 'the youtube.quota cleared event')
  results.push(
    `b: forced expiry → probe ok (${probeCalls.length} channels.list) → chat connected, ${events.messages.filter((m) => m.platform === 'youtube').length - resumedFloor} new message(s) delivered with no click`
  )
  console.log(`[quota] ${results.at(-1)}`)

  // --- c. Stop during the outage: settled complete, then Record right away. --------
  fake.controls.quotaExhausted = true
  await waitFor(
    async () => Boolean((await request(ws, timeoutMs, 'youtube.quota.status')).pausedUntil),
    'the breaker to trip again'
  )
  const complete = await requestRaw(ws, timeoutMs, 'streamTargets.youtube.transition', {
    accountId,
    broadcastId: prepared.broadcastId,
    status: 'complete'
  })
  assert(
    !complete.ok && complete.error?.code === 'youtube-quota-paused',
    `complete during outage ${JSON.stringify(complete)}`
  )
  assert(
    !/<|quotaExceeded|{"error"/.test(complete.error.message),
    `raw provider text leaked: ${complete.error.message}`
  )
  fake.stopAutoChat()
  await request(ws, timeoutMs, 'session.stop', {})
  await waitFor(
    async () => (await request(ws, timeoutMs, 'recording.status', {}))?.state === 'idle',
    'the session to stop'
  )
  const recordStart = Date.now()
  const recording = await request(
    ws,
    timeoutMs,
    'session.start',
    sessionParams({
      outputDirectoryCapability: outputAuthorization.capabilityId,
      video,
      prepared: null,
      streamEnabled: false,
      recordEnabled: true
    })
  )
  assert(
    recording.state === 'recording',
    `recording after the outage stop ${JSON.stringify(recording)}`
  )
  const recordLatencyMs = Date.now() - recordStart
  await request(ws, timeoutMs, 'session.stop', {})
  await waitFor(
    async () => (await request(ws, timeoutMs, 'recording.status', {}))?.state === 'idle',
    'the recording to stop'
  )
  results.push(
    `c: complete refused as ${complete.error.code} ("${complete.error.message}"), Record started ${recordLatencyMs} ms after the request`
  )
  console.log(`[quota] ${results.at(-1)}`)

  // --- d. Go Live while paused: YouTube OAuth refused, others live. -----------------
  const prepareWhilePaused = await requestRaw(ws, timeoutMs, 'streamTargets.youtube.prepare', {
    accountId,
    targetId: youtubeTargetId,
    video
  })
  assert(
    !prepareWhilePaused.ok && prepareWhilePaused.error?.code === 'youtube-quota-paused',
    `prepare while paused ${JSON.stringify(prepareWhilePaused)}`
  )
  assert(
    /stream key/i.test(prepareWhilePaused.error.message),
    `prepare copy should offer the stream key: ${prepareWhilePaused.error.message}`
  )
  const prepareRequests = fake.requests.filter(
    (entry) => entry.path === '/youtube/v3/liveBroadcasts' && entry.method === 'POST'
  )
  assert(
    prepareRequests.length === 1,
    `prepare while paused must spend nothing, broadcast inserts: ${prepareRequests.length}`
  )
  await stopListeners(listeners)
  listeners = [spawnRtmpListener(basePort + 2, 'smoke-custom-d', 'd-custom')]
  await sleep(listenerBindMs)
  const othersLive = await request(
    ws,
    timeoutMs,
    'session.start',
    sessionParams({
      outputDirectoryCapability: outputAuthorization.capabilityId,
      video,
      prepared: null,
      customServerUrl: `rtmp://127.0.0.1:${basePort + 2}/live`,
      customStreamKey: 'smoke-custom-d',
      streamEnabled: true,
      recordEnabled: false
    })
  )
  assert(
    ['streaming', 'recording'].includes(othersLive.state),
    `custom Go Live while paused ${JSON.stringify(othersLive)}`
  )
  await waitFor(
    () => fileSize(listeners[0].receivedPath) > 10_000,
    'the custom destination receiving bytes while YouTube is paused'
  )
  await request(ws, timeoutMs, 'session.stop', {})
  await waitFor(
    async () => (await request(ws, timeoutMs, 'recording.status', {}))?.state === 'idle',
    'the custom session to stop'
  )
  results.push(
    `d: prepare refused as ${prepareWhilePaused.error.code} with the stream-key copy, custom RTMP destination went live`
  )
  console.log(`[quota] ${results.at(-1)}`)

  // --- e. Connect YouTube while paused: terminal, zero profile requests, one toast. --
  const connectFloor = fake.requests.length
  const callbacksBefore = events.callbacks.length
  const startedOAuth = await request(ws, timeoutMs, 'platformAccounts.oauth.startProvider', {
    platform: 'youtube'
  })
  assert(
    startedOAuth.state && startedOAuth.redirectUri,
    `startProvider ${JSON.stringify(startedOAuth)}`
  )
  const callbackResponse = await fetch(
    `${startedOAuth.redirectUri}?state=${encodeURIComponent(startedOAuth.state)}&code=smoke-code`
  )
  assert(callbackResponse.status < 500, `callback page ${callbackResponse.status}`)
  await waitFor(
    () =>
      events.callbacks
        .slice(callbacksBefore)
        .some((result) => result.platform === 'youtube' && result.status !== 'pending'),
    'the YouTube OAuth callback result'
  )
  const callback = events.callbacks
    .slice(callbacksBefore)
    .find((result) => result.platform === 'youtube')
  assert(
    callback.status === 'failed' && callback.retryable === false,
    `callback should be terminal: ${JSON.stringify(callback)}`
  )
  assert(
    callback.reason === 'youtube-quota' && callback.retryAt,
    `callback reason/retryAt: ${JSON.stringify(callback)}`
  )
  await sleep(2500)
  const connectRequests = fake.requests.slice(connectFloor)
  const profileRequests = connectRequests.filter((entry) => entry.path === '/youtube/v3/channels')
  assert(profileRequests.length === 0, `profile lookups while paused: ${profileRequests.length}`)
  assert(
    connectRequests.some((entry) => entry.path === '/token'),
    'the code exchange should reach the fake token route'
  )
  const connectToasts = await countToasts(smoke, /connecting YouTube/i)
  assert(connectToasts === 1, `expected one connect toast, got ${connectToasts}`)
  await sleep(6000)
  const connectToastsLater = await countToasts(smoke, /connecting YouTube/i)
  assert(connectToastsLater <= 1, `connect toast storm: ${connectToastsLater} toasts after 6 s`)
  const callbackCount = events.callbacks
    .slice(callbacksBefore)
    .filter((result) => result.platform === 'youtube').length
  assert(callbackCount === 1, `expected one callback result, got ${callbackCount}`)
  results.push(
    `e: connect while paused → failed/retryable=false/reason=${callback.reason}, 0 profile requests, ${connectToasts} toast (still ${connectToastsLater} after 6 s)`
  )
  console.log(`[quota] ${results.at(-1)}`)

  console.log(
    `YouTube quota drill smoke PASS\n${results.map((line) => `  ${line}`).join('\n')}\nEvidence: ${outputDirectory}`
  )
} finally {
  fake.stopAutoChat()
  ws?.close()
  await stopListeners(listeners)
  await launched?.stop()
  await fake.close()
}

// --- helpers --------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) throw new Error(`[quota] ${message}`)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

async function waitFor(predicate, label, deadlineMs = Math.min(timeoutMs, 45000)) {
  const startedAt = Date.now()
  for (;;) {
    if (await predicate()) return
    if (Date.now() - startedAt > deadlineMs)
      throw new Error(`[quota] Timed out waiting for ${label}.`)
    await sleep(150)
  }
}

function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

async function youtubeProvider(socket, sessionId) {
  const status = await request(socket, timeoutMs, 'liveChat.status', {})
  if (status.sessionId !== sessionId) return null
  return status.providers?.find((provider) => provider.platform === 'youtube') ?? null
}

async function countToasts(smoke, pattern) {
  const response = await requestSmokeCommand(
    smoke,
    'eval-js',
    {
      code: `const toasts = [...document.querySelectorAll('[data-sonner-toast]')].map((node) => node.textContent ?? ''); return toasts.filter((text) => ${pattern.toString()}.test(text)).length`
    },
    { timeoutMs }
  )
  return Number(response?.result ?? 0)
}

/** Like `request`, but resolves the whole envelope so error codes are visible. */
function requestRaw(socket, deadlineMs, method, params) {
  const id = `quota-${Date.now()}-${Math.random().toString(16).slice(2)}`
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      rejectRequest(new Error(`Timed out waiting for ${method}.`))
    }, deadlineMs)
    const onMessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      resolveRequest(message)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

function collectEvents(socket) {
  const collection = { messages: [], quota: [], viewers: [], audience: [], callbacks: [] }
  socket.addEventListener('message', (event) => {
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      return
    }
    switch (parsed.event) {
      case 'liveChat.message':
        collection.messages.push(parsed.payload)
        break
      case 'youtube.quota':
        collection.quota.push(parsed.payload ?? {})
        break
      case 'stream.viewers':
        collection.viewers.push(parsed.payload)
        break
      case 'stream.audience':
        collection.audience.push(parsed.payload)
        break
      case 'platformAccounts.oauth.callback':
        collection.callbacks.push(parsed.payload)
        break
      default:
        break
    }
  })
  return collection
}

function sessionParams({
  outputDirectoryCapability,
  video,
  prepared,
  youtubeServerUrl,
  customServerUrl,
  customStreamKey = 'smoke-custom',
  streamEnabled,
  recordEnabled
}) {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const targets = []
  if (prepared) {
    targets.push({
      id: youtubeTargetId,
      platform: 'youtube',
      label: 'YouTube',
      enabled: true,
      serverUrl: youtubeServerUrl,
      urlMode: 'server-and-key',
      // The key lives in the secret store since prepare; the backend hydrates it.
      streamKey: '',
      streamKeyPresent: true,
      authMode: 'oauth',
      accountId,
      accountLabel: 'Quota smoke channel',
      platformBroadcastId: prepared.broadcastId,
      platformStreamId: prepared.streamId,
      status: { state: 'ready', message: 'Prepared.' },
      createdAt: timestamp,
      updatedAt: timestamp
    })
  }
  if (customServerUrl) {
    targets.push({
      id: customTargetId,
      platform: 'custom',
      label: 'Local RTMP',
      enabled: true,
      serverUrl: customServerUrl,
      urlMode: 'server-and-key',
      streamKey: customStreamKey,
      streamKeyPresent: true,
      authMode: 'manual-rtmp',
      createdAt: timestamp,
      updatedAt: timestamp
    })
  }
  const primary = targets[0]
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
      recordEnabled,
      streamEnabled,
      outputDirectoryCapability,
      video,
      rtmp: {
        preset: 'custom',
        serverUrl: primary?.serverUrl ?? '',
        streamKey: primary?.streamKey ?? ''
      }
    },
    streaming: streamEnabled
      ? {
          enabled: true,
          mode: targets.length > 1 ? 'multi' : 'single',
          targets,
          selectedTargetId: primary.id,
          defaultOutputPreset: 'stream-safe-1080p30',
          defaultBitrateKbps: 6000,
          enabledTargetIds: targets.map((target) => target.id)
        }
      : undefined,
    captions: { burnTarget: 'off', position: 'bottom', textSize: 'm' },
    audio: { microphoneGainDb: 0, microphoneMuted: true, microphoneSyncOffsetMs: 0 }
  }
}

function spawnRtmpListener(port, key, label) {
  const receivedPath = join(outputDirectory, `recv-${label}.flv`)
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
      `rtmp://127.0.0.1:${port}/live/${key}`,
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
  return { process: child, stderr, receivedPath, label }
}

async function stopListeners(list) {
  for (const listener of list) {
    const child = listener?.process
    if (!child?.pid || child.exitCode !== null) continue
    await waitForExit(child, 1500)
    if (child.exitCode !== null) continue
    child.kill('SIGTERM')
    await waitForExit(child, 1000)
    if (child.exitCode === null) child.kill('SIGKILL')
    await waitForExit(child, 1000)
  }
}

function waitForExit(child, ms) {
  return new Promise((resolveExit) => {
    if (child.exitCode !== null) {
      resolveExit()
      return
    }
    const timer = setTimeout(resolveExit, ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}
