// The stream watchdog's ranks and short words (plan 223 A5, A6): which alert
// leads, and the few words the Stream fact row and the Stream Manager's chip
// say. This is the one watchdog module the eager Studio imports; the rest
// (toasts, the notification, the history) lives in watchdog-view.ts and
// loads with the first alert.

import type { WatchdogAlert, WatchdogAlertSeverity } from '@/lib/backend'

const SEVERITY_RANK: Record<WatchdogAlertSeverity, number> = {
  critical: 0,
  warning: 1,
  notice: 2
}

/** Alerts the streamer should see now: snoozed ones are hidden (D3). */
export function visibleWatchdogAlerts(alerts: readonly WatchdogAlert[]): WatchdogAlert[] {
  return alerts
    .filter((alert) => alert.state !== 'snoozed')
    .sort((left, right) => {
      const rank = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
      return rank !== 0 ? rank : left.since.localeCompare(right.since)
    })
}

/** The alert the Stream fact row and the chip name: the worst, oldest first. */
export function topWatchdogAlert(alerts: readonly WatchdogAlert[]): WatchdogAlert | null {
  return visibleWatchdogAlerts(alerts)[0] ?? null
}

/**
 * The chip's few words beside ON AIR, and the Stream fact's value: the
 * check's name in two or three words, with the destination's label where
 * there is one ("YouTube down", "Chat says no sound").
 */
export function watchdogChipLabel(
  alert: Pick<WatchdogAlert, 'check' | 'title' | 'targetId'> &
    Partial<Pick<WatchdogAlert, 'platform'>>
): string {
  switch (alert.check) {
    case 'mic-muted':
      return 'Microphone muted'
    case 'mic-silent':
      return 'Microphone silent'
    case 'no-voice':
      return 'No voice'
    case 'program-silent':
      return 'Viewers hear nothing'
    case 'picture-black':
      return 'Black picture'
    case 'picture-stopped':
      return 'Picture stopped'
    case 'destination-down':
      return alert.targetId === 'all' ? 'Nobody receiving' : `${destinationOf(alert)} down`
    case 'platform-health':
      return alert.title
    case 'bitrate-floor':
      return 'Connection too slow'
    case 'av-drift':
      return 'Sound and picture drifting'
    case 'chat-says':
      return alert.targetId === 'video'
        ? 'Chat says frozen'
        : alert.targetId === 'lag'
          ? 'Chat says lagging'
          : 'Chat says no sound'
    case 'brb-long':
      return 'Be right back'
    case 'still-there':
      return 'Still there?'
  }
}

/** Plan 223's platform ids as the chip may name them (L9's fallback). */
const PLATFORM_NAMES: Record<string, string> = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  kick: 'Kick',
  x: 'X',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  custom: 'Custom destination'
}

/**
 * The destination's label from the card's title, in every shape the
 * backend writes ("Streaming to {label} stopped", "{label} has been down
 * for 0:20", "{label} isn't receiving your stream"); else the platform's
 * name; else the title itself, never a made-up "Destination" (L9).
 */
function destinationOf(
  alert: Pick<WatchdogAlert, 'title'> & Partial<Pick<WatchdogAlert, 'platform'>>
): string {
  return (
    /^Streaming to (.+) stopped$/.exec(alert.title)?.[1] ??
    /^(.+?) (has been down|isn't receiving|ended the broadcast|reports )/.exec(alert.title)?.[1] ??
    (alert.platform ? PLATFORM_NAMES[alert.platform] : undefined) ??
    alert.title
  )
}

/** The toast key per check: the clearing toast replaces the alert's (D3). */
export function watchdogToastId(alert: Pick<WatchdogAlert, 'check' | 'targetId'>): string {
  return alert.targetId ? `watchdog:${alert.check}:${alert.targetId}` : `watchdog:${alert.check}`
}
