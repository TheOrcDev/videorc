// The stream watchdog's renderer side, loaded the first time an alert opens
// (plan 223 A5, A7, D2): the system notification main shows when the Studio
// isn't in front, and the fixes, which run through the Studio's existing
// actions (`micUnmute`, `takeoverHide`, the pages) and never a new control
// of their own. Since plan 250 an alert is an entry behind the bell, not a
// toast.

import type { BackendClient } from '@/backendClient'
import type {
  WatchdogAlert,
  WatchdogAlertFix,
  WatchdogNoticeReason,
  WatchdogSettings
} from '@/lib/backend'
import { openHealth } from '@/lib/health-door'
import { openStudioAudio } from '@/lib/section-doors'
import type { StudioActionSource } from '@/lib/studio-actions/studio-context'
import { toast } from '@/lib/toast'
import { toastUserError } from '@/lib/user-error'
import {
  watchdogNotificationWords,
  watchdogNotifies,
  watchdogNotifyCandidates,
  watchdogOpenSeconds,
  watchdogStayedOpenDelayMs
} from '@/lib/watchdog-view'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

export interface WatchdogSurfaceDeps {
  client: BackendClient | null
  /**
   * The session streams (L5): a record-only session's silent microphone
   * (the 1064 adoption) is the recording's own notice, never a system
   * notification (plan 221 Q7).
   */
  live: () => boolean
  source: () => StudioActionSource | null
  /** Opens the Takeover list (assets) or the Scenes list (layouts). */
  openStudioPanel: (panel: 'assets' | 'layouts') => void
}

let settingsCache: { at: number; settings: WatchdogSettings } | null = null

async function systemNotificationsOn(client: BackendClient | null): Promise<boolean> {
  if (!client) return true
  if (settingsCache && Date.now() - settingsCache.at < 60_000) {
    return settingsCache.settings.systemNotifications
  }
  try {
    const settings = await client.requestTyped('watchdog.settings.get')
    settingsCache = { at: Date.now(), settings }
    return settings.systemNotifications
  } catch {
    return true
  }
}

/** The Destinations page saved new settings: forget the cached copy. */
export function noteWatchdogSettings(settings: WatchdogSettings): void {
  settingsCache = { at: Date.now(), settings }
}

/** The last list this surface saw, for the 60 s ask. */
let latestAlerts: readonly WatchdogAlert[] = []
/** The second asks (D2, D3) by alert id: a pending timer, or 'asked' once it fired. */
const stayedOpenAsks = new Map<string, number | 'asked'>()

async function askMain(alert: WatchdogAlert, reason: WatchdogNoticeReason, now: number) {
  const words = watchdogNotificationWords(alert)
  await window.videorc?.notifyWatchdog?.({
    alertId: alert.id,
    title: words.title,
    body: words.body,
    critical: alert.severity === 'critical',
    openSeconds: watchdogOpenSeconds(alert, now),
    reason
  })
}

/**
 * D2, D3: a second ask at since + 60 s for every warning and critical alert
 * still open then (a warning's first chance to notify; a critical one shows
 * over a focused Studio). Main applies the 60 s rule and never repeats what
 * the first ask showed.
 */
function scheduleStayedOpenAsk(alert: WatchdogAlert, deps: WatchdogSurfaceDeps, now: number) {
  if (stayedOpenAsks.has(alert.id)) return
  const timer = window.setTimeout(
    () => {
      stayedOpenAsks.set(alert.id, 'asked')
      const current = latestAlerts.find((candidate) => candidate.id === alert.id)
      if (!current || current.state !== 'open' || !deps.live()) return
      void systemNotificationsOn(deps.client).then((on) => {
        if (on) void askMain(current, 'stayed-open', Date.now())
      })
    },
    watchdogStayedOpenDelayMs(alert, now)
  )
  stayedOpenAsks.set(alert.id, timer)
}

function dropStayedOpenAsk(alertId: string) {
  const pending = stayedOpenAsks.get(alertId)
  if (pending === undefined) return
  if (pending !== 'asked') window.clearTimeout(pending)
  stayedOpenAsks.delete(alertId)
}

/**
 * Called with each `watchdog.alerts` list after the first. Asks main for
 * the system notification on an open and on every repeat. The alerts
 * themselves are entries behind the bell (plan 250,
 * `notifications/sources/watchdog.ts`), which pop up by the quiet rule;
 * this module raises no toast of its own.
 */
export async function onWatchdogAlertsChanged(
  previous: readonly WatchdogAlert[],
  next: readonly WatchdogAlert[],
  deps: WatchdogSurfaceDeps
): Promise<void> {
  latestAlerts = next
  const now = Date.now()
  for (const id of [...stayedOpenAsks.keys()]) {
    // Gone, hushed or seen: the second ask is off (it is never re-armed:
    // an alert that comes back comes back under a new id).
    if (next.find((candidate) => candidate.id === id)?.state !== 'open') dropStayedOpenAsk(id)
  }
  if (!deps.live()) return
  const candidates = watchdogNotifyCandidates(previous, next)
  if (candidates.length > 0 && (await systemNotificationsOn(deps.client))) {
    for (const { alert, reason } of candidates) {
      void askMain(alert, reason, now)
    }
  }
  for (const alert of next) {
    if (alert.state === 'open' && watchdogNotifies(alert)) scheduleStayedOpenAsk(alert, deps, now)
  }
}

/** One fix, through the Studio's own actions (D2: nothing new of its own). */
export async function runWatchdogFix(
  alert: WatchdogAlert,
  fix: WatchdogAlertFix,
  deps: WatchdogSurfaceDeps
): Promise<void> {
  try {
    switch (fix.kind) {
      case 'unmute':
      case 'end-takeover': {
        const source = deps.source()
        if (!source) return
        const actions = await import('@/lib/studio-actions')
        const context = actions.studioActionContext(source)
        const executor =
          actions.REMOTE_INTENT_EXECUTORS[fix.kind === 'unmute' ? 'micUnmute' : 'takeoverHide']
        const outcome = await executor?.(context, {})
        if (outcome && !outcome.ok && outcome.message) toast.warning(outcome.message)
        return
      }
      case 'show-brb':
        // The chosen takeover is the streamer's pick: open the Takeover list.
        deps.openStudioPanel('assets')
        return
      case 'switch-scene':
        // Re-applying the sources is the Scenes list's job.
        deps.openStudioPanel('layouts')
        return
      case 'open-audio':
        // The door, not the bare tab: the card sits on the Studio page, so
        // opening the tab alone changed nothing and the button looked dead
        // (silent-mic report, 2026-11-22). The door lands on the Microphone
        // row, with its meter and picker, on a page already open too.
        openStudioAudio()
        return
      case 'open-health':
        openHealth()
        return
      case 'open-livestream':
        openWorkspaceTab('live')
        return
      case 'open-platform-dashboard':
        if (fix.url) await window.videorc?.openChatLink?.(fix.url)
        return
      case 'reconnect-destination': {
        if (!deps.client || !alert.targetId) return
        await deps.client.requestTyped('cloud.show.reconnectDestination', {
          targetId: alert.targetId
        })
        return
      }
    }
  } catch (error) {
    toastUserError(error, { action: fix.label.toLowerCase() })
  }
}

export async function acknowledgeWatchdogAlert(
  client: BackendClient | null,
  alertId: string
): Promise<void> {
  if (!client) return
  try {
    await client.requestTyped('watchdog.alert.acknowledge', { id: alertId })
  } catch (error) {
    toastUserError(error, { action: 'acknowledge', object: 'the alert' })
  }
}

export async function snoozeWatchdogAlert(
  client: BackendClient | null,
  alertId: string,
  scope: 'ten-minutes' | 'stream'
): Promise<void> {
  if (!client) return
  try {
    await client.requestTyped('watchdog.alert.snooze', { id: alertId, scope })
  } catch (error) {
    toastUserError(error, { action: 'snooze', object: 'the alert' })
  }
}

/**
 * Mounted once by the Studio: the notification's click brings the Studio
 * forward, a fix pressed in the Stream Manager runs here (A6), and while
 * live the system's idle time reaches the backend every 30 s (still-there).
 */
export function mountWatchdogSurface(options: {
  client: BackendClient | null
  live: boolean
  alerts: () => readonly WatchdogAlert[]
  act: (alert: WatchdogAlert, fix: WatchdogAlertFix) => void
}): () => void {
  const api = window.videorc
  const offFocus = api?.onWatchdogFocus?.(() => openWorkspaceTab('studio'))
  const offFix = api?.onWatchdogFixRequest?.((request) => {
    const alert = options.alerts().find((candidate) => candidate.id === request.alertId)
    const fix = alert?.fixes?.find((candidate) => candidate.kind === request.kind)
    if (alert && fix) options.act(alert, fix)
  })
  let timer: number | null = null
  if (options.live && options.client) {
    const tick = (): void => void reportSystemIdle(options.client)
    tick()
    timer = window.setInterval(tick, 30_000)
  }
  return () => {
    offFocus?.()
    offFix?.()
    if (timer !== null) window.clearInterval(timer)
  }
}

/** Plan 223 `still-there`: main's idle time, once in a while, while live. */
export async function reportSystemIdle(client: BackendClient | null): Promise<void> {
  if (!client || !window.videorc?.getSystemIdleSeconds) return
  try {
    const idleSeconds = await window.videorc.getSystemIdleSeconds()
    await client.requestTyped('watchdog.idle.report', {
      idleSeconds: Math.max(0, Math.floor(idleSeconds))
    })
  } catch {
    // Telemetry only: never a toast.
  }
}
