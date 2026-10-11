// Times in the Schedule dialog (plan 174 S3.5b, D-31), read by people: zones
// as "Madrid (GMT+2)" instead of "Europe/Madrid", the start as "Sat, Oct 12,
// 9:00 PM GMT+2", and the repeated-hour choice only when the clocks go back
// over the chosen time.

// One formatter per zone, kept: the zone picker labels every zone on each
// render, and building ~430 formatters per keystroke made search crawl.
const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    zoneFormatters.set(timeZone, formatter)
  }
  return formatter
}

/** The zone's UTC offset at an instant, in minutes (Madrid in summer: 120). */
export function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(utcMs))
  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? 0)
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second')
  )
  return Math.round((wall - Math.floor(utcMs / 1000) * 1000) / 60_000)
}

/**
 * Every UTC offset at which `localStart` (a `datetime-local` value) happens
 * in the zone: one normally, two when the clocks go back over it (it happens
 * twice), none when they jump over it. Earlier first.
 */
export function localTimeOffsets(localStart: string, timeZone: string): number[] {
  const wall = Date.parse(`${localStart}Z`)
  if (Number.isNaN(wall)) return []
  try {
    const candidates = new Set([
      zoneOffsetMinutes(wall - 86_400_000, timeZone),
      zoneOffsetMinutes(wall, timeZone),
      zoneOffsetMinutes(wall + 86_400_000, timeZone)
    ])
    return [...candidates]
      .filter((offset) => zoneOffsetMinutes(wall - offset * 60_000, timeZone) === offset)
      .sort((a, b) => b - a)
  } catch {
    return []
  }
}

/** "GMT+2", "GMT-5:30", "GMT". */
export function formatGmtOffset(minutes: number): string {
  if (minutes === 0) return 'GMT'
  const sign = minutes > 0 ? '+' : '-'
  const hours = Math.floor(Math.abs(minutes) / 60)
  const rest = Math.abs(minutes) % 60
  return `GMT${sign}${hours}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`
}

/** "Madrid (GMT+2)", "New York (GMT-4)", "UTC": a zone as people name it, at a time. */
export function timeZoneLabel(timeZone: string, atMs: number = Date.now()): string {
  if (timeZone === 'UTC') return 'UTC'
  const city = timeZone.split('/').pop()?.replace(/_/g, ' ') ?? timeZone
  try {
    return `${city} (${formatGmtOffset(zoneOffsetMinutes(atMs, timeZone))})`
  } catch {
    return city
  }
}

/** "Sat, Oct 12, 9:00 PM GMT+2": the start in its zone, the year only when it isn't this one. */
export function formatScheduledStart(
  startUtc: string,
  timeZone: string,
  { locale, nowMs = Date.now() }: { locale?: string; nowMs?: number } = {}
): string {
  const start = new Date(startUtc)
  if (Number.isNaN(start.getTime())) return ''
  const sameYear =
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(start) ===
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(new Date(nowMs))
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short'
  }).format(start)
}
