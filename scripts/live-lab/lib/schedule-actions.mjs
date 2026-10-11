import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { stopFilePath } from './kill-switch.mjs'
import { acquireRunLock, processAlive, readRunLock, releaseRunLock } from './run-lock.mjs'
import { REPO_ROOT } from './schedule-table.mjs'

// Plan 178 U11. What a due slot does. Each action runs a repo script to
// completion as a child of the tick (launchd keeps the tick alive; it never
// starts a second tick while one runs), streams the child's output into the
// day's schedule log, and returns one outcome for the state file:
//   { status, exitCode, reason?, runDir?, detail? }
// `status` is one of planTick's FINAL_STATUSES, or `deferred-lock` when the
// run lock is held and the slot should be retried on the next tick.

export const RUN_SCRIPT = join(REPO_ROOT, 'scripts', 'live-lab', 'run.mjs')
export const INSTALL_SCRIPT = join(REPO_ROOT, 'scripts', 'live-lab', 'install.mjs')
export const PUBLISH_SCRIPT = join(REPO_ROOT, 'scripts', 'live-lab', 'publish.mjs')
export const DOCTOR_SCRIPT = join(REPO_ROOT, 'scripts', 'live-lab', 'doctor.mjs')

// Scenario parameters (the marathon's hours, ...) reach run.mjs through this
// environment variable as JSON, so the run CLI stays exactly
// `--scenario --trigger [--build] [--privacy]`.
export const SCENARIO_PARAMS_ENV = 'VIDEORC_LIVE_LAB_SCENARIO_PARAMS'
export const LOG_KEEP_DAYS = 30
const TAIL_BYTES = 64 * 1024

export function logsDir(workDir) {
  return join(workDir, 'logs')
}

export function scheduleLogPath(workDir, date) {
  return join(logsDir(workDir), `schedule-${date}.log`)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Removes schedule-<date>.log files older than LOG_KEEP_DAYS days. */
export async function pruneLogs(workDir, today) {
  let names = []
  try {
    names = await readdir(logsDir(workDir))
  } catch {
    return []
  }
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() - LOG_KEEP_DAYS * 86_400_000
  const removed = []
  for (const name of names) {
    const match = /^schedule-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)
    if (match && new Date(`${match[1]}T00:00:00Z`).getTime() < cutoff) {
      await rm(join(logsDir(workDir), name), { force: true })
      removed.push(name)
    }
  }
  return removed
}

function appendTail(tail, chunk) {
  const next = tail + chunk
  return next.length > TAIL_BYTES ? next.slice(-TAIL_BYTES) : next
}

/**
 * Runs `node <script> ...args` from the repo root to completion. Output goes
 * to `logStream` (the day's schedule log) and the last 64 KB of each stream
 * is kept for parsing. `onChild` receives the child so the tick can forward
 * SIGTERM to it. Resolves { code, signal, stdout, stderr }.
 */
export function runNodeScript({
  script,
  args = [],
  env = process.env,
  logStream,
  onChild = () => {},
  spawnFn = spawn,
  nodePath = process.execPath
}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawnFn(nodePath, [script, ...args], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      resolve({ code: null, signal: null, stdout, stderr: `spawn failed: ${error.message}` })
      return
    }
    onChild(child)
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString()
      stdout = appendTail(stdout, text)
      logStream?.write(text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderr = appendTail(stderr, text)
      logStream?.write(text)
    })
    child.on('error', (error) => {
      stderr = appendTail(stderr, `spawn failed: ${error.message}\n`)
    })
    child.on('close', (code, signal) => {
      onChild(null)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

/** Pure: RUN_DIR= from the last such stdout line, and the last REFUSED (...) reason. */
export function parseRunOutput(stdout = '', stderr = '') {
  let runDir = null
  for (const line of stdout.split('\n')) {
    const match = /^RUN_DIR=(.+)$/.exec(line.trim())
    if (match) runDir = match[1]
  }
  let refusal = null
  for (const match of `${stdout}\n${stderr}`.matchAll(/REFUSED \((.+)\)/g)) refusal = match[1]
  return { runDir, refusal }
}

export function isLockRefusal(reason) {
  return typeof reason === 'string' && /^run lock held/i.test(reason.trim())
}

/** Pure: run.mjs's exit contract to a slot outcome. */
export function classifyRunExit({ code, signal, stdout, stderr }) {
  const { runDir, refusal } = parseRunOutput(stdout, stderr)
  const base = { exitCode: code, runDir }
  if (code === 0) return { ...base, status: 'passed' }
  if (code === 1) return { ...base, status: 'failed', reason: 'run reported failures or crashed' }
  if (code === 2) {
    const reason = refusal ?? 'refused (no reason printed)'
    return { ...base, status: isLockRefusal(reason) ? 'deferred-lock' : 'refused', reason }
  }
  if (code === 3) return { ...base, status: 'stopped', reason: 'stopped by a kill switch' }
  if (code === null && signal) return { ...base, status: 'crashed', reason: `killed by ${signal}` }
  if (code === null)
    return { ...base, status: 'crashed', reason: lastLine(stderr) || 'did not start' }
  return { ...base, status: 'crashed', reason: `unexpected exit ${code}` }
}

function lastLine(text = '') {
  return text.trim().split('\n').pop()?.trim() ?? ''
}

/** The current holder of the run lock, or null when it is free (a dead holder is free). */
export async function heldRunLock(workDir, { isAlive = processAlive } = {}) {
  const lock = await readRunLock({ dir: workDir })
  if (!lock) return null
  if (lock.corrupt) return { ...lock, describe: `unreadable lock (${lock.reason})` }
  if (!isAlive(lock.pid)) return null
  return { ...lock, describe: `${lock.runId}, pid ${lock.pid}` }
}

/** Slot action `run`: `run.mjs --scenario <name> --trigger schedule`. */
export async function runScenarioSlot({
  slot,
  workDir,
  env = process.env,
  run = runNodeScript,
  isAlive,
  logStream,
  onChild,
  runScript = RUN_SCRIPT
}) {
  const held = await heldRunLock(workDir, { isAlive })
  if (held) {
    return { status: 'deferred-lock', exitCode: null, reason: `run lock held (${held.describe})` }
  }
  const args = ['--scenario', slot.scenario, '--trigger', 'schedule']
  if (slot.build) args.push('--build', slot.build)
  if (slot.privacy) args.push('--privacy', slot.privacy)
  const childEnv = { ...env }
  if (slot.params) childEnv[SCENARIO_PARAMS_ENV] = JSON.stringify(slot.params)
  else delete childEnv[SCENARIO_PARAMS_ENV]
  if (!(await exists(runScript))) {
    return {
      status: 'skipped',
      exitCode: null,
      reason: 'run harness not installed (scripts/live-lab/run.mjs missing)'
    }
  }
  const result = await run({ script: runScript, args, env: childEnv, logStream, onChild })
  return { ...classifyRunExit(result), args }
}

/** Pure: the install record printed by `install.mjs --json` (the trailing JSON object). */
export function parseInstallRecord(stdout = '') {
  const lines = stdout.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index] !== '{') continue
    try {
      return JSON.parse(lines.slice(index).join('\n'))
    } catch {
      return null
    }
  }
  return null
}

/**
 * Slot action `update-check`: install the current public release with
 * `install.mjs --build release --json`. It swaps /Applications/Videorc.app,
 * so it holds the run lock for its whole length and is skipped while the
 * STOP file exists, like any run.
 */
export async function updateCheckSlot({
  date,
  workDir,
  env = process.env,
  run = runNodeScript,
  isAlive = processAlive,
  logStream,
  onChild,
  now = () => new Date(),
  pid = process.pid
}) {
  if (await exists(stopFilePath(workDir))) {
    return { status: 'refused', exitCode: null, reason: 'STOP file present' }
  }
  const runId = `schedule-update-check-${date}`
  const lock = await acquireRunLock({ dir: workDir, runId, now: now(), pid, isAlive })
  if (!lock.ok) {
    if (lock.holder?.corrupt) return { status: 'refused', exitCode: null, reason: lock.reason }
    return { status: 'deferred-lock', exitCode: null, reason: lock.reason }
  }
  try {
    const result = await run({
      script: INSTALL_SCRIPT,
      args: ['--build', 'release', '--json'],
      env,
      logStream,
      onChild
    })
    const record = parseInstallRecord(result.stdout)
    const detail = record
      ? { version: record.version ?? null, previousVersion: record.previous?.version ?? null }
      : null
    if (result.code === 0) return { status: 'passed', exitCode: 0, detail }
    if (result.code === 2) {
      const refused = /REFUSED \(([^)]+)\): (.+)/.exec(`${result.stderr}`)
      return {
        status: 'refused',
        exitCode: 2,
        reason: refused ? `${refused[1]}: ${refused[2]}` : 'install refused'
      }
    }
    const failed = /live:install FAILED: (.+)/.exec(result.stderr)
    return {
      status: result.code === 1 ? 'failed' : 'crashed',
      exitCode: result.code,
      reason:
        failed?.[1] ??
        (result.signal ? `killed by ${result.signal}` : lastLine(result.stderr) || 'install failed')
    }
  } finally {
    await releaseRunLock({ dir: workDir, runId, pid })
  }
}

/** Slot action `report`: `publish.mjs --since <iso>` when U10 is installed. */
export async function reportSlot({
  since,
  env = process.env,
  run = runNodeScript,
  logStream,
  onChild,
  publishScript = PUBLISH_SCRIPT
}) {
  if (!(await exists(publishScript))) {
    return { status: 'skipped', exitCode: null, reason: 'publish not installed' }
  }
  const result = await run({
    script: publishScript,
    args: ['--since', since],
    env,
    logStream,
    onChild
  })
  if (result.code === 0) return { status: 'passed', exitCode: 0, since }
  return {
    status: result.code === null ? 'crashed' : 'failed',
    exitCode: result.code,
    since,
    reason: result.signal
      ? `killed by ${result.signal}`
      : lastLine(result.stderr) || `exit ${result.code}`
  }
}

/** Pure: seconds since the epoch of the last boot, from `sysctl -n kern.boottime`. */
export function parseBootTime(text = '') {
  const match = /sec\s*=\s*(\d+)/.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * U11 step 3: after each boot (the weekly pmset restart, a power cut), the
 * first tick runs `live:doctor` and keeps its output in
 * <work dir>/doctor/boot-<stamp>.txt so the next report can publish any FAIL.
 * The doctor redacts its own output.
 */
export async function bootDoctor({
  workDir,
  now = () => new Date(),
  env = process.env,
  run = runNodeScript,
  logStream,
  onChild
}) {
  const result = await run({ script: DOCTOR_SCRIPT, args: [], env, logStream, onChild })
  const dir = join(workDir, 'doctor')
  await mkdir(dir, { recursive: true })
  const stamp = now().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `boot-${stamp}.txt`)
  await writeFile(file, `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`, 'utf8')
  const summary = /Lab (?:NOT )?ready: .+/.exec(result.stdout)?.[0] ?? null
  return { ok: result.code === 0, exitCode: result.code, file, summary }
}

/** Opens the day's schedule log for appending (creates the logs dir). */
export async function openScheduleLog(workDir, date) {
  await mkdir(logsDir(workDir), { recursive: true })
  return createWriteStream(scheduleLogPath(workDir, date), { flags: 'a' })
}
