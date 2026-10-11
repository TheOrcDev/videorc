import { MINUTE_MS, addDays, localDate, zonedInstant } from './schedule-time.mjs'

// Plan 178 U11. Pure decisions over the schedule table, the state file and
// the clock. A slot is due while now is inside [slot, slot + grace] on its
// local day and nothing final has been recorded for it that day. A slot whose
// window closed without a final outcome is missed: it is recorded and never
// run late, so a machine that was off or busy never piles runs up.

// Outcomes that close a slot for the day.
export const FINAL_STATUSES = Object.freeze([
  'passed',
  'failed',
  'refused',
  'stopped',
  'crashed',
  'missed',
  'skipped',
  'interrupted'
])
// Outcomes that leave it open: deferred waits for the next tick in the window,
// running belongs to a tick that is still alive.
export const OPEN_STATUSES = Object.freeze(['deferred-lock', 'running'])

export function isFinal(entry) {
  return Boolean(entry) && FINAL_STATUSES.includes(entry.status)
}

/** Every slot's window on local `date`. */
export function slotWindows(table, date, timeZone) {
  return table.slots.map((slot) => {
    const start = zonedInstant(date, slot.at, timeZone)
    return { slot, date, start, end: new Date(start.getTime() + slot.graceMinutes * MINUTE_MS) }
  })
}

/**
 * What the tick should do now. Looks at yesterday and today (local), so a
 * window that crossed midnight or closed while the machine slept is still
 * recorded as missed. Returns { today, due, missed, upcoming }: `due` is
 * ordered by slot time and the tick runs only the first; `missed` lists the
 * windows to record as missed.
 */
export function planTick({ table, state, now, timeZone }) {
  const nowMs = now.getTime()
  const today = localDate(now, timeZone)
  const due = []
  const missed = []
  const upcoming = []
  const since = state?.since ? Date.parse(state.since) : Number.NEGATIVE_INFINITY
  for (const date of [addDays(today, -1), today]) {
    for (const window of slotWindows(table, date, timeZone)) {
      const entry = state?.days?.[date]?.[window.slot.id]
      if (isFinal(entry)) continue
      if (window.end.getTime() < since) continue
      if (nowMs < window.start.getTime()) {
        upcoming.push(window)
      } else if (nowMs > window.end.getTime()) {
        missed.push({
          ...window,
          reason:
            entry?.status === 'deferred-lock'
              ? `window closed while the run lock was held (${entry.reason ?? 'unknown holder'})`
              : entry?.status === 'running'
                ? 'window closed while an earlier tick still ran it'
                : 'no tick ran inside the window'
        })
      } else if (entry?.status !== 'running') {
        due.push(window)
      }
    }
  }
  due.sort((left, right) => left.start - right.start)
  return { today, due, missed, upcoming }
}

/** Today's and tomorrow's slots with their recorded outcome, for status. */
export function upcomingSlots({ table, state, now, timeZone }) {
  const today = localDate(now, timeZone)
  const rows = []
  for (const date of [today, addDays(today, 1)]) {
    for (const window of slotWindows(table, date, timeZone)) {
      const entry = state?.days?.[date]?.[window.slot.id] ?? null
      const nowMs = now.getTime()
      let when = 'later'
      if (nowMs > window.end.getTime()) when = 'past'
      else if (nowMs >= window.start.getTime()) when = 'open'
      rows.push({ ...window, entry, when })
    }
  }
  return rows
}
