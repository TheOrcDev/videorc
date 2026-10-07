import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Plan 161: one stream destination's ingest closes the connection mid-stream.
//
// 2026-10-07 incident: YouTube closed the RTMP connection eight minutes into a
// four-platform stream. FFmpeg's fifo refused to retry the EOF, finished that
// one output quietly, and the app said "On air" for twenty more minutes.
//
// Two local RTMP listeners (`ffmpeg -listen 1`). After the session is up, the
// victim listener is killed, which closes its socket under the live leg. The
// smoke proves, against the real app:
//   1. the victim is reported (`stream-target-reconnecting` health event and a
//      `reconnecting` stream.targets state) while the other leg stays live;
//   2. when the listener comes back, the leg reconnects by itself
//      (`stream-target-resumed`, state `live`) and the listener receives new
//      video that starts on a keyframe;
//   3. Stop stays inside its budget while a leg is mid-retry, and the local
//      recording finalizes.
//
// No Docker or external services: listeners are plain `ffmpeg -listen 1`.

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-leg-eof-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'videorc-leg-eof-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const ffprobePath = process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const basePort = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 13935)
const warmMs = Number(process.env.VIDEORC_SMOKE_WARM_MS ?? 15000)
const reportBudgetMs = Number(process.env.VIDEORC_SMOKE_REPORT_BUDGET_MS ?? 15000)
const resumeBudgetMs = Number(process.env.VIDEORC_SMOKE_RESUME_BUDGET_MS ?? 20000)
const afterResumeMs = Number(process.env.VIDEORC_SMOKE_AFTER_RESUME_MS ?? 8000)
const stopBudgetMs = Number(process.env.VIDEORC_SMOKE_STOP_BUDGET_MS ?? 15000)
const listenerBindMs = Number(process.env.VIDEORC_SMOKE_LISTENER_BIND_MS ?? 2500)
const finalizationTimeoutMs = Number(process.env.VIDEORC_SMOKE_FINALIZATION_TIMEOUT_MS ?? 30000)

const targets = [
  { id: 'youtube', label: 'YouTube', victim: true },
  { id: 'twitch', label: 'Twitch', victim: false }
].map((platform, index) => {
  const listenPort = basePort + index
  const streamKey = `legeof${index}`
  return {
    ...platform,
    listenPort,
    streamKey,
    serverUrl: `rtmp://127.0.0.1:${listenPort}/live`,
    listenUrl: `rtmp://127.0.0.1:${listenPort}/live/${streamKey}`,
    recvPath: join(outputDirectory, `recv-${listenPort}.flv`),
    recvAfterPath: join(outputDirectory, `recv-${listenPort}-after.flv`)
  }
})
const victim = targets.find((target) => target.victim)
const healthy = targets.find((target) => !target.victim)

mkdirSync(outputDirectory, { recursive: true })

let stopping = false
let stopApp = async () => {}
const listeners = new Map()
const healthEvents = []
const targetSnapshots = []
const failures = []

try {
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    onLine: (line) => console.log(line)
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
    if (message?.event === 'health.event' && message.payload?.code) {
      healthEvents.push(message.payload)
      if (String(message.payload.code).startsWith('stream-target')) {
        console.log(`  [health] ${message.payload.code}: ${message.payload.message}`)
      }
    }
    if (message?.event === 'stream.targets' && Array.isArray(message.payload?.targets)) {
      targetSnapshots.push(message.payload.targets)
    }
  })

  try {
    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the leg EOF smoke.')
    }
    const recordingDirectory = await requestSmokeCommand(
      smoke,
      'authorize-smoke-resource',
      { kind: 'output-directory', path: outputDirectory },
      { timeoutMs }
    )

    for (const target of targets) {
      listeners.set(target.id, spawnListener(target, target.recvPath))
    }
    await sleep(listenerBindMs)

    const started = await request(
      ws,
      timeoutMs,
      'session.start',
      sessionParams(recordingDirectory.capabilityId)
    )
    if (started.state !== 'recording') {
      throw new Error(`Expected recording state after start, got ${started.state}.`)
    }
    console.log(`Session up; streaming ${warmMs}ms before ${victim.label}'s ingest closes.`)
    await sleep(warmMs)
    await assertSessionRunning(ws, 'before the ingest closed')

    // 1. The ingest closes the connection under the live leg.
    const closedAt = Date.now()
    console.log(`[eof] closing ${victim.label}'s ingest (SIGKILL its listener)`)
    await stopListener(listeners.get(victim.id), 'SIGKILL')
    listeners.delete(victim.id)

    const reported = await waitFor(
      () =>
        latestState(victim.id) === 'reconnecting' &&
        healthEvents.some(
          (event) =>
            event.code === 'stream-target-reconnecting' &&
            String(event.message).includes(victim.label)
        ),
      reportBudgetMs
    )
    if (reported) {
      console.log(
        `  ✓ ${victim.label} reported reconnecting ${Date.now() - closedAt}ms after its ingest closed`
      )
    } else {
      failures.push(
        `${victim.label} was not reported reconnecting within ${reportBudgetMs}ms ` +
          `(state ${latestState(victim.id) ?? 'absent'})`
      )
    }
    if (latestState(healthy.id) === 'live') {
      console.log(`  ✓ ${healthy.label} stayed live`)
    } else {
      failures.push(`${healthy.label} should stay live, got ${latestState(healthy.id) ?? 'absent'}`)
    }
    await assertSessionRunning(ws, 'after the ingest closed')

    // 2. The ingest comes back: the leg must reconnect by itself.
    listeners.set(victim.id, spawnListener(victim, victim.recvAfterPath))
    const reopenedAt = Date.now()
    const resumed = await waitFor(
      () =>
        latestState(victim.id) === 'live' &&
        healthEvents.some((event) => event.code === 'stream-target-resumed'),
      resumeBudgetMs
    )
    if (resumed) {
      console.log(
        `  ✓ ${victim.label} resumed ${Date.now() - reopenedAt}ms after its ingest came back`
      )
    } else {
      failures.push(
        `${victim.label} did not resume within ${resumeBudgetMs}ms ` +
          `(state ${latestState(victim.id) ?? 'absent'})`
      )
    }
    await sleep(afterResumeMs)

    // 3. Close it again right before Stop: Stop must not wait on the retries.
    await stopListener(listeners.get(victim.id), 'SIGKILL')
    listeners.delete(victim.id)
    await sleep(3000)
    const stopStartedAt = Date.now()
    const stopped = await request(ws, timeoutMs, 'session.stop')
    const stopMs = Date.now() - stopStartedAt
    if (stopMs <= stopBudgetMs) {
      console.log(`  ✓ Stop returned in ${stopMs}ms with a leg mid-retry`)
    } else {
      failures.push(`Stop took ${stopMs}ms with a leg mid-retry (budget ${stopBudgetMs}ms)`)
    }
    await sleep(2000)

    const afterBytes = fileSize(victim.recvAfterPath)
    if (afterBytes > 0) {
      console.log(`  ✓ ${victim.label}'s ingest received ${afterBytes} bytes after reconnecting`)
      const firstVideoKeyframe = firstVideoPacketIsKeyframe(victim.recvAfterPath)
      if (firstVideoKeyframe === true) {
        console.log('  ✓ the reconnected stream starts on a keyframe')
      } else if (firstVideoKeyframe === false) {
        failures.push('the reconnected stream does not start on a keyframe')
      } else {
        console.log('  • could not read the reconnected stream’s first packet (ffprobe)')
      }
    } else {
      failures.push(`${victim.label}'s ingest received nothing after reconnecting`)
    }
    const healthyBytes = fileSize(healthy.recvPath)
    if (healthyBytes > 0) {
      console.log(`  ✓ ${healthy.label} received ${healthyBytes} bytes throughout`)
    } else {
      failures.push(`${healthy.label} received no bytes`)
    }
    if (stopped.state === 'failed') {
      failures.push(`the session was marked failed: ${stopped.message ?? 'no message'}`)
    }
    const recording = await waitForFinalRecording(stopped.outputPath ?? started.outputPath)
    if (recording && fileSize(recording) > 0) {
      console.log(`  ✓ local recording finalized: ${recording}`)
    } else {
      failures.push(`the local recording did not finalize (${recording ?? 'no path'})`)
    }
  } finally {
    ws.close()
  }
} finally {
  stopping = true
  for (const listener of listeners.values()) {
    await stopListener(listener, 'SIGTERM')
  }
  await stopApp()
}

if (failures.length > 0) {
  console.error(`Stream leg EOF smoke failed:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log('Stream leg EOF smoke passed.')

async function assertSessionRunning(ws, when) {
  const status = await request(ws, timeoutMs, 'recording.status')
  if (status.state !== 'recording' && status.state !== 'streaming') {
    throw new Error(`The session ended ${when} (state ${status.state}): ${status.message ?? ''}`)
  }
}

function latestState(targetId) {
  const latest = targetSnapshots.at(-1)
  return latest?.find((entry) => entry.targetId === targetId)?.state ?? null
}

async function waitFor(predicate, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await sleep(250)
  }
  return predicate()
}

function fileSize(path) {
  return path && existsSync(path) ? statSync(path).size : 0
}

function firstVideoPacketIsKeyframe(path) {
  try {
    const output = execFileSync(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=flags',
        '-read_intervals',
        '%+#1',
        '-of',
        'csv=p=0',
        path
      ],
      { encoding: 'utf8' }
    )
    const flags = output.split('\n').find((line) => line.trim())
    return flags === undefined ? null : flags.includes('K')
  } catch {
    return null
  }
}

// Since instant stop the published artifact is the MP4 a background job
// exports after the terminal status; the MKV is final only if no export
// replaces it before the deadline.
async function waitForFinalRecording(reportedPath) {
  if (!reportedPath) {
    return reportedPath
  }
  const mp4 = reportedPath.replace(/\.mkv$/i, '.mp4')
  const deadline = Date.now() + finalizationTimeoutMs
  while (Date.now() < deadline) {
    if (fileSize(mp4) > 0) {
      return mp4
    }
    await sleep(500)
  }
  return fileSize(reportedPath) > 0 ? reportedPath : mp4
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

function spawnListener(target, recvPath) {
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
      'flv',
      recvPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (text) => {
    if (stopping) {
      return
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        console.error(`[listener :${target.listenPort}] ${line}`)
      }
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
