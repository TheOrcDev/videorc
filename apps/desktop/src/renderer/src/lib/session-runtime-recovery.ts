import type {
  AutomaticSourceFallbackEvent,
  DiscordAnnounceSnapshot,
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
  type SessionRuntimeActivity,
  type SessionRuntimeNotice
} from '@/lib/session-runtime-notice'
import { sessionActivity, sessionIsLive, sessionIsReplayOnly } from '../../../shared/capture-state'
import { revealInFileManagerLabel } from '@/lib/platform'
import { VIDEORC_PREMIUM_URL } from '@/lib/premium-upgrade'
import { recordingStartupHealthToast } from '@/lib/studio-health'
import { shouldToastBackendError } from '@/lib/backend-transport'
import { ipcErrorMessage } from '@/lib/ipc-error-message'
import { OFFLINE_TOAST_ID, userErrorMessage, type UserErrorContext } from '@/lib/user-error'
import { recordUserError } from '@/lib/user-error-log'
import type { WsStatus } from '@/lib/capture'
import { CHAT_PLATFORM_LABELS } from '@/lib/live-chat-view'
import { notifications } from '@/lib/notifications'
import { publishBackendLifecycle } from '@/lib/notifications/sources/app'
import {
  publishHealthEvent,
  publishMicrophoneLoss,
  publishRecordingFailure,
  publishRecordingQuality,
  rebuildHealthNotifications,
  sessionEndedNotifications
} from '@/lib/notifications/sources/health'
import {
  publishDiscordFailure,
  publishXPlayback,
  publishYouTubeBroadcastProblem,
  publishYouTubeBudget
} from '@/lib/notifications/sources/platforms'
import { notifyOnce } from '@/lib/notify-once'
import { TOAST_WITH_DESCRIPTION_MS, toast } from '@/lib/toast'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import { discordFailureToast } from '@/lib/discord-announce'
import { openHealthToastAction } from '@/lib/health-door'
import type { StreamPlatform, YouTubeQuotaStatus } from '@/lib/backend'
import {
  youtubeBroadcastToast,
  youtubeBudgetNotice,
  youtubeBudgetStepToAnnounce,
  youtubeConnectPausedMessage
} from '@/lib/youtube-quota-copy'

// Plan 083: the thumbnail warning rides this lazy runtime chunk. Since plan
// 250 it is an entry with Retry (`notifications/sources/platforms.ts`).
export { youtubeThumbnailFailure } from '@/lib/youtube-thumbnail-toast'
export { publishYouTubeThumbnailFailure as showYouTubeThumbnailFailure } from '@/lib/notifications/sources/platforms'
// Plan 094: so does every piece of YouTube quota copy the Studio provider shows.
export { youtubeGoLivePausedMessage } from '@/lib/youtube-quota-copy'

/** "Couldn't start/end the YouTube broadcast." with the destination named only when it adds something. */
export function showYouTubeBroadcastToast(
  step: 'start' | 'end',
  target: { id: string; label: string; platform: StreamPlatform },
  message: string
): void {
  publishYouTubeBroadcastProblem(step, target, youtubeBroadcastToast(step, target, message))
}

/** The Discord announcement failure already toasted (plan 187, D13). */
let discordFailureToastedAt: string | null = null

/**
 * A go-live post that failed: one toast per failure, wherever the streamer
 * is, with the way to fix it. An old failure riding a settings change stays
 * quiet (`discordFailureToast`).
 */
export function showDiscordAnnounceFailure(snapshot: DiscordAnnounceSnapshot): void {
  const failure = discordFailureToast(discordFailureToastedAt, snapshot, Date.now())
  if (!failure) return
  discordFailureToastedAt = failure.at
  publishDiscordFailure(failure)
}

/** One quiet notice per daily-budget step reached (plan 094, S6), never on the way down. */
export function showYouTubeBudgetStep(
  previous: YouTubeQuotaStatus | null | undefined,
  status: YouTubeQuotaStatus
): void {
  const reached = youtubeBudgetStepToAnnounce(previous, status)
  const notice = reached ? youtubeBudgetNotice(reached) : null
  if (!reached || !notice) return
  publishYouTubeBudget(reached, notice)
}

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
      ? "Videorc couldn't finish this livestream."
      : "Videorc couldn't finish this recording.")
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

/**
 * The take ended on its own: an urgent entry behind the bell (plan 250), and
 * the end of every problem that belonged to the session.
 */
export function showRecordingFailure({ notice }: RecordingFailurePresentation): void {
  sessionEndedNotifications(notifications, notice.activity)
  publishRecordingFailure(notifications, notice)
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
  // A buffer-only Clips session is not a recording: its loss copy must not
  // say "recording continues with silence".
  const activity: SessionRuntimeActivity = sessionIsReplayOnly(recording)
    ? 'clips'
    : active
      ? sessionActivity(recording)
      : lastActivity
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

/** A lost or silent input: the microphone's entry, urgent (plan 250). */
export function showMicrophoneLoss({ notice }: MicrophoneLossPresentation): void {
  publishMicrophoneLoss(notifications, notice)
}

/** The engine restarting, recovered, or beyond recovering: one subject (plan 250). */
export function showBackendLifecycle(event: BackendLifecycleEvent): void {
  publishBackendLifecycle(event)
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
  recordUserError(copy, error, context)
  if (copy.kind === 'offline') {
    const show = copy.tone === 'warning' ? toast.warning : toast.error
    show(copy.title, { id: OFFLINE_TOAST_ID, description: copy.description })
  } else {
    // A failure Videorc can't explain says to look at Health (plan 174 D9),
    // so its toast opens it. The door keeps the toast's timed life: a
    // door is not a fix, so it never pins the toast open.
    notifyOnce(`backend-error:${copy.title}:${message}`, copy.tone, copy.title, {
      description: copy.description,
      ...(copy.kind === 'unknown'
        ? { action: openHealthToastAction(), duration: TOAST_WITH_DESCRIPTION_MS }
        : {})
    })
  }
}

/** X's own word on whether viewers can watch: one subject (plan 250). */
export function showXPlaybackEvent(event: XPlaybackEvent): void {
  publishXPlayback(event)
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
        : (result.message ?? result.status ?? "Connection couldn't be completed.")
    toast.error(`Couldn't finish connecting ${platformName}`, { id, description })
  }
}

/** The renderer gave up retrying a provider callback (same id as the results). */
export function showOAuthCallbackExhausted(): void {
  const platformName = platformLabelOrAccount(lastOAuthCallbackPlatform)
  console.warn('[oauth] callback retries exhausted; kept unacknowledged')
  toast.error(`Couldn't finish connecting ${platformName}`, {
    id: oauthCallbackToastId(lastOAuthCallbackPlatform),
    description: `Connect ${platformName} again from Destinations → Setup.`,
    action: { label: 'Open Destinations', onClick: () => openWorkspaceTab('live') }
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
    const endedNotice = { ...currentNotice, phase: 'ended' as const }
    replaceNotice(endedNotice)
    // The entry takes the ended words ("Microphone was silent during the
    // livestream") before it ends with the session.
    publishMicrophoneLoss(notifications, endedNotice)
  }
  // Plan 218, plan 250: the session's open problems end with it. They stay
  // in the list as what happened during the stream.
  sessionEndedNotifications(notifications, activity)
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
  // Plan 250 (D13): an entry behind the bell with both buttons, and a short
  // toast while idle: the streamer has just stopped and is looking here.
  notifications.publish({
    key: `recording-saved:${sessionId ?? 'session'}`,
    kind: 'recording-saved',
    title: 'Recording saved',
    actions: [
      { id: 'play', label: 'Play', kind: 'fix', run: openFinishedRecording },
      {
        id: 'open-library',
        label: 'Open in Library',
        kind: 'door',
        run: () => openLibrary(sessionId)
      }
    ],
    once: true
  })
}

/**
 * One `health` event of the running session. Since plan 250 it is an entry
 * behind the bell, on its subject (`notifications/health-kinds.ts` is the
 * table); only an urgent one pops up while recording or live. One toast is
 * left: a start that was refused answers Record or Go Live.
 *
 * Returns the key of a quality notice it showed, so the caller shows it once.
 */
export function showSessionHealthEvent(
  event: HealthEvent,
  qualityToastAlreadyShown: boolean,
  recording?: Pick<RecordingStatus, 'sessionId' | 'state'>
): string | null {
  const startupToast = recordingStartupHealthToast(event)
  if (startupToast?.variant === 'error') {
    toast.error(startupToast.title, {
      id: startupToast.id,
      description: startupToast.description,
      duration: startupToast.duration
    })
    return null
  }
  if (event.code.startsWith('recording-quality-')) {
    if (event.code !== 'recording-quality-not-100' || event.level !== 'warn') return null
    if (qualityToastAlreadyShown) return null
    publishRecordingQuality(notifications, event)
    return event.sessionId ?? event.message
  }
  publishHealthEvent(notifications, event, { recording: recording ?? { state: 'idle' } })
  return null
}

export function showNoiseCleanupCompleted(jobId: string, outputSessionId: string): void {
  notifications.publish({
    key: `noise-cleanup:${jobId}`,
    kind: 'work-done',
    title: 'Noise cleanup complete',
    detail: "A separate cleaned copy is ready. The original wasn't changed.",
    actions: [
      {
        id: 'play',
        label: 'Play',
        kind: 'fix',
        run: () => {
          const openSession = window.videorc?.openSession
          if (!openSession) return
          void openSession(outputSessionId).then((problem) => {
            if (problem) showPlaybackProblem(outputSessionId, problem)
          })
        }
      },
      {
        id: 'reveal',
        label: revealInFileManagerLabel(),
        kind: 'fix',
        run: () => void window.videorc?.revealSession?.(outputSessionId)
      }
    ],
    once: true
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
  notifications.publish({
    key: `source-fallback:${event?.sourceKind ?? 'source'}`,
    kind: 'source-fallback',
    title: sourceFallbackTitle(event),
    detail: sessionIsLive(session)
      ? 'Your stream uses it now. Check the output before you continue.'
      : 'Your recording uses it now. Check the output before you continue.',
    actions: [
      {
        id: 'open-sources',
        label: 'Open Sources',
        kind: 'door',
        run: () => openWorkspaceTab('sources')
      }
    ]
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

  // The losses still open, in the order they were reported: a later
  // recovery of the same source closed the ones before it, as it clears the
  // notice while the Studio watches. Without this a reconnect brought back
  // a microphone problem that had already ended.
  const bySource = new Map<'microphone' | 'system', HealthEvent>()
  for (const event of events) {
    const source = event.code.startsWith('microphone-') ? 'microphone' : 'system'
    if (isSessionAudioLossCode(event.code)) {
      bySource.delete(source)
      bySource.set(source, event)
    } else if (isSessionAudioRecoveryCode(event.code)) {
      bySource.delete(source)
    }
  }
  const microphoneLoss = [...bySource.values()].at(-1)
  if (!microphoneLoss) return null
  for (const [source, event] of bySource) {
    if (event.sessionId !== microphoneLoss.sessionId) bySource.delete(source)
  }
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
  // Plan 250 S9: a session that is still running rebuilds its open problems
  // in the list from its stored events (the last 120): a reload mid-stream
  // had lost them, and a reconnect had missed what cleared in the gap.
  if (
    ['recording', 'streaming'].includes(recording.state) &&
    recording.sessionId &&
    plan.healthSessionId === recording.sessionId &&
    !plan.failureSessionId
  ) {
    rebuildHealthNotifications(notifications, events, { recording })
  }
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

/** The recovery that ends one of those losses. */
export function isSessionAudioRecoveryCode(code: string): boolean {
  return [
    'microphone-input-recovered',
    'microphone-timeline-recovered',
    'system-audio-recovered'
  ].includes(code)
}
