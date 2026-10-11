// Plan 178 U11. Wall-clock helpers for the schedule table. Slots are written
// as local times ("04:30") in the policy timezone (Europe/Madrid by default);
// these helpers turn a local date plus a slot time into a real instant, DST
// included. Pure: no clock, no filesystem.

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

const formatters = new Map()

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short'
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** The wall-clock fields of `instant` in `timeZone`. */
export function wallParts(instant, timeZone) {
  const ms = instant instanceof Date ? instant.getTime() : instant
  const parts = {}
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    parts[part.type] = part.value
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday
  }
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

/** The local calendar day of `instant` in `timeZone`, as YYYY-MM-DD. */
export function localDate(instant, timeZone) {
  const { year, month, day } = wallParts(instant, timeZone)
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/** "YYYY-MM-DD HH:MM" in `timeZone`, for logs and status. */
export function formatLocal(instant, timeZone) {
  const { hour, minute, weekday } = wallParts(instant, timeZone)
  return `${weekday} ${localDate(instant, timeZone)} ${pad(hour)}:${pad(minute)}`
}

/** Calendar arithmetic on a YYYY-MM-DD string (no timezone involved). */
export function addDays(date, days) {
  const [year, month, day] = parseDate(date)
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS)
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

function parseDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date))
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${JSON.stringify(date)}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** "HH:MM" (24 h) to { hour, minute }, or null when malformed. */
export function parseClock(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''))
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null
}

// The zone's offset from UTC at `ms`, in ms (Madrid summer = +2 h).
function offsetAt(ms, timeZone) {
  const p = wallParts(ms, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(ms / 1000) * 1000
}

/**
 * The instant at which the wall clock in `timeZone` reads `clock` ("HH:MM")
 * on local day `date`. A time that falls in a spring-forward gap moves
 * forward by the gap (02:30 on Madrid's March change becomes 03:30 CEST); a
 * time that happens twice on the autumn change resolves to the first one.
 */
export function zonedInstant(date, clock, timeZone) {
  const [year, month, day] = parseDate(date)
  const time = parseClock(clock)
  if (!time) throw new Error(`Not an HH:MM time: ${JSON.stringify(clock)}`)
  const wall = Date.UTC(year, month - 1, day, time.hour, time.minute)
  const offsets = new Set([
    offsetAt(wall - DAY_MS, timeZone),
    offsetAt(wall, timeZone),
    offsetAt(wall + DAY_MS, timeZone)
  ])
  const valid = []
  for (const offset of offsets) {
    const candidate = wall - offset
    const p = wallParts(candidate, timeZone)
    if (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === time.hour &&
      p.minute === time.minute
    ) {
      valid.push(candidate)
    }
  }
  if (valid.length) return new Date(Math.min(...valid))
  // In a gap: keep the offset from before the change, which lands the slot
  // the gap's length later on the new clock.
  return new Date(wall - offsetAt(wall - DAY_MS, timeZone))
}

export { DAY_MS, MINUTE_MS }
