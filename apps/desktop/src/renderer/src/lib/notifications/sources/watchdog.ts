// Plan 250: the stream watchdog's alerts as notifications. The backend owns
// each alert and its words (plan 223); this maps it onto its subject, so a
// silent microphone the watchdog and a `health` event both report is one
// entry. The watchdog leads that entry: it has the live clock and the fix.

import type { WatchdogAlert, WatchdogAlertFix } from '@/lib/backend'
import type { NotificationStore } from '@/lib/notifications/store'
import type { NotificationAction, NotificationTone } from '@/lib/notifications/types'
import { watchdogClearedAlerts, watchdogClearedToast } from '@/lib/watchdog-view'

export interface WatchdogNotificationDeps {
  fix: (alert: WatchdogAlert, fix: WatchdogAlertFix) => void | Promise<void>
  acknowledge: (alert: WatchdogAlert) => void
  /** "I meant to": the mute's own quiet button, for the rest of the stream. */
  snooze: (alert: WatchdogAlert, scope: 'stream') => void
}

/** The subject an alert is about: the entry it shares with other reports. */
export function watchdogSubjectKey(alert: Pick<WatchdogAlert, 'check' | 'targetId'>): string {
  switch (alert.check) {
    case 'mic-muted':
    case 'mic-silent':
    case 'no-voice':
      return 'microphone'
    case 'destination-down':
      return alert.targetId && alert.targetId !== 'all'
        ? `stream-target:${alert.targetId}`
        : 'stream-targets'
    case 'bitrate-floor':
      return 'stream-uplink'
    case 'picture-stopped':
      return 'stream-output'
    case 'program-unreported':
    case 'contribution-missing':
      return 'cloud-status'
    default:
      return alert.targetId
        ? `watchdog:${alert.check}:${alert.targetId}`
        : `watchdog:${alert.check}`
  }
}

/** Who reports: one per check and target, so an alert that returns under a new id is the same report. */
export function watchdogReportSource(alert: Pick<WatchdogAlert, 'check' | 'targetId'>): string {
  return alert.targetId ? `watchdog:${alert.check}:${alert.targetId}` : `watchdog:${alert.check}`
}

export function watchdogTone(alert: Pick<WatchdogAlert, 'severity'>): NotificationTone {
  return alert.severity === 'critical'
    ? 'urgent'
    : alert.severity === 'warning'
      ? 'warning'
      : 'news'
}

/** A fix that runs in place; every other fix opens the page that owns the control. */
const IN_PLACE: readonly WatchdogAlertFix['kind'][] = [
  'unmute',
  'end-takeover',
  'reconnect-destination'
]

function watchdogActions(
  alert: WatchdogAlert,
  deps: WatchdogNotificationDeps
): NotificationAction[] {
  const actions: NotificationAction[] = (alert.fixes ?? []).map((fix) => ({
    id: `fix:${fix.kind}`,
    label: fix.label,
    kind: IN_PLACE.includes(fix.kind) ? 'fix' : 'door',
    run: () => deps.fix(alert, fix)
  }))
  if (alert.check === 'mic-muted') {
    actions.splice(1, 0, {
      id: 'meant-to',
      label: 'I meant to',
      kind: 'fix',
      run: () => deps.snooze(alert, 'stream')
    })
  }
  return actions.slice(0, 2)
}

/**
 * Called with each `watchdog.alerts` list. An open alert is a report on its
 * subject; a cleared one resolves it with the watchdog's recovery words; one
 * that was withdrawn, snoozed or marked seen is taken back without a
 * resolved entry.
 */
export function syncWatchdogAlerts(
  store: NotificationStore,
  previous: readonly WatchdogAlert[],
  next: readonly WatchdogAlert[],
  deps: WatchdogNotificationDeps,
  change: { withdrawn?: readonly string[] } = {}
): void {
  const withdrawn = change.withdrawn ?? []
  for (const alert of watchdogClearedAlerts(previous, next, withdrawn)) {
    store.resolve(watchdogSubjectKey(alert), {
      source: watchdogReportSource(alert),
      title: watchdogClearedToast(alert)
    })
  }
  const listed = new Set(next.map((alert) => alert.id))
  for (const alert of previous) {
    if (!listed.has(alert.id) && withdrawn.includes(alert.id)) {
      store.withdraw(watchdogSubjectKey(alert), watchdogReportSource(alert))
    }
  }
  for (const alert of next) {
    const key = watchdogSubjectKey(alert)
    const source = watchdogReportSource(alert)
    if (alert.state !== 'open') {
      // Got it on the card, or a snooze: the report goes, like the toast did.
      store.withdraw(key, source)
      continue
    }
    store.publish({
      key,
      kind: 'watchdog',
      source,
      lead: true,
      tone: watchdogTone(alert),
      title: alert.title,
      detail: alert.detail,
      actions: watchdogActions(alert, deps),
      onClear: () => deps.acknowledge(alert)
    })
  }
}
