import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { analyzeRecording } from './lib/recording-analyzer.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

// Endurance proof for the multi-platform fan-out under REAL downstream
// trouble (2026-07-15 owner incident: two 3-platform live sessions died
// minutes in with "stream encoder output exceeded its bounded latency
// contract" / "Encoder FIFO write exceeded the complete-frame delivery
// budget", and the healthy multi-minute recordings were marked failed).
//
// Two sessions against three local RTMP listeners:
//
//   Session A — jitter tolerance. One leg sits behind a TCP proxy that
//   periodically stops reading (a platform-side network stall), and the
//   session FFmpeg is frozen (SIGSTOP) once for half a second — a transient
//   downstream hiccup. The session must run to its planned stop and
//   complete: transient pressure degrades the stream, never kills it.
//
//   Session B — stream-death honesty. The session FFmpeg is frozen for
//   several seconds, past the sustained-violation window, so the stream
//   output legitimately dies. The session must NOT be marked failed: the
//   local recording finalizes healthy and a `stream-output-failed` health
//   event tells the truth about the stream.
//
// No Docker or external services: listeners are plain `ffmpeg -listen 1`.

const outputDirectory = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ?? join(tmpdir(), `videorc-ms-endurance-${Date.now()}`)
)
const userDataDir =
  process.env.VIDEORC_USER_DATA_DIR ??
  mkdtempSync(join(tmpdir(), 'videorc-ms-endurance-user-data-'))
const ffmpegPath = process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const basePort = Number(process.env.VIDEORC_SMOKE_RTMP_PORT ?? 12935)
// Session A duration; the release endurance run passes 600000.
const streamMs = Number(process.env.VIDEORC_SMOKE_STREAM_MS ?? 60000)
const listenerBindMs = Number(process.env.VIDEORC_SMOKE_LISTENER_BIND_MS ?? 2500)
// Network stall profile for the proxied leg in session A.
const stallEveryMs = Number(process.env.VIDEORC_SMOKE_STALL_EVERY_MS ?? 15000)
const stallForMs = Number(process.env.VIDEORC_SMOKE_STALL_FOR_MS ?? 4000)
// FFmpeg freeze lengths: transient (must survive) and fatal (stream may die,
// session must still complete with the recording preserved).
const transientFreezeMs = Number(process.env.VIDEORC_SMOKE_TRANSIENT_FREEZE_MS ?? 500)
const fatalFreezeMs = Number(process.env.VIDEORC_SMOKE_FATAL_FREEZE_MS ?? 6000)

const TARGETS = [
  { id: 'youtube', label: 'YouTube', stalled: false },
  { id: 'twitch', label: 'Twitch', stalled: false },
  // The X leg is the jittery one in the incident (rtmps across the ocean).
  { id: 'x', label: 'X (stalling)', stalled: true }
]

const targets = TARGETS.map((platform, index) => {
  const listenPort = basePort + index
  const proxyPort = platform.stalled ? basePort + 100 + index : null
  const streamKey = `endurance${index}`
  return {
    ...platform,
    listenPort,
    proxyPort,
    streamKey,
    serverUrl: `rtmp://127.0.0.1:${proxyPort ?? listenPort}/live`,
    listenUrl: `rtmp://127.0.0.1:${listenPort}/live/${streamKey}`,
    recvPath: join(outputDirectory, `recv-${listenPort}.flv`)
  }
})

mkdirSync(outputDirectory, { recursive: true })

let stopping = false
let stopApp = async () => {}
let appRootPid = null
const listeners = []
const proxies = []
const healthEvents = []
const targetSnapshots = []
let stallCycles = 0

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
  appRootPid = launch.process?.pid ?? null
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
    }
    if (message?.event === 'stream.targets' && Array.isArray(message.payload?.targets)) {
      targetSnapshots.push(message.payload.targets)
    }
  })

  try {
    const health = await request(ws, timeoutMs, 'health.ping', { ffmpegPath })
    if (!health?.ffmpeg?.available) {
      throw new Error(health?.ffmpeg?.message ?? 'FFmpeg is unavailable for the endurance smoke.')
    }
    const recordingDirectory = await requestSmokeCommand(
      smoke,
      'authorize-smoke-resource',
      { kind: 'output-directory', path: outputDirectory },
      { timeoutMs }
    )

    // ---------- Session A: jitter tolerance ----------
    for (const target of targets) {
      listeners.push(spawnListener(target))
      if (target.proxyPort) {
        proxies.push(await startStallProxy(target))
      }
    }
    console.log(
      `Session A: ${targets.length} legs; ${stallForMs}ms network stall on ` +
        `${targets.find((t) => t.stalled).label} every ${stallEveryMs}ms; one ` +
        `${transientFreezeMs}ms FFmpeg freeze mid-run.`
    )
    await sleep(listenerBindMs)

    const startedA = await request(
      ws,
      timeoutMs,
      'session.start',
      sessionParams(recordingDirectory.capabilityId)
    )
    if (startedA.state !== 'recording') {
      throw new Error(`Expected recording state after start, got ${startedA.state}.`)
    }

    let froze = false
    const deadlineA = Date.now() + streamMs
    while (Date.now() < deadlineA) {
      await sleep(2000)
      const status = await request(ws, timeoutMs, 'recording.status')
      if (status.state !== 'recording' && status.state !== 'streaming') {
        throw new Error(
          `SESSION A DIED ${Math.round((Date.now() - (deadlineA - streamMs)) / 1000)}s in ` +
            `(state ${status.state}) after ${stallCycles} stall cycle(s): ${status.message ?? 'no message'}`
        )
      }
      if (!froze && Date.now() > deadlineA - streamMs / 2) {
        froze = true
        freezeSessionFfmpeg(transientFreezeMs)
      }
    }
    const stoppedA = await request(ws, timeoutMs, 'session.stop')
    await sleep(2000)
    console.log(
      `Session A survived ${stallCycles} network stall(s) + a ${transientFreezeMs}ms freeze.`
    )
    await verifySessionA(stoppedA.outputPath ?? startedA.outputPath)

    // ---------- Session B: stream-death honesty ----------
    console.log(`Session B: one fatal ${fatalFreezeMs}ms FFmpeg freeze — the stream may die; the`)
    console.log('recording must be preserved and the failure reported honestly.')
    healthEvents.length = 0
    // Output-directory capabilities are single-use — session B needs its own.
    const recordingDirectoryB = await requestSmokeCommand(
      smoke,
      'authorize-smoke-resource',
      { kind: 'output-directory', path: outputDirectory },
      { timeoutMs }
    )
    // `ffmpeg -listen 1` sinks accept exactly ONE publisher — respawn fresh
    // listeners so session B's legs actually connect.
    for (const listener of listeners.splice(0)) {
      await stopListener(listener)
    }
    for (const target of targets) {
      listeners.push(spawnListener(target))
    }
    await sleep(listenerBindMs)
    const startedB = await request(
      ws,
      timeoutMs,
      'session.start',
      sessionParams(recordingDirectoryB.capabilityId)
    )
    if (startedB.state !== 'recording') {
      throw new Error(`Expected recording state for session B, got ${startedB.state}.`)
    }
    await sleep(8000)
    freezeSessionFfmpeg(fatalFreezeMs)
    // Give the watchdogs time to trip and the exit handler time to finalize.
    const settleDeadline = Date.now() + fatalFreezeMs + 30000
    let finalB = null
    while (Date.now() < settleDeadline) {
      await sleep(2000)
      const status = await request(ws, timeoutMs, 'recording.status')
      if (status.state !== 'recording' && status.state !== 'streaming') {
        finalB = status
        break
      }
    }
    let endedEarly = true
    if (!finalB) {
      // The stream survived the freeze entirely — also a pass; stop cleanly.
      endedEarly = false
      finalB = await request(ws, timeoutMs, 'session.stop')
      console.log('  • Session B survived the fatal freeze without stream death.')
    }
    await sleep(2000)
    // Terminal recording.status snapshots do not carry the artifact path —
    // fall back to the path reported at start.
    if (!finalB.outputPath) {
      finalB = { ...finalB, outputPath: startedB.outputPath }
    }
    await verifySessionB(finalB, endedEarly)
  } finally {
    ws.close()
  }
} finally {
  stopping = true
  for (const proxy of proxies) {
    await proxy.close()
  }
  for (const listener of listeners) {
    await stopListener(listener)
  }
  await stopApp()
}

async function verifySessionA(outputPath) {
  const failures = []
  for (const target of targets) {
    const size = existsSync(target.recvPath) ? statSync(target.recvPath).size : 0
    if (size > 0) {
      console.log(`  ✓ ${target.label} (:${target.listenPort}) received ${size} bytes`)
    } else if (target.stalled) {
      const latest = targetSnapshotsLatestState(target.id)
      console.log(`  • ${target.label} no bytes; final reported state: ${latest ?? 'absent'}`)
      if (latest !== 'failed' && latest !== 'live') {
        failures.push(`stalled leg has no honest final state (${latest ?? 'absent'})`)
      }
    } else {
      failures.push(`healthy leg ${target.label} received no bytes`)
    }
  }
  await verifyRecording(outputPath, failures)
  if (failures.length > 0) {
    throw new Error(`Session A failed: ${failures.join('; ')}`)
  }
  console.log('  ✓ Session A: jitter degraded gracefully, everything survived.')
}

async function verifySessionB(finalStatus, endedEarly) {
  const failures = []
  if (finalStatus.state === 'failed') {
    failures.push(
      `session B was marked FAILED (${finalStatus.message ?? 'no message'}) — the recording was condemned for a stream failure`
    )
  }
  await verifyRecording(finalStatus.outputPath, failures)
  if (endedEarly) {
    // The stream died — the reason must be an explicit, user-visible event,
    // never silence (the incident sessions had zero warnings before death).
    const reported = healthEvents.some((event) =>
      String(event.code ?? '').includes('stream-output-failed')
    )
    if (reported) {
      console.log('  ✓ stream-output-failed health event reported the dead stream honestly')
    } else {
      failures.push('the stream died without a stream-output-failed health event')
    }
  }
  if (failures.length > 0) {
    throw new Error(`Session B failed: ${failures.join('; ')}`)
  }
  console.log(
    `  ✓ Session B: state "${finalStatus.state}" with the recording preserved — a dead stream no longer kills the session.`
  )
}

async function verifyRecording(outputPath, failures) {
  const recordingSize = outputPath && existsSync(outputPath) ? statSync(outputPath).size : 0
  if (recordingSize > 0) {
    const quality = await analyzeRecording(outputPath, {
      ffmpegPath,
      ffprobePath: process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? 'ffprobe',
      intendedFps: 30,
      expectAudio: false,
      gates: {
        requireMotion: false,
        avSyncTargetMs: Number.POSITIVE_INFINITY,
        avSyncHardFailMs: Number.POSITIVE_INFINITY,
        // Freezes legitimately drop frames; timestamp sanity is the gate.
        frameCountTolerance: Number.POSITIVE_INFINITY,
        maxDurationStretchRatio: Number.POSITIVE_INFINITY
      }
    })
    if (quality.verdict.pass) {
      console.log(`  ✓ Recording finalized healthy: ${outputPath} (${recordingSize} bytes)`)
    } else {
      failures.push(`recording failed quality gates: ${quality.verdict.failures.join('; ')}`)
    }
  } else {
    failures.push(`recording did not finalize (${outputPath ?? 'no path'})`)
  }
}

function targetSnapshotsLatestState(targetId) {
  const latest = targetSnapshots.at(-1)
  return latest?.find((entry) => entry.targetId === targetId)?.state ?? null
}

// SIGSTOP the session's FFmpeg (a descendant of the app we launched) for
// `freezeMs` — the deterministic twin of "the downstream muxer stopped
// draining". Walks only OUR OWN launched process tree; the harness's local
// listener FFmpegs are children of this Node process, never of the app.
function freezeSessionFfmpeg(freezeMs) {
  const pids = findDescendantFfmpegPids(appRootPid)
  if (pids.length === 0) {
    throw new Error('No session FFmpeg found under the app process tree to freeze.')
  }
  console.log(`  [freeze] SIGSTOP ${pids.join(', ')} for ${freezeMs}ms`)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGSTOP')
    } catch {
      // raced its exit — the freeze becomes a no-op for that pid
    }
  }
  setTimeout(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGCONT')
      } catch {
        // already gone
      }
    }
  }, freezeMs)
}

function findDescendantFfmpegPids(rootPid) {
  if (!rootPid) {
    return []
  }
  const ffmpegPids = []
  const queue = [rootPid]
  const seen = new Set()
  while (queue.length > 0) {
    const pid = queue.shift()
    if (seen.has(pid)) {
      continue
    }
    seen.add(pid)
    let children = ''
    try {
      children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    } catch {
      continue // no children
    }
    for (const line of children.split('\n')) {
      const child = Number(line.trim())
      if (!Number.isFinite(child) || child <= 0) {
        continue
      }
      queue.push(child)
      let command = ''
      try {
        command = execFileSync('ps', ['-p', String(child), '-o', 'comm='], {
          encoding: 'utf8'
        }).trim()
      } catch {
        continue
      }
      if (command.endsWith('/ffmpeg') || command === 'ffmpeg') {
        ffmpegPids.push(child)
      }
    }
  }
  return ffmpegPids
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

// TCP proxy that periodically stops reading from the publisher so the
// app-side socket genuinely backs up (kernel buffers fill, writes block) —
// the deterministic loopback twin of a platform-side ingest stall.
function startStallProxy(target) {
  const sockets = new Set()
  const server = net.createServer((client) => {
    const upstream = net.connect(target.listenPort, '127.0.0.1')
    sockets.add(client)
    sockets.add(upstream)
    client.pipe(upstream)
    upstream.pipe(client)
    const stallTimer = setInterval(() => {
      if (stopping || client.destroyed) {
        return
      }
      stallCycles += 1
      console.log(
        `[stall-proxy :${target.proxyPort}] cycle ${stallCycles}: pausing reads for ${stallForMs}ms`
      )
      client.pause()
      setTimeout(() => {
        if (!client.destroyed) {
          client.resume()
        }
      }, stallForMs)
    }, stallEveryMs)
    const cleanup = () => {
      clearInterval(stallTimer)
      sockets.delete(client)
      sockets.delete(upstream)
      client.destroy()
      upstream.destroy()
    }
    client.on('close', cleanup)
    client.on('error', cleanup)
    upstream.on('close', cleanup)
    upstream.on('error', cleanup)
  })
  return new Promise((resolveProxy, rejectProxy) => {
    server.once('error', rejectProxy)
    server.listen(target.proxyPort, '127.0.0.1', () => {
      resolveProxy({
        close: () =>
          new Promise((resolveClose) => {
            for (const socket of sockets) {
              socket.destroy()
            }
            server.close(() => resolveClose())
          })
      })
    })
  })
}

function spawnListener(target) {
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
      target.recvPath
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

function stopListener(proc) {
  return new Promise((resolveStop) => {
    if (!proc?.pid || proc.killed) {
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
      proc.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      resolveStop()
    }
  })
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
