import { describe, expect, it } from 'vitest'

import {
  PROOF_POLLING_MIN_MAX_WIDTH,
  PROOF_POLLING_WIDTH_STEP,
  nativePreviewProofFrameUrl,
  nativePreviewProofPollingMaxWidth,
  nativePreviewProofPollingProfile,
  nativePreviewProofPollingProfileKey,
  nativePreviewProofPresentStatus
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

  it('caps the requested width at the DPR-aware surface width, quantized up', () => {
    // A 1280px-wide proof window at 1.25 DPR displays 1600 physical pixels —
    // fetching 1920px sources would be wasted decode + resize work.
    expect(nativePreviewProofPollingProfile(false, 1600)).toEqual({
      intervalMs: 40,
      maxWidth: 1600
    })
    // Mid-bucket widths round UP so the surface is never undersupplied.
    expect(nativePreviewProofPollingProfile(false, 1444).maxWidth).toBe(
      Math.ceil(1444 / PROOF_POLLING_WIDTH_STEP) * PROOF_POLLING_WIDTH_STEP
    )
  })

  it('never exceeds the profile ceiling for oversized surfaces', () => {
    expect(nativePreviewProofPollingProfile(false, 5120).maxWidth).toBe(1920)
    expect(nativePreviewProofPollingProfile(true, 5120).maxWidth).toBe(960)
  })

  it('holds the documented quality floor for tiny proof windows', () => {
    expect(nativePreviewProofPollingProfile(false, 180).maxWidth).toBe(PROOF_POLLING_MIN_MAX_WIDTH)
    expect(nativePreviewProofPollingProfile(true, 1).maxWidth).toBe(PROOF_POLLING_MIN_MAX_WIDTH)
  })

  it('fails open to the full profile cap when geometry is unknown or invalid', () => {
    expect(nativePreviewProofPollingMaxWidth(1920, undefined)).toBe(1920)
    expect(nativePreviewProofPollingMaxWidth(1920, Number.NaN)).toBe(1920)
    expect(nativePreviewProofPollingMaxWidth(1920, 0)).toBe(1920)
    expect(nativePreviewProofPollingMaxWidth(1920, -400)).toBe(1920)
  })

  it('quantizes so live resizes only change the profile across width buckets', () => {
    const inBucketA = nativePreviewProofPollingMaxWidth(1920, 1441)
    const inBucketB = nativePreviewProofPollingMaxWidth(1920, 1599)
    expect(inBucketA).toBe(inBucketB)
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

describe('nativePreviewProofPresentStatus', () => {
  it('carries exactly the fields the proof script consumes', () => {
    const compact = nativePreviewProofPresentStatus({
      state: 'live',
      framesRendered: 812,
      frameAgeMs: 21,
      width: 1920,
      sceneRevision: 14,
      sources: [
        { kind: 'screen', state: 'live', frames: 999, lastError: 'noise' } as never,
        { kind: 'camera', state: 'starting' }
      ]
    })

    expect(compact).toEqual({
      state: 'live',
      framesRendered: 812,
      frameAgeMs: 21,
      width: 1920,
      sceneRevision: 14,
      sources: [
        { kind: 'screen', state: 'live' },
        { kind: 'camera', state: 'starting' }
      ]
    })
    // The full diagnostics payload must never leak onto the present hot path.
    expect(JSON.stringify(compact)).not.toContain('lastError')
  })

  it('omits absent optionals and defaults sources to an empty list', () => {
    expect(
      nativePreviewProofPresentStatus({ state: 'starting', framesRendered: 0, width: 1280 })
    ).toEqual({ state: 'starting', framesRendered: 0, width: 1280, sources: [] })
  })
})
