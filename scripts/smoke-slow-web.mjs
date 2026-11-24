#!/usr/bin/env node

// Real-backend regression for the 2026-11-19 09:57 restart: the window's
// focus check (`cloud.show.check`) waited on videorc.com for its whole 10 s
// request timeout, crossed its 10 s mutation contract, and the backend
// recycled in the middle of a Clips session. The same morning slow room
// controls held the ordered lane and local controls waited behind them.
//
// One signed-in debug backend talks to the local fake cloud web through a
// proxy that can hold a route. Two proofs on one renderer socket:
//
// 1. A web-bound command (`cloud.allowance.refresh`) waits 6 s on the web.
//    While it waits, ordered-lane controls (mute, Save clip, a marker, the
//    editor draft) must answer at once.
// 2. `GET /api/cloud/shows/current` is held for 12 s, past the request's own
//    10 s timeout. `cloud.show.check` must answer at once, the same controls
//    must still answer, and after the hold the backend must be the same
//    process, still serving.
//
// Readiness is observed, never slept for: each proof starts when the proxy
// has seen the held request arrive. The backend is never pointed at the real
// videorc.com, and the fake web's node is never contacted (no show is made).
//
// `VIDEORC_SMOKE_BACKEND_BINARY` runs another build's backend (a base
// worktree, for a before/after), and `VIDEORC_SMOKE_REPORT` names a JSON file
// for the measurements, written pass or fail.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { loadavg, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { devAppSpawnOptions, repoRoot, stopProcess } from './lib/app-launcher.mjs'
import {
  cloudAllowanceBlock,
  newNodeSecret,
  newShowSigningKey,
  startFakeCloudWeb
} from './lib/fake-cloud-web.mjs'
import { removeProfileDir } from './lib/profile-dir-removal.mjs'
import { connectBackend } from './smoke-recording-session.mjs'

const CURRENT_SHOW_PATH = '/api/cloud/shows/current'
const ALLOWANCE_PATH = '/api/cloud/allowance'
// Under the request's 10 s timeout: the command must succeed after the wait.
const ALLOWANCE_HOLD_MS = 6_000
// Over the request's 10 s timeout, which was also the old mutation contract.
const CURRENT_SHOW_HOLD_MS = 12_000
// A local control answers in milliseconds; this leaves room for a busy host.
const LOCAL_CONTROL_BUDGET_MS = 1_000
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 60_000)
const backendBinaryName = process.platform === 'win32' ? 'videorc-backend.exe' : 'videorc-backend'
const backendBinary =
  process.env.VIDEORC_SMOKE_BACKEND_BINARY ?? join(repoRoot, 'target', 'debug', backendBinaryName)
const reportPath = process.env.VIDEORC_SMOKE_REPORT
const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-slow-web-'))

// Ordered-lane commands a streamer presses mid-show. None needs a session:
// each answers ok or its own refusal, and either one proves it was not held.
const LOCAL_CONTROLS = [
  ['mute', 'audio.processing.update', {}],
  ['save clip', 'replay.save', {}],
  ['marker', 'session.marker.create', {}],
  ['editor draft', 'scene.editor.draft.clear', {}]
]
// What a command held by the dispatcher answers, never its own handler.
const HELD_CODES = new Set([
  'command-expired-before-dispatch',
  'command-lane-full',
  'command-not-applied',
  'request-outcome-unknown'
])

assert.ok(
  existsSync(backendBinary),
  `${backendBinary} missing: run \`cargo build -p videorc-backend\` first`
)

const report = {
  backendBinary,
  loadAtStart: loadavg(),
  webBoundCommand: null,
  focusCheck: null,
  failures: []
}
let web
let proxy
let backendProcess
let socket
let rpc
let backendExit = null

try {
  const sessionToken = `slow-web-session-${Math.random().toString(36).slice(2)}`
  web = await startFakeCloudWeb({
    sessionToken,
    // Never contacted: no show is created in this smoke.
    node: { id: 'slow-web-node', secret: newNodeSecret(), agentUrl: 'http://127.0.0.1:9' },
    signingKey: newShowSigningKey().privateKey,
    allowance: cloudAllowanceBlock({ nowMs: Date.now() })
  })
  proxy = await startHoldProxy(web.httpOrigin)

  const secretsPath = join(stateRoot, 'videorc-secrets.json')
  writeFileSync(secretsPath, JSON.stringify({ 'account:videorc:session': sessionToken }, null, 2))
  chmodSync(secretsPath, 0o600)

  backendProcess = spawn(backendBinary, [], {
    ...devAppSpawnOptions({
      env: {
        ...process.env,
        VIDEORC_API_BASE_URL: proxy.origin,
        VIDEORC_DISABLE_AUTO_PREVIEW: '1',
        VIDEORC_DISABLE_BACKEND_REAP: '1',
        VIDEORC_USAGE_STATS: '0',
        VIDEORC_STREAM_REPORT_EMAIL: '0',
        VIDEORC_LIVE_STATUS: '0',
        VIDEORC_APP_DATA_DIR: join(stateRoot, 'app-data'),
        VIDEORC_DATABASE_PATH: join(stateRoot, 'videorc.sqlite3'),
        VIDEORC_SECRETS_PATH: secretsPath,
        VIDEORC_RECORDINGS_DIR: join(stateRoot, 'recordings'),
        VIDEORC_SMOKE_STATE_DIR: stateRoot
      }
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  backendProcess.once('exit', (code, signal) => {
    backendExit = { code, signal, atMs: Date.now() }
  })

  const ready = await waitForBackendReady(backendProcess, timeoutMs)
  socket = await connectBackend({ ...ready, adminToken: undefined }, timeoutMs)
  rpc = createRpc(socket)

  // The signed-in backend reads its plan, then asks for a show a crash left
  // live. Both must have happened before a check can reach the web.
  await waitFor(
    () => proxy.arrivals(CURRENT_SHOW_PATH).length >= 1,
    30_000,
    'the backend never asked the fake web for the current show: it is not signed in'
  )

  // 1. A web-bound command waits; local controls do not.
  proxy.hold(ALLOWANCE_PATH, ALLOWANCE_HOLD_MS)
  const allowanceSeen = proxy.arrivals(ALLOWANCE_PATH).length
  const allowanceStartedAt = Date.now()
  const allowance = rpc.call('cloud.allowance.refresh', {}, timeoutMs)
  await waitFor(
    () => proxy.arrivals(ALLOWANCE_PATH).length > allowanceSeen,
    10_000,
    'cloud.allowance.refresh never reached the fake web'
  )
  const controlsDuringCommand = await probeLocalControls(rpc)
  const allowanceReply = await allowance
  report.webBoundCommand = {
    method: 'cloud.allowance.refresh',
    webHeldMs: ALLOWANCE_HOLD_MS,
    replyMs: Date.now() - allowanceStartedAt,
    ok: allowanceReply.response.ok === true,
    errorCode: allowanceReply.response.error?.code ?? null,
    localControls: controlsDuringCommand,
    load: loadavg()
  }
  proxy.hold(ALLOWANCE_PATH, 0)
  expectLocalControls('while cloud.allowance.refresh waited on the web', controlsDuringCommand)
  expect(
    allowanceReply.response.ok === true,
    `cloud.allowance.refresh should succeed after a ${ALLOWANCE_HOLD_MS} ms answer: ${JSON.stringify(allowanceReply.response.error)}`
  )

  const stats = await rpc.call('diagnostics.stats', {}, 10_000)
  expect(
    Boolean(stats.response.payload?.websocketTransport?.commandLanes?.cloudControl),
    'diagnostics.stats did not expose the cloudControl lane'
  )

  // 2. The focus check, with the web holding its answer past the request's
  // own timeout. The backend spaces checks 10 s apart, so a check is sent
  // until one reaches the web.
  proxy.hold(CURRENT_SHOW_PATH, CURRENT_SHOW_HOLD_MS)
  const checksSeen = proxy.arrivals(CURRENT_SHOW_PATH).length
  let check = null
  const giveUpAt = Date.now() + 45_000
  while (!check && Date.now() < giveUpAt && !backendExit) {
    const attempt = { startedAt: Date.now(), reply: null }
    attempt.done = rpc.call('cloud.show.check', {}, timeoutMs).then(
      (outcome) => {
        attempt.reply = outcome
      },
      (error) => {
        attempt.reply = { failed: String(error?.message ?? error) }
      }
    )
    const reached = await waitFor(
      () => proxy.arrivals(CURRENT_SHOW_PATH).length > checksSeen,
      1_500,
      null
    )
    if (reached) check = attempt
    else await attempt.done
  }
  assert.ok(check, 'no cloud.show.check reached the fake web in 45 s')
  const heldAt = proxy.arrivals(CURRENT_SHOW_PATH).at(-1).at

  const controlsDuringCheck = await probeLocalControls(rpc)
  // Past the hold and the request's own 10 s timeout.
  await delay(Math.max(0, heldAt + CURRENT_SHOW_HOLD_MS + 1_500 - Date.now()))
  const afterHold = backendExit
    ? null
    : await rpc.call('health.ping', {}, 5_000).catch((error) => ({ failed: String(error) }))
  report.focusCheck = {
    webHeldMs: CURRENT_SHOW_HOLD_MS,
    replyMs: check.reply?.elapsedMs ?? null,
    replied: Boolean(check.reply?.response),
    ok: check.reply?.response?.ok === true,
    errorCode: check.reply?.response?.error?.code ?? null,
    localControls: controlsDuringCheck,
    backendExit: backendExit
      ? { ...backendExit, msAfterTheWebWasAsked: backendExit.atMs - heldAt }
      : null,
    healthPingAfterHold: afterHold?.response?.ok === true,
    load: loadavg()
  }
  expect(
    check.reply?.response?.ok === true && check.reply.elapsedMs < LOCAL_CONTROL_BUDGET_MS,
    `cloud.show.check must answer at once while the web holds its answer: ${JSON.stringify(report.focusCheck)}`
  )
  expectLocalControls('while the focus check waited on the web', controlsDuringCheck)
  expect(
    backendExit === null,
    `the backend exited while the web held ${CURRENT_SHOW_PATH}: ${JSON.stringify(backendExit)}`
  )
  expect(
    afterHold?.response?.ok === true,
    `the backend stopped serving after the web held its answer: ${JSON.stringify(afterHold)}`
  )

  assert.deepEqual(report.failures, [], report.failures.join('\n'))
  console.log(
    'Slow-web smoke PASS: ' +
      `local controls answered in ${slowest(controlsDuringCommand)} ms at most while a web-bound command waited ${ALLOWANCE_HOLD_MS} ms, ` +
      `cloud.show.check answered in ${report.focusCheck.replyMs} ms with the web held ${CURRENT_SHOW_HOLD_MS} ms, ` +
      `and the backend kept serving (load ${loadavg()
        .map((value) => value.toFixed(2))
        .join(' ')}).`
  )
} finally {
  report.loadAtEnd = loadavg()
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }
  rpc?.close()
  socket?.close()
  if (backendProcess && !backendExit) {
    await stopProcess(backendProcess, { timeoutMs: 10_000 }).catch(() => {})
  }
  await Promise.resolve(proxy?.close()).catch(() => {})
  await Promise.resolve(web?.close()).catch(() => {})
  await removeProfileDir(stateRoot, { label: 'slow-web smoke' })
}

function expect(condition, message) {
  if (!condition) report.failures.push(message)
}

function expectLocalControls(when, results) {
  for (const result of results) {
    expect(
      result.answered && !result.held && result.elapsedMs < LOCAL_CONTROL_BUDGET_MS,
      `${result.label} (${result.method}) was held ${when}: ${JSON.stringify(result)}`
    )
  }
}

function slowest(results) {
  return Math.max(...results.map((result) => result.elapsedMs ?? Infinity))
}

// Every probe gets the hold's whole length, so a held control reports how
// long it was held instead of only "timed out".
async function probeLocalControls(client) {
  return Promise.all(
    LOCAL_CONTROLS.map(async ([label, method, params]) => {
      const startedAt = Date.now()
      try {
        const outcome = await client.call(method, params, 20_000)
        const code = outcome.response.error?.code ?? null
        return {
          label,
          method,
          answered: true,
          elapsedMs: outcome.elapsedMs,
          ok: outcome.response.ok === true,
          code,
          held: HELD_CODES.has(code)
        }
      } catch (error) {
        return {
          label,
          method,
          answered: false,
          elapsedMs: Date.now() - startedAt,
          failed: String(error?.message ?? error)
        }
      }
    })
  )
}

/**
 * A local reverse proxy in front of the fake web that can hold a route's
 * answer, and records when each request arrived.
 */
async function startHoldProxy(upstreamOrigin) {
  const holds = new Map()
  const seen = []
  const server = createServer(async (req, res) => {
    res.on('error', () => {})
    const path = new URL(req.url, 'http://proxy.invalid').pathname
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      seen.push({ method: req.method, path, at: Date.now() })
      const holdMs = holds.get(path) ?? 0
      if (holdMs > 0) await delay(holdMs)
      const headers = {}
      for (const name of ['authorization', 'content-type', 'accept', 'user-agent']) {
        if (req.headers[name]) headers[name] = req.headers[name]
      }
      const hasBody = !['GET', 'HEAD'].includes(req.method)
      const upstream = await fetch(`${upstreamOrigin}${req.url}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: Buffer.concat(chunks) } : {})
      })
      const body = Buffer.from(await upstream.arrayBuffer())
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json'
      })
      res.end(body)
    } catch {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    hold(path, ms) {
      if (ms > 0) holds.set(path, ms)
      else holds.delete(path)
    },
    arrivals(path) {
      return seen.filter((entry) => entry.path === path)
    },
    close() {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(() => resolve()))
    }
  }
}

/** Polls an observable condition. With `failure` null it answers false instead of throwing. */
async function waitFor(condition, budgetMs, failure) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await delay(25)
  }
  if (condition()) return true
  if (failure === null) return false
  throw new Error(failure)
}

function createRpc(ws) {
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

  const call = (method, params, budgetMs) =>
    new Promise((resolve, reject) => {
      const id = `slow-web-smoke-${nextId++}-${method}`
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

  const close = () => {
    ws.removeEventListener('message', onMessage)
    for (const [id, request] of pending) {
      clearTimeout(request.timer)
      request.reject(new Error(`${request.method} was canceled while closing the smoke client`))
      pending.delete(id)
    }
  }

  return { call, close }
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
