import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { buttonLabels, FAKE_WEBHOOK_NAME, startFakeDiscord } from './lib/fake-discord-webhook.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Plan 187: the Discord go-live announcement, end to end against the real dev
// app and a local fake of Discord's webhook API (scripts/lib/fake-discord-
// webhook.mjs, reached through the dev-only VIDEORC_DISCORD_API_BASE_URL).
// Two local RTMP listeners (`ffmpeg -listen 1`) stand in for Twitch and a
// custom destination, each with a typed public link. The smoke proves:
//   1. a pasted webhook is verified and only its masked tail comes back;
//   2. "Send test message" posts and never pings;
//   3. Go Live posts exactly once, pinging as chosen, after the destinations
//      stay live, with a button per destination (a coalesced edit adds a
//      late one);
//   4. a leg that reconnects never posts again;
//   5. Stop edits the message to "Was live";
//   6. going live again inside the restart window edits it back, with no
//      new post;
//   7. a session whose destinations are all unticked sends nothing;
//   8. a deleted message falls back to one fresh post, and a deleted webhook
//      is reported once and never retried;
//   9. the webhook token never reaches the app log or a renderer event.

const WEBHOOK_ID = '123456789012345678'
const TOKEN = 'SmokeT0ken_shouldNeverLeak-0123456789abcdef'
const WEBHOOK_URL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${TOKEN}`

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-discord-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-discord-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const basePort = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 13965)
const postBudgetMs = Number(process.env.VIDEORC_SMOKE_POST_BUDGET_MS ?? 30000)
const listenerBindMs = 2500

const targets = [
  { id: 'twitch', platform: 'twitch', label: 'Twitch', link: 'https://www.twitch.tv/smoke' },
  {
    id: 'site',
    platform: 'custom',
    label: 'Smoke site',
    link: 'https://example.com/smoke/live'
  }
].map((target, index) => {
  const listenPort = basePort + index
  const streamKey = `discord${index}`
  return {
    ...target,
    listenPort,
    streamKey,
    serverUrl: `rtmp://127.0.0.1:${listenPort}/live`,
    listenUrl: `rtmp://127.0.0.1:${listenPort}/live/${streamKey}`
  }
})

mkdirSync(outputDirectory, { recursive: true })

const failures = []
const appLines = []
const wireMessages = []
const targetSnapshots = []
const discordSnapshots = []
const listeners = new Map()
let stopping = false
let stopApp = async () => {}
const fake = await startFakeDiscord({ webhookId: WEBHOOK_ID, token: TOKEN })

const check = (ok, message) => {
  if (ok) console.log(`  ✓ ${message}`)
  else failures.push(message)
}

try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DISCORD_API_BASE_URL: fake.origin
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => {
      appLines.push(line)
      if (/\[discord\]/.test(line)) console.log(line)
    }
  })
  stopApp = launch.stop
  const smoke = launch.connections['preview-motion-ready']
  const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  ws.addEventListener('message', (event) => {
    wireMessages.push(String(event.data))
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message?.event === 'stream.targets' && Array.isArray(message.payload?.targets)) {
      targetSnapshots.push(message.payload.targets)
    }
    if (message?.event === 'discord.announce.changed') discordSnapshots.push(message.payload)
  })

  try {
    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the Discord smoke.')
    }
    await request(ws, timeoutMs, 'streamTargets.metadata.update', {
      title: 'Discord smoke stream',
      description: 'Plan 187 smoke.',
      defaultPrivacy: 'public',
      targetOverrides: [],
      updatedAt: new Date().toISOString()
    })

    // 1. Paste the webhook.
    console.log('[1] paste the webhook')
    const saved = await request(ws, timeoutMs, 'discord.webhook.save', { url: WEBHOOK_URL })
    check(saved.webhookPresent === true, 'the webhook is saved')
    check(
      saved.webhookName === FAKE_WEBHOOK_NAME,
      `Discord's name for it shows (${saved.webhookName})`
    )
    check(
      saved.webhookHint === `…/${TOKEN.slice(-4)}`,
      `only the masked tail comes back (${saved.webhookHint})`
    )
    check(!JSON.stringify(saved).includes(TOKEN), 'the snapshot never carries the token')
    let refused = null
    try {
      await request(ws, timeoutMs, 'discord.webhook.save', { url: 'https://example.com/hook' })
    } catch (error) {
      refused = error
    }
    check(
      String(refused?.message ?? '').includes("isn't a Discord webhook URL"),
      'a non-Discord URL is refused before any request'
    )

    await request(ws, timeoutMs, 'discord.announce.update', { ping: 'everyone' })
    for (const target of targets) {
      await request(ws, timeoutMs, 'discord.announce.update', {
        linkOverride: { targetId: target.id, link: target.link }
      })
    }
    const preview = await request(ws, timeoutMs, 'discord.links.preview', {
      targets: linkTargets()
    })
    check(
      preview.links.every((row) => row.included && row.linkKind === 'typed'),
      'both destinations are ticked with their typed links'
    )

    // 2. The test message.
    console.log('[2] send a test message')
    const before = fake.announcements().length
    await request(ws, timeoutMs, 'discord.webhook.sendTest', { targets: linkTargets() })
    const testPost = fake.announcements()[before]
    check(testPost?.method === 'POST', 'the test message is posted')
    check(
      String(testPost?.body?.content ?? '').startsWith('Test from Videorc'),
      'it says it is a test'
    )
    check(
      JSON.stringify(testPost?.body?.allowed_mentions) === '{"parse":[]}',
      'the test never pings, even with @everyone chosen'
    )
    check(
      buttonLabels(testPost?.body).join(',') === 'Twitch,Smoke site',
      `it shows the real buttons (${buttonLabels(testPost?.body).join(', ')})`
    )

    // 3. Go live.
    console.log('[3] go live')
    startListeners()
    await sleep(listenerBindMs)
    let mark = fake.announcements().length
    await startSession(ws, smoke)
    const firstPost = await waitForAnnouncement(mark, postBudgetMs)
    check(firstPost?.method === 'POST', 'Go Live posts')
    check(
      String(firstPost?.body?.content ?? '').startsWith('@everyone Live now: Discord smoke stream'),
      `the post pings and names the stream (${firstPost?.body?.content})`
    )
    check(
      JSON.stringify(firstPost?.body?.allowed_mentions) === '{"parse":["everyone"]}',
      'the post is allowed to ping @everyone'
    )
    await sleep(6000)
    const live = fake.announcements().slice(mark)
    const latestLabels = buttonLabels(live.at(-1)?.body)
    check(
      live.filter((entry) => entry.method === 'POST').length === 1,
      'exactly one post for the session'
    )
    check(
      latestLabels.includes('Twitch') && latestLabels.includes('Smoke site'),
      `every destination ends up linked (${latestLabels.join(', ')})`
    )
    check(
      live.slice(1).every((entry) => entry.body?.allowed_mentions?.parse?.length === 0),
      'edits never ping'
    )

    // 4. A leg reconnects.
    console.log('[4] a leg reconnects')
    mark = fake.announcements().length
    await stopListener(listeners.get('twitch'), 'SIGKILL')
    listeners.delete('twitch')
    await waitFor(() => latestState('twitch') === 'reconnecting', 15000)
    listeners.set('twitch', spawnListener(targets[0]))
    await waitFor(() => latestState('twitch') === 'live', 25000)
    await sleep(12000)
    check(
      fake
        .announcements()
        .slice(mark)
        .every((entry) => entry.method !== 'POST'),
      'a reconnect never posts again'
    )

    // 5. Stop.
    console.log('[5] stop')
    mark = fake.announcements().length
    await stopSession(ws)
    const ended = await waitForAnnouncement(mark, 20000)
    check(
      ended?.method === 'PATCH' && String(ended?.body?.content ?? '').startsWith('Was live: '),
      `Stop edits the message to "Was live" (${ended?.body?.content})`
    )

    // 6. Go live again inside the restart window.
    console.log('[6] go live again within 15 minutes')
    await restartListeners()
    await sleep(listenerBindMs)
    mark = fake.announcements().length
    await startSession(ws, smoke)
    const revived = await waitForAnnouncement(mark, postBudgetMs)
    check(
      revived?.method === 'PATCH' && String(revived?.body?.content ?? '').includes('Live now'),
      'a quick restart edits the last message back to live'
    )
    check(
      JSON.stringify(revived?.body?.allowed_mentions) === '{"parse":[]}',
      'the restart does not ping again'
    )
    await sleep(4000)
    await stopSession(ws)
    await waitForAnnouncement(fake.announcements().length - 1, 20000)
    await sleep(3000)
    check(
      fake
        .announcements()
        .slice(mark)
        .every((entry) => entry.method === 'PATCH'),
      'the restarted session never posts'
    )

    // 7. Every destination unticked.
    console.log('[7] nothing ticked')
    await request(ws, timeoutMs, 'discord.announce.update', {
      excludedTargetIds: targets.map((target) => target.id)
    })
    await restartListeners()
    await sleep(listenerBindMs)
    mark = fake.requests.length
    await startSession(ws, smoke)
    await sleep(15000)
    await stopSession(ws)
    await sleep(3000)
    check(fake.requests.length === mark, 'a session with nothing ticked sends nothing')
    await request(ws, timeoutMs, 'discord.announce.update', { excludedTargetIds: [] })

    // 8. The message, then the webhook, deleted in Discord.
    console.log('[8] deleted in Discord')
    fake.script('PATCH', 404, { message: 'Unknown Message', code: 10008 })
    fake.script('POST', 404, { message: 'Unknown Webhook', code: 10015 })
    await restartListeners()
    await sleep(listenerBindMs)
    mark = fake.announcements().length
    const snapshotsBefore = discordSnapshots.length
    await startSession(ws, smoke)
    await waitFor(() => fake.announcements().length >= mark + 2, postBudgetMs)
    await sleep(8000)
    const deletion = fake.announcements().slice(mark)
    check(
      deletion.map((entry) => entry.method).join(',') === 'PATCH,POST',
      `a deleted message falls back to one fresh post (${deletion.map((entry) => entry.method).join(',')})`
    )
    check(
      discordSnapshots
        .slice(snapshotsBefore)
        .some((snapshot) => snapshot.lastError?.code === 'webhook-deleted'),
      'a deleted webhook is reported'
    )
    check(deletion.length === 2, 'a deleted webhook is never retried')
    await stopSession(ws)
  } finally {
    ws.close()
  }
} finally {
  stopping = true
  for (const listener of listeners.values()) await stopListener(listener, 'SIGTERM')
  await stopApp()
  await fake.close()
}

// 9. The token never leaks.
check(!appLines.some((line) => line.includes(TOKEN)), 'the token never reaches the app log')
check(
  !wireMessages.some((message) => message.includes(TOKEN)),
  'the token never reaches a renderer event or answer'
)

if (failures.length > 0) {
  console.error(`Discord announcement smoke failed:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('Discord announcement smoke passed.')

function linkTargets() {
  return targets.map((target) => ({
    id: target.id,
    platform: target.platform,
    label: target.label,
    authMode: 'manual-rtmp'
  }))
}

async function startSession(ws, smoke) {
  // An output-directory capability is single use: one per session.
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
    sessionParams(recordingDirectory.capabilityId)
  )
  if (started.state !== 'recording') {
    throw new Error(`Expected recording state after start, got ${started.state}.`)
  }
}

async function stopSession(ws) {
  await request(ws, timeoutMs, 'session.stop')
  await sleep(1500)
}

async function waitForAnnouncement(after, budgetMs) {
  await waitFor(() => fake.announcements().length > after, budgetMs)
  return fake.announcements()[after] ?? null
}

function latestState(targetId) {
  return targetSnapshots.at(-1)?.find((entry) => entry.targetId === targetId)?.state ?? null
}

async function waitFor(predicate, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(250)
  }
  return predicate()
}

function startListeners() {
  for (const target of targets) listeners.set(target.id, spawnListener(target))
}

async function restartListeners() {
  for (const target of targets) {
    await stopListener(listeners.get(target.id), 'SIGKILL')
    listeners.set(target.id, spawnListener(target))
  }
}

function sessionParams(outputDirectoryCapability) {
  const timestamp = '2026-01-01T00:00:00.000Z'
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
        platform: target.platform,
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
  // Each listener takes one connection, so a fresh one is spawned per session.
  const proc = spawn(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      target.listenUrl,
      '-c',
      'copy',
      '-f',
      'null',
      '-'
    ],
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
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        // already gone
      }
      resolveStop()
    }, 2000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolveStop()
    })
    try {
      proc.kill(signal)
    } catch {
      clearTimeout(timer)
      resolveStop()
    }
  })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
