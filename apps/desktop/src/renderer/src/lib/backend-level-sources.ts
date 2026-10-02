// Plan 092 Phase C: the backend's post-gain levels as audiocn meter sources.
// The bus measures the processed microphone, the gained system audio and the
// mix as written, so these read exactly what the recording and the stream
// get, about 20 times a second.

import { SILENCE_DB } from './audio/decibels'
import type { ChannelLevel, FrameSource, MeterFrame } from './audio/types'
import { AUDIO_LEVEL_FLOOR_DB, type AudioLevelReading, type AudioLevelsEvent } from './backend'
import type { BackendAudioLevelsStore } from './backend-audio-levels'

export type BackendLevelKind = keyof Pick<AudioLevelsEvent, 'microphone' | 'systemAudio' | 'master'>

/** The wire floor (JSON cannot carry -Infinity) read back as digital silence. */
function wireDb(db: number): number {
  return db <= AUDIO_LEVEL_FLOOR_DB ? SILENCE_DB : db
}

/** One reading into a reused meter level; a missing reading is silence. */
export function writeBackendLevel(
  reading: AudioLevelReading | undefined,
  level: ChannelLevel
): ChannelLevel {
  level.peakDb = reading ? wireDb(reading.peakDb) : SILENCE_DB
  level.rmsDb = reading ? wireDb(reading.rmsDb) : SILENCE_DB
  return level
}

/**
 * One backend source as an audiocn meter source. A source missing from an
 * event (system audio not mixed in that window) reads as silence. The frame
 * is one reused object.
 */
export function createBackendLevelSource(
  store: Pick<BackendAudioLevelsStore, 'subscribe'>,
  kind: BackendLevelKind
): FrameSource<MeterFrame> {
  const level: ChannelLevel = { peakDb: SILENCE_DB, rmsDb: SILENCE_DB }
  const frame: MeterFrame = { channels: [level] }
  return {
    subscribe: (listener) =>
      store.subscribe((event) => {
        writeBackendLevel(event[kind], level)
        listener(frame)
      })
  }
}
