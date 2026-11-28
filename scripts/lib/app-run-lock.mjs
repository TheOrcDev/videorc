// The app-run lock: ONE app-driven run at a time on this Mac.
//
// `~/videorc-app-run.lock` is a DIRECTORY (mkdir is the atomic take) holding
// an `owner` file with one line: `<lane> pid <PID> <ISO time>`. The sentinel's
// scripts, `launch-check-release.mjs` and the gallery write and read the same
// shape (`... pid <N> ...`), so the helper only relies on `pid <N>`.
//
//   const lock = await acquireAppRunLock({ lane: 'cloud-talk-show' })
//   ...                      // released on exit and on SIGINT/SIGTERM/SIGHUP
//   lock.release()
//
// - A lock whose owner PID is dead is stale and is cleared.
// - A lock held by THIS process, or by an ancestor of it (a lane shell that
//   took the lock and runs the smoke), counts as held: nothing waits on
//   itself.
// - Otherwise it waits (default 30 min) and then throws, naming the holder.
// - `requireAppRunLock()` is what launchers call: it refuses to start an app
//   without the lock (and takes it when nobody holds it).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_WAIT_MS = 30 * 60 * 1000
export const DEFAULT_POLL_MS = 2_000
// A lock directory with no owner file yet: the taker is between mkdir and
// writeFile. After this long it is a crashed taker's.
export const OWNERLESS_GRACE_MS = 10_000

export function appRunLockPath(env = process.env) {
  return env.VIDEORC_APP_RUN_LOCK_PATH || join(homedir(), 'videorc-app-run.lock')
}

export function formatOwner({ lane, pid, time = new Date() }) {
  const stamp = time instanceof Date ? time.toISOString().replace(/\.\d+Z$/, 'Z') : String(time)
  return `${lane} pid ${pid} ${stamp}\n`
}

/** `{ lane, pid, time }` from an owner line, or null when it names no PID. */
export function parseOwner(text) {
  const line = String(text ?? '')
    .split('\n')
    .find((candidate) => /\bpid (\d+)\b/.test(candidate))
  if (!line) return null
  const match = line.match(/^(.*?)\s*\bpid (\d+)\b\s*(.*)$/)
  if (!match) return null
  return {
    lane: match[1].trim() || 'unknown',
    pid: Number(match[2]),
    time: match[3].trim() || null
  }
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** This process's parent chain, nearest first (the lane shell that holds the lock). */
export function ancestorPids(start = process.pid, parentOf = defaultParentOf) {
  const chain = []
  let pid = start
  for (let depth = 0; depth < 32; depth += 1) {
    const parent = parentOf(pid)
    if (!Number.isInteger(parent) || parent <= 1 || chain.includes(parent)) break
    chain.push(parent)
    pid = parent
  }
  return chain
}

function defaultParentOf(pid) {
  try {
    return Number(
      execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim()
    )
  } catch {
    return NaN
  }
}

function readOwner(lockPath) {
  try {
    return parseOwner(readFileSync(join(lockPath, 'owner'), 'utf8'))
  } catch {
    return null
  }
}

function lockAgeMs(lockPath, now) {
  try {
    return now() - statSync(lockPath).mtimeMs
  } catch {
    return 0
  }
}

// What this process holds, for `requireAppRunLock` and the exit hooks.
let held = null
let hooked = false

function installReleaseHooks() {
  if (hooked) return
  hooked = true
  process.on('exit', () => held?.release())
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129]
  ]) {
    process.on(signal, () => {
      held?.release()
      process.exit(code)
    })
  }
}

/**
 * Takes the lock, waiting for a live holder. Resolves with `{ lockPath,
 * release, held }` (`held: 'self' | 'ancestor' | 'taken'`).
 * Injection points (`alive`, `ancestors`, `now`, `sleep`) are for tests.
 */
export async function acquireAppRunLock({
  lane = process.env.VIDEORC_LANE || 'unnamed-lane',
  env = process.env,
  lockPath = appRunLockPath(env),
  timeoutMs = Number(env.VIDEORC_APP_RUN_LOCK_TIMEOUT_MS ?? DEFAULT_WAIT_MS),
  pollMs = DEFAULT_POLL_MS,
  alive = pidAlive,
  ancestors = () => ancestorPids(),
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  onWait = () => {},
  pid = process.pid
} = {}) {
  if (held && held.lockPath === lockPath) return { ...held, held: 'self' }
  const deadline = now() + timeoutMs
  let lastWaitNote = Number.NEGATIVE_INFINITY
  for (;;) {
    try {
      mkdirSync(lockPath)
      const owner = formatOwner({ lane, pid, time: new Date(now()) })
      writeFileSync(join(lockPath, 'owner'), owner)
      const mine = owner
      const handle = {
        lockPath,
        held: 'taken',
        release() {
          // Only what this process wrote: never a lock somebody else took
          // after a stale clear.
          try {
            if (readFileSync(join(lockPath, 'owner'), 'utf8') === mine) {
              rmSync(lockPath, { recursive: true, force: true })
            }
          } catch {
            /* already gone */
          }
          if (held === handle) held = null
        }
      }
      held = handle
      installReleaseHooks()
      return handle
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const owner = readOwner(lockPath)
    if (owner) {
      if (owner.pid === pid) return { lockPath, held: 'self', release() {} }
      if (alive(owner.pid) && ancestors().includes(owner.pid)) {
        return { lockPath, held: 'ancestor', release() {} }
      }
      if (!alive(owner.pid)) {
        // Stale: its owner died without releasing.
        rmSync(lockPath, { recursive: true, force: true })
        continue
      }
    } else if (lockAgeMs(lockPath, now) > OWNERLESS_GRACE_MS) {
      rmSync(lockPath, { recursive: true, force: true })
      continue
    }
    if (now() >= deadline) {
      const who = owner
        ? `${owner.lane} (pid ${owner.pid}${owner.time ? `, since ${owner.time}` : ''})`
        : 'another run'
      throw new Error(
        `${lockPath} is held by ${who}; waited ${Math.round(timeoutMs / 1000)} s. Try again when it is gone.`
      )
    }
    if (now() - lastWaitNote >= 60_000) {
      lastWaitNote = now()
      onWait(owner)
    }
    await sleep(pollMs)
  }
}

/**
 * What an app launcher calls before it starts an app: the run must hold the
 * lock (taken here when nobody has it). `VIDEORC_APP_RUN_LOCK=off` is the
 * test suites' switch, never a smoke's.
 */
export async function requireAppRunLock(options = {}) {
  const env = options.env ?? process.env
  if (env.VIDEORC_APP_RUN_LOCK === 'off') return { lockPath: null, held: 'off', release() {} }
  return acquireAppRunLock(options)
}
