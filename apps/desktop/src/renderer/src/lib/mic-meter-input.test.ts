import { describe, expect, it } from 'vitest'

import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import type { MicStreamFailureReason } from '@/lib/mic-stream'
import { systemAudioSwitchView } from '@/lib/system-audio'

import {
  MIC_SESSION_LEVEL_UNAVAILABLE_COPY,
  meterHasNoReading,
  micLevelUnavailableCopy,
  micMeterInput,
  micSessionLevelUnavailable,
  systemAudioMeterInput
} from './mic-meter-input'

// Issue 1064: on Windows the renderer analyser (Chromium, WASAPI) showed a
// healthy room while DirectShow handed the recording digital silence.
describe('micMeterInput during a session (issue 1064)', () => {
  const backend = createFrameEmitter<MeterFrame>()
  const analyser = createFrameEmitter<MeterFrame>()
  const base = {
    microphoneSelected: true,
    muted: false,
    backendSource: null,
    analyserDriven: true,
    source: analyser,
    backendPeakDb: null,
    sessionActive: false
  }

  it('paints the backend levels first, session or not', () => {
    expect(micMeterInput({ ...base, backendSource: backend })).toEqual({
      kind: 'source',
      source: backend
    })
    expect(micMeterInput({ ...base, backendSource: backend, sessionActive: true })).toEqual({
      kind: 'source',
      source: backend
    })
  })

  it('never paints the analyser while the bus runs: the 1 Hz backend level, or nothing', () => {
    expect(micMeterInput({ ...base, sessionActive: true })).toEqual({
      kind: 'value',
      peakDb: Number.NaN
    })
    expect(micMeterInput({ ...base, sessionActive: true, backendPeakDb: -18 })).toEqual({
      kind: 'value',
      peakDb: -18
    })
    // Outside a session the analyser is the honest picture, as before.
    expect(micMeterInput(base)).toEqual({ kind: 'source', source: analyser })
  })

  it('says the level is unavailable only for an unmuted session microphone with no reading', () => {
    const noReading = micMeterInput({ ...base, sessionActive: true })
    expect(meterHasNoReading(noReading)).toBe(true)
    expect(
      micSessionLevelUnavailable({
        microphoneSelected: true,
        muted: false,
        sessionActive: true,
        meter: noReading
      })
    ).toBe(true)
    expect(
      micSessionLevelUnavailable({
        microphoneSelected: true,
        muted: false,
        sessionActive: false,
        meter: noReading
      })
    ).toBe(false)
    expect(
      micSessionLevelUnavailable({
        microphoneSelected: true,
        muted: true,
        sessionActive: true,
        meter: micMeterInput({ ...base, muted: true, sessionActive: true })
      })
    ).toBe(false)
    expect(
      micSessionLevelUnavailable({
        microphoneSelected: false,
        muted: false,
        sessionActive: true,
        meter: micMeterInput({ ...base, microphoneSelected: false, sessionActive: true })
      })
    ).toBe(false)
    expect(MIC_SESSION_LEVEL_UNAVAILABLE_COPY).toMatch(/^Level unavailable\./)
    expect(MIC_SESSION_LEVEL_UNAVAILABLE_COPY).not.toMatch(/backend|analyser|Chromium/i)
  })
})

const REASONS: Array<MicStreamFailureReason | undefined> = [
  'no-media',
  'no-label-match',
  'ambiguous-label',
  'labels-hidden',
  'permission-denied',
  'device-busy',
  'device-missing',
  'overconstrained',
  'audio-context',
  'unknown',
  undefined
]

describe('micLevelUnavailableCopy (plan 080 S3)', () => {
  // The level only reaches `unavailable` after the OS granted the mic, yet
  // every failure used to say it "needs permission".
  it('mentions permission only when the mic was actually refused', () => {
    for (const reason of REASONS) {
      const copy = micLevelUnavailableCopy(reason)
      expect(/permission/i.test(copy), `${reason}: ${copy}`).toBe(reason === 'permission-denied')
    }
  })

  it('reassures that recording is unaffected wherever the backend capture is', () => {
    for (const reason of REASONS.filter((reason) => reason !== 'permission-denied')) {
      expect(micLevelUnavailableCopy(reason)).toContain('Recording still works.')
    }
    expect(micLevelUnavailableCopy('device-busy')).toContain(
      'Another app is using this microphone.'
    )
  })
})

describe('systemAudioMeterInput (plan 093)', () => {
  const source = createFrameEmitter<MeterFrame>()
  const live = { audioBusActive: true, mixed: true, backendLevelsLive: true, source }

  it.each(['recording', 'livestream', 'Clips ring'])(
    'takes the running %s bus source while levels arrive',
    () => {
      expect(systemAudioMeterInput(live)).toEqual({ kind: 'source', source })
    }
  )

  it.each([
    { requested: true, confirmed: false },
    { requested: false, confirmed: true },
    { requested: false, confirmed: false }
  ])('has no reading while pending or Off: %j', ({ requested, confirmed }) => {
    const view = systemAudioSwitchView({
      device: { status: 'available' },
      sessionActive: false,
      audioBusActive: true,
      requested,
      confirmed,
      joining: false,
      issue: null
    })
    expect(meterHasNoReading(systemAudioMeterInput({ ...live, mixed: view.meter }))).toBe(true)
  })

  it('has no reading otherwise, never a silent source that looks measured', () => {
    for (const input of [
      { ...live, audioBusActive: false },
      { ...live, mixed: false },
      { ...live, backendLevelsLive: false }
    ]) {
      expect(meterHasNoReading(systemAudioMeterInput(input))).toBe(true)
    }
  })
})
