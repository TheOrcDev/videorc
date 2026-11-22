// Plan 250 S7: devices and the app's own state as notifications. A device
// that came back, Videorc Camera, global shortcuts, the engine's lifecycle,
// and the small things Videorc does on its own (a window it closed for a
// recording, what an agent did on air).

import type { BackendLifecycleEvent } from '@/lib/backend'
import { OPEN_HEALTH_LABEL, openHealth } from '@/lib/health-door'
import { notifications } from '@/lib/notifications'
import type { NotificationStore } from '@/lib/notifications/store'
import type { NotificationAction } from '@/lib/notifications/types'
import { openOutputVideorcCamera } from '@/lib/section-doors'
import { openSettingsTab } from '@/lib/settings-tabs'
import { userErrorMessage } from '@/lib/user-error'
import { recordUserError } from '@/lib/user-error-log'

// --- Devices ----------------------------------------------------------------

export function sourceReturnKey(key: string): string {
  return `source-return:${key}`
}

/**
 * A source that was unplugged mid-session is connected again. The session
 * runs without it, so it counts; "Use it" switches to it.
 */
export function publishSourceReturn(
  key: string,
  deviceName: string,
  useIt: () => void,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: sourceReturnKey(key),
    kind: 'source-return',
    title: `${deviceName} is back`,
    detail: 'This session is running without it.',
    // Not bound to the session: the Studio takes it back when the session
    // ends, as it does when the device is used or unplugged.
    actions: [{ id: 'use-it', label: 'Use it', kind: 'fix', run: useIt }]
  })
}

/** Used, or unplugged again: the entry goes without a resolved row. */
export function withdrawSourceReturn(key: string, store: NotificationStore = notifications): void {
  store.withdraw(sourceReturnKey(key))
}

export const VIDEORC_CAMERA_KEY = 'videorc-camera'

export function publishVideorcCameraStopped(
  words: { title: string; description: string },
  store: NotificationStore = notifications
): void {
  store.publish({
    key: VIDEORC_CAMERA_KEY,
    kind: 'videorc-camera',
    title: words.title,
    detail: words.description,
    actions: [
      { id: 'open-output', label: 'Open Output', kind: 'door', run: openOutputVideorcCamera }
    ]
  })
}

export function resolveVideorcCamera(store: NotificationStore = notifications): void {
  store.resolve(VIDEORC_CAMERA_KEY, { title: 'Videorc Camera is back', was: 'It was stopped' })
}

export const GLOBAL_SHORTCUTS_KEY = 'global-shortcuts'

export function publishGlobalShortcutsProblem(
  words: { title: string; description: string },
  store: NotificationStore = notifications
): void {
  store.publish({
    key: GLOBAL_SHORTCUTS_KEY,
    kind: 'global-shortcuts',
    title: words.title,
    detail: words.description,
    actions: [
      {
        id: 'open-shortcuts',
        label: 'Open Shortcuts',
        kind: 'door',
        run: () => openSettingsTab('shortcuts')
      }
    ]
  })
}

export function resolveGlobalShortcuts(store: NotificationStore = notifications): void {
  store.resolve(GLOBAL_SHORTCUTS_KEY, { title: 'Global shortcuts registered' })
}

/** No key is set any more: the problem is gone without having been fixed. */
export function withdrawGlobalShortcuts(store: NotificationStore = notifications): void {
  store.withdraw(GLOBAL_SHORTCUTS_KEY)
}

// --- The engine -------------------------------------------------------------

export const BACKEND_KEY = 'backend'

/** F-014: a backend crash is said, never a zombie with a Ready badge. */
export function publishBackendLifecycle(
  event: Pick<BackendLifecycleEvent, 'state' | 'attempt'>,
  store: NotificationStore = notifications
): void {
  if (event.state === 'running') {
    store.resolve(BACKEND_KEY, { title: 'Videorc recovered', was: 'It was restarting' })
  } else if (event.state === 'restarting') {
    store.publish({
      key: BACKEND_KEY,
      kind: 'backend',
      title: 'Videorc is recovering',
      detail: `Restarting automatically (attempt ${event.attempt ?? 1})…`
    })
  } else if (event.state === 'failed' || event.state === 'lost') {
    store.publish({
      key: BACKEND_KEY,
      kind: 'backend',
      tone: 'urgent',
      title:
        event.state === 'failed' ? "Videorc can't recover on its own" : 'Videorc needs a restart',
      detail: 'Quit and reopen Videorc.'
    })
  }
}

const OPEN_HEALTH: NotificationAction = {
  id: 'open-health',
  label: OPEN_HEALTH_LABEL,
  kind: 'door',
  run: openHealth
}

/**
 * A backend `error` event: something failed that Videorc cannot explain. It
 * can repeat on every reconnect, so it is one counted entry.
 */
const BACKEND_ERROR_KEY = 'backend-error'
const BACKEND_ERROR_TITLE = 'Videorc hit a problem'

export function publishBackendError(store: NotificationStore = notifications): void {
  store.publish({
    key: BACKEND_ERROR_KEY,
    kind: 'backend-error',
    title: BACKEND_ERROR_TITLE,
    detail: 'Export a support bundle from Health if it repeats.',
    actions: [OPEN_HEALTH]
  })
}

/**
 * Something Videorc tried on its own failed (a read at launch, a reload, a
 * retry): nobody pressed anything, so it waits behind the bell. The same
 * failure again is one counted entry ("3 times."), never a second row.
 */
export function publishBackgroundProblem(
  words: { title: string; description?: string },
  store: NotificationStore = notifications
): void {
  store.publish({
    // A failure Videorc cannot explain joins the backend's own "Videorc hit a
    // problem": one cause, one entry.
    key:
      words.title === BACKEND_ERROR_TITLE ? BACKEND_ERROR_KEY : `background-problem:${words.title}`,
    kind: 'backend-error',
    title: words.title,
    detail: words.description,
    actions: [OPEN_HEALTH]
  })
}

export const CAPTIONS_KEY = 'captions'

/**
 * Live captions start on their own with a session (the Clips ring at launch
 * too), so a start that failed is an entry with its Retry, never a toast.
 */
export function publishCaptionsProblem(
  words: { title: string; description?: string },
  retry?: () => void,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: CAPTIONS_KEY,
    kind: 'captions',
    title: words.title,
    detail: words.description,
    actions: retry ? [{ id: 'retry', label: 'Retry', kind: 'fix', run: retry }] : []
  })
}

/** The session's output cannot carry caption pixels, so captions did not start. */
export function publishCaptionsOutputUnsupported(
  description: string | undefined,
  store: NotificationStore = notifications
): void {
  publishCaptionsProblem(
    {
      title: "Live captions can't start in this session",
      description: description ?? "The active output configuration can't carry caption pixels."
    },
    undefined,
    store
  )
}

/** The captions' own start failed: its words, recorded for support, with Retry. */
export function publishCaptionsStartFailure(
  error: unknown,
  retry: () => void,
  store: NotificationStore = notifications
): void {
  const context = { action: 'start', object: 'live captions' } as const
  const copy = userErrorMessage(error, context)
  if (copy.kind === 'canceled') return
  console.warn(`[captions] ${copy.title}:`, copy.raw || error)
  recordUserError(copy, error, context)
  publishCaptionsProblem({ title: copy.title, description: copy.description }, retry, store)
}

// --- What Videorc did on its own ---------------------------------------------

/** News with nothing to do: never a pop-up, never counted. */
export function publishAppNews(
  key: string,
  title: string,
  detail?: string,
  action?: NotificationAction,
  store: NotificationStore = notifications
): void {
  store.publish({
    key,
    kind: 'app-news',
    title,
    detail,
    actions: action ? [action] : [],
    once: true
  })
}

/** An agent did something on air (plan 233 D11): who, and where agents are set up. */
export function publishAgentNotice(
  id: string,
  title: string,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: id,
    kind: 'app-news',
    title,
    actions: [
      {
        id: 'open-settings',
        label: 'Open Settings',
        kind: 'door',
        run: () => openSettingsTab('remote')
      }
    ]
  })
}

export const OUTPUT_TOO_HEAVY_KEY = 'output-too-heavy'

/** A finished check found the chosen output too heavy: the lighter preset is one press. */
export function publishOutputTooHeavy(
  words: { title: string; description: string; actionLabel: string },
  apply: () => void,
  store: NotificationStore = notifications
): void {
  store.publish({
    key: OUTPUT_TOO_HEAVY_KEY,
    kind: 'output-too-heavy',
    title: words.title,
    detail: words.description,
    actions: [
      {
        id: 'use-preset',
        label: words.actionLabel,
        kind: 'fix',
        run: () => {
          apply()
          // The lighter output is chosen: nothing is left to say.
          store.clear(OUTPUT_TOO_HEAVY_KEY)
        }
      }
    ]
  })
}
