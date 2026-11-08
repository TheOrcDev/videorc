import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { buttonLabels, startFakeDiscord } from './lib/fake-discord-webhook.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Plan 187: the Discord go-live announcement, end to end against the real dev
// app and a local fake of Discord's webhook API (scripts/lib/fake-discord-
// webhook.mjs, reached through the dev-only VIDEORC_DISCORD_API_BASE_URL).
// Two webhooks stand in for two servers ("alerts" and "crew"), and two local
// RTMP listeners (`ffmpeg -listen 1`) for Twitch and a custom destination,
// each with a typed public link. The smoke proves:
//   1. a pasted webhook is verified and only its masked tail comes back; a
//      second one joins the list, a re-paste replaces instead of duplicating;
//   2. "Send test message" posts to the one webhook asked and never pings;
//   3. Go Live posts exactly once per webhook, pinging as chosen, after the
//      destinations stay live, with a button per destination (a coalesced
//      edit adds a late one), and each "View in Discord" link names its own
//      server;
//   4. a leg that reconnects never posts again;
//   5. Stop edits both messages to "Was live";
//   6. going live again inside the restart window edits both back, with no
//      new post;
//   7. a session whose destinations are all unticked sends nothing;
//   8. a deleted message falls back to one fresh post, a deleted webhook is
//      reported once (on its own row) and never retried, and the other
//      webhook keeps posting through it all;
//   9. removing one webhook keeps the other posting;
//  10. neither webhook token ever reaches the app log or a renderer event.

const WEBHOOKS = {
  alerts: {
    webhookId: '123456789012345678',
    token: 'SmokeT0ken_shouldNeverLeak-0123456789abcdef',
    name: 'Smoke alerts'
  },
  crew: {
    webhookId: '223456789012345678',
    token: 'CrewT0ken_shouldNeverLeak-fedcba9876543210',
    name: 'Smoke crew'
  }
}
const webhookUrl = (webhook) =>
  `https://discord.com/api/webhooks/${webhook.webhookId}/${webhook.token}`
const ALERTS = WEBHOOKS.alerts.webhookId
const CREW = WEBHOOKS.crew.webhookId

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
const fake = await startFakeDiscord({ webhooks: [WEBHOOKS.alerts, WEBHOOKS.crew] })
const fakeAlerts = fake.webhooks[0]
const fakeCrew = fake.webhooks[1]

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

    // 1. Paste the webhooks.
    console.log('[1] paste the webhooks')
    const saved = await request(ws, timeoutMs, 'discord.webhook.save', {
      url: webhookUrl(WEBHOOKS.alerts)
    })
    check(saved.webhooks?.length === 1, 'the webhook is saved')
    check(saved.webhooks?.[0]?.id === ALERTS, 'it is named by its Discord id')
    check(
      saved.webhooks?.[0]?.name === WEBHOOKS.alerts.name,
      `Discord's name for it shows (${saved.webhooks?.[0]?.name})`
    )
    check(
      saved.webhooks?.[0]?.hint === `…/${WEBHOOKS.alerts.token.slice(-4)}`,
      `only the masked tail comes back (${saved.webhooks?.[0]?.hint})`
    )
    check(
      !JSON.stringify(saved).includes(WEBHOOKS.alerts.token),
      'the snapshot never carries the token'
    )
    const both = await request(ws, timeoutMs, 'discord.webhook.save', {
      url: webhookUrl(WEBHOOKS.crew)
    })
    check(
      both.webhooks?.map((webhook) => webhook.id).join(',') === `${ALERTS},${CREW}`,
      'a second webhook joins the list after the first'
    )
    check(both.webhooks?.[1]?.name === WEBHOOKS.crew.name, 'the second one has its own name')
    const repasted = await request(ws, timeoutMs, 'discord.webhook.save', {
      url: webhookUrl(WEBHOOKS.alerts)
    })
    check(
      repasted.webhooks?.map((webhook) => webhook.id).join(',') === `${ALERTS},${CREW}`,
      'pasting a saved webhook again replaces it instead of adding a copy'
    )
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

    // 2. The test message, to one webhook.
    console.log('[2] send a test message')
    const beforeCrew = fake.announcements(CREW).length
    const beforeAlerts = fake.announcements(ALERTS).length
    const tested = await request(ws, timeoutMs, 'discord.webhook.sendTest', {
      targets: linkTargets(),
      webhookId: CREW
    })
    const testPost = fake.announcements(CREW)[beforeCrew]
    check(testPost?.method === 'POST', 'the test message is posted to the webhook asked')
    check(
      fake.announcements(ALERTS).length === beforeAlerts,
      'the other webhook gets no test message'
    )
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
    check(
      String(tested?.messageUrl ?? '').startsWith(
        `https://discord.com/channels/${fakeCrew.guildId}/${fakeCrew.channelId}/`
      ),
      `the test's link names that webhook's server (${tested?.messageUrl})`
    )

    // 3. Go live.
    console.log('[3] go live')
    startListeners()
    await sleep(listenerBindMs)
    let marks = markAll()
    await startSession(ws, smoke)
    const firstPosts = await Promise.all([
      waitForAnnouncement(ALERTS, marks[ALERTS], postBudgetMs),
      waitForAnnouncement(CREW, marks[CREW], postBudgetMs)
    ])
    check(
      firstPosts.every((post) => post?.method === 'POST'),
      'Go Live posts to every webhook'
    )
    check(
      firstPosts.every((post) =>
        String(post?.body?.content ?? '').startsWith('@everyone Live now: Discord smoke stream')
      ),
      `the posts ping and name the stream (${firstPosts[0]?.body?.content})`
    )
    check(
      firstPosts.every(
        (post) => JSON.stringify(post?.body?.allowed_mentions) === '{"parse":["everyone"]}'
      ),
      'the posts are allowed to ping @everyone'
    )
    await sleep(6000)
    for (const [label, id] of [
      ['alerts', ALERTS],
      ['crew', CREW]
    ]) {
      const live = fake.announcements(id).slice(marks[id])
      const latestLabels = buttonLabels(live.at(-1)?.body)
      check(
        live.filter((entry) => entry.method === 'POST').length === 1,
        `exactly one post for the session on ${label}`
      )
      check(
        latestLabels.includes('Twitch') && latestLabels.includes('Smoke site'),
        `every destination ends up linked on ${label} (${latestLabels.join(', ')})`
      )
      check(
        live.slice(1).every((entry) => entry.body?.allowed_mentions?.parse?.length === 0),
        `edits never ping on ${label}`
      )
    }
    const posted = await request(ws, timeoutMs, 'discord.announce.get')
    const lastPostOf = (id) => posted.webhooks?.find((webhook) => webhook.id === id)?.lastPost
    check(
      String(lastPostOf(ALERTS)?.messageUrl ?? '').startsWith(
        `https://discord.com/channels/${fakeAlerts.guildId}/${fakeAlerts.channelId}/`
      ) &&
        String(lastPostOf(CREW)?.messageUrl ?? '').startsWith(
          `https://discord.com/channels/${fakeCrew.guildId}/${fakeCrew.channelId}/`
        ),
      'each webhook remembers its own last post in its own server'
    )
    check(
      lastPostOf(ALERTS)?.state === 'live' && lastPostOf(CREW)?.state === 'live',
      'both last posts are live'
    )

    // 4. A leg reconnects.
    console.log('[4] a leg reconnects')
    marks = markAll()
    await stopListener(listeners.get('twitch'), 'SIGKILL')
    listeners.delete('twitch')
    await waitFor(() => latestState('twitch') === 'reconnecting', 15000)
    listeners.set('twitch', spawnListener(targets[0]))
    await waitFor(() => latestState('twitch') === 'live', 25000)
    await sleep(12000)
    check(
      fake
        .announcements()
        .slice(marks.all)
        .every((entry) => entry.method !== 'POST'),
      'a reconnect never posts again, on either webhook'
    )

    // 5. Stop.
    console.log('[5] stop')
    marks = markAll()
    await stopSession(ws)
    const ended = await Promise.all([
      waitForAnnouncement(ALERTS, marks[ALERTS], 20000),
      waitForAnnouncement(CREW, marks[CREW], 20000)
    ])
    check(
      ended.every(
        (edit) =>
          edit?.method === 'PATCH' && String(edit?.body?.content ?? '').startsWith('Was live: ')
      ),
      `Stop edits both messages to "Was live" (${ended[0]?.body?.content})`
    )

    // 6. Go live again inside the restart window.
    console.log('[6] go live again within 15 minutes')
    await restartListeners()
    await sleep(listenerBindMs)
    marks = markAll()
    await startSession(ws, smoke)
    const revived = await Promise.all([
      waitForAnnouncement(ALERTS, marks[ALERTS], postBudgetMs),
      waitForAnnouncement(CREW, marks[CREW], postBudgetMs)
    ])
    check(
      revived.every(
        (edit) => edit?.method === 'PATCH' && String(edit?.body?.content ?? '').includes('Live now')
      ),
      'a quick restart edits both last messages back to live'
    )
    check(
      revived.every((edit) => JSON.stringify(edit?.body?.allowed_mentions) === '{"parse":[]}'),
      'the restart does not ping again'
    )
    await sleep(4000)
    await stopSession(ws)
    await Promise.all([
      waitForAnnouncement(ALERTS, fake.announcements(ALERTS).length - 1, 20000),
      waitForAnnouncement(CREW, fake.announcements(CREW).length - 1, 20000)
    ])
    await sleep(3000)
    check(
      fake
        .announcements()
        .slice(marks.all)
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
    const quiet = fake.requests.length
    await startSession(ws, smoke)
    await sleep(15000)
    await stopSession(ws)
    await sleep(3000)
    check(fake.requests.length === quiet, 'a session with nothing ticked sends nothing')
    await request(ws, timeoutMs, 'discord.announce.update', { excludedTargetIds: [] })

    // 8. The message, then the webhook, deleted in Discord: on "alerts" only.
    console.log('[8] deleted in Discord on one webhook')
    fake.script('PATCH', 404, { message: 'Unknown Message', code: 10008 }, { webhookId: ALERTS })
    fake.script('POST', 404, { message: 'Unknown Webhook', code: 10015 }, { webhookId: ALERTS })
    await restartListeners()
    await sleep(listenerBindMs)
    marks = markAll()
    const snapshotsBefore = discordSnapshots.length
    await startSession(ws, smoke)
    await waitFor(() => fake.announcements(ALERTS).length >= marks[ALERTS] + 2, postBudgetMs)
    const crewRevived = await waitForAnnouncement(CREW, marks[CREW], postBudgetMs)
    await sleep(8000)
    const deletion = fake.announcements(ALERTS).slice(marks[ALERTS])
    check(
      deletion.map((entry) => entry.method).join(',') === 'PATCH,POST',
      `a deleted message falls back to one fresh post (${deletion.map((entry) => entry.method).join(',')})`
    )
    const reported = discordSnapshots
      .slice(snapshotsBefore)
      .filter((snapshot) =>
        snapshot.webhooks?.some(
          (webhook) => webhook.id === ALERTS && webhook.lastError?.code === 'webhook-deleted'
        )
      )
    check(reported.length > 0, 'a deleted webhook is reported on its own row')
    check(
      reported.every((snapshot) =>
        snapshot.webhooks?.some((webhook) => webhook.id === CREW && !webhook.lastError)
      ),
      'the other webhook carries no failure'
    )
    check(deletion.length === 2, 'a deleted webhook is never retried')
    check(
      crewRevived?.method === 'PATCH' &&
        String(crewRevived?.body?.content ?? '').includes('Live now'),
      'the other webhook still revives its message while this one fails'
    )
    const crewMark = fake.announcements(CREW).length
    await stopSession(ws)
    const crewEnded = await waitForAnnouncement(CREW, crewMark, 20000)
    check(
      crewEnded?.method === 'PATCH' &&
        String(crewEnded?.body?.content ?? '').startsWith('Was live: '),
      'the other webhook still gets its "Was live" edit'
    )
    await sleep(2000)
    check(
      fake.announcements(ALERTS).length === marks[ALERTS] + 2,
      'nothing more goes to the deleted webhook'
    )

    // 9. Remove the deleted webhook; the other keeps posting.
    console.log('[9] remove one webhook')
    const removed = await request(ws, timeoutMs, 'discord.webhook.remove', {
      webhookId: ALERTS
    })
    check(
      removed.webhooks?.map((webhook) => webhook.id).join(',') === CREW,
      'removing one webhook keeps the other'
    )
    check(
      removed.webhooks?.[0]?.lastPost?.state === 'ended',
      'the kept webhook keeps its last post'
    )
    let removedAgain = null
    try {
      await request(ws, timeoutMs, 'discord.webhook.remove', { webhookId: ALERTS })
    } catch (error) {
      removedAgain = error
    }
    check(
      String(removedAgain?.message ?? '').includes('already removed'),
      'removing it again is refused, not ignored'
    )
    await restartListeners()
    await sleep(listenerBindMs)
    marks = markAll()
    await startSession(ws, smoke)
    const crewOnly = await waitForAnnouncement(CREW, marks[CREW], postBudgetMs)
    check(
      crewOnly?.method === 'PATCH' && String(crewOnly?.body?.content ?? '').includes('Live now'),
      'the kept webhook announces the next stream'
    )
    await sleep(4000)
    await stopSession(ws)
    await waitForAnnouncement(CREW, fake.announcements(CREW).length - 1, 20000)
    await sleep(2000)
    check(fake.announcements(ALERTS).length === marks[ALERTS], 'the removed webhook gets nothing')
  } finally {
    ws.close()
  }
} finally {
  stopping = true
  for (const listener of listeners.values()) await stopListener(listener, 'SIGTERM')
  await stopApp()
  await fake.close()
}

// 10. The tokens never leak.
for (const webhook of Object.values(WEBHOOKS)) {
  check(
    !appLines.some((line) => line.includes(webhook.token)),
    `the ${webhook.name} token never reaches the app log`
  )
  check(
    !wireMessages.some((message) => message.includes(webhook.token)),
    `the ${webhook.name} token never reaches a renderer event or answer`
  )
}

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

/** Where each webhook's announcements stand now, to slice what comes next. */
function markAll() {
  return {
    [ALERTS]: fake.announcements(ALERTS).length,
    [CREW]: fake.announcements(CREW).length,
    all: fake.announcements().length
  }
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

async function waitForAnnouncement(webhookId, after, budgetMs) {
  await waitFor(() => fake.announcements(webhookId).length > after, budgetMs)
  return fake.announcements(webhookId)[after] ?? null
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
      // The stream's own profile (stream-safe-1080p30 below): a computer that
      // runs one encode for both (Linux, and any host without a second
      // encoder) refuses a recording that differs from the stream.
      video: { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 },
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
