import type {
  AutomaticSourceFallbackEvent,
  BackendLifecycleEvent,
  HealthEvent,
  OAuthCallbackResult,
  RecordingStatus,
  SessionSummary,
  XPlaybackEvent
} from '@/lib/backend'
import {
  activityIsLive,
  activitySavesRecording,
  sessionRuntimeNoticeTitle,
  type SessionRuntimeActivity,
  type SessionRuntimeNotice
} from '@/lib/session-runtime-notice'
import { sessionActivity, sessionIsLive } from '../../../shared/capture-state'
import { revealInFileManagerLabel } from '@/lib/platform'
import { VIDEORC_PREMIUM_URL } from '@/lib/premium-upgrade'
import { recordingStartupHealthToast } from '@/lib/studio-health'
import { requestSystemAudioResume, SYSTEM_AUDIO_ECHO_TOAST_ID } from '@/lib/system-audio'
import { shouldToastBackendError } from '@/lib/backend-transport'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import { OFFLINE_TOAST_ID, userErrorMessage, type UserErrorContext } from '@/lib/user-error'
import type { WsStatus } from '@/lib/capture'
import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'
import { notifyOnce } from '@/lib/notify-once'
import { toast } from '@/lib/toast'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import type { StreamPlatform, YouTubeQuotaStatus } from '@/lib/backend'
import {
  youtubeBroadcastToast,
  youtubeBudgetNotice,
  youtubeBudgetStepToAnnounce,
  youtubeConnectPausedMessage
} from '@/lib/youtube-quota-copy'

// Plan 083: the thumbnail warning rides this lazy runtime-toast chunk.
export { showYouTubeThumbnailFailure, youtubeThumbnailFailure } from '@/lib/youtube-thumbnail-toast'
// Plan 094: so does every piece of YouTube quota copy the Studio provider shows.
export { youtubeGoLivePausedMessage } from '@/lib/youtube-quota-copy'

/** "Couldn't start/end the YouTube broadcast." with the destination named only when it adds something. */
export function showYouTubeBroadcastToast(
  step: 'start' | 'end',
  target: { id: string; label: string; platform: StreamPlatform },
  message: string
): void {
  const broadcastToast = youtubeBroadcastToast(step, target, message)
  toast.warning(broadcastToast.title, {
    id: `youtube-broadcast-${step}:${target.id}`,
    description: broadcastToast.description
  })
}

/** One quiet notice per daily-budget step reached (plan 094, S6), never on the way down. */
export function showYouTubeBudgetStep(
  previous: YouTubeQuotaStatus | null | undefined,
  status: YouTubeQuotaStatus
): void {
  const reached = youtubeBudgetStepToAnnounce(previous, status)
  const notice = reached ? youtubeBudgetNotice(reached) : null
  if (!reached || !notice) return
  notifyOnce(`youtube-budget:${reached}`, 'info', notice.title, {
    description: notice.description
  })
}

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
  openWorkspaceTab('library', sessionId)
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
    (activityIsLive(activity)
      ? 'Videorc could not finish this livestream.'
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
    ...(activitySavesRecording(notice.activity)
      ? {
          action: {
            label: 'Open in Library',
            onClick: () => openLibrary(sessionId)
          }
        }
      : {}),
    ...(activitySavesRecording(notice.activity) && sessionId && notice.outputPath && revealSession
      ? {
          cancel: {
            label: revealInFileManagerLabel(),
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
  currentDedupeKey,
  currentNotice
}: {
  event: HealthEvent
  recording: RecordingStatus
  lastSessionId?: string
  lastActivity: SessionRuntimeActivity
  currentDedupeKey: string | null
  currentNotice?: SessionRuntimeNotice | null
}): MicrophoneLossPresentation | null {
  const active = ['recording', 'streaming'].includes(recording.state)
  const correlatedActive = active && (!event.sessionId || event.sessionId === recording.sessionId)
  const correlatedTerminal =
    Boolean(event.sessionId) &&
    event.sessionId === lastSessionId &&
    ['stopping', 'idle'].includes(recording.state)
  if (!correlatedActive && !correlatedTerminal) return null

  const dedupeKey = event.sessionId ?? lastSessionId ?? 'active-session'
  const previousIssues =
    currentNotice?.kind === 'microphone-input-lost' && currentNotice.sessionId === event.sessionId
      ? (currentNotice.audioIssues ?? [
          { code: 'microphone-input-lost', message: currentNotice.message }
        ])
      : []
  if (
    previousIssues.some(
      (issue) => issue.code === event.code || issue.code === 'audio-inputs-lost'
    ) ||
    (currentDedupeKey === dedupeKey && !currentNotice)
  )
    return null
  const audioIssues = [...previousIssues, { code: event.code, message: event.message }]

  // Go Live reports `recording` with a stream URL: still a live session.
  const activity: SessionRuntimeActivity = active ? sessionActivity(recording) : lastActivity
  return {
    dedupeKey,
    activity,
    notice: {
      kind: 'microphone-input-lost',
      activity,
      phase: active ? 'active' : recording.state === 'stopping' ? 'ending' : 'ended',
      message: audioIssues.map((issue) => issue.message).join(' '),
      audioIssues,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      at: Date.now()
    }
  }
}

export function showMicrophoneLoss({ notice }: MicrophoneLossPresentation): void {
  // System-only failures already have a persistent mixer state; keep the existing no-toast policy.
  if (notice.audioIssues?.every((issue) => issue.code === 'system-audio-lost')) return
  toast.warning(sessionRuntimeNoticeTitle(notice), {
    id: MICROPHONE_INPUT_LOST_TOAST_ID,
    description: notice.message,
    duration: Infinity
  })
}

export function showBackendLifecycle(event: BackendLifecycleEvent): void {
  if (event.state === 'restarting') {
    toast.warning('Videorc is recovering', {
      id: 'backend-lifecycle',
      description: `Restarting automatically (attempt ${event.attempt ?? 1})…`
    })
  } else if (event.state === 'failed') {
    toast.error("Videorc can't recover on its own", {
      id: 'backend-lifecycle',
      description: 'Quit and reopen Videorc.',
      duration: Infinity
    })
  } else if (event.state === 'lost') {
    toast.error('Videorc needs a restart', {
      id: 'backend-lifecycle',
      description: 'Quit and reopen Videorc.',
      duration: Infinity
    })
  }
}

export function showBackendError(
  error: unknown,
  status: WsStatus,
  context?: UserErrorContext
): void {
  const message = ipcErrorMessage(error)
  // Permission grants intentionally restart the backend. During that brief
  // reconnect window the Session badge already explains the state, so avoid a
  // wall of duplicate transport errors. A connected-state blip stays visible.
  if (!shouldToastBackendError(message, status)) return
  // Plan 174 S2.4: what failed and what to do, never the raw text; that goes
  // to the console and the support bundle.
  const copy = userErrorMessage(error, context)
  if (copy.kind === 'canceled') return
  console.warn(`[backend-error] ${copy.title}:`, message)
  if (copy.kind === 'offline') {
    const show = copy.tone === 'warning' ? toast.warning : toast.error
    show(copy.title, { id: OFFLINE_TOAST_ID, description: copy.description })
  } else {
    notifyOnce(`backend-error:${copy.title}:${message}`, copy.tone, copy.title, {
      description: copy.description
    })
  }
}

export function showXPlaybackEvent(event: XPlaybackEvent): void {
  // One toast per playback state: the backend re-checks on a timer.
  if (event.status === 'verified') {
    notifyOnce('x-playback', 'success', 'Viewers can watch your X broadcast.', {
      description: event.shareUrl
    })
  } else if (event.status === 'pending') {
    notifyOnce('x-playback', 'warning', 'X is still preparing your stream', {
      description:
        'Viewers may see a loading spinner for a few minutes. Keep streaming. Videorc keeps checking.'
    })
  } else {
    notifyOnce('x-playback', 'error', 'X never showed your stream', {
      description:
        'Viewers saw a loading spinner. Your local recording is unaffected; the next Go Live uses a replacement source if this repeats.'
    })
  }
}

/**
 * One toast per connect incident (plan 094, S3): every result for a platform
 * shares `oauth-callback:{platform}`, so the renderer's retries update it in
 * place instead of stacking (the owner saw about 35 "OAuth callback failed."
 * toasts in one connect). The platform of the last result is remembered so
 * the exhaust toast lands on the same id.
 */
let lastOAuthCallbackPlatform: string = 'provider'

export function oauthCallbackToastId(platform?: string): string {
  return `oauth-callback:${platform ?? 'provider'}`
}

export function showOAuthCallbackResult(result: OAuthCallbackResult): void {
  const platform = result.platform ?? 'provider'
  lastOAuthCallbackPlatform = platform
  const id = oauthCallbackToastId(result.platform)
  const platformName = result.platform ? CHAT_PLATFORM_LABELS[result.platform] : 'the account'
  if (result.status === 'success' && result.accountConnected) {
    toast.success(result.platform ? `Connected ${platformName}` : 'Account connected', { id })
  } else if (result.status === 'success' && result.platform === 'x' && result.tokenStored) {
    toast.success('X Live is on', { id })
  } else if (result.status === 'success') {
    // Plan 174 S2.4 (J2-11): a step on the way, not news. The approve toast
    // goes; the connected one follows.
    toast.dismiss(id)
  } else {
    const description =
      result.reason === 'youtube-quota' && result.retryAt
        ? youtubeConnectPausedMessage(result.retryAt)
        : (result.message ?? result.status ?? 'Connection could not be completed.')
    toast.error(`Couldn't finish connecting ${platformName}.`, { id, description })
  }
}

/** The renderer gave up retrying a provider callback (same id as the results). */
export function showOAuthCallbackExhausted(): void {
  const platformName = platformLabelOrAccount(lastOAuthCallbackPlatform)
  console.warn('[oauth] callback retries exhausted; kept unacknowledged')
  toast.error(`Couldn't finish connecting ${platformName}.`, {
    id: oauthCallbackToastId(lastOAuthCallbackPlatform),
    description: `Connect ${platformName} again from Livestream → Setup.`,
    action: { label: 'Open Livestream', onClick: () => openWorkspaceTab('live') }
  })
}

function platformLabelOrAccount(platform: string): string {
  return platform in CHAT_PLATFORM_LABELS
    ? CHAT_PLATFORM_LABELS[platform as keyof typeof CHAT_PLATFORM_LABELS]
    : 'the account'
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
  if (!activitySavesRecording(activity)) return

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
    toast.warning('This recording has dropped frames', {
      description: event.message,
      duration: 15_000,
      action: { label: 'Open in Library', onClick: () => openLibrary(event.sessionId ?? undefined) }
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
  showSessionAudioNews(event)
  showLiveOutputNews(event)
  return null
}

const STREAM_OUTPUT_TOAST_ID = 'stream-output'
const SCREEN_CAPTURE_TOAST_ID = 'screen-capture'

/**
 * Plan 087: what happens to the live output mid-session. Until 0.9.125 a dead
 * stream was reported only when the session stopped, so the streamer kept
 * presenting to nothing. Each pair shares a key: the good news replaces the
 * bad news instead of stacking beside it.
 */
function showLiveOutputNews(event: HealthEvent): void {
  if (event.code === 'stream-output-failed') {
    toast.error('Your stream stopped', {
      id: STREAM_OUTPUT_TOAST_ID,
      description: event.message,
      duration: Infinity
    })
  } else if (event.code === 'stream-output-stalled') {
    toast.warning('Your stream is frozen', {
      id: STREAM_OUTPUT_TOAST_ID,
      description: event.message,
      duration: Infinity
    })
  } else if (event.code === 'stream-output-resumed') {
    toast.success('Your stream is moving again', {
      id: STREAM_OUTPUT_TOAST_ID,
      description: event.message,
      duration: 8_000
    })
  } else if (event.code === 'screen-capture-stopped') {
    const show = event.level === 'error' ? toast.error : toast.warning
    show('Screen capture stopped', {
      id: SCREEN_CAPTURE_TOAST_ID,
      description: event.message,
      duration: event.level === 'error' ? Infinity : 20_000
    })
  } else if (event.code === 'screen-capture-restored') {
    toast.success('Screen capture is back', {
      id: SCREEN_CAPTURE_TOAST_ID,
      description: event.message,
      duration: 8_000
    })
  } else if (event.code === 'host-overloaded') {
    toast.warning('This computer is overloaded', {
      id: 'host-overloaded',
      description: event.message,
      duration: 20_000
    })
  }
}

/**
 * Plan 076: what the audio bus reports mid-session. An echo pause stays up
 * until it is resumed (a live loop repeats every word); a stall and a
 * recovered microphone are news the interface shows nowhere else.
 */
function showSessionAudioNews(event: HealthEvent): void {
  if (event.code === 'system-audio-echo-paused') {
    toast.warning('System audio paused: your stream was echoing', {
      id: SYSTEM_AUDIO_ECHO_TOAST_ID,
      description: event.message,
      duration: Infinity,
      action: { label: 'Resume', onClick: requestSystemAudioResume }
    })
  } else if (event.code === 'audio-output-stalled') {
    notifyOnce('audio-output-stalled', 'warning', 'Audio dropped for a moment', {
      description: event.message,
      duration: 12_000
    })
  } else if (event.code === 'microphone-timeline-recovered') {
    notifyOnce('microphone-timeline-recovered', 'success', 'Microphone is back', {
      description: event.message,
      duration: 8_000
    })
  }
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
          if (problem) showPlaybackProblem(outputSessionId, problem)
        })
      }
    },
    cancel: {
      label: revealInFileManagerLabel(),
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
  // Plan 174 S2.4: a plan limit is news about Premium, not a failure.
  toast.info(title, {
    description,
    duration: 15_000,
    action: { label: 'View Premium', onClick: openPremiumUpgradePage }
  })
}

/** "Couldn't play this recording": the reason, and where the file is. */
export function showPlaybackProblem(sessionId: string, problem: string): void {
  const revealSession = window.videorc?.revealSession
  toast.error("Couldn't play this recording", {
    id: `playback-problem:${sessionId}`,
    description: problem,
    ...(revealSession
      ? {
          action: {
            label: revealInFileManagerLabel(),
            onClick: () => void revealSession(sessionId)
          }
        }
      : {})
  })
}

const SOURCE_FALLBACK_NOUNS: Record<AutomaticSourceFallbackEvent['sourceKind'], string> = {
  capture: 'Screen',
  camera: 'Camera',
  microphone: 'Microphone'
}

/** Pure. "Camera switched to FaceTime HD Camera", or "Camera turned off". */
export function sourceFallbackTitle(event: AutomaticSourceFallbackEvent | undefined): string {
  if (!event) return 'A source changed'
  const noun = SOURCE_FALLBACK_NOUNS[event.sourceKind] ?? 'A source'
  const name = event.nextName?.trim()
  if (name) return `${noun} switched to ${name}`
  return event.nextId ? `${noun} switched` : `${noun} turned off`
}

export function showSourceFallbackActiveSession(
  session: Pick<RecordingStatus, 'state' | 'streamUrl'>,
  event?: AutomaticSourceFallbackEvent
): void {
  toast.warning(sourceFallbackTitle(event), {
    description: sessionIsLive(session)
      ? 'Your stream uses it now. Check the output before you continue.'
      : 'Your recording uses it now. Check the output before you continue.',
    duration: 10_000,
    id: 'source-reconciliation:active-session'
  })
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

/**
 * A stored session's mode as what the session was doing: `record`, Go Live's
 * default `record+stream` and `stream`, older rows' `recording` and
 * `streaming`, and `imported`.
 */
export function sessionModeActivity(mode: string): SessionRuntimeActivity {
  const value = mode.toLowerCase()
  if (!value.includes('stream')) return 'recording'
  return value.includes('record') ? 'record+stream' : 'live-stream'
}

export function completeSessionRuntimeRecovery({
  plan,
  recording,
  events,
  priorSessionState,
  priorSessionActivity
}: {
  plan: SessionRuntimeRecoveryPlan
  recording: RecordingStatus
  events: HealthEvent[]
  priorSessionState: RecordingStatus['state']
  /** What the Studio last saw the prior session do (`sessionActivity`), if it was running. */
  priorSessionActivity?: SessionRuntimeActivity
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
      // The stored mode says what the session did. Without a summary, the
      // Studio's last sighting does: the state alone reads Go Live as a
      // recording (plan 174 B-6).
      activity: plan.failureSummary
        ? sessionModeActivity(plan.failureSummary.mode)
        : (priorSessionActivity ??
          (priorSessionState === 'streaming' ? 'live-stream' : 'recording'))
    }
  }

  const microphoneLoss = latestMatchingEvent(events, (event) => isSessionAudioLossCode(event.code))
  if (!microphoneLoss) return null
  const losses = events.filter(
    (event) => event.sessionId === microphoneLoss.sessionId && isSessionAudioLossCode(event.code)
  )
  const bySource = new Map(
    losses.map((event) => [event.code.startsWith('microphone-') ? 'microphone' : 'system', event])
  )
  return {
    kind: 'microphone-input-lost',
    event:
      bySource.size > 1
        ? {
            ...microphoneLoss,
            code: 'audio-inputs-lost',
            message: [...bySource.values()].map((event) => event.message).join(' ')
          }
        : microphoneLoss
  }
}

export async function recoverSessionRuntime({
  recording,
  sessions,
  priorSessionId,
  priorSessionState,
  priorSessionActivity,
  loadHealthEvents
}: {
  recording: RecordingStatus
  sessions: SessionSummary[]
  priorSessionId?: string
  priorSessionState: RecordingStatus['state']
  priorSessionActivity?: SessionRuntimeActivity
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
  return completeSessionRuntimeRecovery({
    plan,
    recording,
    events,
    priorSessionState,
    ...(priorSessionActivity ? { priorSessionActivity } : {})
  })
}

export function isSessionAudioLossCode(code: string): boolean {
  return ['microphone-input-lost', 'microphone-timeline-lost', 'system-audio-lost'].includes(code)
}
