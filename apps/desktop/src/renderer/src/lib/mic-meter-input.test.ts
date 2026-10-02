import { describe, expect, it } from 'vitest'

import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import type { MicStreamFailureReason } from '@/lib/mic-stream'

import {
  meterHasNoReading,
  micLevelUnavailableCopy,
  systemAudioMeterInput
} from './mic-meter-input'

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
    expect(micLevelUnavailableCopy('device-busy')).toContain('Another app is using this mic.')
  })
})

describe('systemAudioMeterInput (plan 093)', () => {
  const source = createFrameEmitter<MeterFrame>()
  const live = { sessionActive: true, mixed: true, backendLevelsLive: true, source }

  it('takes the bus source only while a session mixes System audio and levels arrive', () => {
    expect(systemAudioMeterInput(live)).toEqual({ kind: 'source', source })
  })

  it('has no reading otherwise, never a silent source that looks measured', () => {
    for (const input of [
      { ...live, sessionActive: false },
      { ...live, mixed: false },
      { ...live, backendLevelsLive: false }
    ]) {
      expect(meterHasNoReading(systemAudioMeterInput(input))).toBe(true)
    }
  })
})
