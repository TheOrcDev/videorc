import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Performance check over the REAL backend WS: run the ladder on this machine,
// then prove the benchmark sessions were invisible — no recording.status /
// health.event reached the client, no Library row, no media left behind.
// Runs the debug backend against an isolated database, so the owner's library
// and stored recommendation are never touched. Needs no capture permission:
// every rung records the synthetic test pattern.

const backendBinaryName = process.platform === 'win32' ? 'videorc-backend.exe' : 'videorc-backend'
const backendBinary = join(process.cwd(), 'target', 'debug', backendBinaryName)
assert.ok(
  existsSync(backendBinary),
  `target/debug/${backendBinaryName} missing — run \`cargo build -p videorc-backend\` first`
)

const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-performance-check-'))
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const ceiling = {
  ceilingWidth: Number(process.env.VIDEORC_PERFORMANCE_CHECK_WIDTH ?? 1920),
  ceilingHeight: Number(process.env.VIDEORC_PERFORMANCE_CHECK_HEIGHT ?? 1080),
  ceilingFps: Number(process.env.VIDEORC_PERFORMANCE_CHECK_FPS ?? 30)
}
const SUPPRESSED = new Set([
  'recording.status',
  'recording.finalization',
  'health.event',
  'session.log',
  'diagnostics.stats'
])

let backend
let socket

try {
  backend = spawn(backendBinary, [], {
    env: {
      ...process.env,
      VIDEORC_DATABASE_PATH: join(stateRoot, 'videorc.sqlite3'),
      VIDEORC_DISABLE_BACKEND_REAP: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let backendStderr = ''
  backend.stderr.on('data', (chunk) => {
    backendStderr = (backendStderr + chunk.toString()).slice(-8000)
  })
  const ready = await waitForReady(backend)
  socket = await connect(`ws://127.0.0.1:${ready.port}/ws?token=${ready.adminToken}`)
  const rpc = makeRpc(socket)

  const leaked = []
  const progress = []
  let running = false
  const completed = new Promise((resolve) => {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (typeof message.event !== 'string') {
        return
      }
      if (running && SUPPRESSED.has(message.event)) {
        leaked.push(message.event)
      }
      if (message.event === 'log' && process.env.VIDEORC_PERFORMANCE_CHECK_VERBOSE === '1') {
        console.log(`[backend ${message.payload.level}] ${message.payload.message}`)
      }
      if (message.event === 'performance.check.progress') {
        progress.push(message.payload)
      }
      if (message.event === 'performance.check.completed') {
        running = false
        resolve(message.payload)
      }
    })
  })

  const before = await rpc('performance.check.get')
  assert.deepEqual(before, { running: false, stale: false }, 'fresh database has no verdict')

  running = true
  const started = await rpc('performance.check.run', ceiling)
  assert.equal(started.running, true)
  const second = await rpc.expectError('performance.check.run', ceiling)
  assert.equal(second.code, 'performance-check-refused', 'a second run is refused, not queued')

  const completedState = await withTimeout(completed, timeoutMs, 'performance.check.completed')
  assert.equal(completedState.running, false, 'completed is published after the run ended')
  const result = completedState.result
  assert.ok(result, 'a finished check carries its verdict')
  assert.ok(Array.isArray(result.rungs) && result.rungs.length > 0, 'completed carries the rungs')
  console.log(
    result.rungs
      .map(
        (rung) =>
          `${rung.video.width}x${rung.video.height}@${rung.video.fps} ${rung.verdict}` +
          ` speed=${rung.encoderSpeed ?? 'n/a'} fps=${rung.deliveredFps ?? 'n/a'}` +
          ` drain=${rung.drainAfterStopMs ?? 'n/a'}ms encode=${rung.encodeBackend ?? 'n/a'}` +
          ` compositor=${rung.compositorBackend ?? 'n/a'}` +
          (rung.reasons.length ? ` [${rung.reasons.join(', ')}]` : '')
      )
      .join('\n')
  )
  console.log(
    `recommended ${result.recommended.width}x${result.recommended.height}@${result.recommended.fps}` +
      ` (${result.recommended.preset}) in ${result.durationMs}ms belowFloor=${result.belowFloor}`
  )

  assert.deepEqual(leaked, [], 'benchmark session events must never reach a client')
  assert.ok(progress.length >= 1, 'progress is reported per measured rung')
  assert.ok(
    result.rungs.every((rung) => rung.verdict !== 'failed' || rung.reasons.length > 0),
    'every failed rung names why'
  )
  if (process.env.VIDEORC_PERFORMANCE_CHECK_EXPECT_PASS !== '0') {
    assert.equal(result.belowFloor, false, `nothing passed on this machine:\n${backendStderr}`)
  }

  if (process.env.VIDEORC_PERFORMANCE_CHECK_EXPECT_HEIGHT) {
    assert.equal(
      result.recommended.height,
      Number(process.env.VIDEORC_PERFORMANCE_CHECK_EXPECT_HEIGHT),
      'the ladder must step down to the first rung that holds'
    )
    assert.ok(
      result.rungs.some((rung) => rung.verdict === 'failed'),
      'a step-down run records the rungs that failed'
    )
  }

  const after = await rpc('performance.check.get')
  assert.equal(after.running, false)
  assert.equal(after.stale, false)
  assert.deepEqual(after.result, result, 'the verdict is persisted and served back verbatim')

  // A cancelled check keeps the previous verdict and frees the capture slot.
  running = true
  const cancelledRun = new Promise((resolve) => {
    socket.addEventListener('message', function onMessage(event) {
      const message = JSON.parse(String(event.data))
      if (message.event === 'performance.check.completed') {
        socket.removeEventListener('message', onMessage)
        resolve(message.payload)
      }
    })
  })
  await rpc('performance.check.run', ceiling)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const cancelStarted = Date.now()
  await rpc('performance.check.cancel')
  const cancelled = await withTimeout(cancelledRun, 15000, 'cancelled performance check')
  running = false
  console.log(`cancel settled in ${Date.now() - cancelStarted}ms`)
  assert.deepEqual(cancelled.result, result, 'a cancelled run keeps the previous verdict')
  assert.deepEqual(leaked, [], 'a cancelled benchmark stays invisible too')

  const sessions = (await rpc('sessions.list', { limit: 50 })).items
  assert.deepEqual(sessions, [], 'benchmark sessions never appear in the Library')
  const benchmarkDir = join(stateRoot, 'PerformanceChecks')
  assert.deepEqual(
    existsSync(benchmarkDir) ? readdirSync(benchmarkDir) : [],
    [],
    'benchmark media is deleted'
  )
  const status = await rpc('recording.status')
  assert.equal(status.state, 'idle', 'the studio is idle again after the check')
  console.log('Performance check smoke passed.')
} finally {
  if (socket) {
    socket.close()
  }
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM')
  }
  await rm(stateRoot, { recursive: true, force: true })
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))
  ])
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('backend did not print READY in time')),
      timeoutMs
    )
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      const line = buffer.split('\n').find((candidate) => candidate.startsWith('READY '))
      if (line) {
        clearTimeout(timer)
        resolve(JSON.parse(line.slice('READY '.length)))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`backend exited early with code ${code}`))
    })
  })
}

function connect(url) {
  // Node's built-in WebSocket (browser-style events; available since Node 22).
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', (event) => reject(event.error ?? new Error('ws error')), {
      once: true
    })
  })
}

function makeRpc(ws) {
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (typeof message.id !== 'string' || !pending.has(message.id)) {
      return // server events
    }
    const { resolve, reject, expectError, timer } = pending.get(message.id)
    pending.delete(message.id)
    clearTimeout(timer)
    if (message.ok) {
      if (expectError) {
        reject(new Error(`expected an error but ${message.id} succeeded`))
      } else {
        resolve(message.payload)
      }
    } else if (expectError) {
      resolve(message.error)
    } else {
      reject(new Error(`${message.id} failed: ${message.error?.code} ${message.error?.message}`))
    }
  })
  const send = (method, params, expectError) =>
    new Promise((resolve, reject) => {
      const id = `smoke-${nextId++}-${method}`
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`${method} timed out`))
        }
      }, timeoutMs)
      pending.set(id, { resolve, reject, expectError, timer })
      try {
        ws.send(JSON.stringify({ id, method, params: params ?? {} }))
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })
  const rpc = (method, params) => send(method, params, false)
  rpc.expectError = (method, params) => send(method, params, true)
  return rpc
}
