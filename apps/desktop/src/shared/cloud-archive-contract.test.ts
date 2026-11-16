import { describe, it, expect } from 'vitest'
import { validateBackendRpcParams, validateBackendRpcResult } from './backend-rpc-contract'
describe('cloud archive wire boundary', () => {
  it('requires consent, bounded orientation and rejects arbitrary options', () => {
    const value = { consent: true, showId: 'sh_fixture', orientation: 'h' }
    expect(validateBackendRpcParams('cloud.archive.start', value)).toEqual(value)
    expect(() =>
      validateBackendRpcParams('cloud.archive.start', { ...value, consent: false })
    ).toThrow()
    expect(() =>
      validateBackendRpcParams('cloud.archive.start', { ...value, recordOn: true })
    ).toThrow()
    expect(() =>
      validateBackendRpcParams('cloud.archive.start', { ...value, orientation: '4k' })
    ).toThrow()
  })
  it('interrupted and partial states cannot claim completion or leak local paths', () => {
    const job = {
      id: 'archive',
      showId: 'show',
      state: 'partial',
      reason: 'missing segments',
      bytes: 1,
      segments: 1,
      localSessionId: null
    }
    expect(validateBackendRpcResult('cloud.archive.status', [job])).toEqual([job])
    expect(() =>
      validateBackendRpcResult('cloud.archive.status', [{ ...job, token: 'secret' }])
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('cloud.archive.status', [{ ...job, path: '/private/file' }])
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('cloud.archive.status', [{ ...job, state: 'qualified' }])
    ).toThrow()
  })
})
