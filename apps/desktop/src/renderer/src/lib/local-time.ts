// The one way the renderer turns an instant into the streamer's local clock.
//
// Electron's ICU tz data lags IANA (Electron 39 ships 2025b, which still moves
// Vancouver, Edmonton, Inuvik, Winnipeg, Casablanca and Havana an hour twice a
// year), so `toLocaleTimeString`, `getHours` and a zone-less
// `Intl.DateTimeFormat` read the wrong hour there. The backend bundles current
// tz data: `time.localOffsets` sends the system zone's UTC offsets for a few
// years around now, and every format here runs at a fixed offset from those
// spans. An instant outside every window the backend covered asks for its
// own window, and reads ICU's offset only until that answer arrives. The `videorc/no-system-local-time` lint rule keeps the rest of the
// renderer on these helpers. Components that show a time call `useLocalTime()`
// so they re-render when the spans arrive or refresh: no text stays on ICU's
// hour.
import { useSyncExternalStore } from 'react'
import { BackendClient } from '@/backendClient'
import type { LocalOffsetSpan, LocalOffsets } from '../../../shared/backend'
import { offsetTimeZone } from '@/lib/schedule-time'

/** Re-read the spans this often, and when the system zone changes. */
const REFRESH_MS = 6 * 60 * 60_000
const RETRY_MS = [1_000, 5_000, 30_000]
const FORMATTER_CACHE_MAX = 200
/** An out-of-window instant fetches the two-year window it falls in. */
const WINDOW_MS = 2 * 366 * 86_400_000

interface CoveredWindow {
  fromMs: number
  untilMs: number
  spans: LocalOffsetSpan[]
}

let windows: CoveredWindow[] = []
let windowsZone: string | null = null
let syncing: Promise<void> | null = null
const requestedWindows = new Set<number>()
const formatters = new Map<string, Intl.DateTimeFormat>()
let revision = 0
const listeners = new Set<() => void>()

/** The system's IANA zone name. Reading the name is safe; ICU's rules are not. */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** Replace every covered window with this one (`null` forgets them all). */
export function setLocalOffsets(next: LocalOffsets | null): void {
  windows = []
  windowsZone = next?.timeZone ?? null
  requestedWindows.clear()
  if (next) addWindow(next)
  publish()
}

/** Add a window the backend covered, for the zone already loaded. */
export function addLocalOffsets(next: LocalOffsets): void {
  if (next.timeZone !== windowsZone) return
  addWindow(next)
  publish()
}

function addWindow(next: LocalOffsets): void {
  if (!next.spans.length || next.untilMs <= next.fromMs) return
  windows.push({
    fromMs: next.fromMs,
    untilMs: next.untilMs,
    spans: [...next.spans].sort((a, b) => a.fromMs - b.fromMs)
  })
}

function publish(): void {
  formatters.clear()
  revision += 1
  for (const listener of listeners) listener()
}

/** Store subscription for `useLocalTime`. */
export function subscribeLocalTime(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Bumps each time the spans change, so memoized time text can depend on it. */
export function localTimeRevision(): number {
  return revision
}

/**
 * Re-render when the local offsets arrive or refresh. Returns the revision,
 * for the deps of a `useMemo` that formats times.
 */
export function useLocalTime(): number {
  return useSyncExternalStore(subscribeLocalTime, localTimeRevision, localTimeRevision)
}

/**
 * The streamer's UTC offset at `ms`, in minutes (Vancouver from 2026-11: -420).
 * ICU's guess before the backend answers, for another zone, and for an
 * instant no window covers yet (which asks for its window).
 */
export function localOffsetMinutes(ms: number): number {
  if (windowsZone !== null && windowsZone === systemTimeZone()) {
    const window = windows.find((covered) => ms >= covered.fromMs && ms < covered.untilMs)
    if (window) return spanOffsetAt(window.spans, ms)
    requestWindow(ms)
  }
  // oxlint-disable-next-line videorc/no-system-local-time -- fallback until the backend answers
  return -new Date(ms).getTimezoneOffset()
}

function spanOffsetAt(spans: LocalOffsetSpan[], ms: number): number {
  let low = 0
  let high = spans.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (spans[middle].fromMs <= ms) low = middle
    else high = middle - 1
  }
  return spans[low].offsetMinutes
}

function requestWindow(ms: number): void {
  if (!syncing || !Number.isFinite(ms)) return
  const bucket = Math.floor(ms / WINDOW_MS)
  if (requestedWindows.has(bucket)) return
  requestedWindows.add(bucket)
  const fromUtc = new Date(bucket * WINDOW_MS).toISOString()
  const untilUtc = new Date((bucket + 1) * WINDOW_MS).toISOString()
  void fetchOffsets({ timeZone: systemTimeZone(), fromUtc, untilUtc })
    .then(addLocalOffsets)
    .catch((error: unknown) => {
      requestedWindows.delete(bucket)
      console.warn('[local-time] could not read the offsets for', fromUtc, error)
    })
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

async function fetchOffsets(params: {
  timeZone: string
  fromUtc?: string
  untilUtc?: string
}): Promise<LocalOffsets> {
  const connection = await window.videorc.getBackendConnection()
  if (!connection) throw new Error('Videorc is reconnecting.')
  const client = new BackendClient(connection)
  try {
    await client.connect()
    return await client.request<LocalOffsets>('time.localOffsets', params)
  } finally {
    client.close()
  }
}

async function syncOnce(attempt: number): Promise<void> {
  try {
    setLocalOffsets(await fetchOffsets({ timeZone: systemTimeZone() }))
  } catch (error) {
    console.warn('[local-time] using the system time zone data until Videorc answers:', error)
    const delay = RETRY_MS[attempt]
    if (delay !== undefined) setTimeout(() => void syncOnce(attempt + 1), delay)
  }
}
