import type {
  ReplayBufferState,
  ReplaySaveFailedEvent,
  ReplaySavedEvent,
  ReplayStateEvent
} from '../../../shared/backend'
import { formatTimecode } from '../../../shared/timecode'
import type { BackendClient } from '@/backendClient'
import type { RecordingStatus, Scene } from '@/lib/backend'
import type { CaptureConfig, SettingsState } from '@/lib/capture'
import { revealInFileManagerLabel } from '@/lib/platform'
import { buildStartSessionParams } from '@/lib/session-params'
import { toast } from '@/lib/toast'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

// Plan 181 (the owner's redesign, R4): the clip buffer's words, numbers and
// toasts. Loaded lazily by the Studio provider and the UI that shows the
// ring; the eager provider keeps only the switch, the events and the pure
// reconcile decision.
//
// Words (CONTEXT.md): a **clip** is the saved video (the last N seconds),
// **Clip** / **Save clip** the one action, **Clips** the Output section and
// its switch ("Keep the last seconds"). Never "replay" in copy.

export const CLIPS_LABEL = 'Clips'
export const SAVE_CLIP_LABEL = 'Save clip'
export const CLIP_BUTTON_LABEL = 'Clip'
export const KEEP_LAST_SECONDS_LABEL = 'Keep the last seconds'

/** The ring's segment length, so a clip runs N to N + 2 s (D3). */
export const REPLAY_SEGMENT_SECONDS = 2
/** The ring's AAC audio, beside the video bitrate, in the disk estimate. */
const REPLAY_AUDIO_KBPS = 192

const TOAST_ID = 'clips'

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

/**
 * The status bar chip while the ring holds frames: "Clip · 0:30" (what a
 * press saves right now), "Clips starting…" while it fills.
 */
export function replayStatusBarLabel(ring: ReplayStateEvent): string | null {
  if (ring.state === 'on') return `Clip · ${replayClock(ring.bufferedSeconds)}`
  if (ring.state === 'starting') return 'Clips starting…'
  return null
}

export function showClipSaved(event: ReplaySavedEvent): void {
  const held = replayClock(Math.round(event.coveredSeconds))
  toast.success('Clip saved', {
    id: `${TOAST_ID}-saved-${event.saveId}`,
    duration: 12_000,
    description: event.complete ? `Last ${held}.` : `Last ${held}, the buffer was still filling.`,
    action: {
      label: revealInFileManagerLabel(),
      onClick: () => void window.videorc?.revealSession(event.replaySessionId)
    }
  })
}

export function showClipSaveFailed(event: ReplaySaveFailedEvent): void {
  toast.error("Couldn't save the clip", {
    id: `${TOAST_ID}-failed-${event.saveId}`,
    duration: 10_000,
    description: event.message
  })
}

/**
 * A Clip press with nothing to save: the ring holds no frames and nothing
 * records. Says which, and points at the one switch.
 */
export function showNothingToClip(input: {
  state: ReplayBufferState
  enabled: boolean
  blockedReason: string | null
}): void {
  const openOutput = { label: 'Open Output', onClick: () => openWorkspaceTab('recording') }
  if (input.blockedReason) {
    toast.warning('Clips are off on this computer', {
      id: TOAST_ID,
      description: input.blockedReason,
      action: openOutput
    })
    return
  }
  if (!input.enabled) {
    toast.warning('Clips are off', {
      id: TOAST_ID,
      description: `Turn on ${KEEP_LAST_SECONDS_LABEL} on the Output page, or start a recording.`,
      action: openOutput
    })
    return
  }
  if (input.state === 'starting') {
    toast.info('Clips are still starting', {
      id: TOAST_ID,
      description: 'Try again in a moment.'
    })
    return
  }
  toast.warning('Nothing to clip yet', {
    id: TOAST_ID,
    description: 'The last seconds are not being kept right now. Start a recording, or go live.'
  })
}

/** The ring ended with its session, not by the switch. */
export function showClipsStopped(reason: string | undefined): void {
  toast.warning('Clips stopped', {
    id: TOAST_ID,
    duration: 10_000,
    description: reason ?? `Turn on ${KEEP_LAST_SECONDS_LABEL} again on the Output page.`
  })
}

export function showClipsCouldNotStart(reason: string): void {
  toast.error("Clips couldn't start", {
    id: TOAST_ID,
    duration: 10_000,
    description: reason
  })
}

/**
 * The buffer-only session's request (plan 181): the Record session's params
 * with no file and no stream, the ring attached, built here so the eager
 * provider keeps only the switch, the refs and the events.
 */
export async function startBufferOnlySession(input: {
  client: BackendClient
  captureConfig: CaptureConfig
  scene: Scene | null
  sceneEditMode: boolean
  settings: SettingsState
  /** A newer scene, source or switch intent cancels this automatic start. */
  isCurrent: () => boolean
}): Promise<RecordingStatus | null> {
  if (!input.isCurrent()) return null
  const outputDirectory = input.settings.outputDirectoryHandle
    ? await window.videorc?.authorizeOutputDirectory?.(input.settings.outputDirectoryHandle)
    : null
  // Authorization crosses an async boundary. Never let an old automatic
  // start restore its scene after the user has committed another layout.
  if (!input.isCurrent()) return null
  const params = buildStartSessionParams({
    captureConfig: input.captureConfig,
    scene: input.scene,
    sceneEditMode: input.sceneEditMode,
    settings: input.settings,
    suppressCaptionsForSession: true,
    replayArmed: true
  })
  return input.client.requestTyped('session.start', {
    ...params,
    output: {
      ...params.output,
      recordEnabled: false,
      streamEnabled: false,
      ...(outputDirectory ? { outputDirectoryCapability: outputDirectory.capabilityId } : {})
    },
    streaming: undefined,
    captions: undefined,
    simulcast: undefined
  })
}
