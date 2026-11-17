import { describe, expect, it } from 'vitest'
import { validateBackendRpcParams, validateBackendRpcResult } from './backend-rpc-contract'
describe('host speech RPC boundary', () => {
  const owner = {
    showId: 'show-a',
    sourceId: 'source-a',
    generation: 1,
    published: true,
    muted: false
  }
  const frame = { sourceId: 'source-a', sequence: 1, sampleRate: 48000, samples: [0, 0.1, -0.1] }
  it('accepts the bounded host publication and PCM contracts', () => {
    expect(validateBackendRpcParams('cloud.speech.sync', owner)).toEqual(owner)
    expect(validateBackendRpcParams('cloud.speech.audio', frame)).toEqual(frame)
  })
  it('rejects guest identity assertions, unknown fields and oversized or malformed PCM', () => {
    for (const value of [
      { ...owner, guest: 'guest:a' },
      { ...owner, generation: -1 },
      { ...owner, generation: 0 },
      { ...owner, showId: '' }
    ])
      expect(() => validateBackendRpcParams('cloud.speech.sync', value)).toThrow()
    for (const samples of [[], [NaN], [Infinity], [1.01], new Array(4801).fill(0)])
      expect(() => validateBackendRpcParams('cloud.speech.audio', { ...frame, samples })).toThrow()
    expect(() =>
      validateBackendRpcParams('cloud.speech.audio', { ...frame, sequence: 0 })
    ).toThrow()
  })
  it('never promotes simulated observations to production qualification', () => {
    const status = {
      uploadAllowed: true,
      sourceId: 'source-a',
      reason: 'host-only',
      productionQualified: false
    }
    expect(validateBackendRpcResult('cloud.speech.sync', status)).toEqual(status)
    expect(() =>
      validateBackendRpcResult('cloud.speech.sync', { ...status, productionQualified: true })
    ).toThrow()
  })
  it('persists source-clock cues without inventing a native capture or show-clock proof', () => {
    const cue = {
      sourceId: 'source-a',
      speechSessionId: 'speech-a',
      seq: 1,
      offsetSeconds: 1,
      durationSeconds: 2,
      text: 'Host words',
      clockBasis: 'processed-host-source',
      clock: {
        basis: 'show-created-at-wall-estimate',
        showCreatedAt: null,
        sourceObservedAt: '2026-11-16T00:00:00Z',
        showOffsetSeconds: null,
        uncertaintyMs: null
      }
    }
    expect(validateBackendRpcResult('cloud.speech.transcript', [cue])).toEqual([cue])
    expect(() =>
      validateBackendRpcResult('cloud.speech.transcript', [
        { ...cue, clockBasis: 'native-session' }
      ])
    ).toThrow()
  })
  it('requires bounded current-session caption pixels with independent output flags', () => {
    const overlay = {
      sessionClientId: 'speech-a',
      expiresAt: 1000,
      stream: true,
      recording: false,
      frame: { pngBase64: 'AAAA', position: 'bottom', target: 'primary', styleRevision: 1 }
    }
    expect(validateBackendRpcParams('cloud.speech.overlay', overlay)).toEqual(overlay)
    for (const patch of [
      { guestId: 'g' },
      { expiresAt: NaN },
      { frame: { ...overlay.frame, url: 'https://other' } }
    ])
      expect(() =>
        validateBackendRpcParams('cloud.speech.overlay', { ...overlay, ...patch })
      ).toThrow()
  })
})
