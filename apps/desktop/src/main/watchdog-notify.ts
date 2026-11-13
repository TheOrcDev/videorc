// The stream watchdog's system notification (plan 223 A7, D2, D3). The
// renderer asks when an alert opens, again at since + 60 s while it is still
// open, and on each repeat; main decides from what only it knows: whether
// the Studio is the front window. D3's timing: a critical alert notifies at
// once when the Studio is not in front, and once it has stayed open 60 s
// even when it is; a warning notifies after 60 s open, and only when the
// Studio is not in front (D2); the second ask never repeats a notification
// the first already showed. A click brings the Studio forward and focuses
// the card; it never runs the fix (a notification click is too easy to make
// by accident). Pure decision here, Electron at the edge, like updater.ts.

import type { WatchdogNotice } from '../shared/backend'

/** After this long open, a critical alert notifies even a focused Studio, and a warning at all. */
export const CRITICAL_NOTIFIES_FOCUSED_AFTER_SECONDS = 60
export const NOTIFIES_AFTER_OPEN_SECONDS = CRITICAL_NOTIFIES_FOCUSED_AFTER_SECONDS

/** The same alert id is not shown twice inside this window (a repeat is minutes apart). */
export const NOTIFY_DEDUPE_MS = 30_000

export interface WatchdogNotifyInput {
  notice: WatchdogNotice
  /** The main window is focused: the card is on screen already. */
  mainFocused: boolean
  /** The Livestream page's "System notifications" switch (D7). */
  enabled: boolean
  /** `Notification.isSupported()`. */
  supported: boolean
  /** When this alert id was last shown, if it was. */
  lastShownAt: number | null
  now: number
}

export type WatchdogNotifyDecision =
  | { show: true; title: string; body: string }
  | {
      show: false
      reason: 'off' | 'unsupported' | 'focused' | 'duplicate' | 'too-soon' | 'shown'
    }

export function watchdogNotifyDecision(input: WatchdogNotifyInput): WatchdogNotifyDecision {
  if (!input.enabled) return { show: false, reason: 'off' }
  if (!input.supported) return { show: false, reason: 'unsupported' }
  if (
    input.lastShownAt !== null &&
    input.now - input.lastShownAt < NOTIFY_DEDUPE_MS &&
    input.now >= input.lastShownAt
  ) {
    return { show: false, reason: 'duplicate' }
  }
  const { critical, openSeconds } = input.notice
  const stayedOpen = openSeconds >= NOTIFIES_AFTER_OPEN_SECONDS
  const show = { show: true as const, title: input.notice.title, body: input.notice.body }
  switch (input.notice.reason) {
    case 'opened':
      // D3: critical at once, when the Studio is not in front; a warning
      // waits for the 60 s ask.
      if (!critical) return { show: false, reason: 'too-soon' }
      return input.mainFocused ? { show: false, reason: 'focused' } : show
    case 'stayed-open':
      // The second ask at since + 60 s: never a second notification for
      // what the first ask showed.
      if (input.lastShownAt !== null) return { show: false, reason: 'shown' }
      if (!stayedOpen) return { show: false, reason: 'too-soon' }
      // D2: a critical alert open 60 s shows over a focused Studio; a
      // warning shows only when the Studio is not in front.
      if (critical || !input.mainFocused) return show
      return { show: false, reason: 'focused' }
    case 'repeat':
      if (!input.mainFocused || (critical && stayedOpen)) return show
      return { show: false, reason: 'focused' }
  }
}

/** Per-process memory of what was shown, keyed by alert id. */
export class WatchdogNotifyLedger {
  private shown = new Map<string, number>()

  lastShownAt(alertId: string): number | null {
    return this.shown.get(alertId) ?? null
  }

  mark(alertId: string, now: number): void {
    this.shown.set(alertId, now)
    // A long stream opens many alerts; keep the map small.
    if (this.shown.size > 200) {
      const oldest = [...this.shown.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100)
      for (const [id] of oldest) this.shown.delete(id)
    }
  }
}
