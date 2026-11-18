import { describe, expect, it } from 'vitest'
import { validateBackendRpcParams, validateBackendRpcResult } from './backend-rpc-contract'
import { clipMarkedToast } from './clip-marks'
describe('cloud Clips contract', () => {
  it('requires consent and distinguishes cloud buffer generation from a native session', () => {
    expect(() =>
      validateBackendRpcParams('cloud.clips.enable', {
        showId: 'sh_room',
        orientation: 'h',
        requestId: '00000000-0000-4000-8000-000000000001'
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcParams('cloud.clips.enable', {
        showId: 'sh_room',
        consent: true,
        orientation: 'h',
        requestId: '00000000-0000-4000-8000-000000000001'
      })
    ).not.toThrow()
    expect(() =>
      validateBackendRpcParams('cloud.clips.save', { showId: 'sh_room', markerId: 'marker' })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('cloud.clips.status', {
        available: false,
        enabled: false,
        generation: null,
        state: 'off',
        reason: 'unqualified',
        sessionId: 'fabricated'
      })
    ).toThrow()
  })
  it('queues honestly without claiming a file or measured media', () => {
    expect(
      clipMarkedToast({
        showId: 'sh_room',
        markerId: 'marker',
        atSeconds: 35.25,
        source: 'manual',
        saved: true,
        reason: 'cloud-clip-queued'
      }).title
    ).toBe('Marker saved; clip queued')
    expect(() =>
      validateBackendRpcResult('cloud.clips.jobs', [
        {
          id: 'clip_one',
          showId: 'sh_room',
          markerId: 'marker',
          state: 'interrupted',
          reason: 'Retry',
          localSessionId: null
        }
      ])
    ).not.toThrow()
  })
})
