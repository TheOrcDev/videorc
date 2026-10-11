import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import {
  collectProcessCensus,
  pruneDeadOwnedProcessRecords,
  waitForCleanProcessState,
  waitForNoLiveProcessState
} from '../../lib/process-census.mjs'
import { systemClock } from './step-engine.mjs'

// Plan 178 U6 (plan 176 L2 step 5, plan 166 S5 step 5). Teardown always runs,
// in finally, and each part is attempted even when an earlier one failed:
//
// 1. End the stream first (remote `streamStop`, wait for idle). This is what
//    a kill switch needs within 60 s; everything after is cleanup.
// 2. Stop the observers, quit the app (the launcher signals only the exact
//    app PID it published, app-launcher.mjs).
// 3. Assert the owned-process ledgers are clean (waitForCleanProcessState).
//    A live PID still in a Videorc ledger is signalled (it is an app-owned
//    PID recorded by Videorc, AGENTS.md); nothing else ever is.
// 4. Stop the run's own helpers (card browser, RTMP sink, caffeinate).
// 5. Collect crash and log evidence into the run folder.

export const STREAM_STOP_DEADLINE_MS = 30_000
export const CLEAN_LEDGER_DEADLINE_MS = 15_000
export const DIAGNOSTIC_REPORTS_DIR = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')
const CRASH_REPORT_NAME = /^(?:Videorc|videorc-backend|ffmpeg|native_preview_host_helper)/i

async function timed(name, fn, clock, steps) {
  const startedAt = clock.now()
  try {
    const detail = await fn()
    steps.push({ name, ok: true, detail: detail ?? null, ms: clock.now() - startedAt })
    return true
  } catch (error) {
    steps.push({ name, ok: false, detail: error?.message ?? String(error), ms: clock.now() - startedAt })
    return false
  }
}

/**
 * Ends the stream if one runs: `remote.state()` is the latest remote.state,
 * `remote.intent(kind)` sends one intent, `waitFor` is the event wait.
 */
export async function endStream({ remote, waitFor, deadlineMs = STREAM_STOP_DEADLINE_MS }) {
  if (!remote) return 'no remote connection (the app quit stops the session)'
  const state = remote.state()
  if (!state?.sessionActive) return 'not live'
  const sent = await remote.intent('streamStop', {}, { deadlineMs })
  if (!sent?.accepted) throw new Error(`streamStop was not accepted: ${sent?.message ?? 'no reason'}`)
  await waitFor(() => {
    const now = remote.state()
    return now && !now.sessionActive && now.sessionState === 'idle'
  }, { deadlineMs, label: 'session idle after streamStop' })
  return 'stopped'
}

/** Reaps live PIDs that a Videorc ledger records, then asserts a clean state. */
export async function assertCleanLedgers({
  ledgerPaths,
  rootPid,
  waitClean = waitForCleanProcessState,
  waitNoLive = waitForNoLiveProcessState,
  census = collectProcessCensus,
  prune = pruneDeadOwnedProcessRecords,
  signal = (pid, name) => process.kill(pid, name),
  deadlineMs = CLEAN_LEDGER_DEADLINE_MS
}) {
  try {
    await waitClean({ ledgerPaths, rootPid, timeoutMs: deadlineMs })
    return { clean: true, reaped: [], pruned: 0 }
  } catch (firstError) {
    const snapshot = await census({ ledgerPaths, rootPid })
    const reaped = []
    for (const record of snapshot.aliveRecords) {
      try {
        signal(record.pid, 'SIGTERM')
        reaped.push({ pid: record.pid, label: record.label ?? null })
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    }
    await waitNoLive({ ledgerPaths, rootPid, timeoutMs: deadlineMs })
    const pruned = await prune({ ledgerPaths })
    const removed = pruned.reduce((total, entry) => total + entry.removed.length, 0)
    const error = new Error(
      `The ledger was not clean after quit (${reaped.length} live owned PID(s) reaped, ${removed} dead record(s) pruned): ${firstError.message.split('\n')[0]}`
    )
    error.reaped = reaped
    throw error
  }
}

async function listNewFiles(dir, sinceMs, filter = () => true) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const found = []
  for (const name of names) {
    if (!filter(name)) continue
    try {
      const info = await stat(join(dir, name))
      if (info.isFile() && info.mtimeMs >= sinceMs) found.push(join(dir, name))
    } catch {
      // Gone between readdir and stat.
    }
  }
  return found.sort()
}

/** Local bearer tokens in launch output ("token":"...") are cut before copying. */
export function redactLaunchOutput(text) {
  return String(text).replace(/("(?:token|capability)"\s*:\s*")[^"]*"/g, '$1[redacted]"')
}

/**
 * Copies new crash and log evidence into <runDir>/crash and <runDir>/logs.
 * Only files changed since the run started; names only in the result.
 */
export async function collectArtifacts({
  runDir,
  userDataDir,
  launchStateDir,
  startedAtMs,
  diagnosticReportsDir = DIAGNOSTIC_REPORTS_DIR
}) {
  const collected = { crashReports: [], crashpad: [], backendCrashes: false, logs: [] }
  const crashDir = join(runDir, 'crash')
  const logsDir = join(runDir, 'logs')
  await mkdir(crashDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })

  for (const path of await listNewFiles(diagnosticReportsDir, startedAtMs, (name) => CRASH_REPORT_NAME.test(name))) {
    await copyFile(path, join(crashDir, basename(path)))
    collected.crashReports.push(basename(path))
  }
  for (const sub of ['completed', 'pending', 'new']) {
    for (const path of await listNewFiles(join(userDataDir, 'Crashpad', sub), startedAtMs, (name) => name.endsWith('.dmp'))) {
      await copyFile(path, join(crashDir, `crashpad-${basename(path)}`))
      collected.crashpad.push(basename(path))
    }
  }
  try {
    await copyFile(join(userDataDir, 'backend-crashes.json'), join(crashDir, 'backend-crashes.json'))
    collected.backendCrashes = true
  } catch {
    // None recorded.
  }
  for (const path of await listNewFiles(join(userDataDir, 'logs'), startedAtMs, (name) => name.startsWith('backend.log'))) {
    await copyFile(path, join(logsDir, basename(path)))
    collected.logs.push(basename(path))
  }
  for (const path of await listNewFiles(join(userDataDir, 'logs', 'ffmpeg'), startedAtMs, (name) => name.endsWith('.log'))) {
    await copyFile(path, join(logsDir, `ffmpeg-${basename(path)}`))
    collected.logs.push(`ffmpeg-${basename(path)}`)
  }
  if (launchStateDir) {
    for (const path of await listNewFiles(launchStateDir, startedAtMs, (name) => /\.(?:stdout|stderr)\.log$/.test(name))) {
      const kind = path.endsWith('.stdout.log') ? 'stdout' : 'stderr'
      await writeFile(join(logsDir, `app-${kind}.log`), redactLaunchOutput(await readFile(path, 'utf8')))
      collected.logs.push(`app-${kind}.log`)
    }
  }
  return collected
}

/**
 * The whole teardown. Every dependency is injectable. Returns
 * { steps, clean, streamEndedMs } where clean means every step succeeded.
 */
export async function teardown({
  remote,
  waitFor,
  observer,
  quitApp,
  ledgerPaths,
  rootPid,
  helpers = [],
  collect,
  closeCard,
  clock = systemClock,
  assertClean = assertCleanLedgers,
  log = () => {}
}) {
  const startedAt = clock.now()
  const steps = []
  let streamEndedMs = null
  await timed('end-stream', async () => {
    const result = await endStream({ remote, waitFor })
    streamEndedMs = clock.now() - startedAt
    return result
  }, clock, steps)
  await timed('stop-observer', async () => observer?.stop(), clock, steps)
  await timed('quit-app', async () => {
    if (!quitApp) return 'not launched'
    const result = await quitApp()
    return result?.state ?? 'quit'
  }, clock, steps)
  await timed('clean-ledger', async () => {
    const paths = typeof ledgerPaths === 'function' ? await ledgerPaths() : ledgerPaths
    if (!paths?.length) return 'no ledgers'
    const result = await assertClean({ ledgerPaths: paths, rootPid })
    return result.clean ? 'clean' : result
  }, clock, steps)
  for (const helper of helpers) {
    if (!helper) continue
    await timed(`stop-${helper.label}`, async () => (await helper.stop())?.state, clock, steps)
  }
  await timed('collect-artifacts', async () => (collect ? collect() : null), clock, steps)
  await timed('close-card', async () => closeCard?.(), clock, steps)
  const clean = steps.every((step) => step.ok)
  for (const step of steps) if (!step.ok) log(`Teardown: ${step.name} failed: ${step.detail}`)
  return { steps, clean, streamEndedMs, durationMs: clock.now() - startedAt }
}
