import { describe, expect, it } from 'vitest'

import {
  PROOF_POLLING_MIN_MAX_WIDTH,
  PROOF_POLLING_WIDTH_STEP,
  nativePreviewProofFrameTransport,
  nativePreviewProofFrameUrl,
  nativePreviewProofPollingMaxWidth,
  nativePreviewProofPollingProfile,
  nativePreviewProofPollingProfileKey,
  nativePreviewProofPresentStatus,
  previewSurfaceCreateTargetFps
} from './native-preview-proof-polling'

describe('nativePreviewProofPollingProfile', () => {
  it('keeps the full-quality idle preview profile', () => {
    expect(nativePreviewProofPollingProfile(false)).toEqual({
      intervalMs: 40,
      maxWidth: 1920,
      ceilingWidth: 1920
    })
  })

  it('keeps the full-quality Preview while recording', () => {
    // The proof surface is the production Preview on Linux and Windows: a
    // recording must not drop it to a stretched 960 px at 8 fps.
    expect(nativePreviewProofPollingProfile(true)).toEqual(nativePreviewProofPollingProfile(false))
    expect(nativePreviewProofPollingProfile(true, 1320)).toEqual({
      intervalMs: 40,
      maxWidth: 1440,
      ceilingWidth: 1920
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
      maxWidth: 1600,
      ceilingWidth: 1920
    })
    // Mid-bucket widths round UP so the surface is never undersupplied.
    expect(nativePreviewProofPollingProfile(false, 1444).maxWidth).toBe(
      Math.ceil(1444 / PROOF_POLLING_WIDTH_STEP) * PROOF_POLLING_WIDTH_STEP
    )
  })

  it('never exceeds the profile ceiling for oversized surfaces', () => {
    expect(nativePreviewProofPollingProfile(false, 5120).maxWidth).toBe(1920)
    expect(nativePreviewProofPollingProfile(true, 5120).maxWidth).toBe(1920)
  })

  it('keeps the unquantized profile ceiling for layers that measure their drawn width', () => {
    // A docked Preview whose geometry went stale at 941 px still lets a layer
    // drawn 1320 px wide ask for 1320, recording or not.
    expect(nativePreviewProofPollingProfile(false, 941).ceilingWidth).toBe(1920)
    expect(nativePreviewProofPollingProfile(true, 941).ceilingWidth).toBe(1920)
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

// Plan 257 S3: Linux waits for I420 frames; Windows keeps its interval BMP.
describe('nativePreviewProofFrameTransport', () => {
  it('picks the waiting I420 transport on Linux only', () => {
    expect(nativePreviewProofFrameTransport('linux', {})).toBe('wait-i420')
    expect(nativePreviewProofFrameTransport('win32', {})).toBe('interval')
    expect(nativePreviewProofFrameTransport('darwin', {})).toBe('interval')
  })

  it('takes only a known override', () => {
    expect(
      nativePreviewProofFrameTransport('linux', { VIDEORC_PROOF_FRAME_TRANSPORT: 'interval' })
    ).toBe('interval')
    expect(
      nativePreviewProofFrameTransport('win32', { VIDEORC_PROOF_FRAME_TRANSPORT: 'wait-i420' })
    ).toBe('wait-i420')
    expect(
      nativePreviewProofFrameTransport('linux', { VIDEORC_PROOF_FRAME_TRANSPORT: 'h264' })
    ).toBe('wait-i420')
  })
})

describe('previewSurfaceCreateTargetFps', () => {
  it('asks Linux for 30 fps status ticks and keeps 60 elsewhere', () => {
    expect(previewSurfaceCreateTargetFps('linux')).toBe(30)
    expect(previewSurfaceCreateTargetFps('darwin')).toBe(60)
    expect(previewSurfaceCreateTargetFps('win32')).toBe(60)
    expect(previewSurfaceCreateTargetFps(undefined)).toBe(60)
  })
})
