// The stream watchdog's renderer side, loaded the first time an alert opens
// (plan 223 A5, A7, D2): the toasts keyed `watchdog:<check>` with the fix
// as their action, the clearing toast that replaces them, the system
// notification main shows when the Studio isn't in front, and the fixes,
// which run through the Studio's existing actions (`micUnmute`,
// `takeoverHide`, the pages) and never a new control of their own.

import type { BackendClient } from '@/backendClient'
import type { WatchdogAlert, WatchdogAlertFix, WatchdogSettings } from '@/lib/backend'
import { openHealth } from '@/lib/health-door'
import type { StudioActionSource } from '@/lib/studio-actions/studio-context'
import { toast } from '@/lib/toast'
import { toastUserError } from '@/lib/user-error'
import {
  watchdogClearedAlerts,
  watchdogClearedToast,
  watchdogNotificationWords,
  watchdogNotifyCandidates,
  watchdogOpenSeconds,
  watchdogToastId
} from '@/lib/watchdog-view'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

export interface WatchdogSurfaceDeps {
  client: BackendClient | null
  source: () => StudioActionSource | null
  /** Opens the Takeover list (assets) or the Scenes list (layouts). */
  openStudioPanel: (panel: 'assets' | 'layouts') => void
  /** The Studio page, where the one Audio section lives. */
  openStudio: () => void
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

/** The Livestream page saved new settings: forget the cached copy. */
export function noteWatchdogSettings(settings: WatchdogSettings): void {
  settingsCache = { at: Date.now(), settings }
}

/**
 * Called with each `watchdog.alerts` list after the first. Opens and
 * refreshes the toasts, replaces them with the clearing toast, and asks main
 * for the system notification on an open and on every repeat.
 */
export async function onWatchdogAlertsChanged(
  previous: readonly WatchdogAlert[],
  next: readonly WatchdogAlert[],
  deps: WatchdogSurfaceDeps
): Promise<void> {
  const before = new Map(previous.map((alert) => [alert.id, alert]))
  for (const alert of next) {
    if (alert.state === 'snoozed') continue
    const known = before.get(alert.id)
    const changed = !known || known.title !== alert.title || known.detail !== alert.detail
    if (!changed) continue
    const [fix] = alert.fixes ?? []
    const show =
      alert.severity === 'critical'
        ? toast.error
        : alert.severity === 'warning'
          ? toast.warning
          : toast.info
    show(alert.title, {
      id: watchdogToastId(alert),
      description: alert.detail,
      duration: alert.severity === 'notice' ? 8_000 : Infinity,
      ...(fix
        ? { action: { label: fix.label, onClick: () => void runWatchdogFix(alert, fix, deps) } }
        : {})
    })
  }
  for (const alert of watchdogClearedAlerts(previous, next)) {
    toast.success(watchdogClearedToast(alert), { id: watchdogToastId(alert) })
  }
  const candidates = watchdogNotifyCandidates(previous, next)
  if (candidates.length > 0 && (await systemNotificationsOn(deps.client))) {
    const now = Date.now()
    for (const alert of candidates) {
      const words = watchdogNotificationWords(alert)
      void window.videorc?.notifyWatchdog?.({
        alertId: alert.id,
        title: words.title,
        body: words.body,
        critical: alert.severity === 'critical',
        openSeconds: watchdogOpenSeconds(alert, now)
      })
    }
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
        deps.openStudio()
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
