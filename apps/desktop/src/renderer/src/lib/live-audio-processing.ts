import type {
  AudioProcessingUpdateParams,
  AudioProcessingUpdateResult,
  AudioSettings,
  RecordingStatus
} from '@/lib/backend'

export type LiveAudioProcessingValues = Pick<AudioSettings, 'microphoneGainDb' | 'microphoneMuted'>

export interface RejectedLiveAudioProcessingUpdate {
  rollback: LiveAudioProcessingValues
  disableForSession: boolean
  message: string
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
    (input.result && input.result.sessionId !== input.requested.sessionId) ||
    input.current.microphoneGainDb !== input.requested.microphoneGainDb ||
    input.current.microphoneMuted !== input.requested.microphoneMuted
  ) {
    return null
  }

  // A rejected request provides no acknowledgement that the native session
  // changed. Treat it as unavailable for the rest of this capture: restoring
  // the last acknowledged values is the only state the UI can claim truthfully.
  const nativeAudioUnavailable =
    !input.result || input.result.reasonCode === 'native-audio-unavailable'
  return {
    rollback: input.lastApplied,
    disableForSession: nativeAudioUnavailable,
    message: nativeAudioUnavailable
      ? 'Live microphone controls are unavailable for this capture. The previous gain and mute settings were restored.'
      : 'The live microphone change was not applied. The previous gain and mute settings were restored.'
  }
}
