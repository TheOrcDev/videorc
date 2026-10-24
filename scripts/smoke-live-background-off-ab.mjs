// Plan 190 S9: zero cost when off. A/B of this branch against a base worktree
// (origin/main) with NO live background chosen, alternating base and branch
// runs on the same host. Per run:
// - app ready: launch to the backend-ready and preview-motion-ready markers;
// - idle preview compositor frame p95 (median of the 2 s windows over 30 s);
// - a 1080p60 recording's compositor frame p95 (median over 20 s);
// - process memory (the tree's own `scripts/smoke-process-memory.mjs`).
// Pass: every branch median within the larger of 3 % or the base-to-base
// noise band, and memory within 2 MB plus the noise band.
//
// Both trees must be built first (`cargo build -p videorc-backend` and the
// desktop build in each, never sharing a target dir); runs use
// VIDEORC_SMOKE_SKIP_PREBUILD=1. Usage:
//   node scripts/smoke-live-background-off-ab.mjs --base <worktree> [--rounds 3]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const branchRoot = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const baseRoot = resolve(args[args.indexOf('--base') + 1] ?? '')
assert(args.includes('--base') && baseRoot !== branchRoot, 'pass --base <origin/main worktree>')
const rounds = args.includes('--rounds') ? Number(args[args.indexOf('--rounds') + 1]) : 3
const timeoutMs = 180000
const IDLE_MS = 30000
const RECORD_MS = 20000

const LAYOUT = {
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
}

const results = { base: [], branch: [] }
for (let round = 0; round < rounds; round += 1) {
  // Alternate the order so a host trend doesn't favour one side.
  const order = round % 2 === 0 ? ['base', 'branch'] : ['branch', 'base']
  for (const side of order) {
    const root = side === 'base' ? baseRoot : branchRoot
    console.log(`round ${round + 1}/${rounds}: ${side} (${root}), load ${loadavg()[0].toFixed(1)}`)
    const timing = await measureTiming(root)
    const memory = await measureMemory(root)
    results[side].push({ ...timing, ...memory })
    console.log(`  ${JSON.stringify(results[side].at(-1))}`)
  }
}

const metrics = [
  'readyMs',
  'idleP95Ms',
  'recordP95Ms',
  'ownedRssMb',
  'backendRssMb',
  'rendererRssMb'
]
const rows = metrics.map((metric) => {
  const base = results.base.map((run) => run[metric]).filter(Number.isFinite)
  const branch = results.branch.map((run) => run[metric]).filter(Number.isFinite)
  const baseMedian = median(base)
  const branchMedian = median(branch)
  // The noise band: how far base runs spread around their own median.
  const noise = Math.max(...base.map((value) => Math.abs(value - baseMedian)), 0)
  const memory = metric.endsWith('RssMb')
  const allowed = memory ? 2 + noise : Math.max(baseMedian * 0.03, noise)
  const delta = branchMedian - baseMedian
  return { metric, base: baseMedian, branch: branchMedian, delta, allowed, pass: delta <= allowed }
})
console.table(
  rows.map((row) => ({
    ...row,
    base: fmt(row.base),
    branch: fmt(row.branch),
    delta: fmt(row.delta),
    allowed: fmt(row.allowed)
  }))
)
const failed = rows.filter((row) => !row.pass)
assert.equal(
  failed.length,
  0,
  `zero cost when off FAILED: ${failed.map((row) => row.metric).join(', ')}`
)
console.log('Live background zero-cost A/B PASS')

async function measureTiming(root) {
  const { launchDevApp } = await import(pathToFileURL(join(root, 'scripts/lib/app-launcher.mjs')))
  const { connectBackend, request } = await import(
    pathToFileURL(join(root, 'scripts/smoke-recording-session.mjs'))
  )
  const { requestSmokeCommand } = await import(
    pathToFileURL(join(root, 'scripts/lib/smoke-command-client.mjs'))
  )
  const userDataDir = mkdtempSync(join(tmpdir(), 'videorc-live-ab-user-data-'))
  const outputDirectory = mkdtempSync(join(tmpdir(), 'videorc-live-ab-output-'))
  const started = performance.now()
  const launch = await launchDevApp({
    env: {
      VIDEORC_SMOKE_SKIP_PREBUILD: '1',
      VIDEORC_SMOKE_COMMAND_SERVER: '1',
      VIDEORC_SMOKE_PREVIEW_MOTION: '1',
      VIDEORC_SMOKE_DISABLE_NATIVE_MICROPHONE: '1',
      VIDEORC_SMOKE_STATE_DIR: outputDirectory,
      VIDEORC_SMOKE_OUTPUT_DIR: outputDirectory,
      VIDEORC_USER_DATA_DIR: userDataDir,
      VIDEORC_DATABASE_PATH: join(userDataDir, 'videorc.sqlite3')
    },
    timeoutMs,
    requiredMarkers: ['backend-ready', 'preview-motion-ready']
  })
  const readyMs = performance.now() - started
  const ws = await connectBackend(launch.connections['backend-ready'], timeoutMs)
  const smoke = launch.connections['preview-motion-ready']
  try {
    await requestSmokeCommand(smoke, 'enable-synthetic-source', { settleMs: 0 }, { timeoutMs })
    await requestSmokeCommand(smoke, 'preview-window-open', {}, { timeoutMs })
    const idleP95Ms = await sampleP95(request, ws, IDLE_MS)
    const capability = await requestSmokeCommand(
      smoke,
      'authorize-smoke-resource',
      { path: outputDirectory, kind: 'output-directory' },
      { timeoutMs }
    )
    await request(ws, timeoutMs, 'session.start', {
      sources: { testPattern: true },
      layout: LAYOUT,
      output: {
        recordEnabled: true,
        streamEnabled: false,
        outputDirectoryCapability: capability.capabilityId,
        video: { preset: 'custom', width: 1920, height: 1080, fps: 60, bitrateKbps: 8000 },
        rtmp: { preset: 'custom', serverUrl: '', streamKey: '' }
      }
    })
    const recordP95Ms = await sampleP95(request, ws, RECORD_MS)
    await request(ws, timeoutMs, 'session.stop')
    return { readyMs, idleP95Ms, recordP95Ms }
  } finally {
    ws.close()
    await launch.stop()
  }
}

async function sampleP95(request, ws, durationMs) {
  const values = []
  const until = Date.now() + durationMs
  // Skip the first window (warm-up), then one sample per 2 s stats window.
  await sleep(2500)
  while (Date.now() < until) {
    const status = await request(ws, 4000, 'compositor.status')
    if (Number.isFinite(status.frameTimeP95Ms)) values.push(status.frameTimeP95Ms)
    await sleep(2000)
  }
  assert(values.length >= 3, 'too few compositor p95 samples')
  return median(values)
}

async function measureMemory(root) {
  const output = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(root, 'scripts/smoke-process-memory.mjs')], {
      cwd: root,
      env: { ...process.env, VIDEORC_SMOKE_SKIP_PREBUILD: '1' },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    let text = ''
    child.stdout.on('data', (chunk) => {
      text += chunk.toString()
    })
    child.once('error', rejectRun)
    child.once('exit', (code) =>
      code === 0 ? resolveRun(text) : rejectRun(new Error(`process memory smoke exited ${code}`))
    )
  })
  const reportPath = /Process memory report: (.+)/.exec(output)?.[1]?.trim()
  assert(reportPath, `the process memory smoke printed no report in ${root}`)
  const summary = findSummary(JSON.parse(readFileSync(reportPath, 'utf8')))
  assert(summary, `no memory summary in ${reportPath}`)
  const roleMb = (needle) => {
    const entry = Object.entries(summary.roles ?? {}).find(([role]) => role.includes(needle))
    return entry ? entry[1].maxRssKb / 1024 : NaN
  }
  return {
    ownedRssMb: summary.maxOwnedRssKb / 1024,
    backendRssMb: roleMb('backend'),
    rendererRssMb: roleMb('renderer')
  }
}

function findSummary(value) {
  if (!value || typeof value !== 'object') return null
  if ('maxOwnedRssKb' in value && 'roles' in value) return value
  for (const child of Object.values(value)) {
    const found = findSummary(child)
    if (found) return found
  }
  return null
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN
}

function fmt(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 'n/a'
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
