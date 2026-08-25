import type {
  BackendLifecycleEvent,
  HealthEvent,
  RecordingStatus,
  SessionSummary
} from '@/lib/backend'
import {
  sessionRuntimeNoticeTitle,
  type SessionRuntimeActivity,
  type SessionRuntimeNotice
} from '@/lib/session-runtime-notice'
import { VIDEORC_PREMIUM_URL } from '@/lib/premium-upgrade'
import { recordingStartupHealthToast } from '@/lib/studio-health'
import { isTransientBackendError, shouldToastBackendError } from '@/lib/backend-transport'
import type { WsStatus } from '@/lib/capture'
import { toast } from 'sonner'

const WORKSPACE_NAVIGATE_EVENT = 'videorc:navigate-workspace'
const RECORDING_STOPPED_UNEXPECTEDLY_TOAST_ID = 'recording-stopped-unexpectedly'
const MICROPHONE_INPUT_LOST_TOAST_ID = 'microphone-input-lost'

type SessionRuntimeRecoveryPlan = {
  failureSessionId?: string
  failureSummary?: SessionSummary
  healthSessionId?: string
}

export type SessionRuntimeRecovery =
  | {
      kind: 'recording-failed'
      status: RecordingStatus
      activity: SessionRuntimeActivity
    }
  | { kind: 'microphone-input-lost'; event: HealthEvent }
  | null

export type RecordingFailurePresentation = {
  dedupeKey: string
  notice: Extract<SessionRuntimeNotice, { kind: 'recording-failed' }>
}

export type MicrophoneLossPresentation = {
  dedupeKey: string
  activity: SessionRuntimeActivity
  notice: Extract<SessionRuntimeNotice, { kind: 'microphone-input-lost' }>
}

export function sessionRuntimeContinuationIsCurrent(
  expectedEpoch: number,
  currentEpoch: number,
  expectedSessionId?: string,
  currentSessionId?: string
): boolean {
  return (
    expectedEpoch === currentEpoch && (!expectedSessionId || expectedSessionId === currentSessionId)
  )
}

function openLibrary(sessionId?: string): void {
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_NAVIGATE_EVENT, {
      detail: { tab: 'library', sessionId: sessionId ?? null }
    })
  )
}

export function recordingFailurePresentation({
  status,
  activity,
  fallbackSessionId,
  currentDedupeKey
}: {
  status: RecordingStatus
  activity: SessionRuntimeActivity
  fallbackSessionId?: string
  currentDedupeKey: string | null
}): RecordingFailurePresentation | null {
  const sessionId = status.sessionId ?? fallbackSessionId
  const dedupeKey = sessionId ?? 'active-session'
  if (currentDedupeKey === dedupeKey) return null
  const message =
    status.message ??
    (activity === 'live-stream'
      ? 'Videorc could not finish this live session.'
      : 'Videorc could not finish this recording.')
  return {
    dedupeKey,
    notice: {
      kind: 'recording-failed',
      activity,
      message,
      ...(sessionId ? { sessionId } : {}),
      ...(status.outputPath ? { outputPath: status.outputPath } : {}),
      at: Date.now()
    }
  }
}

export function showRecordingFailure({ notice }: RecordingFailurePresentation): void {
  const sessionId = notice.sessionId
  const revealSession = window.videorc?.revealSession
  toast.dismiss(MICROPHONE_INPUT_LOST_TOAST_ID)
  toast.error(sessionRuntimeNoticeTitle(notice), {
    id: RECORDING_STOPPED_UNEXPECTEDLY_TOAST_ID,
    description: notice.message,
    duration: Infinity,
    ...(notice.activity === 'recording'
      ? {
          action: {
            label: 'Open Library',
            onClick: () => openLibrary(sessionId)
          }
        }
      : {}),
    ...(notice.activity === 'recording' && sessionId && notice.outputPath && revealSession
      ? {
          cancel: {
            label: 'Show in Finder',
            onClick: () => void revealSession(sessionId)
          }
        }
      : {})
  })
}

export function microphoneLossPresentation({
  event,
  recording,
  lastSessionId,
  lastActivity,
  currentDedupeKey
}: {
  event: HealthEvent
  recording: RecordingStatus
  lastSessionId?: string
  lastActivity: SessionRuntimeActivity
  currentDedupeKey: string | null
}): MicrophoneLossPresentation | null {
  const active = ['recording', 'streaming'].includes(recording.state)
  const correlatedActive = active && (!event.sessionId || event.sessionId === recording.sessionId)
  const correlatedTerminal =
    Boolean(event.sessionId) &&
    event.sessionId === lastSessionId &&
    ['stopping', 'idle'].includes(recording.state)
  if (!correlatedActive && !correlatedTerminal) return null

  const dedupeKey = event.sessionId ?? lastSessionId ?? 'active-session'
  if (currentDedupeKey === dedupeKey) return null
  const activity: SessionRuntimeActivity =
    recording.state === 'streaming'
      ? 'live-stream'
      : recording.state === 'recording'
        ? 'recording'
        : lastActivity
  return {
    dedupeKey,
    activity,
    notice: {
      kind: 'microphone-input-lost',
      activity,
      phase: active ? 'active' : recording.state === 'stopping' ? 'ending' : 'ended',
      message: event.message,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      at: Date.now()
    }
  }
}

export function showMicrophoneLoss({ notice }: MicrophoneLossPresentation): void {
  toast.warning(sessionRuntimeNoticeTitle(notice), {
    id: MICROPHONE_INPUT_LOST_TOAST_ID,
    description: notice.message,
    duration: Infinity
  })
}

export function showBackendLifecycle(event: BackendLifecycleEvent): void {
  if (event.state === 'restarting') {
    toast.warning('Backend crashed', {
      id: 'backend-lifecycle',
      description: `Restarting automatically (attempt ${event.attempt ?? 1})…`
    })
  } else if (event.state === 'failed') {
    toast.error('Backend crashed repeatedly', {
      id: 'backend-lifecycle',
      description: 'Automatic restarts stopped. Restart Videorc to recover.',
      duration: Infinity
    })
  } else if (event.state === 'lost') {
    toast.error('Backend shutdown could not be confirmed', {
      id: 'backend-lifecycle',
      description: 'A replacement was not started. Quit and reopen Videorc to recover safely.',
      duration: Infinity
    })
  }
}

export function showBackendError(message: string, status: WsStatus): void {
  // Permission grants intentionally restart the backend. During that brief
  // reconnect window the Session badge already explains the state, so avoid a
  // wall of duplicate transport errors. A connected-state blip stays visible.
  if (!shouldToastBackendError(message, status)) return
  toast.error(message, isTransientBackendError(message) ? { id: 'backend-transport' } : undefined)
}

export function showSessionFinished({
  status,
  lastSessionId,
  activity,
  currentNotice,
  replaceNotice
}: {
  status: RecordingStatus
  lastSessionId?: string
  activity: SessionRuntimeActivity
  currentNotice: SessionRuntimeNotice | null
  replaceNotice: (notice: SessionRuntimeNotice) => void
}): void {
  if (currentNotice?.kind === 'microphone-input-lost' && currentNotice.phase !== 'ended') {
    const endedNotice: SessionRuntimeNotice = { ...currentNotice, phase: 'ended' }
    replaceNotice(endedNotice)
    toast.warning(sessionRuntimeNoticeTitle(endedNotice), {
      id: MICROPHONE_INPUT_LOST_TOAST_ID,
      description: endedNotice.message,
      duration: Infinity
    })
  }
  if (activity !== 'recording') return

  const sessionId = status.sessionId ?? lastSessionId
  const openFinishedRecording = (): void => {
    if (!sessionId || !window.videorc?.openSession) {
      openLibrary(sessionId)
      return
    }
    void window.videorc.openSession(sessionId).then((problem) => {
      if (problem) openLibrary(sessionId)
    })
  }
  toast.success('Recording saved', {
    action: { label: 'Play', onClick: openFinishedRecording },
    cancel: { label: 'Open in Library', onClick: () => openLibrary(sessionId) },
    duration: 12_000
  })
}

export function showSessionHealthEvent(
  event: HealthEvent,
  qualityToastAlreadyShown: boolean
): string | null {
  const startupToast = recordingStartupHealthToast(event)
  if (startupToast) {
    const show = startupToast.variant === 'warning' ? toast.warning : toast.error
    show(startupToast.title, {
      id: startupToast.id,
      description: startupToast.description,
      duration: startupToast.duration
    })
  }

  if (event.code.startsWith('recording-quality-')) {
    if (event.code !== 'recording-quality-not-100' || event.level !== 'warn') return null
    const dedupeKey = event.sessionId ?? event.message
    if (qualityToastAlreadyShown) return null
    toast.warning('Recording is not 100%', {
      description: event.message,
      duration: 15_000,
      action: { label: 'Open Library', onClick: () => openLibrary(event.sessionId ?? undefined) }
    })
    return dedupeKey
  }
  if (event.code === 'mic-silent') {
    const show = event.level === 'error' ? toast.error : toast.warning
    show(event.level === 'error' ? 'Recording has no sound' : 'Microphone is silent', {
      description: event.message,
      duration: 15_000
    })
  }
  return null
}

export function showNoiseCleanupCompleted(jobId: string, outputSessionId: string): void {
  toast.success('Noise cleanup complete', {
    id: `noise-cleanup-completed-${jobId}`,
    description: 'A separate cleaned copy is ready. The original was not changed.',
    duration: 15_000,
    action: {
      label: 'Play',
      onClick: () => {
        const openSession = window.videorc?.openSession
        if (!openSession) return
        void openSession(outputSessionId).then((problem) => {
          if (problem) toast.error(problem)
        })
      }
    },
    cancel: {
      label: 'Show in Finder',
      onClick: () => void window.videorc?.revealSession?.(outputSessionId)
    }
  })
}

export function showPremiumUpgrade(title: string, description?: string): void {
  const openPremiumUpgradePage = (): void => {
    const opener = window.videorc?.openOAuthUrl
    if (opener) {
      void opener(VIDEORC_PREMIUM_URL)
      return
    }
    window.open(VIDEORC_PREMIUM_URL, '_blank', 'noopener,noreferrer')
  }
  toast.error(title, {
    description,
    duration: 15_000,
    action: { label: 'View Premium', onClick: openPremiumUpgradePage }
  })
}

export function showSourceFallbackActiveSession(state: RecordingStatus['state']): void {
  toast.warning(
    state === 'streaming'
      ? 'Source changed while streaming. Check the output before continuing.'
      : 'Source changed while recording. Check the output before continuing.',
    { duration: 10_000, id: 'source-reconciliation:active-session' }
  )
}

function latestMatchingEvent(
  events: HealthEvent[],
  matches: (event: HealthEvent) => boolean
): HealthEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event && matches(event)) return event
  }
  return undefined
}

export function sessionRuntimeRecoveryPlan({
  recording,
  sessions,
  priorSessionId,
  priorSessionState
}: {
  recording: RecordingStatus
  sessions: SessionSummary[]
  priorSessionId?: string
  priorSessionState: RecordingStatus['state']
}): SessionRuntimeRecoveryPlan {
  const priorSessionWasActive = ['recording', 'streaming', 'stopping'].includes(priorSessionState)
  const currentSessionOwnsRuntime = ['recording', 'streaming', 'stopping'].includes(recording.state)
  const priorSessionCanBeRecovered =
    !currentSessionOwnsRuntime || recording.sessionId === priorSessionId
  const missedFailureSummary =
    priorSessionWasActive && priorSessionId && priorSessionCanBeRecovered
      ? sessions.find((session) => session.id === priorSessionId && session.status === 'failed')
      : undefined
  const authoritativeFailureSummary =
    recording.state === 'failed' && recording.sessionId
      ? sessions.find(
          (session) => session.id === recording.sessionId && session.status === 'failed'
        )
      : undefined
  const failureSummary = authoritativeFailureSummary ?? missedFailureSummary
  const failureSessionId =
    recording.state === 'failed'
      ? (recording.sessionId ??
        failureSummary?.id ??
        (priorSessionWasActive ? priorSessionId : undefined))
      : missedFailureSummary?.id
  const activeSessionSummary =
    currentSessionOwnsRuntime && recording.sessionId
      ? sessions.find((session) => session.id === recording.sessionId)
      : undefined

  return {
    failureSessionId,
    failureSummary,
    healthSessionId:
      failureSessionId ??
      ((activeSessionSummary?.healthEventCount ?? 0) > 0 ? activeSessionSummary?.id : undefined)
  }
}

export function completeSessionRuntimeRecovery({
  plan,
  recording,
  events,
  priorSessionState
}: {
  plan: SessionRuntimeRecoveryPlan
  recording: RecordingStatus
  events: HealthEvent[]
  priorSessionState: RecordingStatus['state']
}): SessionRuntimeRecovery {
  if (plan.failureSessionId) {
    const latestFailure = latestMatchingEvent(events, (event) => event.level === 'error')
    const outputPath = recording.outputPath ?? plan.failureSummary?.outputPath
    const message =
      (recording.state === 'failed' ? recording.message : undefined) ?? latestFailure?.message
    return {
      kind: 'recording-failed',
      status: {
        ...(recording.state === 'failed' ? recording : { state: 'failed' }),
        sessionId: plan.failureSessionId,
        ...(outputPath ? { outputPath } : {}),
        ...(message ? { message } : {})
      },
      activity: ['stream', 'streaming'].includes(plan.failureSummary?.mode.toLowerCase() ?? '')
        ? 'live-stream'
        : plan.failureSummary || priorSessionState !== 'streaming'
          ? 'recording'
          : 'live-stream'
    }
  }

  const microphoneLoss = latestMatchingEvent(
    events,
    (event) => event.code === 'microphone-input-lost'
  )
  return microphoneLoss ? { kind: 'microphone-input-lost', event: microphoneLoss } : null
}

export async function recoverSessionRuntime({
  recording,
  sessions,
  priorSessionId,
  priorSessionState,
  loadHealthEvents
}: {
  recording: RecordingStatus
  sessions: SessionSummary[]
  priorSessionId?: string
  priorSessionState: RecordingStatus['state']
  loadHealthEvents: (sessionId: string) => Promise<HealthEvent[]>
}): Promise<SessionRuntimeRecovery> {
  const plan = sessionRuntimeRecoveryPlan({
    recording,
    sessions,
    ...(priorSessionId ? { priorSessionId } : {}),
    priorSessionState
  })
  const events = plan.healthSessionId
    ? await loadHealthEvents(plan.healthSessionId).catch(() => [])
    : []
  return completeSessionRuntimeRecovery({ plan, recording, events, priorSessionState })
}
