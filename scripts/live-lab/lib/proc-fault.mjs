import { setTimeout as delay } from 'node:timers/promises'

import {
  classifyProcess,
  processTreeRows,
  readOwnedProcessLedgers,
  readSystemProcessTable
} from '../../lib/process-census.mjs'

// Plan 178 U13 (plan 166 S9 step 2). Freeze one of the app's own FFmpeg
// processes with SIGSTOP for a moment, then SIGCONT it, no matter what.
//
// "Own" is decided by the owned-process ledger the desktop app writes
// (scripts/lib/process-census.mjs reads it): the PID must be a ledger record,
// or a live descendant of one, and the process table must classify it as
// ffmpeg. Anything else is refused before any signal is sent. The harness
// never guesses from a process name alone and never uses pgrep.
//
// 0.5 s is below the backend's 2 s stall notice (plan 087): the stream must
// ride it out silently. 6 s is above it: the app must say
// stream-output-stalled and then stream-output-resumed. Nothing is ever
// stopped longer than MAX_PAUSE_MS, by validation and by a backup timer.

export const MAX_PAUSE_MS = 10_000

function refuse(reason) {
  const error = new Error(`proc-fault refused: ${reason}`)
  error.code = 'PROC_FAULT_REFUSED'
  return error
}

// Pure: is `pid` one of the app's own ffmpeg processes? `records` are the
// ledger rows (readOwnedProcessLedgers), `processTable` the live table
// (readSystemProcessTable). Returns { ok, reason, row, ownerPid }.
export function inspectOwnedFfmpeg(pid, { records, processTable }) {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: `pid ${pid} is not valid` }
  const rowsByPid = new Map((processTable ?? []).map((row) => [row.pid, row]))
  const row = rowsByPid.get(pid)
  if (!row) return { ok: false, reason: `pid ${pid} is not running` }
  let ownerPid = null
  for (const record of records ?? []) {
    if (record.pid === pid) {
      ownerPid = record.pid
      break
    }
    if (processTreeRows(processTable, record.pid).some((entry) => entry.pid === pid)) {
      ownerPid = record.pid
      break
    }
  }
  if (ownerPid === null) {
    return {
      ok: false,
      reason: `pid ${pid} is not in the owned-process ledger or under a record`,
      row
    }
  }
  const role = classifyProcess(row)
  if (role !== 'ffmpeg') {
    return {
      ok: false,
      reason: `pid ${pid} is ${role}, not ffmpeg (owner ${ownerPid})`,
      row,
      ownerPid
    }
  }
  return { ok: true, reason: null, row, ownerPid }
}

// The ledger as the census API reads it. `ledger` is { ledgerPaths, readFile?,
// readProcessTable? }; both readers are injectable for tests.
export async function readOwnedProcesses(ledger) {
  if (!ledger || !Array.isArray(ledger.ledgerPaths) || ledger.ledgerPaths.length === 0) {
    throw refuse('no owned-process ledger paths were given')
  }
  const records = readOwnedProcessLedgers(ledger.ledgerPaths, {
    readFile: ledger.readFile ?? undefined
  })
  const processTable = await (ledger.readProcessTable ?? readSystemProcessTable)()
  return { records, processTable }
}

// Every owned ffmpeg PID right now (for a scenario to pick one).
export async function ownedFfmpegPids(ledger) {
  const { records, processTable } = await readOwnedProcesses(ledger)
  const pids = new Set()
  for (const record of records) {
    for (const row of processTreeRows(processTable, record.pid)) {
      if (classifyProcess(row) === 'ffmpeg') pids.add(row.pid)
    }
    const own = processTable.find((row) => row.pid === record.pid)
    if (own && classifyProcess(own) === 'ffmpeg') pids.add(own.pid)
  }
  return [...pids].sort((a, b) => a - b)
}

// SIGSTOP `pid` for `ms`, SIGCONT in finally. Refuses (throws, code
// PROC_FAULT_REFUSED) before any signal when the pid is not an owned ffmpeg
// or `ms` is out of range. Returns what happened, including whether the
// SIGCONT landed (false when the process was gone by then).
export async function pauseOwnedProcess({
  pid,
  ms,
  ledger,
  kill = process.kill.bind(process),
  wait = delay,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {}
}) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_PAUSE_MS) {
    throw refuse(`ms must be 1..${MAX_PAUSE_MS} (got ${ms})`)
  }
  const owned = await readOwnedProcesses(ledger)
  const verdict = inspectOwnedFfmpeg(pid, owned)
  if (!verdict.ok) throw refuse(verdict.reason)

  const stoppedAt = now()
  kill(pid, 'SIGSTOP')
  log(`proc-fault: SIGSTOP ${pid} (ffmpeg under ${verdict.ownerPid}) for ${ms} ms`)
  let continued = null
  let continuedAt = null
  const resume = (why) => {
    if (continued !== null) return
    try {
      kill(pid, 'SIGCONT')
      continued = true
    } catch (error) {
      continued = false
      log(`proc-fault: SIGCONT ${pid} ${error.code ?? error.message} (${why})`)
    }
    continuedAt = now()
  }
  // Backup: whatever `wait` does, the process runs again at the cap.
  const backup = setTimer(() => resume('backup timer'), MAX_PAUSE_MS)
  try {
    await wait(ms)
  } finally {
    clearTimer(backup)
    resume('finally')
  }
  return {
    pid,
    ownerPid: verdict.ownerPid,
    ms,
    stoppedAt,
    continuedAt,
    pausedMs: continuedAt - stoppedAt,
    continued
  }
}
