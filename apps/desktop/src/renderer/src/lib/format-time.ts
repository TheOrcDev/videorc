// Plan 174 S1.4 (E-20, J2-16): one spelling per time fact.
//
//   formatTimecode       "2:05", "1:02:05"   clocks, durations, timestamps
//   formatRelativeTime   "now", "4m", "2h", "3d", then "Oct 2"
//
// The relative form rolls over to days and then to a date, so an old row
// never reads "2207h 25m".

export { formatTimecode, type TimecodeOptions } from '../../../shared/timecode'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Past this, a row shows the date it happened instead of an age. */
const RELATIVE_DAYS_MAX = 7

/**
 * A compact age for a dense row: "now" under 45 s, then minutes, hours and
 * days ("4m", "2h", "3d"), then the date ("Oct 2", with the year when it is
 * not this year). An unreadable time is the empty string; a time in the
 * future reads "now".
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return ''
  const elapsed = Math.max(0, nowMs - at)
  if (elapsed < 45_000) return 'now'
  if (elapsed < HOUR_MS) return `${Math.max(1, Math.floor(elapsed / MINUTE_MS))}m`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`
  if (elapsed < RELATIVE_DAYS_MAX * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d`
  return formatShortDate(at, nowMs)
}

/** "Oct 2", or "Oct 2, 2025" outside the current year. */
export function formatShortDate(atMs: number, nowMs: number): string {
  const at = new Date(atMs)
  const sameYear = at.getFullYear() === new Date(nowMs).getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  }).format(at)
}
