import { describe, expect, it } from 'vitest'

import {
  SOUND_CHECK_COPY,
  SOUND_CHECK_WINDOW_MS,
  addSoundCheckSample,
  framePeakDb,
  soundCheckGainDb,
  soundCheckReading,
  type SoundCheckSample
} from './first-run-sound'

/** Readings every 50 ms (the warm microphone's rate) from `from` for `ms`. */
function talk(peakDb: number, ms: number, from = 0): SoundCheckSample[] {
  const samples: SoundCheckSample[] = []
  for (let at = from; at < from + ms; at += 50) samples.push({ at, peakDb })
  return samples
}

describe('framePeakDb', () => {
  it('reads the loudest channel', () => {
    expect(framePeakDb({ channels: [{ peakDb: -30 }, { peakDb: -12 }] })).toBe(-12)
  })

  it('is silence with no channels', () => {
    expect(framePeakDb({ channels: [] })).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('soundCheckReading', () => {
  it('has no verdict before three seconds of speech', () => {
    const samples = talk(-14, 2_500)
    expect(soundCheckReading(samples, 2_500)).toEqual({ verdict: 'none', speechPeakDb: null })
  })

  it('ignores room noise below the speech gate', () => {
    expect(soundCheckReading(talk(-52, 6_000), 6_000).verdict).toBe('none')
  })

  it('reads good speech in the meter speech zone', () => {
    expect(soundCheckReading(talk(-14, 4_000), 4_000)).toEqual({
      verdict: 'good',
      speechPeakDb: -14
    })
  })

  it('reads quiet speech', () => {
    expect(soundCheckReading(talk(-32, 4_000), 4_000).verdict).toBe('quiet')
  })

  it('reads loud speech', () => {
    expect(soundCheckReading(talk(-5, 4_000), 4_000).verdict).toBe('loud')
  })

  it('reads a clip as loud at once', () => {
    const samples = [...talk(-14, 500), { at: 500, peakDb: -0.5 }]
    expect(soundCheckReading(samples, 550).verdict).toBe('loud')
  })

  it('uses the 90th-percentile speech peak, not one stray loud word', () => {
    const samples = talk(-16, 4_000).map((sample, index) =>
      index === 10 ? { ...sample, peakDb: -4 } : sample
    )
    expect(soundCheckReading(samples, 4_000).verdict).toBe('good')
  })

  it('forgets speech older than the window', () => {
    const samples = talk(-14, 4_000)
    expect(soundCheckReading(samples, 4_000 + SOUND_CHECK_WINDOW_MS).verdict).toBe('none')
  })

  it('never counts a long gap between readings as speech', () => {
    const sparse: SoundCheckSample[] = [0, 1_000, 2_000, 3_000, 4_000].map((at) => ({
      at,
      peakDb: -14
    }))
    expect(soundCheckReading(sparse, 4_000).verdict).toBe('none')
  })
})

describe('addSoundCheckSample', () => {
  it('drops readings older than the window and keeps the input untouched', () => {
    const first = [{ at: 0, peakDb: -20 }]
    const next = addSoundCheckSample(first, { at: SOUND_CHECK_WINDOW_MS + 10, peakDb: -18 })
    expect(next).toEqual([{ at: SOUND_CHECK_WINDOW_MS + 10, peakDb: -18 }])
    expect(first).toHaveLength(1)
  })

  it('skips a NaN reading (nothing reads)', () => {
    expect(addSoundCheckSample([], { at: 0, peakDb: Number.NaN })).toEqual([])
  })
})

describe('soundCheckGainDb', () => {
  it('moves the speech peak to −12 dBFS', () => {
    expect(soundCheckGainDb(0, -30)).toBe(18)
    expect(soundCheckGainDb(4, -6)).toBe(-2)
  })

  it('rounds to whole dB', () => {
    expect(soundCheckGainDb(0, -20.4)).toBe(8)
  })

  it('stays inside the fader range at both ends', () => {
    expect(soundCheckGainDb(10, -50)).toBe(24)
    expect(soundCheckGainDb(-20, 0)).toBe(-24)
  })
})

describe('SOUND_CHECK_COPY', () => {
  it('has a line for every verdict', () => {
    expect(Object.keys(SOUND_CHECK_COPY).sort()).toEqual(['good', 'loud', 'none', 'quiet'])
  })
})
