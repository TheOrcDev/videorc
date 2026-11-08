import { describe, expect, it } from 'vitest'

import { sessionOutputSummary } from './session-output-video'

const saved = { preset: 'custom', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 } as const
const shared = { preset: 'custom', width: 1920, height: 1080, fps: 30, bitrateKbps: 6000 } as const

describe('sessionOutputSummary (release test 146, plan 0004)', () => {
  it('names the stream profile while live when the recording matches the stream', () => {
    expect(
      sessionOutputSummary({ live: true, recordEnabled: true, saved, sharedFallback: shared })
    ).toBe('1080p · 30 fps · matches the stream')
  })

  it('keeps the saved recording size off-air and in a recording-only session', () => {
    expect(
      sessionOutputSummary({ live: false, recordEnabled: true, saved, sharedFallback: shared })
    ).toBe('720p · 30 fps')
    expect(
      sessionOutputSummary({ live: true, recordEnabled: true, saved, sharedFallback: null })
    ).toBe('720p · 30 fps')
  })

  it('names the stream profile without the recording note for a stream-only session', () => {
    expect(
      sessionOutputSummary({
        live: true,
        recordEnabled: false,
        saved,
        sharedFallback: null,
        streamVideo: shared
      })
    ).toBe('1080p · 30 fps')
  })
})
