// Idle-pipeline performance probe.
//
// Launches an ISOLATED app instance (VIDEORC_USER_DATA_DIR gives it its own
// single-instance lock, so it runs alongside the owner's dev app), brings up
// the synthetic live preview, then samples per-process CPU/RSS of the spawned
// process tree and reports averages plus pipeline counters — most importantly
// the compositor-status HTTP fetch count, which must NOT grow ~60/s while the
// preview presents (the renderer already delivers that status per frame).
//
// Usage: node scripts/perf-idle-probe.mjs
// Env knobs: VIDEORC_PERF_SAMPLE_SECONDS=30, VIDEORC_PROBE_TIMEOUT_MS=180000

import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { promisify } from 'node:util'

import { launchDevApp } from './lib/app-launcher.mjs'

const execFileAsync = promisify(execFile)
const timeoutMs = Number(process.env.VIDEORC_PROBE_TIMEOUT_MS ?? 180000)
const sampleSeconds = Number(process.env.VIDEORC_PERF_SAMPLE_SECONDS ?? 30)
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
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
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

function classifyProcess(args) {
  if (args.includes('videorc-backend')) return 'backend'
  if (args.includes('native_preview_host_helper')) return 'helper'
  if (args.includes('--type=renderer')) return 'renderer'
  if (args.includes('--type=gpu-process')) return 'gpu'
  if (args.includes('--type=')) return 'electron-aux'
  if (/Electron\.app\/Contents\/MacOS\/Electron/.test(args)) return 'main'
  if (/electron-vite|esbuild|pnpm|cargo/.test(args)) return 'tooling'
  return 'other'
}

async function sampleProcessGroup(pgid) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,pcpu=,rss=,args='])
  const byCategory = {}
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match || Number(match[2]) !== pgid) continue
    const category = classifyProcess(match[5])
    const entry = (byCategory[category] ??= { cpu: 0, rssKb: 0 })
    entry.cpu += Number(match[3])
    entry.rssKb += Number(match[4])
  }
  return byCategory
}

const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-perf-userdata-'))
console.log('isolated userData:', userDataDir)

const launched = await launchDevApp({
  requiredMarkers: ['backend-ready', 'preview-motion-ready'],
  timeoutMs,
  env: {
    VIDEORC_SMOKE_PREVIEW_MOTION: '1',
    VIDEORC_USER_DATA_DIR: userDataDir
  },
  onLine: (line) => {
    if (/error|panic|present pump/i.test(line)) console.log('APP>', line)
  }
})

const smoke = launched.connections['preview-motion-ready']
const pgid = launched.process.pid
console.log('smoke server', JSON.stringify(smoke), 'pgid', pgid)

try {
  for (const attempt of [
    ['open-tab', { tab: 'studio', waitFor: '[data-videorc-preview-stage]' }],
    ['open-layout-tab', {}]
  ]) {
    try {
      await smokeCommandRetry(smoke, attempt[0], attempt[1])
      break
    } catch (e) {
      console.log(attempt[0], 'FAILED:', String(e?.message ?? e))
    }
  }
  await smokeCommandRetry(smoke, 'preview-window-open')
  console.log('settling 8s for surface + compositor...')
  await sleep(8000)

  const statusBefore = await smokeCommand(smoke, 'native-preview-surface-status')
  console.log(`sampling ${sampleSeconds}s...`)
  const accumulated = {}
  let ticks = 0
  for (let i = 0; i < sampleSeconds; i += 1) {
    const sample = await sampleProcessGroup(pgid)
    for (const [category, entry] of Object.entries(sample)) {
      const slot = (accumulated[category] ??= { cpu: 0, rssKb: 0, ticks: 0 })
      slot.cpu += entry.cpu
      slot.rssKb = entry.rssKb
      slot.ticks += 1
    }
    ticks += 1
    await sleep(1000)
  }
  const statusAfter = await smokeCommand(smoke, 'native-preview-surface-status')

  console.log('\n=== per-process averages (CPU summed per category) ===')
  for (const [category, slot] of Object.entries(accumulated).sort()) {
    console.log(
      `${category.padEnd(13)} avg_cpu=${(slot.cpu / Math.max(1, slot.ticks)).toFixed(1).padStart(5)}%  rss=${Math.round(slot.rssKb / 1024)}MB`
    )
  }

  const fetchesBefore = statusBefore?.nativePreviewMainStatusFetchSuccesses ?? 0
  const fetchesAfter = statusAfter?.nativePreviewMainStatusFetchSuccesses ?? 0
  const fetchDelta = fetchesAfter - fetchesBefore
  const framesBefore = statusBefore?.presentedFrameId ?? statusBefore?.framesRendered ?? 0
  const framesAfter = statusAfter?.presentedFrameId ?? statusAfter?.framesRendered ?? 0
  console.log('\n=== pipeline counters over the window ===')
  console.log(
    `presented frames: ${framesAfter - framesBefore} (${((framesAfter - framesBefore) / ticks).toFixed(1)}/s)`
  )
  console.log(`status HTTP fetches: ${fetchDelta} (${(fetchDelta / ticks).toFixed(1)}/s)`)
  console.log(
    `presented status age p95: ${statusAfter?.nativePreviewMainPresentedStatusAgeP95Ms}ms`
  )
  console.log(`present fps: ${statusAfter?.presentFps}`)
  console.log(
    `present interval p95/p99: ${statusAfter?.intervalP95Ms}ms/${statusAfter?.intervalP99Ms}ms ` +
      `queueWait p95: ${statusAfter?.nativePreviewMainQueueWaitP95Ms}ms ` +
      `queuedBehind: ${statusAfter?.nativePreviewMainQueuedBehindCount} ` +
      `helperRT p95: ${statusAfter?.nativePreviewHelperRoundTripP95Ms}ms`
  )
  console.log(`transport: ${statusAfter?.transport} backing: ${statusAfter?.backing}`)

  // The reuse fix's contract: presents flow per frame while HTTP fetches stay
  // near zero. Tolerate a small trickle (startup, occasional stale statuses).
  const fetchesPerSecond = fetchDelta / ticks
  if (framesAfter - framesBefore > 0 && fetchesPerSecond > 5) {
    console.log(`\nprobe FAILED: ${fetchesPerSecond.toFixed(1)} status fetches/s (expected ~0)`)
    process.exitCode = 1
  } else {
    console.log('\nprobe PASSED')
  }
} finally {
  await launched.stop()
}
