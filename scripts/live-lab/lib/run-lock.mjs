import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

// Plan 178 U4. One run at a time. The lock is a small JSON file in the work
// dir (~/videorc-live-lab/run.lock) with the PID, run id and start time of the
// holder. A lock whose PID is dead is stale: it is cleared and the clearing is
// reported, so a crash never blocks the next scheduled run. A lock that cannot
// be read is not cleared (there is no PID to prove dead); it is reported and
// the run is refused.

export const RUN_LOCK_FILE = 'run.lock'

export function runLockPath(dir) {
  return join(dir, RUN_LOCK_FILE)
}

// True when a signal could be delivered: the process exists. EPERM means it
// exists but belongs to someone else, which still counts as alive.
export function processAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function parseLock(text, path) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { corrupt: true, path, reason: 'not valid JSON' }
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Number.isInteger(parsed.pid) ||
    typeof parsed.runId !== 'string' ||
    typeof parsed.startedAt !== 'string'
  ) {
    return { corrupt: true, path, reason: 'missing pid, runId or startedAt' }
  }
  return { corrupt: false, path, pid: parsed.pid, runId: parsed.runId, startedAt: parsed.startedAt }
}

// null when no lock exists; otherwise the parsed lock, with `corrupt: true`
// and a reason when it cannot be trusted.
export async function readRunLock({ dir, read = (file) => readFile(file, 'utf8') }) {
  const path = runLockPath(dir)
  let text
  try {
    text = await read(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  return parseLock(text, path)
}

async function tryCreate(path, lock) {
  let handle
  try {
    handle = await open(path, 'wx', 0o644)
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

// { ok: true, lock, clearedStale } or { ok: false, reason, holder }.
// `clearedStale` is the dead lock that was removed (null when none), so the
// run manifest can record it.
export async function acquireRunLock({
  dir,
  runId,
  now = new Date(),
  pid = process.pid,
  isAlive = processAlive,
  read
}) {
  if (typeof runId !== 'string' || runId.trim() === '') {
    return { ok: false, reason: 'runId missing', holder: null }
  }
  await mkdir(dir, { recursive: true })
  const path = runLockPath(dir)
  const lock = { pid, runId, startedAt: now.toISOString() }
  let clearedStale = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await tryCreate(path, lock)) {
      return { ok: true, lock: { ...lock, path }, clearedStale }
    }
    const holder = await readRunLock({ dir, read })
    if (holder === null) continue
    if (holder.corrupt) {
      return {
        ok: false,
        reason: `run lock ${path} unreadable (${holder.reason}); remove it by hand after checking nothing is live`,
        holder
      }
    }
    if (isAlive(holder.pid)) {
      return {
        ok: false,
        reason: `run lock held by ${holder.runId} (pid ${holder.pid}, since ${holder.startedAt})`,
        holder
      }
    }
    clearedStale = holder
    await rm(path, { force: true })
  }
  return { ok: false, reason: `run lock ${path} could not be taken (raced twice)`, holder: null }
}

// Releases only our own lock: the file must name this runId (and pid when
// given). Releasing someone else's lock is refused, so a late teardown of a
// crashed run never frees a lock a newer run holds.
export async function releaseRunLock({ dir, runId, pid, read }) {
  const holder = await readRunLock({ dir, read })
  if (holder === null) return { released: false, reason: 'no lock' }
  if (holder.corrupt) return { released: false, reason: `lock unreadable (${holder.reason})` }
  if (holder.runId !== runId || (pid !== undefined && holder.pid !== pid)) {
    return {
      released: false,
      reason: `lock belongs to ${holder.runId} (pid ${holder.pid}), not ${runId}`
    }
  }
  await rm(holder.path, { force: true })
  return { released: true, reason: null }
}
