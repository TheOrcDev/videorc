import { describe, expect, it } from 'vitest'

import type { MeterFrame } from './audio/types'
import type { AudioLevelsEvent } from './backend'
import { createBackendAudioLevelsStore } from './backend-audio-levels'
import { createBackendLevelSource, writeBackendLevel } from './backend-level-sources'

describe('backend level sources (plan 092 Phase C)', () => {
  it('reads the wire floor as digital silence and passes real levels through', () => {
    expect(writeBackendLevel({ peakDb: -120, rmsDb: -120 }, { peakDb: 0 })).toEqual({
      peakDb: Number.NEGATIVE_INFINITY,
      rmsDb: Number.NEGATIVE_INFINITY
    })
    expect(writeBackendLevel({ peakDb: -6, rmsDb: -18 }, { peakDb: 0 })).toEqual({
      peakDb: -6,
      rmsDb: -18
    })
    expect(writeBackendLevel(undefined, { peakDb: 0 }).peakDb).toBe(Number.NEGATIVE_INFINITY)
  })

  it('emits one reused meter frame per event for its own bus tap', () => {
    const store = createBackendAudioLevelsStore()
    const source = createBackendLevelSource(store, 'systemAudio')
    const frames: MeterFrame[] = []
    const peaks: number[] = []
    const stop = source.subscribe((frame) => {
      frames.push(frame)
      peaks.push(frame.channels[0].peakDb)
    })
    const withSystem: AudioLevelsEvent = {
      sessionId: 's',
      microphone: { peakDb: -12, rmsDb: -20 },
      systemAudio: { peakDb: -9, rmsDb: -15 },
      masterClippedSamples: 0
    }
    store.publish(withSystem)
    store.publish({
      sessionId: 's',
      microphone: { peakDb: -12, rmsDb: -20 },
      masterClippedSamples: 0
    })
    stop()
    store.publish(withSystem)
    expect(peaks).toEqual([-9, Number.NEGATIVE_INFINITY])
    expect(frames[0]).toBe(frames[1])
  })
})
