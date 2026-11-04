import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { processExists, readOwnedProcessLedgers } from './process-census.mjs'

// Removes a smoke's isolated profile or state directory after its app or
// backend stopped (issue #1080). On Windows the just-exited Electron, backend
// and SQLite processes keep handles open for a moment (EBUSY on
// videorc.sqlite3-wal, EPERM, ENOTEMPTY), so a plain rmSync right after Stop
// threw and turned a printed PASS into exit 1.
//
// First it waits, bounded, for every process still recorded in the profile's
// owned-process ledger (`<dir>/owned-processes/*.json`, written by Electron
// main) and every pid the caller names to be gone. Then it retries the removal
// with a short backoff. When the directory still cannot be removed it logs a
// warning and returns: teardown never decides the verdict, and a real FAIL
// keeps its own exit code because this never touches process.exitCode.

export const PROFILE_REMOVAL_RETRY_CODES = Object.freeze(['EBUSY', 'EPERM', 'ENOTEMPTY'])
export const PROFILE_REMOVAL_TIMEOUT_MS = 5000
export const PROFILE_REMOVAL_REAP_TIMEOUT_MS = 5000

const FIRST_RETRY_DELAY_MS = 50
const MAX_RETRY_DELAY_MS = 1000
const REAP_POLL_MS = 100

export async function removeProfileDir(
  path,
  {
    label = 'smoke',
    pids = [],
    timeoutMs = PROFILE_REMOVAL_TIMEOUT_MS,
    reapTimeoutMs = PROFILE_REMOVAL_REAP_TIMEOUT_MS,
    rm = (target) => rmSync(target, { recursive: true, force: true }),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
    isAlive = processExists,
    ownedPids = profileOwnedPids,
    warn = console.warn
  } = {}
) {
  if (!path) return { removed: true, attempts: 0, livePids: [] }

  const livePids = await waitForOwnedProcesses({
    pids: [...new Set([...pids, ...ownedPids(path)])],
    timeoutMs: reapTimeoutMs,
    sleep,
    now,
    isAlive
  })
  if (livePids.length > 0) {
    warn(
      `${label}: owned process(es) ${livePids.join(', ')} still alive after ${reapTimeoutMs} ms; removing ${path} anyway.`
    )
  }

  const deadline = now() + timeoutMs
  let delayMs = FIRST_RETRY_DELAY_MS
  for (let attempts = 1; ; attempts += 1) {
    let error
    try {
      await rm(path)
      return { removed: true, attempts, livePids }
    } catch (caught) {
      error = caught
    }
    const retryable = PROFILE_REMOVAL_RETRY_CODES.includes(error?.code)
    if (!retryable || now() + delayMs > deadline) {
      warn(
        `${label}: warning: could not remove isolated profile ${path} after ${attempts} attempt(s) (${error?.code ?? error?.message ?? String(error)}); leaving it behind.`
      )
      return { removed: false, attempts, livePids, error }
    }
    await sleep(delayMs)
    delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS)
  }
}

/** Pids Electron main still records as owned in this profile's ledgers. */
export function profileOwnedPids(path, { readDir = readdirSync, readFile } = {}) {
  const ledgerDir = join(path, 'owned-processes')
  let names
  try {
    names = readDir(ledgerDir)
  } catch {
    return []
  }
  const ledgerPaths = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(ledgerDir, name))
  return readOwnedProcessLedgers(ledgerPaths, readFile ? { readFile } : undefined).map(
    (record) => record.pid
  )
}

async function waitForOwnedProcesses({ pids, timeoutMs, sleep, now, isAlive }) {
  const deadline = now() + timeoutMs
  let live = pids.filter((pid) => isAlive(pid))
  while (live.length > 0 && now() < deadline) {
    await sleep(REAP_POLL_MS)
    live = live.filter((pid) => isAlive(pid))
  }
  return live
}
