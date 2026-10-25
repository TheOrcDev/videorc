import { describe, expect, it } from 'vitest'

import {
  CLIP_LENGTHS,
  CLIP_MARK_CLIP_SAVED_REASON,
  CLIP_MARK_IN_REPORT,
  DEFAULT_CLIP_SECONDS,
  INVALID_CLIP_LENGTH_CODE,
  INVALID_CLIP_LENGTH_MESSAGE,
  LONG_CLIP_SECONDS,
  clipMarkParams,
  isClipLength,
  parseClipLength,
  clipLengthWords,
  clipMarkKeptSomething,
  clipMarkSavedClip,
  clipMarkedToast,
  clipSavingToast,
  formatClipMarkClock
} from './clip-marks'

describe('clip mark clock', () => {
  it('reads m:ss below an hour and h:mm:ss from one hour', () => {
    expect(formatClipMarkClock(0)).toBe('0:00')
    expect(formatClipMarkClock(61.9)).toBe('1:01')
    expect(formatClipMarkClock(754.2)).toBe('12:34')
    expect(formatClipMarkClock(3600)).toBe('1:00:00')
    expect(formatClipMarkClock(3725)).toBe('1:02:05')
    expect(formatClipMarkClock(-4)).toBe('0:00')
  })

  it('says the ring length in words', () => {
    expect(clipLengthWords(30)).toBe('30 seconds')
    expect(clipLengthWords(60)).toBe('1 minute')
    expect(clipLengthWords(120)).toBe('2 minutes')
    expect(clipLengthWords(90)).toBe('1.5 minutes')
    expect(clipLengthWords(undefined)).toBe('seconds')
  })
})

describe('clip marked toast', () => {
  it('points every saved mark at the stream report in Buddy (plan 119 S3)', () => {
    expect(CLIP_MARK_IN_REPORT).toBe("It's in your stream report in Buddy.")
    expect(
      clipMarkedToast({ sessionId: 's', atSeconds: 754.2, source: 'manual', saved: true })
    ).toEqual({
      kind: 'success',
      title: 'Clip marked at 12:34',
      description: "It's in your stream report in Buddy."
    })
    expect(
      clipMarkedToast(
        { sessionId: 's', atSeconds: 3725, source: 'voice', saved: true },
        { streaming: true }
      )
    ).toEqual({
      kind: 'success',
      title: 'Clip marked at 1:02:05',
      description: "It's in your stream report in Buddy."
    })
  })

  it('points nowhere for a recording that never went live: it has no stream report', () => {
    expect(
      clipMarkedToast(
        { sessionId: 's', atSeconds: 754.2, source: 'manual', saved: true },
        { streaming: false }
      )
    ).toEqual({ kind: 'success', title: 'Clip marked at 12:34', description: undefined })
  })

  it('says the ring is saving the clip, with or without a mark in the recording (plan 181 R4)', () => {
    const ringOnly = {
      sessionId: 's',
      atSeconds: 61.5,
      source: 'manual' as const,
      saved: false,
      reason: CLIP_MARK_CLIP_SAVED_REASON
    }
    expect(clipMarkSavedClip(ringOnly)).toBe(true)
    expect(clipMarkKeptSomething(ringOnly)).toBe(true)
    expect(clipMarkSavedClip({ reason: undefined })).toBe(false)
    expect(clipMarkKeptSomething({ saved: true, reason: undefined })).toBe(true)
    expect(clipMarkKeptSomething({ saved: false, reason: 'recording-off' })).toBe(false)
    expect(clipSavingToast(ringOnly, 30)).toEqual({
      kind: 'success',
      title: 'Saving the last 0:30 as a clip',
      description: "It's in Library in a moment."
    })
    expect(clipSavingToast({ saved: true }, 120)).toEqual({
      kind: 'success',
      title: 'Saving the last 2:00 as a clip',
      description: "It's in Library, and this moment is marked in your recording."
    })
    expect(clipSavingToast(ringOnly, undefined).title).toBe('Saving the last seconds as a clip')
  })

  it('explains an unsaved mark instead of confirming it', () => {
    const toast = clipMarkedToast({
      sessionId: 's',
      atSeconds: 61.5,
      source: 'voice',
      saved: false,
      reason: 'recording-off'
    })
    expect(toast).toEqual({
      kind: 'warning',
      title: 'Clips are off, and nothing is recording.',
      description: 'Turn on Keep the last seconds on the Output page, or start a recording.'
    })
  })
})

describe('clip lengths (plan 199)', () => {
  it('mirrors the backend: 30 s by default, 1 min beside it, nothing else', () => {
    expect(DEFAULT_CLIP_SECONDS).toBe(30)
    expect(LONG_CLIP_SECONDS).toBe(60)
    expect(CLIP_LENGTHS).toEqual([30, 60])
    expect(INVALID_CLIP_LENGTH_CODE).toBe('invalid-clip-length')
    expect(INVALID_CLIP_LENGTH_MESSAGE).toBe('A clip is 30 seconds or 1 minute.')
    for (const value of CLIP_LENGTHS) expect(isClipLength(value)).toBe(true)
    for (const value of [0, 15, 45, 120, '30', null, undefined, 30.5]) {
      expect(isClipLength(value)).toBe(false)
    }
  })

  it('reads a relayed length: none is the 30-second clip, an odd one is refused in words', () => {
    expect(parseClipLength(undefined)).toBeUndefined()
    expect(parseClipLength(null)).toBeUndefined()
    expect(parseClipLength(30)).toBe(30)
    expect(parseClipLength(60)).toBe(60)
    for (const value of [45, '60', 0, {}]) {
      expect(() => parseClipLength(value)).toThrow('A clip is 30 seconds or 1 minute.')
    }
  })

  it('sends no params for a press without a length, exactly as before', () => {
    expect(clipMarkParams()).toBeUndefined()
    expect(clipMarkParams(30)).toEqual({ seconds: 30 })
    expect(clipMarkParams(60)).toEqual({ seconds: 60 })
  })
})
