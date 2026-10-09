import { describe, expect, it } from 'vitest'

import { CLIP_MARK_IN_REPORT, clipMarkedToast, formatClipMarkClock } from './clip-marks'

describe('clip mark clock', () => {
  it('reads m:ss below an hour and h:mm:ss from one hour', () => {
    expect(formatClipMarkClock(0)).toBe('0:00')
    expect(formatClipMarkClock(61.9)).toBe('1:01')
    expect(formatClipMarkClock(754.2)).toBe('12:34')
    expect(formatClipMarkClock(3600)).toBe('1:00:00')
    expect(formatClipMarkClock(3725)).toBe('1:02:05')
    expect(formatClipMarkClock(-4)).toBe('0:00')
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
      title: "Recording is off, so this clip can't be saved.",
      description: 'Turn on Record in the Studio to keep clips from a stream.'
    })
  })
})
