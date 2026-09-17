#!/usr/bin/env node

// Real-backend regression for the 2026-08-25 live-control outage. One
// authenticated WebSocket deliberately wedges AccountMaintenance inside the
// production dispatcher, waits for an observable generation-scoped readiness
// status (never a sleep-based handshake), then proves every operator-critical
// lane still replies before the blocker is released.
//
// The synchronization RPCs are `test.*`: the backend admits these exact three
// methods to a renderer role only in a debug build with
// VIDEORC_ENABLE_SMOKE_RPC=1. The same renderer socket carries the blocker,
// readiness checks, probes, release, and final status so this exercises
// per-connection lane isolation rather than two clients accidentally masking
// a shared serial queue.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devAppSpawnOptions, repoRoot, stopProcess } from './lib/app-launcher.mjs'
import { connectBackend } from './smoke-recording-session.mjs'

const BLOCK_METHOD = 'test.commandLanes.accountMaintenance.block'
const STATUS_METHOD = 'test.commandLanes.accountMaintenance.status'
const RELEASE_METHOD = 'test.commandLanes.accountMaintenance.release'
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 60_000)
const laneReplyBudgetMs = 2_000
const backendBinaryName = process.platform === 'win32' ? 'videorc-backend.exe' : 'videorc-backend'
const backendBinary = join(repoRoot, 'target', 'debug', backendBinaryName)
const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-command-lanes-'))

assert.ok(
  existsSync(backendBinary),
  `target/debug/${backendBinaryName} missing — run \`cargo build -p videorc-backend\` first`
)

let backendProcess
let socket
let rpc
let blockerActive = false

try {
  backendProcess = spawn(backendBinary, [], {
    ...devAppSpawnOptions({
      env: {
        ...process.env,
        VIDEORC_DISABLE_AUTO_PREVIEW: '1',
        VIDEORC_DISABLE_BACKEND_REAP: '1',
        VIDEORC_ENABLE_SMOKE_RPC: '1',
        VIDEORC_APP_DATA_DIR: join(stateRoot, 'app-data'),
        VIDEORC_DATABASE_PATH: join(stateRoot, 'videorc.sqlite3'),
        VIDEORC_SECRETS_PATH: join(stateRoot, 'videorc-secrets.json'),
        VIDEORC_RECORDINGS_DIR: join(stateRoot, 'recordings'),
        VIDEORC_SMOKE_STATE_DIR: stateRoot
      }
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const ready = await waitForBackendReady(backendProcess, timeoutMs)
  assert.ok(typeof ready.token === 'string' && ready.token.length >= 32, 'READY omitted token')

  // One renderer-role WebSocket for the entire proof.
  socket = await connectBackend({ ...ready, adminToken: undefined }, timeoutMs)
  rpc = createRpc(socket, timeoutMs)

  const initial = await rpc.ok(STATUS_METHOD, {})
  assert.equal(initial.payload.active, false, 'command-lane blocker must start inactive')

  let blockSettled = false
  const blocked = rpc.call(BLOCK_METHOD, {}, timeoutMs)
  blocked.then(
    () => {
      blockSettled = true
    },
    () => {
      blockSettled = true
    }
  )

  const active = await waitForActiveGeneration(rpc, initial.payload.generation, timeoutMs)
  blockerActive = true
  assert.equal(blockSettled, false, 'AccountMaintenance blocker replied before release')

  const probes = await Promise.all([
    probe(rpc, 'Observation', 'diagnostics.stats', {}),
    probe(rpc, 'LiveControl/screens', 'screens.clear', {}),
    probe(rpc, 'LiveControl/scene', 'scene.layout.apply_preview', {}),
    probe(rpc, 'LiveControl/captions', 'captions.stop', {}),
    probe(rpc, 'DurableChat', 'liveChat.send', {
      operationId: randomUUID(),
      sessionId: 'command-lane-smoke',
      text: 'command lane smoke'
    }),
    probe(rpc, 'Stop', 'session.stop', {})
  ])

  for (const result of probes) {
    assert.ok(
      result.elapsedMs < laneReplyBudgetMs,
      `${result.label} exceeded ${laneReplyBudgetMs}ms (${result.elapsedMs}ms)`
    )
  }
  const diagnostics = probes.find((result) => result.label === 'Observation')?.response.payload
  assert.ok(
    diagnostics?.websocketTransport?.commandLanes?.accountMaintenance,
    'diagnostics.stats did not expose AccountMaintenance lane telemetry'
  )
  const chat = probes.find((result) => result.label === 'DurableChat')?.response
  assert.ok(
    chat?.ok || chat?.error?.code === 'live-chat-send-failed',
    `DurableChat returned an unexpected domain outcome: ${JSON.stringify(chat)}`
  )
  const scene = probes.find((result) => result.label === 'LiveControl/scene')?.response
  assert.ok(
    scene?.ok || ['invalid-params', 'layout-preview-failed'].includes(scene?.error?.code),
    `scene change returned an unexpected domain outcome: ${JSON.stringify(scene)}`
  )
  for (const label of ['Observation', 'LiveControl/screens', 'LiveControl/captions', 'Stop']) {
    const outcome = probes.find((result) => result.label === label)?.response
    assert.equal(outcome?.ok, true, `${label} should succeed: ${JSON.stringify(outcome)}`)
  }

  const stillActive = await rpc.ok(STATUS_METHOD, {}, laneReplyBudgetMs)
  assert.equal(stillActive.payload.active, true, 'probe commands accidentally released the blocker')
  assert.equal(stillActive.payload.activeGeneration, active.activeGeneration)
  assert.equal(blockSettled, false, 'AccountMaintenance blocker settled during the lane probes')

  const released = await rpc.ok(RELEASE_METHOD, {}, laneReplyBudgetMs)
  blockerActive = false
  assert.equal(released.payload.released, true, 'release did not find the active blocker')
  assert.equal(released.payload.generation, active.activeGeneration)

  const blockReply = await withDeadline(
    blocked,
    laneReplyBudgetMs,
    'blocked AccountMaintenance reply'
  )
  assert.equal(
    blockReply.response.ok,
    true,
    `blocker failed: ${JSON.stringify(blockReply.response)}`
  )
  assert.equal(blockReply.response.payload.generation, active.activeGeneration)

  const finalStatus = await rpc.ok(STATUS_METHOD, {}, laneReplyBudgetMs)
  assert.equal(
    finalStatus.payload.active,
    false,
    'command-lane blocker stayed active after release'
  )
  assert.equal(finalStatus.payload.generation, active.generation)

  console.log(
    'Command-lane smoke PASS — one real WebSocket held AccountMaintenance while Observation, ' +
      'screens/captions LiveControl, DurableChat, and Stop all replied before explicit release. ' +
      probes.map(({ label, elapsedMs }) => `${label}=${elapsedMs}ms`).join(', ')
  )
} finally {
  if (blockerActive && rpc) {
    await rpc.call(RELEASE_METHOD, {}, 1_000).catch(() => {})
  }
  rpc?.close()
  socket?.close()
  if (backendProcess) {
    await stopProcess(backendProcess, { timeoutMs: 10_000 }).catch(() => {})
  }
  rmSync(stateRoot, { recursive: true, force: true })
}

async function probe(client, label, method, params) {
  const outcome = await client.call(method, params, laneReplyBudgetMs)
  return { label, ...outcome }
}

async function waitForActiveGeneration(client, previousGeneration, budgetMs) {
  const deadline = Date.now() + budgetMs
  let last
  while (Date.now() < deadline) {
    // The request/response round trip is the backoff and, more importantly,
    // the readiness evidence. There is no fixed sleep that can race dispatch.
    const status = await client.ok(STATUS_METHOD, {}, Math.min(1_000, deadline - Date.now()))
    last = status.payload
    if (
      last.active === true &&
      Number.isSafeInteger(last.generation) &&
      last.generation > previousGeneration &&
      last.activeGeneration === last.generation
    ) {
      return last
    }
  }
  throw new Error(`AccountMaintenance blocker did not become observable: ${JSON.stringify(last)}`)
}

function createRpc(ws, defaultTimeoutMs) {
  let nextId = 0
  const pending = new Map()

  const onMessage = (event) => {
    let response
    try {
      response = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (typeof response.id !== 'string' || !pending.has(response.id)) return
    const request = pending.get(response.id)
    pending.delete(response.id)
    clearTimeout(request.timer)
    request.resolve({ response, elapsedMs: Date.now() - request.startedAt })
  }
  ws.addEventListener('message', onMessage)

  const call = (method, params = {}, budgetMs = defaultTimeoutMs) =>
    new Promise((resolve, reject) => {
      const id = `command-lane-smoke-${nextId++}-${method}`
      const startedAt = Date.now()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} did not reply within ${budgetMs}ms`))
      }, budgetMs)
      pending.set(id, { method, resolve, reject, timer, startedAt })
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })

  const ok = async (method, params = {}, budgetMs = defaultTimeoutMs) => {
    const outcome = await call(method, params, budgetMs)
    assert.equal(
      outcome.response.ok,
      true,
      `${method} failed: ${JSON.stringify(outcome.response.error)}`
    )
    return { ...outcome.response, elapsedMs: outcome.elapsedMs }
  }

  const close = () => {
    ws.removeEventListener('message', onMessage)
    for (const [id, request] of pending) {
      clearTimeout(request.timer)
      request.reject(new Error(`${request.method} was canceled while closing the smoke client`))
      pending.delete(id)
    }
  }

  return { call, ok, close }
}

function withDeadline(promise, budgetMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${budgetMs}ms`)), budgetMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function waitForBackendReady(child, budgetMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Backend did not print READY in time.')),
      budgetMs
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith('READY '))
      if (!line) return
      try {
        finish(resolve, JSON.parse(line.slice('READY '.length)))
      } catch {
        finish(reject, new Error(`Backend printed invalid READY JSON: ${line}`))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000)
    })
    child.once('error', (error) => finish(reject, error))
    child.once('exit', (code, signal) =>
      finish(
        reject,
        new Error(
          `Backend exited before READY (code=${code}, signal=${signal}).${stderr ? `\n${stderr}` : ''}`
        )
      )
    )
  })
}
