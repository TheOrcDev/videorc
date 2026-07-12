import { describe, expect, it } from 'vitest'

import {
  nativePreviewProofFrameUrl,
  nativePreviewProofPollingProfile,
  nativePreviewProofPollingProfileKey
} from './native-preview-proof-polling'

describe('nativePreviewProofPollingProfile', () => {
  it('keeps the full-quality idle preview profile', () => {
    expect(nativePreviewProofPollingProfile(false)).toEqual({
      intervalMs: 40,
      maxWidth: 1920
    })
  })

  it('contains proof-BMP work while recording without blanking the Windows preview', () => {
    expect(nativePreviewProofPollingProfile(true)).toEqual({
      intervalMs: 125,
      maxWidth: 960
    })
  })

  it('invalidates an applied profile when the proof window is recreated', () => {
    const profile = nativePreviewProofPollingProfile(true)

    expect(nativePreviewProofPollingProfileKey(41, profile)).not.toBe(
      nativePreviewProofPollingProfileKey(42, profile)
    )
  })

  it('uses the backend camelCase maxWidth query contract', () => {
    const url = nativePreviewProofFrameUrl(
      'http://127.0.0.1:4312/preview/screen/latest.bmp?token=test',
      959.6
    )
    const parsed = new URL(url)

    expect(parsed.searchParams.get('maxWidth')).toBe('960')
    expect(parsed.searchParams.has('max_width')).toBe(false)
  })
})
