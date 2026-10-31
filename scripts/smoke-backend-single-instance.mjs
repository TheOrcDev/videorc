import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { launchDevApp } from './lib/app-launcher.mjs'

const stateRoot = mkdtempSync(join(tmpdir(), 'videorc-backend-single-instance-'))
const appDataDir = join(stateRoot, 'app-data')
const timeoutMs = Number(process.env.VIDEORC_SMOKE_TIMEOUT_MS ?? 120000)
const ledgerPath = join(appDataDir, 'Videorc', 'owned-processes', 'global.json')

let first
let second
let frozenMainPid = null

try {
  first = await launchIsolatedApp('a')
  const firstPid = onlyBackendPid()
  assert.equal(processExists(firstPid), true, 'first backend should be alive after first launch')

  // Production never runs two apps on one app-data dir (the single-instance
  // lock); here each has its own user data, so the first app's crash recovery
  // restarted the backend the second launch reaped and raced it for the ledger.
  // Freeze the first app's main for the takeover: its backend stays up to be
  // reaped, and nothing restarts it.
  frozenMainPid = first.connections['backend-ready']?.parentPid ?? null
  assert.ok(processExists(frozenMainPid), 'first app main pid should be known and alive')
  process.kill(frozenMainPid, 'SIGSTOP')

  let sawReapLog = false
  second = await launchIsolatedApp('b', (line) => {
    // The app logs "Confirmed N stale owned process record(s) dead after
    // reaping M live pid(s): <label>:<pid>" (main/index.ts). The older
    // "Reaping <pid>" form is accepted too so a future wording change in
    // either direction does not silently break this smoke again (it asserted
    // a line no code wrote until Plan 053).
    if (
      (line.includes('after reaping') && line.includes(`:${firstPid}`)) ||
      (line.includes('Reaping') && line.includes(String(firstPid)))
    ) {
      sawReapLog = true
    }
  })
  const secondPid = onlyBackendPid()

  await waitUntil(() => !processExists(firstPid), 5000, 'first backend to be reaped')
  assert.notEqual(secondPid, firstPid, 'second launch should own a new backend pid')
  assert.equal(processExists(secondPid), true, 'second backend should stay alive')
  assert.equal(
    sawReapLog,
    true,
    `second launch should log "after reaping ... :${firstPid}" for the first backend`
  )
  assert.deepEqual(
    readLedger().map((record) => record.pid),
    [secondPid],
    'global ledger should contain only the newest backend pid'
  )

  console.log('Backend single-instance smoke OK - second app launch reaped the first backend.')
} finally {
  if (second) {
    await second.stop()
  }
  if (frozenMainPid && processExists(frozenMainPid)) process.kill(frozenMainPid, 'SIGCONT')
  if (first) {
    await first.stop()
  }
  await rm(stateRoot, { recursive: true, force: true })
}

function launchIsolatedApp(name, onLine) {
  return launchDevApp({
    env: {
      VIDEORC_APP_DATA_DIR: appDataDir,
      VIDEORC_USER_DATA_DIR: join(stateRoot, `user-data-${name}`),
      VIDEORC_DISABLE_AUTO_PREVIEW: '1',
      VIDEORC_DISABLE_BACKEND_REAP: '0'
    },
    timeoutMs,
    requiredMarkers: ['backend-ready'],
    onLine
  })
}

function onlyBackendPid() {
  const records = readLedger()
  assert.equal(
    records.length,
    1,
    `expected exactly one backend record, got ${records.length}: ${JSON.stringify(
      records.map(({ pid, label }) => ({
        pid,
        label,
        alive: processExists(pid),
        parent: parentOf(pid)
      }))
    )}`
  )
  return records[0].pid
}

function readLedger() {
  assert.equal(existsSync(ledgerPath), true, `expected global backend ledger at ${ledgerPath}`)
  return JSON.parse(readFileSync(ledgerPath, 'utf8'))
}

function parentOf(pid) {
  try {
    return Number(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    )
  } catch {
    return null
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'linux') {
    // kill(pid, 0) still succeeds for a zombie until its parent waits on it.
    // A reaped backend that is only waiting to be collected is not alive.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[0]
      if (state === 'Z' || state === 'X') {
        return false
      }
    } catch {
      return false
    }
  }
  if (process.platform === 'darwin') {
    // The same on macOS: a backend reaped while the frozen first app cannot
    // wait on it stays a zombie until that app runs again.
    try {
      const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      if (state.trim().startsWith('Z')) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}

async function waitUntil(predicate, timeoutMs, label) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out waiting for ${label}.`)
}
