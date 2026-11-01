import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { writeLabJson } from './config.mjs'
import { processAlive } from './run-lock.mjs'

// Plan 178 U11. The schedule's memory: which slot ran on which local day and
// how it ended, plus a short history for `live:schedule status`. It holds no
// secret (slot ids, exit codes, run folder paths under the work dir) and is
// written atomically with writeLabJson. A corrupt file fails closed: the tick
// refuses to schedule rather than forget what already ran today.

export const STATE_FILE = 'schedule-state.json'
export const STATE_VERSION = 1
export const KEEP_STATE_DAYS = 14
export const KEEP_HISTORY = 60
export const TICK_LOCK_FILE = 'schedule-tick.lock'

export function emptyState() {
  return {
    version: STATE_VERSION,
    since: null,
    days: {},
    history: [],
    lastBootDoctor: null,
    lastTick: null
  }
}

export function statePath(dir) {
  return join(dir, STATE_FILE)
}

export async function readState(dir, { read = (file) => readFile(file, 'utf8') } = {}) {
  let text
  try {
    text = await read(statePath(dir))
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState()
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      `${statePath(dir)} is not valid JSON; inspect it before the schedule runs again`
    )
  }
  if (parsed?.version !== STATE_VERSION || typeof parsed.days !== 'object' || !parsed.days) {
    throw new Error(`${statePath(dir)} has an unexpected shape (version ${parsed?.version})`)
  }
  return {
    ...emptyState(),
    ...parsed,
    history: Array.isArray(parsed.history) ? parsed.history : []
  }
}

function pruneDays(days) {
  const kept = {}
  for (const date of Object.keys(days).sort().slice(-KEEP_STATE_DAYS)) kept[date] = days[date]
  return kept
}

export async function writeState(dir, state) {
  const next = {
    ...state,
    days: pruneDays(state.days ?? {}),
    history: (state.history ?? []).slice(-KEEP_HISTORY)
  }
  await writeLabJson(dir, STATE_FILE, next)
  return next
}

/** Pure: a copy of `state` with the slot's outcome for `date` set. */
export function withSlot(state, date, slotId, entry) {
  return {
    ...state,
    days: { ...state.days, [date]: { ...(state.days[date] ?? {}), [slotId]: entry } }
  }
}

/** Pure: final outcomes also go to the history list. */
export function withHistory(state, row) {
  return { ...state, history: [...(state.history ?? []), row] }
}

/**
 * Pure: a slot left as `running` by a tick that no longer exists (crash,
 * reboot, SIGKILL) becomes `interrupted`. Only called while holding the tick
 * lock, so no live tick can own such an entry.
 */
export function closeAbandoned(state, now) {
  let next = state
  const closed = []
  for (const [date, slots] of Object.entries(state.days ?? {})) {
    for (const [slotId, entry] of Object.entries(slots)) {
      if (entry?.status !== 'running') continue
      const interrupted = {
        ...entry,
        status: 'interrupted',
        endedAt: now.toISOString(),
        reason: 'the tick running it ended without recording an outcome (crash or reboot)'
      }
      next = withHistory(withSlot(next, date, slotId, interrupted), {
        date,
        slotId,
        ...interrupted
      })
      closed.push({ date, slotId })
    }
  }
  return { state: next, closed }
}

// One tick at a time. launchd never starts a second instance of a label while
// one runs, but an operator can type `live:schedule tick` by hand; this lock
// keeps the two apart. A lock whose PID is dead is cleared.
export async function acquireTickLock({
  dir,
  pid = process.pid,
  now = new Date(),
  isAlive = processAlive
}) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, TICK_LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o644)
      try {
        await handle.writeFile(`${JSON.stringify({ pid, startedAt: now.toISOString() })}\n`)
      } finally {
        await handle.close()
      }
      return {
        ok: true,
        release: async () => {
          const holder = await readTickLock(path)
          if (holder?.pid === pid) await rm(path, { force: true })
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const holder = await readTickLock(path)
    if (holder && isAlive(holder.pid)) {
      return {
        ok: false,
        reason: `another tick is running (pid ${holder.pid}, since ${holder.startedAt})`
      }
    }
    await rm(path, { force: true })
  }
  return { ok: false, reason: 'tick lock could not be taken (raced twice)' }
}

async function readTickLock(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return Number.isInteger(parsed?.pid) ? parsed : null
  } catch {
    return null
  }
}
