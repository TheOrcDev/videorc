// Renderer memory-leak attribution probe.
//
// The leaking memory lives OUTSIDE the V8 heap (vmmap shows PartitionAlloc
// regions growing ~40/s while JS heap stays ~50MB), so heap snapshots are
// blind to it. This probe launches an isolated instance with the synthetic
// live preview, captures two Chromium memory-infra dumps a window apart, and
// reports per-process, per-allocator growth — naming the exact allocator
// (partition_alloc partitions, mojo, cc, v8, malloc...) that leaks.
//
// Usage: node scripts/perf-memory-probe.mjs
// Env knobs: VIDEORC_PERF_LEAK_WINDOW_SECONDS=100, VIDEORC_PROBE_TIMEOUT_MS

import { mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'

import { launchDevApp, repoRoot } from './lib/app-launcher.mjs'
import {
  collectPerformanceMetadata,
  createPerformanceReport,
  failingChecks,
  observationCheck,
  passingCheck,
  performanceMode,
  writePerformanceReport
} from './lib/performance-contract.mjs'
import {
  ownedProcessLedgerPaths,
  pruneDeadOwnedProcessRecords,
  waitForCleanProcessState,
  waitForNoLiveProcessState
} from './lib/process-census.mjs'

const mode = performanceMode()
const timeoutMs = Number(process.env.VIDEORC_PROBE_TIMEOUT_MS ?? 180000)
const windowSeconds = Number(process.env.VIDEORC_PERF_LEAK_WINDOW_SECONDS ?? 100)
const maxAllocatorGrowthMbPerMinute = Number(
  process.env.VIDEORC_PERF_MAX_ALLOCATOR_GROWTH_MB_MIN ?? 40
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function smokeCommand(smoke, command, params = {}) {
  const body = JSON.stringify({ command, params })
  return new Promise((resolveCmd, rejectCmd) => {
    const req = httpRequest(
      {
        hostname: smoke.host,
        port: smoke.port,
        path: '/command',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${smoke.capability}` }
      },
      (res) => {
        res.setEncoding('utf8')
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          try {
            const payload = JSON.parse(text)
            if (payload.error) rejectCmd(new Error(`${command} -> ${payload.error}`))
            else resolveCmd(payload.result ?? payload)
          } catch {
            rejectCmd(new Error(`${command} -> invalid JSON: ${text.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', rejectCmd)
    req.write(body)
    req.end()
  })
}

async function smokeCommandRetry(smoke, command, params = {}) {
  const deadline = Date.now() + 30000
  let last
  while (Date.now() < deadline) {
    try {
      return await smokeCommand(smoke, command, params)
    } catch (e) {
      last = e
      const m = String(e?.message ?? e)
      if (!m.includes('Main window is not ready') && !m.includes('Could not find tab')) throw e
      await sleep(250)
    }
  }
  throw last
}

// Last detailed memory dump per pid plus process labels:
// { dumps: Map<pid, allocators>, labels: Map<pid, name> }.
function parseMemoryDumps(traceFile) {
  const trace = JSON.parse(readFileSync(traceFile, 'utf8'))
  const events = trace.traceEvents ?? trace
  const byPid = new Map()
  const labels = new Map()
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'process_name' && event.args?.name) {
      labels.set(event.pid, event.args.name)
      continue
    }
    if (event.ph !== 'v' || !event.args?.dumps?.allocators) continue
    const allocators = {}
    for (const [name, node] of Object.entries(event.args.dumps.allocators)) {
      const value = node?.attrs?.size?.value
      if (typeof value === 'string') {
        allocators[name] = parseInt(value, 16)
      }
    }
    byPid.set(event.pid, allocators)
  }
  return { dumps: byPid, labels }
}

// Roll allocator paths up to meaningful groups (partition_alloc has per-bucket
// children; the roots and first level are what we need).
function groupAllocators(allocators) {
  const groups = {}
  for (const [name, bytes] of Object.entries(allocators)) {
    const parts = name.split('/')
    const key = parts[0] === 'partition_alloc' ? parts.slice(0, 3).join('/') : parts[0]
    // Only leaf-ish entries to avoid double counting roots that include children.
    groups[key] = Math.max(groups[key] ?? 0, bytes)
  }
  return groups
}

const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-mem-probe-'))
const appDataDir = join(stateRoot, 'app-data')
const userDataDir = join(stateRoot, 'user-data')
const ledgerPaths = ownedProcessLedgerPaths({ appDataDir, userDataDir, workspaceRoot: repoRoot })
let devtoolsUrl = null
const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_SMOKE_STATE_DIR: stateRoot,
    VIDEORC_APP_DATA_DIR: appDataDir,
    VIDEORC_USER_DATA_DIR: userDataDir,
    VIDEORC_DATABASE_PATH: join(appDataDir, 'videorc.sqlite3'),
    VIDEORC_REMOTE_DEBUG_PORT: '0'
  },
  onLine: (line) => {
    const devtools = /DevTools listening on (ws:\/\/[^\s]+)/.exec(line)
    if (devtools) devtoolsUrl = devtools[1]
    if (/error|panic|present pump/i.test(line)) console.log('APP>', line)
  }
})

class CdpClient {
  constructor(ws) {
    this.ws = ws
    this.serial = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      }
    })
  }

  static connect(url) {
    return new Promise((resolveConnect, rejectConnect) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => resolveConnect(new CdpClient(ws)))
      ws.addEventListener('error', () => rejectConnect(new Error(`CDP connect failed: ${url}`)))
    })
  }

  send(method, params = {}) {
    const id = ++this.serial
    // A dying renderer must never hang the probe on an unanswered request.
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rejectSend(new Error(`CDP ${method} timed out`))
      }, 10000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolveSend(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          rejectSend(error)
        }
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

async function fetchJsonHttp(url) {
  return new Promise((resolveFetch, rejectFetch) => {
    const req = httpRequest(url, { method: 'GET' }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        try {
          resolveFetch(JSON.parse(text))
        } catch (e) {
          rejectFetch(e)
        }
      })
    })
    req.on('error', rejectFetch)
    req.end()
  })
}

const COUNTER_INSTRUMENT = `(() => {
  if (window.__videorcCounters) return 'already'
  const counts = { localStorageSet: 0, localStorageBytes: 0, wsOut: 0, jsonStringifyBytes: 0, timeouts: 0, microtasks: 0 }
  window.__videorcCounters = counts
  const origSetItem = Storage.prototype.setItem
  Storage.prototype.setItem = function (key, value) {
    counts.localStorageSet += 1
    counts.localStorageBytes += String(value).length
    return origSetItem.call(this, key, value)
  }
  const origSend = WebSocket.prototype.send
  WebSocket.prototype.send = function (data) {
    counts.wsOut += 1
    return origSend.call(this, data)
  }
  const origStringify = JSON.stringify
  JSON.stringify = function (...args) {
    const result = origStringify.apply(this, args)
    counts.jsonStringifyBytes += typeof result === 'string' ? result.length : 0
    return result
  }
  const origSetTimeout = window.setTimeout
  window.setTimeout = function (...args) { counts.timeouts += 1; return origSetTimeout.apply(this, args) }
  return 'instrumented'
})()`

const smoke = launched.connections['preview-motion-ready']
const traceFiles = []
const allocatorGrowth = []
let matchingDumpProcesses = 0
let runError = null
let teardownClean = false
let teardownRecovery = null

try {
  for (const attempt of [
    ['open-tab', { tab: 'studio', waitFor: '[data-videorc-preview-card]' }],
    ['open-layout-tab', {}]
  ]) {
    try {
      await smokeCommandRetry(smoke, attempt[0], attempt[1])
      break
    } catch {
      /* tab probably opened anyway; presents prove the pipeline below */
    }
  }
  if (process.env.VIDEORC_MEM_PROBE_NO_PREVIEW !== '1') {
    await smokeCommandRetry(smoke, 'preview-window-open')
  }
  console.log('settling 12s...')
  await sleep(12000)

  if (process.env.VIDEORC_MEM_PROBE_BLANK === '1') {
    console.log('bisecting: blanking the main window (about:blank, preload kept)...')
    await smokeCommand(smoke, 'blank-main-window')
    await sleep(3000)
  }

  // What does the backend actually stream to ws clients? Count events by name
  // for 10s on our own unfiltered connection — the renderer sees this stream
  // minus whatever it excluded.
  const backend = launched.connections['backend-ready']
  const counts = new Map()
  const tap = new WebSocket(
    `ws://${backend.host}:${backend.port}/ws?token=${encodeURIComponent(backend.token)}`
  )
  let tapBytes = 0
  tap.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    tapBytes += event.data.length
    try {
      const parsed = JSON.parse(event.data)
      if (parsed.event) counts.set(parsed.event, (counts.get(parsed.event) ?? 0) + 1)
    } catch {
      /* responses */
    }
  })
  await sleep(10000)
  tap.close()
  console.log('\n=== ws event stream (10s tap, unfiltered) ===')
  for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${String(count / 10).padStart(6)}/s  ${name}`)
  }
  console.log(`  total ${(tapBytes / 10 / 1024).toFixed(0)}KB/s on the wire`)

  let cdp = null
  if (devtoolsUrl) {
    try {
      const { host } = new URL(devtoolsUrl.replace('ws://', 'http://'))
      const targets = await fetchJsonHttp(`http://${host}/json/list`)
      const mainTarget = targets.find(
        (target) => target.type === 'page' && /^https?:\/\/localhost/.test(target.url ?? '')
      )
      if (mainTarget) {
        cdp = await CdpClient.connect(mainTarget.webSocketDebuggerUrl)
        const setup = await cdp.send('Runtime.evaluate', { expression: COUNTER_INSTRUMENT })
        console.log('page-world counters:', setup.result?.value)
      }
    } catch (error) {
      console.log('counter instrumentation unavailable:', String(error?.message ?? error))
    }
  }

  const ipcCountsBefore = await smokeCommand(smoke, 'ipc-send-counts').catch(() => ({}))

  console.log('capturing baseline memory-infra dump...')
  const before = await smokeCommand(smoke, 'memory-infra-dump', { seconds: 5 })
  traceFiles.push(before.file)
  const { dumps: beforeDumps } = parseMemoryDumps(before.file)
  console.log(`baseline dump: ${before.file} (${beforeDumps.size} processes)`)

  console.log(`leaking window: ${windowSeconds}s of 60Hz presents...`)
  await sleep(windowSeconds * 1000)

  console.log('capturing second memory-infra dump...')
  const after = await smokeCommand(smoke, 'memory-infra-dump', { seconds: 5 })
  traceFiles.push(after.file)
  const { dumps: afterDumps, labels } = parseMemoryDumps(after.file)
  console.log(`second dump: ${after.file}`)
  for (const [window, pid] of Object.entries(after.windows ?? {})) {
    labels.set(pid, `${labels.get(pid) ?? 'Renderer'}: ${window}`)
  }

  const ipcCountsAfter = await smokeCommand(smoke, 'ipc-send-counts').catch(() => ({}))
  console.log('\n=== main->renderer IPC sends during the window ===')
  for (const [channel, count] of Object.entries(ipcCountsAfter)) {
    const delta = count - (ipcCountsBefore[channel] ?? 0)
    if (delta > 0) {
      console.log(`  ${(delta / windowSeconds).toFixed(1).padStart(7)}/s  ${channel}`)
    }
  }

  if (cdp) {
    try {
      const read = await cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__videorcCounters)',
        returnByValue: true
      })
      const counters = JSON.parse(read.result.value)
      console.log('\n=== page-world rates during the window ===')
      for (const [key, value] of Object.entries(counters)) {
        console.log(`  ${key.padEnd(20)} ${(value / (windowSeconds + 22)).toFixed(1)}/s-ish`)
      }
    } catch {
      /* cosmetic */
    } finally {
      cdp.close()
    }
  }

  console.log(`\n=== allocator growth over ${windowSeconds}s (per process) ===`)
  for (const [pid, afterAllocators] of afterDumps) {
    const beforeAllocators = beforeDumps.get(pid)
    if (!beforeAllocators) continue
    matchingDumpProcesses += 1
    const beforeGroups = groupAllocators(beforeAllocators)
    const afterGroups = groupAllocators(afterAllocators)
    const deltas = Object.entries(afterGroups)
      .map(([name, bytes]) => ({ name, delta: bytes - (beforeGroups[name] ?? 0), bytes }))
      .filter((entry) => Math.abs(entry.delta) > 2 * 1024 * 1024)
      .sort((a, b) => b.delta - a.delta)
    if (deltas.length === 0) continue
    allocatorGrowth.push(
      ...deltas.map((entry) => ({
        pid,
        process: labels.get(pid) ?? 'unknown process',
        allocator: entry.name,
        deltaBytes: entry.delta,
        finalBytes: entry.bytes,
        growthMbPerMinute: entry.delta / 1048576 / (windowSeconds / 60)
      }))
    )
    console.log(`\npid ${pid} (${labels.get(pid) ?? 'unknown process'}):`)
    for (const entry of deltas.slice(0, 10)) {
      console.log(
        `  ${(entry.delta / 1048576).toFixed(1).padStart(8)}MB grew  (now ${(entry.bytes / 1048576).toFixed(0)}MB)  ${entry.name}`
      )
    }
  }
} catch (error) {
  runError = error
} finally {
  try {
    await smokeCommand(smoke, 'app-quit').catch(() => undefined)
    await waitForNoLiveProcessState({
      ledgerPaths,
      pgid: launched.process.pid,
      timeoutMs: 10000
    }).catch(async () => launched.stop())
    await launched.stop()
    const clean = await waitForCleanProcessState({
      ledgerPaths,
      pgid: launched.process.pid,
      timeoutMs: 1000
    })
    teardownClean = clean.records.length === 0 && clean.processGroupRows.length === 0
  } catch (error) {
    runError ??= error
    try {
      teardownRecovery = await pruneDeadOwnedProcessRecords({ ledgerPaths })
    } catch (cleanupError) {
      teardownRecovery = { error: cleanupError?.message ?? String(cleanupError) }
    }
  }
}

const truthFailures = [
  ...(runError ? [runError.message] : []),
  ...(matchingDumpProcesses <= 0
    ? ['memory-infra dumps had no matching process allocator data']
    : []),
  ...(!teardownClean ? ['memory probe process teardown was not clean'] : [])
]
const growthFailures = allocatorGrowth
  .filter((entry) => entry.growthMbPerMinute > maxAllocatorGrowthMbPerMinute)
  .map(
    (entry) =>
      `${entry.process} ${entry.allocator} grew ${entry.growthMbPerMinute.toFixed(1)}MiB/min; maximum ${maxAllocatorGrowthMbPerMinute}MiB/min`
  )
const enforcedGrowthFailures = mode === 'gate' ? growthFailures : []
const report = createPerformanceReport({
  scenario:
    process.env.VIDEORC_MEM_PROBE_NO_PREVIEW === '1'
      ? 'chromium-memory-control'
      : 'chromium-memory-native-preview',
  mode,
  metadata: await collectPerformanceMetadata({ cwd: repoRoot }),
  timing: { warmupMs: 12000, measurementMs: windowSeconds * 1000 },
  metrics: {
    matchingDumpProcesses,
    allocatorGrowth,
    maxAllocatorGrowthMbPerMinute,
    traceFiles,
    teardownRecovery,
    scratchDirectory: stateRoot
  },
  checks: [
    ...(!truthFailures.length ? [passingCheck('allocator dumps and teardown were complete')] : []),
    ...failingChecks(truthFailures),
    ...failingChecks(enforcedGrowthFailures),
    ...(mode === 'report-only'
      ? growthFailures.map((failure) => observationCheck(`report-only observation: ${failure}`))
      : [])
  ]
})
const reportPath = await writePerformanceReport(report)
console.log(`Chromium memory report: ${reportPath}`)

const failed = truthFailures.length > 0 || enforcedGrowthFailures.length > 0
if (!failed && process.env.VIDEORC_PERF_RETAIN_ARTIFACTS !== '1') {
  await Promise.all([
    rm(stateRoot, { recursive: true, force: true }),
    ...traceFiles.map((path) => rm(path, { force: true }))
  ])
} else {
  console.log(`Chromium memory scratch retained: ${stateRoot}`)
}
if (failed) {
  throw new Error(
    `Chromium memory ${mode} failed:\n${[...truthFailures, ...enforcedGrowthFailures].join('\n')}`
  )
}
