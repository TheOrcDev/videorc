import { describe, expect, it } from 'vitest'

import {
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

  it('contains proof-PNG work while recording without blanking the Windows preview', () => {
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
})
