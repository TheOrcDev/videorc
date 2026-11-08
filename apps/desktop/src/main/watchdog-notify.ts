// The stream watchdog's system notification (plan 223 A7, D3). The renderer
// asks on an alert's open and on each repeat; main decides from what only
// it knows: whether the Studio is the front window. A critical alert that
// has stayed open 60 s shows even when the Studio is focused. A click brings
// the Studio forward and focuses the card; it never runs the fix (a
// notification click is too easy to make by accident). Pure decision here,
// Electron at the edge, like updater.ts.

import type { WatchdogNotice } from '../shared/backend'

/** After this long open, a critical alert notifies even a focused Studio. */
export const CRITICAL_NOTIFIES_FOCUSED_AFTER_SECONDS = 60

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
  | { show: false; reason: 'off' | 'unsupported' | 'focused' | 'duplicate' }

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
  const stayedOpen =
    input.notice.critical && input.notice.openSeconds >= CRITICAL_NOTIFIES_FOCUSED_AFTER_SECONDS
  if (input.mainFocused && !stayedOpen) return { show: false, reason: 'focused' }
  return { show: true, title: input.notice.title, body: input.notice.body }
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
