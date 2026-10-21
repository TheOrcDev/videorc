import type { StatusTone } from '@/components/status-badge'
import type {
  CaptionsStatus,
  CloudPhase,
  LiveChatProviderState,
  PreviewCameraState,
  PreviewLiveState,
  PreviewScreenState,
  StreamTargetState
} from '@/lib/backend'
import type { SystemAudioIssue } from '@/lib/system-audio-session'
import { statusWordFromValue } from '@/lib/status-word'

// Plan 174 S1.3: one label function per state machine, so a status chip
// shows a word ("Needs permission") and never the backend's value
// ("permission-needed"). "On air" is only ever the session's own word (D4);
// the session's labels live with the rest of its view in
// `studio-session-view.ts` and are re-exported here.
//
// Plan 174 S2.3a adds the other machines a streamer reads: a destination,
// captions, a platform's chat, the microphone's signal and Videorc's own
// connection. Every surface that shows one of these states asks here, so the
// same state never reads two ways (J2-4).

// The start-blocking copy lives in its own small module because the Studio
// provider reads it eagerly; this file's other tables stay in lazy chunks.
export { connectionBlockedReason, START_BLOCKED_COPY } from '@/lib/start-blocked-copy'

export {
  sessionStatusGlyph,
  sessionStatusLabel,
  sessionStatusPulses,
  sessionStatusTone,
  type SessionStatusGlyph,
  type SessionStatusOptions
} from '@/lib/studio-session-view'

const PREVIEW_STATE_LABELS: Record<PreviewLiveState, string> = {
  connecting: 'Connecting…',
  live: 'Running',
  reconnecting: 'Reconnecting…',
  unavailable: 'Unavailable'
}

/** Health's Preview chip: the live preview pipeline's state as a word. */
export function previewStateLabel(state: PreviewLiveState): string {
  return PREVIEW_STATE_LABELS[state] ?? statusWordFromValue(state)
}

/** A source that is producing frames or sound (D4): never "Live" or "On air". */
export const SOURCE_RECEIVING_LABEL = 'Receiving'

const PREVIEW_SOURCE_STATE_LABELS: Record<PreviewCameraState | PreviewScreenState, string> = {
  starting: 'Starting…',
  live: SOURCE_RECEIVING_LABEL,
  'permission-needed': 'Needs permission',
  // The preview's `device-missing` / `source-missing` is also its idle state
  // (plan 173): a connected source whose preview is not running reports it,
  // so it reads "Not running", never "Not found".
  'device-missing': 'Not running',
  'source-missing': 'Not running',
  failed: 'Failed'
}

/** Health's Camera and Screen chips: the preview source's state as a word. */
export function previewSourceStateLabel(state: PreviewCameraState | PreviewScreenState): string {
  return PREVIEW_SOURCE_STATE_LABELS[state] ?? statusWordFromValue(state)
}

const DESTINATION_STATE_LABELS: Record<StreamTargetState, string> = {
  // At Go Live a destination that is not set up is left out of the stream.
  'not-configured': 'Skipped',
  ready: 'Ready',
  connecting: 'Connecting…',
  live: 'On air',
  warning: 'Not receiving',
  reconnecting: 'Reconnecting…',
  failed: 'Failed',
  stopped: 'Ended'
}

/**
 * One destination's state in a word, on the Livestream cards, the stream
 * failure banner and the Stream Manager's health details (J2-4). A failed
 * destination is "Failed", never "Stopped"; one whose stream finished is
 * "Ended"; one that is streaming is "On air", never "Live".
 */
export function destinationStateLabel(state: StreamTargetState): string {
  return DESTINATION_STATE_LABELS[state] ?? statusWordFromValue(state)
}

const CLOUD_PHASE_LABELS: Record<CloudPhase, string> = {
  off: 'Off',
  connecting: 'Connecting…',
  live: 'On air',
  hold: 'Be right back',
  resuming: 'Resuming…',
  ending: 'Ending…',
  failed: 'Failed'
}

/**
 * The Videorc Cloud show's state in a word, in the Stream Manager's health
 * details (plan 184 C7): "On air" like a destination, "Be right back" while
 * viewers see the hold image.
 */
export function cloudPhaseLabel(phase: CloudPhase): string {
  return CLOUD_PHASE_LABELS[phase] ?? statusWordFromValue(phase)
}

type CaptionsStatusInput = Pick<CaptionsStatus, 'state' | 'desiredEnabled'>

export type CaptionsStatusOptions = {
  /** The streamer's Live captions switch; defaults to what the status reports. */
  enabled?: boolean
  /** A recording or livestream is running. */
  sessionActive?: boolean
}

function captionsEnabled(status: CaptionsStatusInput, options: CaptionsStatusOptions): boolean {
  // The backend's idle status is also its "turned off" status (desiredEnabled false).
  return options.enabled ?? status.desiredEnabled ?? status.state !== 'idle'
}

/**
 * Live captions in a word, the same on the Captions page, the Studio's quick
 * settings and the Captions reader (D-26): "Off", "Ready", "Starting…",
 * "Listening", "Reconnecting…", "Higher delay", "Blocked", "Failed". Captions
 * transcribe; they are never "Live" or "Armed".
 */
export function captionsStatusLabel(
  status: CaptionsStatusInput,
  options: CaptionsStatusOptions = {}
): string {
  if (!captionsEnabled(status, options)) return 'Off'
  switch (status.state) {
    case 'starting':
      return 'Starting…'
    case 'listening':
    case 'live':
      return 'Listening'
    case 'reconnecting':
      return 'Reconnecting…'
    case 'degraded':
      return 'Higher delay'
    case 'blocked':
      return 'Blocked'
    case 'error':
      return 'Failed'
    case 'ready':
      return 'Ready'
    default:
      // On, with nothing running yet: ready for the next recording, or
      // waiting for the caption service while one runs.
      return options.sessionActive ? 'Waiting…' : 'Ready'
  }
}

/** The tone beside the captions word: colour only where the state means something. */
export function captionsStatusTone(
  status: CaptionsStatusInput,
  options: CaptionsStatusOptions = {}
): StatusTone {
  if (!captionsEnabled(status, options)) return 'neutral'
  switch (status.state) {
    case 'listening':
    case 'live':
      return 'good'
    case 'reconnecting':
    case 'degraded':
      return 'warn'
    case 'blocked':
    case 'error':
      return 'error'
    default:
      return 'neutral'
  }
}

type ChatProviderInput = Pick<LiveChatProviderState, 'state' | 'read' | 'write' | 'retryAt'>

/**
 * One platform's chat in a word or two, in the Stream Manager's status bar
 * and its destination badges (H-13): the connection first, then what chat
 * can't do. "Read-only" (never "receive-only"), "Reconnect to send", "Off"
 * when chat is turned off and "Unavailable" when the platform has none for
 * this stream (never "Idle").
 */
export function chatStateLabel(provider: ChatProviderInput): string {
  switch (provider.state) {
    case 'failed':
      return 'Failed'
    case 'ended':
      return 'Ended'
    case 'disabled':
      return 'Off'
    case 'unsupported':
      return 'Unavailable'
    default:
      break
  }
  if (provider.read === 'unavailable') return 'Unavailable'
  if (provider.state === 'connecting') return 'Connecting…'
  if (provider.state === 'reconnecting') return 'Reconnecting…'
  // A parked connector that resumes on its own (the YouTube quota pause).
  if (provider.state === 'waiting') return provider.retryAt ? 'Paused' : 'Waiting…'
  if (provider.write === 'ready') return 'Connected'
  if (provider.write === 'missing-scope') return 'Reconnect to send'
  if (provider.write === 'failed') return 'Send failed'
  return 'Read-only'
}

/**
 * The microphone meter's state, for its data attribute and the probes. The
 * words a streamer hears come from `micSignalLabel`.
 */
export type MicMonitorState = 'live' | 'monitoring' | 'muted' | 'idle'

const MIC_SIGNAL_LABELS: Record<MicMonitorState, string> = {
  // A microphone delivering sound is "Receiving", with or without a session:
  // Videorc has no monitor bus, so "Monitoring" promised one (C-38).
  live: SOURCE_RECEIVING_LABEL,
  monitoring: SOURCE_RECEIVING_LABEL,
  muted: 'Muted',
  idle: 'No signal'
}

/** The microphone meter's state in a word: "Receiving", "Muted", "No signal". */
export function micSignalLabel(state: MicMonitorState): string {
  return MIC_SIGNAL_LABELS[state]
}

const SYSTEM_AUDIO_ISSUE_LABELS: Record<SystemAudioIssue, string> = {
  echo: 'Paused',
  lost: 'Stopped',
  bypassed: 'Off until you stop',
  unavailable: "Couldn't start"
}

/**
 * System audio's problem in a word or two, the same in Sources and the
 * Studio's quick settings (J2-4). The line under it is `systemAudioIssueCopy`.
 */
export function systemAudioIssueLabel(issue: SystemAudioIssue): string {
  return SYSTEM_AUDIO_ISSUE_LABELS[issue]
}
