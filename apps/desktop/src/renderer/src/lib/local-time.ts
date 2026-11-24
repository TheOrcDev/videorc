// The one way the renderer turns an instant into the streamer's local clock.
//
// Electron's ICU tz data lags IANA (Electron 39 ships 2025b, which still moves
// Vancouver, Edmonton, Inuvik, Winnipeg, Casablanca and Havana an hour twice a
// year), so `toLocaleTimeString`, `getHours` and a zone-less
// `Intl.DateTimeFormat` read the wrong hour there. The backend bundles current
// tz data: `time.localOffsets` sends the system zone's UTC offsets for a few
// years around now, and every format here runs at a fixed offset from those
// spans. The `videorc/no-system-local-time` lint rule keeps the rest of the
// renderer on these helpers.
import { BackendClient } from '@/backendClient'
import type { LocalOffsetSpan, LocalOffsets } from '../../../shared/backend'
import { offsetTimeZone } from '@/lib/schedule-time'

/** Re-read the spans this often, and when the system zone changes. */
const REFRESH_MS = 6 * 60 * 60_000
const RETRY_MS = [1_000, 5_000, 30_000]
const FORMATTER_CACHE_MAX = 200

let spans: LocalOffsetSpan[] | null = null
let spansZone: string | null = null
let syncing: Promise<void> | null = null
const formatters = new Map<string, Intl.DateTimeFormat>()

/** The system's IANA zone name. Reading the name is safe; ICU's rules are not. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** Use these spans (tests, and every window after `time.localOffsets`). */
export function setLocalOffsets(next: LocalOffsets | null): void {
  spans = next && next.spans.length ? [...next.spans].sort((a, b) => a.fromMs - b.fromMs) : null
  spansZone = next?.timeZone ?? null
}

/**
 * The streamer's UTC offset at `ms`, in minutes (Vancouver from 2026-11: -420).
 * Before the backend answers, or for another zone, ICU's guess.
 */
export function localOffsetMinutes(ms: number): number {
  if (spans && spansZone === systemTimeZone()) {
    let low = 0
    let high = spans.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (spans[middle].fromMs <= ms) low = middle
      else high = middle - 1
    }
    return spans[low].offsetMinutes
  }
  // oxlint-disable-next-line videorc/no-system-local-time -- fallback until the backend answers
  return -new Date(ms).getTimezoneOffset()
}

/** Options for `formatLocal`: an `Intl` format without a zone of its own. */
export type LocalFormatOptions = Omit<Intl.DateTimeFormatOptions, 'timeZone'>

/** What `Date#toLocaleString()` showed: "12/15/2026, 10:00:00 AM" in en-US. */
export const LOCAL_DATE_TIME: LocalFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
}

/** What `Date#toLocaleDateString()` showed: "12/15/2026" in en-US. */
export const LOCAL_DATE: LocalFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric' }

/** `ms` on the streamer's clock, formatted by `Intl` at that instant's offset. */
export function formatLocal(
  ms: number,
  options: LocalFormatOptions,
  locale?: string | string[]
): string {
  if (!Number.isFinite(ms)) return ''
  const offset = localOffsetMinutes(ms)
  const key = `${String(locale ?? '')}|${offset}|${JSON.stringify(options)}`
  let format = formatters.get(key)
  if (!format) {
    if (formatters.size >= FORMATTER_CACHE_MAX) formatters.clear()
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: offsetTimeZone(offset) })
    formatters.set(key, format)
  }
  return format.format(ms)
}

/** "2026-12-15": the streamer's calendar day at `ms`, for same-day checks. */
export function localDayKey(ms: number): string {
  return new Date(ms + localOffsetMinutes(ms) * 60_000).toISOString().slice(0, 10)
}

/** The local calendar day `days` after the one `ms` falls on, as `localDayKey`. */
export function localDayKeyAfter(ms: number, days: number): string {
  const day = Date.parse(`${localDayKey(ms)}T00:00:00Z`) + days * 86_400_000
  return new Date(day).toISOString().slice(0, 10)
}

/**
 * Load the system zone's spans from the backend in this window, then keep
 * them fresh. Safe to call from every renderer entry; failures keep ICU's
 * offsets and retry.
 */
export function startLocalTimeSync(): Promise<void> {
  if (!syncing) {
    syncing = syncOnce(0)
    setInterval(() => void syncOnce(RETRY_MS.length), REFRESH_MS)
  }
  return syncing
}

async function syncOnce(attempt: number): Promise<void> {
  const timeZone = systemTimeZone()
  let client: BackendClient | null = null
  try {
    const connection = await window.videorc.getBackendConnection()
    if (!connection) throw new Error('Videorc is reconnecting.')
    client = new BackendClient(connection)
    await client.connect()
    setLocalOffsets(await client.request<LocalOffsets>('time.localOffsets', { timeZone }))
    formatters.clear()
  } catch (error) {
    console.warn('[local-time] using the system time zone data until Videorc answers:', error)
    const delay = RETRY_MS[attempt]
    if (delay !== undefined) setTimeout(() => void syncOnce(attempt + 1), delay)
  } finally {
    client?.close()
  }
}
