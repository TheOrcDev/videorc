import { describe, expect, it } from 'vitest'

import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import type { MicStreamFailureReason } from '@/lib/mic-stream'
import { systemAudioSwitchView } from '@/lib/system-audio'

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
