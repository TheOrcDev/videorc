import assert from 'node:assert/strict'
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

try {
  first = await launchIsolatedApp('a')
  const firstPid = onlyBackendPid()
  assert.equal(processExists(firstPid), true, 'first backend should be alive after first launch')

  let sawReapLog = false
  second = await launchIsolatedApp('b', (line) => {
    if (line.includes('Reaping') && line.includes(String(firstPid))) {
      sawReapLog = true
    }
  })
  const secondPid = onlyBackendPid()

  await waitUntil(() => !processExists(firstPid), 5000, 'first backend to be reaped')
  assert.notEqual(secondPid, firstPid, 'second launch should own a new backend pid')
  assert.equal(processExists(secondPid), true, 'second backend should stay alive')
  assert.equal(sawReapLog, true, 'second launch should log reaping the first backend')
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
  assert.equal(records.length, 1, `expected exactly one backend record, got ${records.length}`)
  return records[0].pid
}

function readLedger() {
  assert.equal(existsSync(ledgerPath), true, `expected global backend ledger at ${ledgerPath}`)
  return JSON.parse(readFileSync(ledgerPath, 'utf8'))
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
