import { describe, expect, it } from 'vitest'

import type { MicStreamFailureReason } from '@/lib/mic-stream'

import { micPreviewUnavailableCopy } from './mic-picker-preview'

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

describe('micPreviewUnavailableCopy', () => {
  // Plan 080 S3: the preview only reaches `unavailable` after the OS granted
  // the mic, yet every failure used to say it "needs permission".
  it('mentions permission only when the mic was actually refused', () => {
    for (const reason of REASONS) {
      const copy = micPreviewUnavailableCopy(reason)
      expect(/permission/i.test(copy), `${reason}: ${copy}`).toBe(reason === 'permission-denied')
    }
  })

  it('reassures that recording is unaffected wherever the backend capture is', () => {
    for (const reason of REASONS.filter((reason) => reason !== 'permission-denied')) {
      expect(micPreviewUnavailableCopy(reason)).toContain('Recording still works.')
    }
    expect(micPreviewUnavailableCopy('device-busy')).toContain('Another app is using this mic.')
  })
})
