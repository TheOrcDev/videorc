// Times in the Schedule dialog (plan 174 S3.5b, D-31), read by people: zones
// as "Madrid (GMT+2)" instead of "Europe/Madrid", the start as "Sat, Oct 12,
// 9:00 PM GMT+2", and the repeated-hour choice only when the clocks go back
// over the chosen time.
//
// The zone rules live in the backend's bundled tz data: Electron's ICU lags
// the law (Electron 39 still has Vancouver, Edmonton, Winnipeg, Casablanca
// and Havana changing clocks). The backend sends each time with its UTC
// offset, and this file only formats a time at that fixed offset.

import { offsetTimeZone } from '@/lib/offset-time-zone'

export { offsetTimeZone }

/** The `datetime-local` value ("2026-12-15T10:00") of an instant at a fixed UTC offset. */
export function wallTimeAt(utcMs: number, offsetMinutes: number): string {
  return new Date(utcMs + offsetMinutes * 60_000).toISOString().slice(0, 16)
}

/** "GMT+2", "GMT-5:30", "GMT". */
export function formatGmtOffset(minutes: number): string {
  if (minutes === 0) return 'GMT'
  const sign = minutes > 0 ? '+' : '-'
  const hours = Math.floor(Math.abs(minutes) / 60)
  const rest = Math.abs(minutes) % 60
  return `GMT${sign}${hours}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`
}

/**
 * "Madrid (GMT+2)", "New York (GMT-4)", "UTC": a zone as people name it, with
 * the backend's offset for it. Just the city while the offset is unknown.
 */
export function timeZoneLabel(timeZone: string, offsetMinutes?: number | null): string {
  if (timeZone === 'UTC') return 'UTC'
  const city = timeZone.split('/').pop()?.replace(/_/g, ' ') ?? timeZone
  return typeof offsetMinutes === 'number' ? `${city} (${formatGmtOffset(offsetMinutes)})` : city
}

/** "Sat, Oct 12, 9:00 PM GMT+2": the start at its offset, the year only when it isn't this one. */
export function formatScheduledStart(
  startUtc: string,
  offsetMinutes: number,
  { locale, nowMs = Date.now() }: { locale?: string; nowMs?: number } = {}
): string {
  const start = new Date(startUtc)
  if (Number.isNaN(start.getTime())) return ''
  const timeZone = offsetTimeZone(offsetMinutes)
  const year = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' })
  const sameYear = year.format(start) === year.format(new Date(nowMs))
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
