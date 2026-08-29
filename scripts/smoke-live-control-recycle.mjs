#!/usr/bin/env node

// End-to-end regression for the 2026-08-27 operator-control outage. A real
// renderer WebSocket dispatches a smoke-only LiveControl command that never
// completes. The production 10-second execution watchdog must latch retirement
// of that backend generation, safe recording finalization must keep both old
// processes alive even when it takes longer than the old 30-second kill edge,
// then Electron must launch a different exact PID that answers an authenticated
// command and exposes the analyzed, completed recording.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import WebSocket from 'ws'

import { launchDevApp, stopProcess } from './lib/app-launcher.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import { waitForOwnedTcpListener } from './lib/live-control-recycle-smoke.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import {
  appQuitRecordingSessionParams,
  createExecutableFfmpegShim,
  createFinalizationBarrierServer,
  finalizationBarrierEnvironment,
  readFinalizationRecoveryRecords,
  readSessionRow,
  resolveToolPath
} from './smoke-app-quit-recording-finalization.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const BLOCK_METHOD = 'test.commandLanes.liveControl.block'
const STATUS_METHOD = 'test.commandLanes.accountMaintenance.status'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120_000)
const replacementBudgetMs = 25_000
const minimumFinalizationHoldMs = 30_000
const finalizationHoldMs = Number(
  process.env.VIDEORC_LIVE_CONTROL_FINALIZATION_HOLD_MS ?? minimumFinalizationHoldMs + 1_000
)
const pollMs = 100
const stateRoot = resolve(
  process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
    mkdtempSync(join(tmpdir(), 'videorc-live-control-recycle-'))
)
const outputDirectory = join(stateRoot, 'recordings')
const databasePath = join(stateRoot, 'app-data', 'videorc.sqlite3')
const recoveryDirectory = join(stateRoot, 'app-data', 'session-finalization-recovery')
const streamArtifactPath = join(outputDirectory, 'recycle-stream.flv')
const streamPort = Number(process.env.VIDEORC_LIVE_CONTROL_RECYCLE_RTMP_PORT ?? 19629)
const streamTarget = {
  serverUrl: `rtmp://127.0.0.1:${streamPort}/live`,
  streamKey: 'live-control-recycle',
  listenUrl: `rtmp://127.0.0.1:${streamPort}/live/live-control-recycle`
}
const realFfmpeg = resolveToolPath(process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg', 'FFmpeg')
const realFfprobe = resolveToolPath(
  process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? siblingFfprobePath(realFfmpeg) ?? 'ffprobe',
  'FFprobe'
)

if (!Number.isFinite(finalizationHoldMs) || finalizationHoldMs <= minimumFinalizationHoldMs) {
  throw new Error(
    `VIDEORC_LIVE_CONTROL_FINALIZATION_HOLD_MS must exceed ${minimumFinalizationHoldMs}ms; got ${finalizationHoldMs}.`
  )
}

mkdirSync(outputDirectory, { recursive: true })
console.log(`Live-control recycle evidence: ${stateRoot}`)

const barrier = await createFinalizationBarrierServer()
const shimPath = createExecutableFfmpegShim(stateRoot)
let launched
let oldSocket
let newSocket
let streamListener
let remote

try {
  launched = await launchDevApp({
    requiredMarkers: ['backend-ready', 'preview-motion-ready'],
    timeoutMs,
    env: {
      VIDEORC_SMOKE_STATE_DIR: stateRoot,
      VIDEORC_ENABLE_SMOKE_RPC: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_PRINT_BACKEND_READY: '1',
      VIDEORC_BUNDLED_FFPROBE_PATH: realFfprobe,
      PATH: [dirname(shimPath), process.env.PATH].filter(Boolean).join(delimiter),
      ...finalizationBarrierEnvironment(barrier, realFfmpeg)
    }
  })

  const original = launched.connections['backend-ready']
  const smoke = launched.connections['preview-motion-ready']
  assertBackendConnection(original, 'initial backend')
  const oldBackendPid = requiredPid(original.pid, 'initial backend PID')
  const appPid = requiredPid(smoke?.appPid, 'Electron PID')
  oldSocket = await connectBackend(original, timeoutMs)
  streamListener = spawnRtmpListener()
  await waitForOwnedTcpListener({
    child: streamListener.process,
    port: streamPort,
    timeoutMs: Math.min(10_000, timeoutMs),
    diagnostics: () => streamListener.stderr.join('')
  })

  const outputAuthorization = await requestSmokeCommand(
    smoke,
    'authorize-smoke-resource',
    { kind: 'output-directory', path: outputDirectory },
    { timeoutMs }
  )
  const recording = await request(
    oldSocket,
    timeoutMs,
    'session.start',
    dualOutputRecordingSessionParams({
      outputDirectoryCapability: requiredString(
        outputAuthorization.capabilityId,
        'output directory capability'
      )
    })
  )
  assert.equal(recording?.state, 'recording', `Expected recording, got ${recording?.state}.`)
  const sessionId = requiredString(recording.sessionId, 'recording session ID')
  await waitForStreamBytes(10_000)

  const initialBlocker = await request(oldSocket, 2_000, STATUS_METHOD, {})
  assert.equal(initialBlocker.active, false, 'live-control blocker must start inactive')

  // Attach a rejection handler immediately: generation teardown is allowed to
  // close the socket before the best-effort outcome-unknown response arrives.
  const blockedOutcome = request(oldSocket, timeoutMs, BLOCK_METHOD, {}).then(
    (payload) => ({ kind: 'reply', payload }),
    (error) => ({ kind: 'closed', message: error instanceof Error ? error.message : String(error) })
  )

  const active = await waitForBlockerActive(
    oldSocket,
    initialBlocker.generation,
    Math.min(5_000, timeoutMs)
  )
  const barrierEntry = await waitForFinalizationEntryWithLiveProcesses(barrier, {
    connections: launched.connections,
    oldBackendPid,
    appPid,
    budgetMs: Math.min(20_000, timeoutMs)
  })

  const recoveryRecords = readFinalizationRecoveryRecords(recoveryDirectory)
  assert.equal(
    recoveryRecords.length,
    1,
    `Expected one live finalization recovery record, found ${recoveryRecords.length}.`
  )
  const recovery = recoveryRecords[0].value
  assert.equal(recovery.sessionId, sessionId)
  assert.equal(recovery.mp4StagingPath, barrierEntry.args.at(-1))
  assert.equal(recovery.status, 'completed')

  const heldDatabaseRow = await readSessionRow(databasePath, sessionId)
  assert.ok(heldDatabaseRow, `Session ${sessionId} is missing while finalization is held.`)
  assert.equal(heldDatabaseRow.status, 'running')
  assert.equal(heldDatabaseRow.mp4_path, null)

  const heldForMs = await assertProcessesAliveWithoutReplacementFor({
    connections: launched.connections,
    oldBackendPid,
    appPid,
    durationMs: finalizationHoldMs
  })
  assert.ok(heldForMs > minimumFinalizationHoldMs, `Finalization was held for only ${heldForMs}ms.`)

  barrier.release()
  const replacementStartedAt = Date.now()
  const replacement = await waitForBackendReplacement(
    launched.connections,
    oldBackendPid,
    replacementBudgetMs
  )
  const replacementElapsedMs = Date.now() - replacementStartedAt
  assertBackendConnection(replacement, 'replacement backend')
  assert.notEqual(replacement.pid, oldBackendPid, 'supervisor reused the retired backend PID')

  await waitForPidExit(oldBackendPid, 5_000)
  newSocket = await connectBackend(replacement, 5_000)
  const health = await request(newSocket, 2_000, 'health.ping', {})
  assert.ok(health, 'replacement backend did not answer health.ping')
  const replacementBlocker = await request(newSocket, 2_000, STATUS_METHOD, {})
  assert.equal(replacementBlocker.active, false, 'blocker state leaked into the new generation')

  const sessions = await request(newSocket, 5_000, 'sessions.list', { limit: 20 })
  const finalized = sessions?.items?.find((session) => session.id === sessionId)
  assert.ok(finalized, `Restarted backend did not expose finalized session ${sessionId}.`)
  assert.equal(finalized.status, 'completed', `Session ${sessionId} remained ${finalized.status}.`)
  const mp4Path = requiredString(finalized.mp4Path, 'finalized recording MP4 path')
  assert.equal(existsSync(mp4Path), true, `Finalized recording is missing: ${mp4Path}`)
  assert.ok(statSync(mp4Path).size > 0, `Finalized recording is empty: ${mp4Path}`)
  assert.deepEqual(
    readFinalizationRecoveryRecords(recoveryDirectory),
    [],
    'Safe recycle left a session-finalization recovery record behind.'
  )
  const quality = await analyzeRecording(mp4Path, {
    ffmpegPath: realFfmpeg,
    ffprobePath: realFfprobe,
    intendedFps: 30,
    expectAudio: true,
    gates: { requireMotion: false }
  })
  const reports = writeReports(quality)
  assert.equal(
    quality.verdict.pass,
    true,
    `Recycled recording failed ffprobe/ffmpeg analysis: ${quality.verdict.failures.join('; ')} ` +
      `(report: ${reports.mdPath})`
  )

  await waitForChildExit(streamListener.process, 10_000)
  assert.notEqual(
    streamListener.process.exitCode,
    null,
    'The retired generation kept the live stream connection open after safe recycle.'
  )
  assert.equal(existsSync(streamArtifactPath), true, 'The local RTMP stream artifact is missing.')
  assert.ok(statSync(streamArtifactPath).size > 0, 'The local RTMP stream artifact is empty.')

  // Prove the replacement is usable by the actual Studio renderer, not only
  // by this script's direct backend socket. A remote client delivers the same
  // scene intent used by deck/control surfaces; only Studio can execute it and
  // return the correlated authoritative ACK.
  const remoteStatus = await request(newSocket, 5_000, 'remote.control.enable', {})
  assert.equal(remoteStatus.enabled, true, 'Replacement backend did not enable remote control.')
  const discoveryPath = requiredString(remoteStatus.discoveryPath, 'remote discovery path')
  const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'))
  remote = await connectRemote(discovery.host, discovery.port, discovery.token)
  // The remote surface is authored by Studio, so an idle describe proves the
  // renderer has reconciled the replacement generation before we touch a
  // source control that is intentionally disabled during an active session.
  await waitForRemoteDescribe(remote, (describe) => describe.state?.sessionActive === false)
  await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 500 }, { timeoutMs })
  await waitForBackendState(
    newSocket,
    'compositor.status',
    (status) =>
      status?.state === 'live' &&
      (status.framesRendered ?? 0) > 0 &&
      status.sceneSources?.some(
        (source) => source?.id === 'source:test-pattern' || source?.kind === 'test-pattern'
      ),
    'replacement Studio synthetic compositor readiness'
  )
  const sceneAckPromise = waitForRemoteEvent(remote, 'remote.ack')
  const sceneTicket = await remoteRequest(remote, 'remote.intent', {
    kind: 'sceneApply',
    layoutPreset: 'screen-only'
  })
  assert.equal(sceneTicket.payload?.accepted, true, 'Replacement rejected the scene intent ticket.')
  const sceneAck = await sceneAckPromise
  assert.equal(
    sceneAck?.intentId,
    sceneTicket.payload.intentId,
    'Replacement Studio ACK did not correlate to the scene intent.'
  )
  assert.equal(sceneAck?.ok, true, `Replacement Studio NACKed scene apply: ${sceneAck?.message}`)
  const remoteScene = await waitForRemoteDescribe(
    remote,
    (describe) => describe.state?.layoutPreset === 'screen-only'
  )
  assert.equal(remoteScene.state.layoutPreset, 'screen-only')
  const compositor = await waitForBackendState(
    newSocket,
    'compositor.status',
    (status) => status?.sceneLayout?.layoutPreset === 'screen-only',
    'backend-confirmed replacement scene'
  )
  assert.equal(compositor.sceneLayout.layoutPreset, 'screen-only')
  remote.close()
  remote = null
  await request(newSocket, 5_000, 'remote.control.disable', {})

  const outcome = await blockedOutcome
  assert.equal(
    outcome.kind,
    'closed',
    `the wedged command unexpectedly completed before generation retirement: ${JSON.stringify(outcome)}`
  )
  assert.ok(
    replacementElapsedMs <= replacementBudgetMs,
    `backend replacement exceeded ${replacementBudgetMs}ms (${replacementElapsedMs}ms)`
  )

  console.log(
    `Live-control recycle PASS — blocker generation ${active.activeGeneration}, old pid ${original.pid} exited, ` +
      `new pid ${replacement.pid} answered health.ping in ${replacementElapsedMs}ms; old socket ${outcome.kind}; ` +
      `dual-output recording ${sessionId} stayed protected through ${Math.round(heldForMs)}ms of blocked finalization, ` +
      `then finalized at ${mp4Path}; its live stream ended at recycle and replacement Studio committed a correlated scene command.`
  )
} finally {
  barrier.release({ allowMissing: true })
  await barrier.close()
  oldSocket?.close()
  newSocket?.close()
  remote?.close()
  await stopRtmpListener(streamListener)
  if (launched) {
    await stopProcess(launched.process, { timeoutMs: 15_000 }).catch(() => {})
  }
}

// A supervisor-restarted backend inherits the launcher's stdio pipes. Explicit
// exit keeps that process tree from retaining this script's event loop.
process.exit(0)

async function waitForBlockerActive(socket, previousGeneration, budgetMs) {
  const deadline = Date.now() + budgetMs
  let last
  while (Date.now() < deadline) {
    last = await request(socket, Math.min(1_000, deadline - Date.now()), STATUS_METHOD, {})
    if (
      last.active === true &&
      Number.isSafeInteger(last.generation) &&
      last.generation > previousGeneration &&
      last.activeGeneration === last.generation
    ) {
      return last
    }
  }
  throw new Error(`LiveControl blocker did not become observable: ${JSON.stringify(last)}`)
}

async function waitForBackendReplacement(connections, oldPid, budgetMs) {
  const deadline = Date.now() + budgetMs
  let last
  while (Date.now() < deadline) {
    last = connections['backend-ready']
    if (Number.isSafeInteger(last?.pid) && last.pid > 0 && last.pid !== oldPid) {
      return last
    }
    await sleep(pollMs)
  }
  throw new Error(
    `Timed out waiting for a backend PID different from ${oldPid}; last marker=${JSON.stringify(last)}`
  )
}

async function waitForFinalizationEntryWithLiveProcesses(
  barrier,
  { connections, oldBackendPid, appPid, budgetMs }
) {
  const deadline = Date.now() + budgetMs
  while (!barrier.entry && Date.now() < deadline) {
    assertProcessesAliveWithoutReplacement({ connections, oldBackendPid, appPid })
    await Promise.race([barrier.entryPromise, sleep(pollMs)])
  }
  if (!barrier.entry) {
    throw new Error(`Timed out ${budgetMs}ms waiting for the MP4 finalization export barrier.`)
  }
  assertProcessesAliveWithoutReplacement({ connections, oldBackendPid, appPid })
  return barrier.entry
}

async function assertProcessesAliveWithoutReplacementFor({
  connections,
  oldBackendPid,
  appPid,
  durationMs
}) {
  const startedAt = performance.now()
  while (performance.now() - startedAt <= durationMs) {
    assertProcessesAliveWithoutReplacement({ connections, oldBackendPid, appPid })
    const remaining = durationMs - (performance.now() - startedAt)
    if (remaining > 0) await sleep(Math.min(250, remaining))
  }
  return performance.now() - startedAt
}

function assertProcessesAliveWithoutReplacement({ connections, oldBackendPid, appPid }) {
  assert.equal(pidIsAlive(appPid), true, `Electron pid ${appPid} exited during safe finalization.`)
  assert.equal(
    pidIsAlive(oldBackendPid),
    true,
    `Original backend pid ${oldBackendPid} exited during safe finalization.`
  )
  const markerPid = connections['backend-ready']?.pid
  assert.equal(
    markerPid,
    oldBackendPid,
    `Supervisor published replacement backend pid ${markerPid} before safe finalization completed.`
  )
}

async function waitForPidExit(pid, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return
    await sleep(pollMs)
  }
  throw new Error(`Retired backend pid ${pid} remained alive after its replacement was ready.`)
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

function assertBackendConnection(connection, label) {
  assert.ok(connection && typeof connection === 'object', `${label} marker missing`)
  assert.ok(Number.isSafeInteger(connection.pid) && connection.pid > 0, `${label} PID missing`)
  assert.ok(
    typeof connection.token === 'string' && connection.token.length >= 32,
    `${label} token missing`
  )
  assert.ok(Number.isSafeInteger(connection.port) && connection.port > 0, `${label} port missing`)
}

function dualOutputRecordingSessionParams({ outputDirectoryCapability }) {
  const params = appQuitRecordingSessionParams({ outputDirectoryCapability })
  return {
    ...params,
    output: {
      ...params.output,
      streamEnabled: true,
      rtmp: {
        preset: 'custom',
        serverUrl: streamTarget.serverUrl,
        streamKey: streamTarget.streamKey
      }
    }
  }
}

function spawnRtmpListener() {
  const stderr = []
  const process = spawn(
    realFfmpeg,
    [
      '-y',
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-listen',
      '1',
      '-i',
      streamTarget.listenUrl,
      '-c',
      'copy',
      '-f',
      'flv',
      streamArtifactPath
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  process.stderr.setEncoding('utf8')
  process.stderr.on('data', (text) => stderr.push(text))
  return { process, stderr }
}

async function waitForStreamBytes(budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (streamListener.process.exitCode !== null) {
      throw new Error(
        `Local RTMP listener exited before receiving stream data: ${streamListener.stderr.join('').trim()}`
      )
    }
    if (existsSync(streamArtifactPath) && statSync(streamArtifactPath).size > 0) return
    await sleep(pollMs)
  }
  throw new Error(`Local RTMP listener received no bytes within ${budgetMs}ms.`)
}

async function stopRtmpListener(listener) {
  const child = listener?.process
  if (!child?.pid || child.exitCode !== null) return
  child.kill('SIGTERM')
  await waitForChildExit(child, 1_500)
  if (child.exitCode === null) child.kill('SIGKILL')
  await waitForChildExit(child, 1_000)
}

function waitForChildExit(child, budgetMs) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, budgetMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

function connectRemote(host, port, token) {
  return new Promise((resolveConnection, rejectConnection) => {
    const socket = new WebSocket(`ws://${host}:${port}/ws?token=${encodeURIComponent(token)}`)
    const timer = setTimeout(
      () => rejectConnection(new Error('replacement remote connect timed out')),
      timeoutMs
    )
    socket.once('open', () => {
      clearTimeout(timer)
      resolveConnection(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      rejectConnection(error)
    })
  })
}

function remoteRequest(socket, method, params) {
  const id = `recycle-${Math.random().toString(36).slice(2)}`
  return new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(
      () => rejectRequest(new Error(`replacement ${method} timed out`)),
      timeoutMs
    )
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolveRequest(message)
    }
    socket.on('message', onMessage)
    socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }))
  })
}

function waitForRemoteEvent(socket, event) {
  return new Promise((resolveEvent, rejectEvent) => {
    const timer = setTimeout(
      () => rejectEvent(new Error(`replacement timed out waiting for ${event}`)),
      timeoutMs
    )
    const onMessage = (raw) => {
      const message = JSON.parse(String(raw))
      if (message.event !== event) return
      clearTimeout(timer)
      socket.off('message', onMessage)
      resolveEvent(message.payload)
    }
    socket.on('message', onMessage)
  })
}

async function waitForRemoteDescribe(socket, predicate = () => true) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const response = await remoteRequest(socket, 'remote.describe')
    if (response.payload?.describe && response.payload?.state) {
      last = response.payload
      if (predicate(last)) return last
    }
    await sleep(100)
  }
  throw new Error(
    `Replacement Studio never published the expected remote state: ${JSON.stringify(last)}`
  )
}

async function waitForBackendState(socket, method, predicate, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await request(socket, Math.min(5_000, timeoutMs), method, {})
    if (predicate(last)) return last
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}; last ${method}: ${JSON.stringify(last)}`)
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${label}.`)
  }
  return value
}

function requiredPid(value, label) {
  if (!Number.isSafeInteger(value) || value <= 1) {
    throw new Error(`Missing or invalid ${label}: ${value}`)
  }
  return value
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
