// Plan 250 S5: the session's `health` events as notifications. The table in
// `health-kinds.ts` says what each code does; this builds the entry (its
// words, its door, the session it ends with) and hands it to the store. It
// raises no toast: only an urgent entry pops up, through `pop-up.ts`.

import type { HealthEvent, RecordingStatus } from '@/lib/backend'
import { OPEN_HEALTH_LABEL, openHealth } from '@/lib/health-door'
import {
  HEALTH_SOURCE,
  healthKindFor,
  MICROPHONE_LOST_SOURCE,
  type HealthDoor
} from '@/lib/notifications/health-kinds'
import type { NotificationStore } from '@/lib/notifications/store'
import type { NotificationAction } from '@/lib/notifications/types'
import { revealInFileManagerLabel } from '@/lib/platform'
import {
  openLibraryRecording,
  openOutputRecordings,
  openSourcesSystemAudio,
  openStudioAudio
} from '@/lib/section-doors'
import {
  separateFileFailedToast,
  separateFileRoleFromMessage
} from '@/lib/separate-source-recordings-view'
import {
  activityIsLive,
  activitySavesRecording,
  sessionRuntimeNoticeTitle,
  type SessionRuntimeActivity,
  type SessionRuntimeNotice
} from '@/lib/session-runtime-notice'
import { openSettingsTab } from '@/lib/settings-tabs'
import { recordingStartupHealthToast } from '@/lib/studio-health'
import { requestSystemAudioResume } from '@/lib/system-audio'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

export interface HealthNotificationContext {
  /** The session the Studio is running, or last ran. */
  recording: Pick<RecordingStatus, 'sessionId' | 'state'>
}

/** A condition with no session id of its own still ends with the session. */
export const CURRENT_SESSION = 'session'

function sessionOf(event: Pick<HealthEvent, 'sessionId'>, context: HealthNotificationContext) {
  return event.sessionId ?? context.recording.sessionId ?? CURRENT_SESSION
}

function door(to: HealthDoor): NotificationAction {
  switch (to) {
    case 'health':
      return { id: 'open-health', label: OPEN_HEALTH_LABEL, kind: 'door', run: openHealth }
    case 'audio':
      return { id: 'open-audio', label: 'Open Audio', kind: 'door', run: openStudioAudio }
    case 'sources':
      return {
        id: 'open-sources',
        label: 'Open Sources',
        kind: 'door',
        run: () => openWorkspaceTab('sources')
      }
    case 'system-audio':
      return {
        id: 'open-sources',
        label: 'Open Sources',
        kind: 'door',
        run: openSourcesSystemAudio
      }
    case 'output':
      return { id: 'open-output', label: 'Open Output', kind: 'door', run: openOutputRecordings }
  }
}

const OPEN_PERMISSIONS: NotificationAction = {
  id: 'open-permissions',
  label: 'Open Permissions',
  kind: 'door',
  run: () => openSettingsTab('permissions')
}

function openInLibrary(sessionId: string | undefined): NotificationAction {
  return {
    id: 'open-library',
    label: 'Open in Library',
    kind: 'door',
    run: () => (sessionId ? openLibraryRecording(sessionId) : openWorkspaceTab('library'))
  }
}

export const SEPARATE_FILES_SHED_WORDS = {
  title: 'Separate files stopped so the main recording keeps up',
  description:
    'Your Mac fell behind encoding the separate files. The separate files keep what they recorded, and your Combined recording keeps going.'
} as const

export const DISK_FULL_WORDS = {
  title: 'Recording stopped: the recordings folder is full',
  description: 'The recording up to that point is kept. Free some space before you record again.'
} as const

/** The backend's line for a take that died on a full disk (`recording-disk-full`). */
export function isDiskFullMessage(message: string | undefined): boolean {
  return /ran out of space/.test(message ?? '')
}

function publishDiskFull(store: NotificationStore, sessionId: string | undefined): void {
  store.publish({
    key: `recording-failed:${sessionId ?? CURRENT_SESSION}`,
    kind: 'recording-failed',
    title: DISK_FULL_WORDS.title,
    detail: DISK_FULL_WORDS.description,
    actions: [door('output'), openInLibrary(sessionId)],
    once: true
  })
}

/**
 * One `health` event. Returns false for a code with no row, a silent one,
 * and one that needs its own function (a lost microphone, a quality notice).
 */
export function publishHealthEvent(
  store: NotificationStore,
  event: HealthEvent,
  context: HealthNotificationContext
): boolean {
  const row = healthKindFor(event.code)
  if (!row || row.effect === 'ignore') return false
  const sessionId = sessionOf(event, context)

  if (row.effect === 'open') {
    const urgent = row.urgentOnError === true && event.level === 'error'
    const to =
      // Screen capture that stopped for want of access opens Permissions.
      row.key === 'screen-capture' && event.permissionPane ? OPEN_PERMISSIONS : null
    const actions: NotificationAction[] =
      row.key === 'system-audio-echo'
        ? [
            { id: 'resume', label: 'Resume', kind: 'fix', run: requestSystemAudioResume },
            door('system-audio')
          ]
        : to
          ? [to]
          : row.door
            ? [door(row.door)]
            : []
    store.publish({
      key: row.key,
      kind: row.kind,
      source: row.source ?? HEALTH_SOURCE,
      ...(urgent ? { tone: 'urgent' as const } : {}),
      title: urgent && row.errorTitle ? row.errorTitle : row.title,
      detail: event.message,
      actions,
      sessionId
    })
    return true
  }

  if (row.effect === 'resolve') {
    for (const source of row.sources ?? [HEALTH_SOURCE]) {
      store.resolve(row.key, { source, title: row.title, ...(row.was ? { was: row.was } : {}) })
    }
    return true
  }

  if (row.effect === 'event') {
    store.publish({
      key: row.key,
      kind: row.kind,
      title: row.title,
      detail: row.detail ?? event.message,
      actions: row.door ? [door(row.door)] : []
    })
    return true
  }

  // The codes that need more than their row.
  if (event.code === 'recording-disk-full') {
    publishDiskFull(store, event.sessionId ?? context.recording.sessionId ?? undefined)
    return true
  }
  if (event.code === 'separate-source-recordings-role-failed') {
    const takeRunning =
      context.recording.sessionId === event.sessionId &&
      (context.recording.state === 'recording' || context.recording.state === 'streaming')
    const copy = separateFileFailedToast(event.message, takeRunning)
    const role = separateFileRoleFromMessage(event.message) ?? 'file'
    store.publish({
      key: `separate-file:${event.sessionId ?? 'take'}:${role}`,
      kind: 'separate-file',
      title: copy.title,
      detail: copy.description,
      actions: [door('health')],
      once: true
    })
    return true
  }
  if (event.code === 'separate-source-recordings-shed') {
    store.publish({
      key: `separate-files-shed:${event.sessionId ?? 'take'}`,
      kind: 'separate-file',
      title: SEPARATE_FILES_SHED_WORDS.title,
      detail: SEPARATE_FILES_SHED_WORDS.description,
      actions: [door('health')],
      once: true
    })
    return true
  }
  // What the session said at its start, and holds true until it ends.
  const startup = recordingStartupHealthToast(event)
  if (startup?.variant === 'warning') {
    store.publish({
      key: `session-notice:${event.code}`,
      kind: 'session-notice',
      title: startup.title,
      detail: startup.description,
      sessionId
    })
    return true
  }
  return false
}

/**
 * Plan 250 S9: the last word on each subject, from a session's stored
 * events (oldest first). A `health` event is sent once, so a renderer that
 * reloads mid-session, or reconnects after a gap, has missed what opened and
 * what cleared meanwhile. Only conditions are read: an open with no later
 * resolve is still open, and a resolve that was missed still resolves.
 * Things that happened once (a blip, a failed file) are not replayed.
 */
export function lastHealthWords(events: readonly HealthEvent[]): HealthEvent[] {
  const ordered = [...events].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)
  )
  /** The last event to touch each report, by subject and reporter. */
  const last = new Map<string, HealthEvent>()
  for (const event of ordered) {
    const row = healthKindFor(event.code)
    if (row?.effect === 'open') {
      last.set(`${row.key}\n${row.source ?? HEALTH_SOURCE}`, event)
    } else if (row?.effect === 'resolve') {
      for (const source of row.sources ?? [HEALTH_SOURCE]) last.set(`${row.key}\n${source}`, event)
    } else if (recordingStartupHealthToast(event)?.variant === 'warning') {
      last.set(`session-notice:${event.code}\n${HEALTH_SOURCE}`, event)
    }
  }
  // One event can be the last word on two reports: say it once, in order.
  return ordered.filter((event) => [...last.values()].includes(event))
}

/** Rebuilds the session's open conditions in the list from its stored events. */
export function rebuildHealthNotifications(
  store: NotificationStore,
  events: readonly HealthEvent[],
  context: HealthNotificationContext
): void {
  for (const event of lastHealthWords(events)) publishHealthEvent(store, event, context)
}

/** "This recording has dropped frames", once per recording. */
export function publishRecordingQuality(store: NotificationStore, event: HealthEvent): void {
  const sessionId = event.sessionId ?? undefined
  store.publish({
    key: `recording-quality:${sessionId ?? CURRENT_SESSION}`,
    kind: 'recording-quality',
    title: 'This recording has dropped frames',
    detail: event.message,
    actions: [openInLibrary(sessionId)],
    once: true
  })
}

type MicrophoneLossNotice = Extract<SessionRuntimeNotice, { kind: 'microphone-input-lost' }>

/**
 * A lost or silent input, in the session's own words (they change with the
 * activity and the phase). System audio alone keeps its mixer state and
 * raises nothing, as before.
 */
export function publishMicrophoneLoss(
  store: NotificationStore,
  notice: MicrophoneLossNotice
): void {
  if (notice.audioIssues?.every((issue) => issue.code === 'system-audio-lost')) return
  store.publish({
    key: 'microphone',
    kind: 'microphone',
    source: MICROPHONE_LOST_SOURCE,
    tone: 'urgent',
    title: sessionRuntimeNoticeTitle(notice),
    detail: notice.message,
    actions: [door('audio')],
    sessionId: notice.sessionId ?? CURRENT_SESSION
  })
}

type RecordingFailedNotice = Extract<SessionRuntimeNotice, { kind: 'recording-failed' }>

/** The take ended on its own: urgent, wherever the streamer is. */
export function publishRecordingFailure(
  store: NotificationStore,
  notice: RecordingFailedNotice
): void {
  const { sessionId } = notice
  if (isDiskFullMessage(notice.message)) {
    publishDiskFull(store, sessionId)
    return
  }
  const revealSession = window.videorc?.revealSession
  const saves = activitySavesRecording(notice.activity)
  store.publish({
    key: `recording-failed:${sessionId ?? CURRENT_SESSION}`,
    kind: 'recording-failed',
    title: sessionRuntimeNoticeTitle(notice),
    detail: notice.message,
    actions: saves
      ? [
          openInLibrary(sessionId),
          ...(sessionId && notice.outputPath && revealSession
            ? [
                {
                  id: 'reveal',
                  label: revealInFileManagerLabel(),
                  kind: 'fix' as const,
                  run: () => void revealSession(sessionId)
                }
              ]
            : [])
        ]
      : [],
    once: true
  })
}

/** The session's open problems end with it, and stay in the list as what happened. */
export function sessionEndedNotifications(
  store: NotificationStore,
  activity: SessionRuntimeActivity
): void {
  store.sessionEnded(activityIsLive(activity) ? 'livestream' : 'recording')
}
