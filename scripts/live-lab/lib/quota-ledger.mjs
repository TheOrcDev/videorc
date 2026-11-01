import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  fsyncSync
} from 'node:fs'
import { join } from 'node:path'

import { DIR_MODE, FILE_MODE } from './config.mjs'

// Plan 178 U8 (plan 176 L4 step 4). A local counter of the lab Google
// project's YouTube Data API units. Every lab call (observer, viewer bot,
// doctor) is charged here BEFORE it is sent, by Google's documented cost, and
// a call that would push the Pacific day past the cap is refused, not sent.
// YouTube quota resets at midnight Pacific time, so days are Pacific days.
// The file sits in the lab dir (0700) as 0600; it holds counts only.

export const LEDGER_FILE = 'quota-ledger.json'
export const LEDGER_VERSION = 1
export const DEFAULT_MAX_UNITS_PER_DAY = 8000
export const KEEP_DAYS = 14

// Google's cost table (same as crates/videorc-backend/src/youtube_quota.rs,
// checked 2026-10-02): reads 1, writes 50. Confirm against the lab project's
// Cloud Console metrics during the first real run (plan 176 C2).
export const QUOTA_COSTS = Object.freeze({
  'channels.list': 1,
  'liveBroadcasts.list': 1,
  'liveStreams.list': 1,
  'videos.list': 1,
  'liveChatMessages.list': 1,
  'liveBroadcasts.insert': 50,
  'liveBroadcasts.update': 50,
  'liveBroadcasts.delete': 50,
  'liveBroadcasts.bind': 50,
  'liveBroadcasts.transition': 50,
  'liveStreams.insert': 50,
  'liveStreams.delete': 50,
  'liveChatMessages.insert': 50,
  'liveChatMessages.delete': 50,
  'videos.update': 50,
  'thumbnails.set': 50
})

export class QuotaRefused extends Error {
  constructor({ method, units, spent, max, day }) {
    super(
      `Lab quota refused ${method} (${units} units): ${spent} of ${max} units already spent on Pacific day ${day}.`
    )
    this.name = 'QuotaRefused'
    this.code = 'QUOTA_REFUSED'
    this.method = method
    this.units = units
    this.spent = spent
    this.max = max
    this.day = day
  }
}

const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

/** Pure: the Pacific calendar day of `date` as YYYY-MM-DD (DST aware). */
export function pacificDay(date) {
  return PACIFIC_DAY.format(date instanceof Date ? date : new Date(date))
}

/** Pure: Google's cost for one call, or a thrown error for an unknown method. */
export function costOf(method) {
  const units = QUOTA_COSTS[method]
  if (units === undefined) {
    throw new Error(`Unknown YouTube Data API method "${method}": add its documented cost first.`)
  }
  return units
}

function emptyLedger() {
  return { version: LEDGER_VERSION, days: {} }
}

function readLedger(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return emptyLedger()
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // Fail closed: a corrupt counter must not read as zero spent.
    throw new Error(`${path} is not valid JSON. Inspect it before spending more lab quota.`)
  }
  if (parsed?.version !== LEDGER_VERSION || typeof parsed.days !== 'object') {
    throw new Error(`${path} has an unexpected shape (version ${parsed?.version}).`)
  }
  return parsed
}

function writeLedger(dir, path, ledger) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  const temp = join(dir, `.${LEDGER_FILE}.${randomBytes(6).toString('hex')}.tmp`)
  const fd = openSync(temp, 'wx', FILE_MODE)
  try {
    writeSync(fd, `${JSON.stringify(ledger, null, 2)}\n`)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    rmSync(temp, { force: true })
    throw error
  }
  closeSync(fd)
  chmodSync(temp, FILE_MODE)
  renameSync(temp, path)
}

function pruneDays(days, keep = KEEP_DAYS) {
  const names = Object.keys(days).sort()
  const kept = {}
  for (const name of names.slice(-keep)) kept[name] = days[name]
  return kept
}

/**
 * The lab's unit counter. Synchronous on purpose: a charge is read, checked
 * and written before the call it pays for goes out. One run at a time holds
 * the run lock (U4), so there is no cross-process race to solve here.
 */
export function createQuotaLedger({
  dir,
  maxUnitsPerDay = DEFAULT_MAX_UNITS_PER_DAY,
  now = () => new Date()
}) {
  if (!dir) throw new Error('createQuotaLedger needs the lab dir.')
  if (!Number.isFinite(maxUnitsPerDay) || maxUnitsPerDay <= 0) {
    throw new Error('maxUnitsPerDay must be a positive number.')
  }
  const path = join(dir, LEDGER_FILE)

  const dayEntry = (ledger, day) => ledger.days[day] ?? { units: 0, calls: {} }

  function today() {
    const day = pacificDay(now())
    const entry = dayEntry(readLedger(path), day)
    return {
      day,
      units: entry.units,
      max: maxUnitsPerDay,
      remaining: Math.max(0, maxUnitsPerDay - entry.units),
      calls: entry.calls
    }
  }

  function canSpend(units) {
    return today().units + units <= maxUnitsPerDay
  }

  function charge(method, n = 1) {
    if (!Number.isInteger(n) || n < 1) throw new Error('charge count must be a positive integer.')
    const units = costOf(method) * n
    const day = pacificDay(now())
    const ledger = readLedger(path)
    const entry = dayEntry(ledger, day)
    if (entry.units + units > maxUnitsPerDay) {
      throw new QuotaRefused({ method, units, spent: entry.units, max: maxUnitsPerDay, day })
    }
    const row = entry.calls[method] ?? { calls: 0, units: 0 }
    entry.calls[method] = { calls: row.calls + n, units: row.units + units }
    entry.units += units
    ledger.days = pruneDays({ ...ledger.days, [day]: entry })
    writeLedger(dir, path, ledger)
    return { method, units, day, spent: entry.units, remaining: maxUnitsPerDay - entry.units }
  }

  return { path, maxUnitsPerDay, charge, canSpend, today }
}
