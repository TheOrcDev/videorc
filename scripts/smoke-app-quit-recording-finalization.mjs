import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createServer, createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { launchDevApp, repoRoot } from './lib/app-launcher.mjs'
import { siblingFfprobePath } from './lib/ffmpeg-sibling-paths.mjs'
import {
  formatCensus,
  ownedProcessLedgerPaths,
  processExists,
  waitForCleanProcessState
} from './lib/process-census.mjs'
import { analyzeRecording, writeReports } from './lib/recording-analyzer.mjs'
import { requestSmokeCommand } from './lib/smoke-command-client.mjs'
import { connectBackend, request } from './smoke-recording-session.mjs'

const SHIM_MODE = '--ffmpeg-finalization-barrier-shim'
const BARRIER_HOST_ENV = 'VIDEORC_FINALIZATION_BARRIER_HOST'
const BARRIER_PORT_ENV = 'VIDEORC_FINALIZATION_BARRIER_PORT'
const BARRIER_TOKEN_ENV = 'VIDEORC_FINALIZATION_BARRIER_TOKEN'
const REAL_FFMPEG_ENV = 'VIDEORC_FINALIZATION_REAL_FFMPEG'
const MINIMUM_HOLD_MS = 30_000
const TEST_PATTERN_GATES = Object.freeze({ requireMotion: false })

export function finalizationBarrierEnvironment(barrier, realFfmpeg) {
  return {
    [REAL_FFMPEG_ENV]: realFfmpeg,
    ...barrier.env
  }
}

export function isMp4FinalizationExport(args) {
  const outputPath = args.at(-1)
  if (
    typeof outputPath !== 'string' ||
    basename(outputPath) !== 'export.mp4' ||
    !/^\.videorc-export-.+\.partial$/.test(basename(dirname(outputPath))) ||
    !args.includes('-n') ||
    !hasArgumentPair(args, '-c:v', 'copy') ||
    !hasArgumentPair(args, '-c:a', 'aac')
  ) {
    return false
  }

  return args.some(
    (argument, index) =>
      argument === '-i' &&
      typeof args[index + 1] === 'string' &&
      extname(args[index + 1]).toLowerCase() === '.mkv'
  )
}

export function appQuitRecordingSessionParams({ outputDirectoryCapability }) {
  return {
    sources: { testPattern: true },
    layout: {
      layoutPreset: 'screen-only',
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
      streamEnabled: false,
      outputDirectoryCapability,
      video: {
        preset: 'custom',
        width: 640,
        height: 360,
        fps: 30,
        bitrateKbps: 2000
      },
      rtmp: {
        preset: 'custom',
        serverUrl: '',
        streamKey: ''
      }
    }
  }
}

export function readFinalizationRecoveryRecords(recoveryDirectory) {
  if (!existsSync(recoveryDirectory)) return []
  return readdirSync(recoveryDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const path = join(recoveryDirectory, entry.name)
      return { path, value: JSON.parse(readFileSync(path, 'utf8')) }
    })
}

export async function runFfmpegFinalizationBarrierShim(
  args,
  env = process.env,
  spawnProcess = spawn
) {
  const realFfmpeg = requiredEnv(env, REAL_FFMPEG_ENV)
  if (isMp4FinalizationExport(args)) {
    await waitForFinalizationBarrierRelease(env, args)
  }

  const child = spawnProcess(realFfmpeg, args, { stdio: 'inherit' })
  return await new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild)
    child.once('close', (code, signal) => {
      resolveChild({ code: code ?? (signal ? 1 : 0), signal })
    })
  })
}

async function runSmoke() {
  if (process.platform !== 'darwin') {
    throw new Error(
      'The live app quit-during-recording smoke currently requires macOS; its executable FFmpeg shim is POSIX-only.'
    )
  }

  const holdMs = positiveInteger(
    process.env.VIDEORC_APP_QUIT_RECORDING_HOLD_MS,
    MINIMUM_HOLD_MS + 1_000
  )
  if (holdMs <= MINIMUM_HOLD_MS) {
    throw new Error(
      `VIDEORC_APP_QUIT_RECORDING_HOLD_MS must exceed ${MINIMUM_HOLD_MS}ms; got ${holdMs}.`
    )
  }

  const timeoutMs = positiveInteger(process.env.VIDEORC_SMOKE_TIMEOUT_MS, 180_000)
  const exitTimeoutMs = positiveInteger(
    process.env.VIDEORC_APP_QUIT_RECORDING_EXIT_TIMEOUT_MS,
    90_000
  )
  const recordingMs = positiveInteger(process.env.VIDEORC_APP_QUIT_RECORDING_MS, 2_500)
  const stateRoot = resolve(
    process.env.VIDEORC_SMOKE_OUTPUT_DIR ??
      join(tmpdir(), `videorc-app-quit-recording-smoke-${Date.now()}`)
  )
  const appDataDir = join(stateRoot, 'app-data')
  const userDataDir = join(stateRoot, 'user-data')
  const outputDirectory = join(stateRoot, 'recordings')
  const databasePath = join(appDataDir, 'videorc.sqlite3')
  const recoveryDirectory = join(appDataDir, 'session-finalization-recovery')
  const realFfmpeg = resolveToolPath(process.env.VIDEORC_SMOKE_FFMPEG_PATH ?? 'ffmpeg', 'FFmpeg')
  const realFfprobe = resolveToolPath(
    process.env.VIDEORC_SMOKE_FFPROBE_PATH ?? siblingFfprobePath(realFfmpeg) ?? 'ffprobe',
    'FFprobe'
  )
  const ledgerPaths = ownedProcessLedgerPaths({
    appDataDir,
    userDataDir,
    workspaceRoot: repoRoot
  })

  mkdirSync(outputDirectory, { recursive: true })
  const barrier = await createFinalizationBarrierServer()
  const shimPath = createExecutableFfmpegShim(stateRoot)
  let launched
  let backendSocket
  let normalExitComplete = false

  console.log(`App-quit recording smoke evidence: ${stateRoot}`)
  console.log(`Holding the real MP4 finalization export for ${holdMs}ms after it begins.`)

  try {
    launched = await launchDevApp({
      env: {
        VIDEORC_SMOKE_COMMAND_SERVER: '1',
        VIDEORC_SMOKE_STATE_DIR: stateRoot,
        VIDEORC_DISABLE_AUTO_PREVIEW: '1',
        VIDEORC_BUNDLED_FFPROBE_PATH: realFfprobe,
        // Dev main deliberately leaves VIDEORC_BUNDLED_FFMPEG_PATH empty on macOS.
        // Put an executable named `ffmpeg` first on the inherited backend PATH so
        // the ordinary renderer session path uses the barrier without privileged
        // caller-supplied binary paths.
        PATH: [dirname(shimPath), process.env.PATH].filter(Boolean).join(delimiter),
        ...finalizationBarrierEnvironment(barrier, realFfmpeg)
      },
      timeoutMs,
      requiredMarkers: ['backend-ready', 'preview-motion-ready'],
      onLine: (line) => {
        if (/shutdown|finaliz|export|error|panic/i.test(line)) console.log(line)
      }
    })

    const backendConnection = launched.connections['backend-ready']
    const smoke = launched.connections['preview-motion-ready']
    const backendPid = requiredPid(backendConnection?.pid, 'backend-ready backend PID')
    const appPid = requiredPid(smoke?.appPid, 'preview-motion-ready Electron PID')
    assert.equal(processExists(appPid), true, `Electron main process ${appPid} is not alive.`)
    assert.equal(processExists(backendPid), true, `Backend process ${backendPid} is not alive.`)

    const outputAuthorization = await requestSmokeCommand(
      smoke,
      'authorize-smoke-resource',
      { kind: 'output-directory', path: outputDirectory },
      { timeoutMs }
    )
    backendSocket = await connectBackend(backendConnection, timeoutMs)
    const started = await request(
      backendSocket,
      timeoutMs,
      'session.start',
      appQuitRecordingSessionParams({
        outputDirectoryCapability: requiredString(
          outputAuthorization.capabilityId,
          'output directory capability'
        )
      })
    )
    assert.equal(started?.state, 'recording', `Expected recording, got ${started?.state}.`)
    const sessionId = requiredString(started.sessionId, 'recording session ID')
    const mkvPath = requiredString(started.outputPath, 'recording MKV path')
    await closeWebSocket(backendSocket, 2_000)
    backendSocket = null

    await sleep(recordingMs)
    const quitAccepted = await requestSmokeCommand(smoke, 'app-quit', {}, { timeoutMs: 2_000 })
    assert.deepEqual(
      quitAccepted,
      { quitting: true },
      'app-quit must acknowledge the normal quit request before Electron begins teardown.'
    )

    const barrierEntry = await waitForBarrierEntryWithLiveProcesses(barrier, {
      pids: [appPid, backendPid],
      timeoutMs
    })
    assert.equal(isMp4FinalizationExport(barrierEntry.args), true)

    const recoveryRecords = readFinalizationRecoveryRecords(recoveryDirectory)
    assert.equal(
      recoveryRecords.length,
      1,
      `Expected one live finalization recovery record, found ${recoveryRecords.length}.`
    )
    const recovery = recoveryRecords[0]
    assert.equal(recovery.value.sessionId, sessionId)
    assert.equal(recovery.value.outputPath, mkvPath)
    assert.equal(recovery.value.mp4StagingPath, barrierEntry.args.at(-1))
    assert.equal(recovery.value.status, 'completed')

    const heldDatabaseRow = await readSessionRow(databasePath, sessionId)
    assert.ok(heldDatabaseRow, `Session ${sessionId} is missing while finalization is held.`)
    assert.equal(heldDatabaseRow.status, 'running')
    assert.equal(heldDatabaseRow.mp4_path, null)

    const heldForMs = await assertProcessesAliveFor({
      pids: [appPid, backendPid],
      durationMs: holdMs
    })
    assert.ok(heldForMs > MINIMUM_HOLD_MS, `Finalization was held for only ${heldForMs}ms.`)
    console.log(
      `Electron ${appPid} and backend ${backendPid} remained alive for ${Math.round(heldForMs)}ms of blocked finalization.`
    )

    barrier.release()
    const [exit, clean] = await Promise.all([
      waitForChildClose(launched.process, exitTimeoutMs),
      waitForCleanProcessState({
        ledgerPaths,
        pgid: launched.process.pid,
        timeoutMs: exitTimeoutMs
      })
    ])
    assert.equal(exit.signal, null, `Dev app exited from signal ${exit.signal}.`)
    assert.equal(exit.code, 0, `Dev app exited with code ${exit.code}.`)
    assert.equal(
      clean.records.length,
      0,
      `Owned process ledger was not cleared.\n${formatCensus(clean)}`
    )
    assert.equal(
      clean.processGroupRows.length,
      0,
      `App process group did not exit cleanly.\n${formatCensus(clean)}`
    )
    normalExitComplete = true

    const completedRow = await readSessionRow(databasePath, sessionId)
    assert.ok(completedRow, `Session ${sessionId} is missing after app exit.`)
    assert.equal(completedRow.status, 'completed')
    assert.ok(completedRow.ended_at, 'Completed session row has no ended_at timestamp.')
    const mp4Path = requiredString(completedRow.mp4_path, 'completed session MP4 path')
    assert.equal(extname(mp4Path).toLowerCase(), '.mp4')
    assert.equal(existsSync(mp4Path), true, `Completed MP4 is missing: ${mp4Path}`)
    assert.ok(statSync(mp4Path).size > 0, `Completed MP4 is empty: ${mp4Path}`)

    const remainingRecoveryRecords = readFinalizationRecoveryRecords(recoveryDirectory)
    assert.deepEqual(
      remainingRecoveryRecords,
      [],
      `Finalization recovery record was not cleared: ${remainingRecoveryRecords
        .map((record) => record.path)
        .join(', ')}`
    )

    const quality = await analyzeRecording(mp4Path, {
      ffmpegPath: realFfmpeg,
      ffprobePath: realFfprobe,
      intendedFps: 30,
      expectAudio: true,
      gates: TEST_PATTERN_GATES
    })
    const reports = writeReports(quality)
    assert.equal(
      quality.verdict.pass,
      true,
      `Final MP4 failed ffprobe/ffmpeg analysis: ${quality.verdict.failures.join('; ')} (report: ${reports.mdPath})`
    )

    console.log(
      `App quit recording finalization smoke OK: ${mp4Path} (${statSync(mp4Path).size} bytes), ` +
        `DB status completed, recovery cleared, analyzer report ${reports.mdPath}.`
    )
  } finally {
    barrier.release({ allowMissing: true })
    await barrier.close()
    if (backendSocket) {
      await closeWebSocket(backendSocket, 2_000).catch(() => {})
    }
    if (launched && !normalExitComplete) {
      await launched.stop().catch((error) => {
        console.warn(`Emergency launcher teardown failed: ${error?.message ?? error}`)
      })
    }
  }
}

export async function createFinalizationBarrierServer() {
  const token = randomBytes(32).toString('hex')
  let entry = null
  let heldSocket = null
  let released = false
  let resolveEntry
  const entryPromise = new Promise((resolveEntered) => {
    resolveEntry = resolveEntered
  })
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    let buffered = ''
    socket.on('data', (chunk) => {
      if (entry || buffered.length > 64 * 1024) return
      buffered += chunk
      const newline = buffered.indexOf('\n')
      if (newline === -1) return
      let candidate
      try {
        candidate = JSON.parse(buffered.slice(0, newline))
      } catch {
        socket.destroy()
        return
      }
      if (
        candidate?.token !== token ||
        candidate?.event !== 'mp4-finalization-export-entered' ||
        !Array.isArray(candidate?.args) ||
        !isMp4FinalizationExport(candidate.args)
      ) {
        socket.destroy()
        return
      }
      entry = candidate
      heldSocket = socket
      socket.write('hold\n')
      resolveEntry(candidate)
      if (released) socket.end('release\n')
    })
  })
  server.listen(0, '127.0.0.1')
  await new Promise((resolveListening, rejectListening) => {
    server.once('listening', resolveListening)
    server.once('error', rejectListening)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'Finalization barrier did not bind TCP.')

  return {
    env: {
      [BARRIER_HOST_ENV]: '127.0.0.1',
      [BARRIER_PORT_ENV]: String(address.port),
      [BARRIER_TOKEN_ENV]: token
    },
    entryPromise,
    get entry() {
      return entry
    },
    release({ allowMissing = false } = {}) {
      if (released) return
      if (!heldSocket && !allowMissing) {
        throw new Error('Cannot release finalization before its FFmpeg export entered the barrier.')
      }
      released = true
      heldSocket?.end('release\n')
    },
    async close() {
      heldSocket?.destroy()
      if (!server.listening) return
      await new Promise((resolveClose) => server.close(resolveClose))
    }
  }
}

async function waitForFinalizationBarrierRelease(env, args) {
  const host = requiredEnv(env, BARRIER_HOST_ENV)
  const port = Number(requiredEnv(env, BARRIER_PORT_ENV))
  const token = requiredEnv(env, BARRIER_TOKEN_ENV)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${BARRIER_PORT_ENV}: ${port}`)
  }

  await new Promise((resolveRelease, rejectRelease) => {
    const socket = createConnection({ host, port })
    let released = false
    let buffered = ''
    const fail = (error) => {
      if (!released) rejectRelease(error)
    }
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          token,
          event: 'mp4-finalization-export-entered',
          pid: process.pid,
          args
        })}\n`
      )
    })
    socket.on('data', (chunk) => {
      buffered += chunk
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      if (!lines.includes('release')) return
      released = true
      socket.end()
      resolveRelease()
    })
    socket.once('error', fail)
    socket.once('close', () => {
      fail(new Error('Finalization barrier connection closed before release.'))
    })
  })
}

export function createExecutableFfmpegShim(stateRoot) {
  const shimDirectory = join(stateRoot, 'finalization-barrier-bin')
  const shimPath = join(shimDirectory, 'ffmpeg')
  mkdirSync(shimDirectory, { recursive: true })
  writeFileSync(
    shimPath,
    `#!/usr/bin/env node\nimport { runFfmpegFinalizationBarrierShim } from ${JSON.stringify(import.meta.url)}\nconst result = await runFfmpegFinalizationBarrierShim(process.argv.slice(2))\nprocess.exitCode = result.code\n`,
    { encoding: 'utf8', mode: 0o700 }
  )
  chmodSync(shimPath, 0o700)
  return shimPath
}

async function waitForBarrierEntryWithLiveProcesses(barrier, { pids, timeoutMs }) {
  const deadline = Date.now() + timeoutMs
  while (!barrier.entry && Date.now() < deadline) {
    assertLivePids(pids, 'before finalization entered the barrier')
    await Promise.race([barrier.entryPromise, sleep(100)])
  }
  if (!barrier.entry) {
    throw new Error(`Timed out waiting ${timeoutMs}ms for the MP4 finalization export barrier.`)
  }
  return barrier.entry
}

async function assertProcessesAliveFor({ pids, durationMs }) {
  const startedAt = performance.now()
  while (performance.now() - startedAt <= durationMs) {
    assertLivePids(pids, 'while MP4 finalization was intentionally held')
    const remaining = durationMs - (performance.now() - startedAt)
    if (remaining > 0) await sleep(Math.min(250, remaining))
  }
  return performance.now() - startedAt
}

function assertLivePids(pids, phase) {
  for (const pid of pids) {
    assert.equal(processExists(pid), true, `Process ${pid} exited ${phase}.`)
  }
}

async function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.off('close', onClose)
      rejectExit(new Error(`Timed out ${timeoutMs}ms waiting for the dev app launcher to exit.`))
    }, timeoutMs)
    const onClose = (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    }
    child.once('close', onClose)
  })
}

async function closeWebSocket(socket, timeoutMs) {
  if (socket.readyState === WebSocket.CLOSED) return
  await new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      socket.removeEventListener('close', onClose)
      rejectClose(new Error(`Timed out ${timeoutMs}ms waiting for the backend socket to close.`))
    }, timeoutMs)
    const onClose = () => {
      clearTimeout(timer)
      resolveClose()
    }
    socket.addEventListener('close', onClose, { once: true })
    if (socket.readyState === WebSocket.OPEN) socket.close()
  })
}

export async function readSessionRow(databasePath, sessionId) {
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database
      .prepare(
        'SELECT id, status, started_at, ended_at, output_path, mp4_path, duration_ms FROM sessions WHERE id = ?'
      )
      .get(sessionId)
  } finally {
    database.close()
  }
}

export function resolveToolPath(command, label) {
  const requested = requiredString(command, `${label} command`)
  const resolvedCommand = requested.includes('/')
    ? resolve(requested)
    : spawnSync('/usr/bin/which', [requested], { encoding: 'utf8', timeout: 10_000 }).stdout.trim()
  if (!resolvedCommand) {
    throw new Error(`${label} is unavailable at ${requested}.`)
  }

  assertToolAvailable(resolvedCommand, label)
  return resolvedCommand
}

function assertToolAvailable(command, label) {
  const result = spawnSync(command, ['-version'], { encoding: 'utf8', timeout: 10_000 })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} is unavailable at ${command}: ${result.error?.message ?? result.stderr ?? result.stdout}`
    )
  }
}

function hasArgumentPair(args, name, value) {
  return args.some((argument, index) => argument === name && args[index + 1] === value)
}

function requiredEnv(env, name) {
  return requiredString(env[name], name)
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${label}.`)
  }
  return value
}

function requiredPid(value, label) {
  if (!Number.isInteger(value) || value <= 1) {
    throw new Error(`Missing or invalid ${label}: ${value}`)
  }
  return value
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

const invokedModule = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedModule === import.meta.url) {
  if (process.argv[2] === SHIM_MODE) {
    const result = await runFfmpegFinalizationBarrierShim(process.argv.slice(3))
    process.exitCode = result.code
  } else {
    await runSmoke()
  }
}
