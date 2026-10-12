import type {
  ReplayBufferState,
  ReplaySaveFailedEvent,
  ReplaySavedEvent,
  ReplayStateEvent
} from '../../../shared/backend'
import { formatTimecode } from '../../../shared/timecode'
import { revealInFileManagerLabel } from '@/lib/platform'
import { toast } from '@/lib/toast'
import { userErrorMessage } from '@/lib/user-error'

// Plan 181: the replay buffer's words, numbers and toasts. Loaded lazily by
// the Studio provider and the UI that shows the ring; the eager provider
// keeps only the switch, the events and the pure reconcile decision.
//
// Words (CONTEXT.md): "Replay buffer" is the feature and its switch, "Save
// replay" the action, and a "replay" the saved file. Never "clip": a clip
// is a clip mark.

export const REPLAY_BUFFER_LABEL = 'Replay buffer'
export const SAVE_REPLAY_LABEL = 'Save replay'

/** The ring's segment length, so a replay runs N to N + 2 s (D3). */
export const REPLAY_SEGMENT_SECONDS = 2
/** The ring's AAC audio, beside the video bitrate, in the disk estimate. */
const REPLAY_AUDIO_KBPS = 192

const TOAST_ID = 'replay-buffer'

/** "15 s", "30 s", "1 min", "2 min", "5 min". */
export function replayLengthLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  const minutes = seconds / 60
  return Number.isInteger(minutes) ? `${minutes} min` : `${minutes.toFixed(1)} min`
}

/** The ring's length as the Studio's timecode: "0:30", "5:00". */
export function replayClock(seconds: number): string {
  return formatTimecode(Math.max(0, seconds) * 1000)
}

/**
 * What the ring takes on disk at most, mirroring the backend's bound: the
 * kept segments (ceil(N/2) + 2) plus the one being written, each a full
 * segment of video and AAC audio.
 */
export function estimatedReplayDiskBytes(seconds: number, videoBitrateKbps: number): number {
  const keptSegments = Math.ceil(seconds / REPLAY_SEGMENT_SECONDS) + 2 + 1
  const bytesPerSecond = ((videoBitrateKbps + REPLAY_AUDIO_KBPS) * 1000) / 8
  return keptSegments * REPLAY_SEGMENT_SECONDS * bytesPerSecond
}

/** "120 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const gb = bytes / 1_000_000_000
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`
}

export type ReplayRowTone = 'good' | 'neutral' | 'warn'

/**
 * The one line under the switch (plan 181 S5.1). The switch is the intent;
 * this is what the ring does right now, in the Studio's words.
 */
export function replayStatusLine(
  ring: ReplayStateEvent,
  armed: boolean,
  transportActive: boolean
): { label: string; tone: ReplayRowTone } {
  switch (ring.state) {
    case 'on':
      return {
        label: `${replayClock(ring.bufferedSeconds)} / ${replayClock(ring.seconds)}`,
        tone: 'good'
      }
    case 'starting':
      return { label: 'Starting…', tone: 'neutral' }
    case 'error':
      return { label: 'Stopped', tone: 'warn' }
    default:
      if (armed && transportActive) return { label: 'Starts after this session', tone: 'neutral' }
      if (armed) return { label: 'Starting…', tone: 'neutral' }
      return { label: 'Off', tone: 'neutral' }
  }
}

/** The status bar chip while the ring holds frames: "Replay · 0:30". */
export function replayStatusBarLabel(ring: ReplayStateEvent): string | null {
  if (ring.state === 'on') return `Replay · ${replayClock(ring.bufferedSeconds)}`
  if (ring.state === 'starting') return 'Replay starting…'
  return null
}

/** Why a Save replay press did nothing, by the ring's state. */
function replayOffDescription(state: ReplayBufferState, armed: boolean): string {
  if (state === 'starting' || armed)
    return 'The replay buffer is still starting. Try again in a moment.'
  return 'Turn it on in Studio to keep the last seconds ready to save.'
}

export function showReplaySaved(event: ReplaySavedEvent): void {
  const held = replayClock(Math.round(event.coveredSeconds))
  toast.success('Replay saved', {
    id: `${TOAST_ID}-saved-${event.saveId}`,
    duration: 12_000,
    description: event.complete ? `Last ${held}.` : `Last ${held}, the buffer was still filling.`,
    action: {
      label: revealInFileManagerLabel(),
      onClick: () => void window.videorc?.revealSession(event.replaySessionId)
    }
  })
}

export function showReplaySaveFailed(event: ReplaySaveFailedEvent): void {
  toast.error("Couldn't save the replay", {
    id: `${TOAST_ID}-failed-${event.saveId}`,
    duration: 10_000,
    description: event.message
  })
}

/** The `replay.save` RPC refused before any work started (off, starting). */
export function showReplaySaveRefused(error: unknown): void {
  toast.warning("Couldn't save the replay", {
    id: TOAST_ID,
    description: userErrorMessage(error).description
  })
}

export function showReplayBufferOff(
  state: ReplayBufferState,
  armed: boolean,
  turnOn: () => void
): void {
  toast.warning('Replay buffer is off', {
    id: TOAST_ID,
    description: replayOffDescription(state, armed),
    ...(armed || state === 'starting' ? {} : { action: { label: 'Turn on', onClick: turnOn } })
  })
}

/** D4: a Save replay press while a recording runs without the ring. */
export function showReplayMarkedInstead(): void {
  toast.info('Marked in your recording instead', {
    id: TOAST_ID,
    description:
      'The replay buffer restarts with each recording, so this moment was marked in the recording.'
  })
}

/** The ring ended with its session, not by the switch. */
export function showReplayBufferStopped(reason: string | undefined): void {
  toast.warning('Replay buffer stopped', {
    id: TOAST_ID,
    duration: 10_000,
    description: reason ?? 'Turn it on again in Studio.'
  })
}

export function showReplayBufferCouldNotStart(reason: string): void {
  toast.error("Couldn't start the replay buffer", {
    id: TOAST_ID,
    duration: 10_000,
    description: reason
  })
}
