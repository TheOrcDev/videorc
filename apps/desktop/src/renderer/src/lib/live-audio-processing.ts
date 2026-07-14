import type {
  AudioProcessingUpdateParams,
  AudioProcessingUpdateResult,
  AudioSettings,
  RecordingStatus
} from '@/lib/backend'

export type LiveAudioProcessingValues = Pick<AudioSettings, 'microphoneGainDb' | 'microphoneMuted'>

export interface LiveAudioProcessingSessionStartSnapshot extends LiveAudioProcessingValues {
  sessionId: string
}

export interface LiveAudioProcessingSessionSyncDecision {
  lastApplied: LiveAudioProcessingValues
  enqueueDesired: boolean
}

export interface RejectedLiveAudioProcessingUpdate {
  rollback: LiveAudioProcessingValues
  disableForSession: boolean
  message: string
}

export interface LiveAudioProcessingUpdateSettlement {
  requested: AudioProcessingUpdateParams
  result?: AudioProcessingUpdateResult
  error?: unknown
}

export type LiveAudioProcessingUpdateSender = (
  params: AudioProcessingUpdateParams
) => Promise<AudioProcessingUpdateResult>

/**
 * FFmpeg polls runtime commands on its stats cadence, so a slider drag must not
 * turn into a FIFO of several-second websocket requests. Keep one request in
 * flight and replace the pending request with the newest complete mic state.
 * Stopping a session drops pending work and makes the eventual in-flight reply
 * inert; the backend stop marker independently rejects requests already queued
 * at the native session mutex.
 */
export class LatestWinsLiveAudioProcessingQueue {
  private inFlight: AudioProcessingUpdateParams | null = null
  private pending: AudioProcessingUpdateParams | null = null
  private drainPromise: Promise<void> | null = null
  private stopped = false

  constructor(
    private readonly sessionId: string,
    private readonly send: LiveAudioProcessingUpdateSender,
    private readonly onSettled: (settlement: LiveAudioProcessingUpdateSettlement) => boolean
  ) {}

  get hasOutstandingWork(): boolean {
    return this.inFlight !== null || this.pending !== null
  }

  enqueue(params: AudioProcessingUpdateParams): void {
    if (this.stopped || params.sessionId !== this.sessionId) return
    if (sameAudioProcessingParams(params, this.pending ?? this.inFlight)) return

    this.pending = params
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null
      })
    }
  }

  stop(): void {
    this.stopped = true
    this.pending = null
  }

  async waitForIdle(): Promise<void> {
    await this.drainPromise
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.pending) {
      const requested = this.pending
      this.pending = null
      this.inFlight = requested

      let settlement: LiveAudioProcessingUpdateSettlement
      try {
        settlement = { requested, result: await this.send(requested) }
      } catch (error) {
        settlement = { requested, error }
      }

      this.inFlight = null
      if (this.stopped) break
      if (!this.onSettled(settlement)) {
        this.stop()
      }
    }
  }
}

function sameAudioProcessingParams(
  left: AudioProcessingUpdateParams,
  right: AudioProcessingUpdateParams | null
): boolean {
  return (
    right !== null &&
    left.sessionId === right.sessionId &&
    left.microphoneGainDb === right.microphoneGainDb &&
    left.microphoneMuted === right.microphoneMuted
  )
}

/**
 * Central live-sync decision for every mic control. Individual controls only
 * update captureConfig; StudioProvider turns the latest shared settings into
 * one session-scoped backend mutation once capture is actually active.
 */
export function activeAudioProcessingUpdateParams(
  recording: Pick<RecordingStatus, 'state' | 'sessionId'>,
  audio: Pick<AudioSettings, 'microphoneGainDb' | 'microphoneMuted'>
): AudioProcessingUpdateParams | null {
  if (!['recording', 'streaming'].includes(recording.state) || !recording.sessionId) {
    return null
  }
  return {
    sessionId: recording.sessionId,
    microphoneGainDb: audio.microphoneGainDb,
    microphoneMuted: audio.microphoneMuted
  }
}

/**
 * Seed a newly active session from the exact mic values included in its start
 * request. Controls can still change while start is in flight; comparing the
 * active values with this seed preserves that edit without inventing a
 * redundant live mutation for an untouched start.
 */
export function liveAudioProcessingSessionSyncDecision(
  desired: AudioProcessingUpdateParams,
  startSnapshot: LiveAudioProcessingSessionStartSnapshot | null
): LiveAudioProcessingSessionSyncDecision {
  const startSnapshotMatches = startSnapshot?.sessionId === desired.sessionId
  const lastApplied = {
    microphoneGainDb: startSnapshotMatches
      ? startSnapshot.microphoneGainDb
      : desired.microphoneGainDb,
    microphoneMuted: startSnapshotMatches ? startSnapshot.microphoneMuted : desired.microphoneMuted
  }
  return {
    lastApplied,
    enqueueDesired:
      !startSnapshotMatches ||
      desired.microphoneGainDb !== lastApplied.microphoneGainDb ||
      desired.microphoneMuted !== lastApplied.microphoneMuted
  }
}

/**
 * A successful websocket response is not enough: the backend can truthfully
 * reject a live change when this capture has no native post-controls audio
 * path. Roll back only while the UI still shows the rejected request; a late
 * response must never overwrite a newer mic edit or a newer session.
 */
export function rejectedLiveAudioProcessingUpdate(input: {
  recording: Pick<RecordingStatus, 'state' | 'sessionId'>
  current: LiveAudioProcessingValues
  requested: AudioProcessingUpdateParams
  /** Missing when the `audio.processing.update` request itself rejected. */
  result?: AudioProcessingUpdateResult
  lastApplied: LiveAudioProcessingValues
}): RejectedLiveAudioProcessingUpdate | null {
  if (
    !['recording', 'streaming'].includes(input.recording.state) ||
    input.recording.sessionId !== input.requested.sessionId ||
    input.result?.applied ||
    input.result?.reasonCode === 'session-ended' ||
    (input.result && input.result.sessionId !== input.requested.sessionId)
  ) {
    return null
  }

  // A rejected request provides no acknowledgement that the active capture
  // changed. Treat a missing or unhealthy controller as unavailable for the
  // rest of this capture: restoring the last acknowledged values is the only
  // state the UI can claim truthfully.
  const liveAudioControlStateUnknown =
    !input.result || input.result.reasonCode === 'live-audio-control-state-unknown'
  const liveAudioControlsUnavailable =
    liveAudioControlStateUnknown ||
    input.result?.reasonCode === 'native-audio-unavailable' ||
    input.result?.reasonCode === 'live-audio-control-unavailable'
  const currentRequestStillVisible =
    input.current.microphoneGainDb === input.requested.microphoneGainDb &&
    input.current.microphoneMuted === input.requested.microphoneMuted
  if (!liveAudioControlsUnavailable && !currentRequestStillVisible) {
    return null
  }
  const backendConfirmedRollback =
    input.result?.confirmedMicrophoneGainDb !== undefined &&
    input.result.confirmedMicrophoneMuted !== undefined
      ? {
          microphoneGainDb: input.result.confirmedMicrophoneGainDb,
          microphoneMuted: input.result.confirmedMicrophoneMuted
        }
      : null
  return {
    rollback: backendConfirmedRollback ?? input.lastApplied,
    disableForSession: liveAudioControlsUnavailable,
    message: liveAudioControlStateUnknown
      ? 'The live microphone change could not be confirmed, and the captured audio state may differ from the controls shown. Stop and restart this capture before relying on microphone gain or mute.'
      : liveAudioControlsUnavailable
        ? 'Live microphone controls are unavailable for this capture. The previous gain and mute settings were restored.'
        : 'The live microphone change was not applied. The previous gain and mute settings were restored.'
  }
}
