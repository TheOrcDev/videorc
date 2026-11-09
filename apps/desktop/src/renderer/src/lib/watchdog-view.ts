// The stream watchdog's words and ranks on the renderer side (plan 223 A5,
// A6): which alert leads, what the Stream fact row and the Stream Manager's
// chip say, the toast and notification shapes. Pure, so it runs under the
// node vitest runner; the backend owns the alerts and their copy, this only
// orders and quotes them.

import type { WatchdogAlert } from '@/lib/backend'

export {
  topWatchdogAlert,
  visibleWatchdogAlerts,
  watchdogChipLabel,
  watchdogToastId
} from './watchdog-rank'

/**
 * The system notification's words (plan 223, "System notification form"):
 * "Videorc: your microphone is muted" / "Muted for 0:42 on the livestream.
 * Click to open the Studio."
 */
export function watchdogNotificationWords(alert: WatchdogAlert): { title: string; body: string } {
  const bare = alert.title.replace(/ on the livestream$/, '')
  const title = `Videorc: ${bare.charAt(0).toLowerCase()}${bare.slice(1)}`
  const clock = /^Muted for (\d+:\d{2}(?::\d{2})?)\./.exec(alert.detail)?.[1]
  const body = clock
    ? `Muted for ${clock} on the livestream. Click to open the Studio.`
    : `${alert.detail.replace(/\s+$/, '')} Click to open the Studio.`
  return { title, body }
}

/**
 * Two card texts that differ only in their live clock ("0:41" vs "0:42")
 * are the same words (the backend's `same_words`): the list re-emits them
 * every second, the toast must not (L1).
 */
export function watchdogSameWords(before: string, after: string): boolean {
  const strip = (text: string) => text.replace(/[\d:]+/g, '#')
  return strip(before) === strip(after)
}

/** Seconds since the alert opened, from its RFC 3339 `since`. */
export function watchdogOpenSeconds(alert: Pick<WatchdogAlert, 'since'>, nowMs: number): number {
  const since = Date.parse(alert.since)
  return Number.isNaN(since) ? 0 : Math.max(0, Math.floor((nowMs - since) / 1000))
}

/** Alerts that may notify at all (D3): warning and critical, never still-there. */
export function watchdogNotifies(alert: Pick<WatchdogAlert, 'severity' | 'check'>): boolean {
  return alert.severity !== 'notice' && alert.check !== 'still-there'
}

/**
 * Whether a transition between two lists means an ask (open or repeat),
 * and why; the second ask at since + 60 s is `watchdogStayedOpenDelayMs`.
 */
export function watchdogNotifyCandidates(
  previous: readonly WatchdogAlert[],
  next: readonly WatchdogAlert[]
): { alert: WatchdogAlert; reason: 'opened' | 'repeat' }[] {
  const before = new Map(previous.map((alert) => [alert.id, alert]))
  const out: { alert: WatchdogAlert; reason: 'opened' | 'repeat' }[] = []
  for (const alert of next) {
    if (!watchdogNotifies(alert) || alert.state === 'snoozed') continue
    const known = before.get(alert.id)
    if (!known) {
      out.push({ alert, reason: 'opened' })
    } else if (
      !!alert.lastRepeatAt &&
      (alert.lastRepeatAt ?? null) !== (known.lastRepeatAt ?? null)
    ) {
      out.push({ alert, reason: 'repeat' })
    }
  }
  return out
}

/** D2, D3: the second ask comes when the alert has been open this long. */
export const WATCHDOG_STAYED_OPEN_SECONDS = 60

/** Milliseconds until the alert's since + 60 s (0 when that has passed). */
export function watchdogStayedOpenDelayMs(
  alert: Pick<WatchdogAlert, 'since'>,
  nowMs: number
): number {
  const since = Date.parse(alert.since)
  if (Number.isNaN(since)) return WATCHDOG_STAYED_OPEN_SECONDS * 1000
  return Math.max(0, since + WATCHDOG_STAYED_OPEN_SECONDS * 1000 - nowMs)
}

/**
 * Alerts that were listed before and are gone now because their signal
 * recovered: their clearing toasts. An id the backend named as withdrawn
 * (M2: a fold, a replace, the session's end) is not a recovery; see
 * `watchdogQuietedAlerts`.
 */
export function watchdogClearedAlerts(
  previous: readonly WatchdogAlert[],
  next: readonly WatchdogAlert[],
  withdrawn: readonly string[] = []
): WatchdogAlert[] {
  const ids = new Set(next.map((alert) => alert.id))
  const quiet = new Set(withdrawn)
  return previous.filter((alert) => !ids.has(alert.id) && !quiet.has(alert.id))
}

/**
 * Alerts whose toast should simply go (M2): withdrawn without a recovery,
 * or snoozed (ten minutes, or "I meant to", which keeps the card listed and
 * hidden) or acknowledged since the last list.
 */
export function watchdogQuietedAlerts(
  previous: readonly WatchdogAlert[],
  next: readonly WatchdogAlert[],
  withdrawn: readonly string[] = []
): WatchdogAlert[] {
  const ids = new Set(next.map((alert) => alert.id))
  const quiet = new Set(withdrawn)
  const before = new Map(previous.map((alert) => [alert.id, alert]))
  const gone = previous.filter((alert) => !ids.has(alert.id) && quiet.has(alert.id))
  const hushed = next.filter((alert) => {
    if (alert.state === 'open') return false
    const known = before.get(alert.id)
    return !known || known.state === 'open'
  })
  return [...gone, ...hushed]
}

/** The success toast when a check clears ("Copy (exact)", the last row). */
export function watchdogClearedToast(alert: WatchdogAlert): string {
  switch (alert.check) {
    case 'mic-muted':
      return 'Microphone unmuted'
    case 'mic-silent':
    case 'no-voice':
    case 'program-silent':
      return 'Sound is back'
    case 'picture-black':
    case 'picture-stopped':
      return 'Picture is back'
    case 'destination-down':
    case 'platform-health': {
      const label = destinationLabel(alert.title)
      return label && alert.targetId && alert.targetId !== 'all'
        ? `${label} is back`
        : 'Destinations are back'
    }
    case 'bitrate-floor':
      return 'Connection is back to speed'
    case 'av-drift':
      return 'Sound and picture are in step again'
    case 'chat-says':
      return 'Chat has gone quiet about it'
    case 'brb-long':
      return 'Takeover ended'
    case 'still-there':
      return 'Welcome back'
  }
}

function destinationLabel(title: string): string | null {
  const stopped = /^Streaming to (.+) stopped$/.exec(title)
  if (stopped) return stopped[1]
  const down = /^(.+) has been down for/.exec(title)
  if (down) return down[1]
  const reports = /^(.+) (reports|isn't receiving|ended)/.exec(title)
  return reports ? reports[1] : null
}

/** The Library's "Alerts" list from `watchdog-*` health events (D13). */
export interface WatchdogHistoryRow {
  check: string
  title: string
  openedAt: string
  clearedAt: string | null
}

export function watchdogHistory(
  events: readonly { code: string; message: string; createdAt: string }[]
): WatchdogHistoryRow[] {
  const sorted = [...events].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const open = new Map<string, WatchdogHistoryRow>()
  const rows: WatchdogHistoryRow[] = []
  for (const event of sorted) {
    const match = /^watchdog-(.+?)(?:-(cleared|acknowledged|snoozed))?$/.exec(event.code)
    if (!match) continue
    const [, check, suffix] = match
    if (!suffix) {
      const row: WatchdogHistoryRow = {
        check,
        title: event.message.split('. ')[0] ?? event.message,
        openedAt: event.createdAt,
        clearedAt: null
      }
      open.set(check, row)
      rows.push(row)
    } else if (suffix === 'cleared' || suffix === 'snoozed') {
      const row = open.get(check)
      if (row) {
        row.clearedAt = event.createdAt
        open.delete(check)
      }
    }
  }
  return rows
}

/** "12:04 to 12:05 (0:52)", or "12:04, still open". */
export function watchdogHistorySpan(row: WatchdogHistoryRow): string {
  const opened = timeOfDay(row.openedAt)
  if (!row.clearedAt) return `${opened}, still open`
  const seconds = Math.max(
    0,
    Math.round((Date.parse(row.clearedAt) - Date.parse(row.openedAt)) / 1000)
  )
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${opened} to ${timeOfDay(row.clearedAt)} (${minutes}:${String(rest).padStart(2, '0')})`
}

function timeOfDay(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
