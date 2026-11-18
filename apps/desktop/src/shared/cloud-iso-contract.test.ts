import fixture from '../../../../protocol-fixtures/cloud-source-iso.json'
import { describe, expect, it } from 'vitest'

import {
  isTypedBackendRpcMethod,
  validateBackendEventPayload,
  validateBackendRpcParams,
  validateBackendRpcResult
} from './backend-rpc-contract'

// Plan 249 S22: the separate-files (cloud ISO) wire boundary, as
// docs/cloud/249-s22-contract.md §5 freezes it.

const availability = {
  enabled: false,
  productionQualified: false,
  provider: {
    adapter: 'livekit-track-egress',
    sdkSupport: 'present-unexercised',
    facts: { readOn: '2026-11-16', microsPerTrackEgressMinute: 1_000, concurrentExports: 100 }
  },
  unmet: { managedAcceptance: 'not-run', ownerDecisionD8: 'pending' }
}

const status = {
  availability,
  iso: {
    request: {
      atMs: 1_800_000_000_000,
      consentVersion: 'iso-consent-v1',
      maxActiveEntries: 12,
      maxMinutes: 120,
      costCeilingMicros: 1_440_000,
      retentionDays: 30
    },
    lastRefusal: null,
    guestConsent: [{ identity: 'g_ann', atMs: 1_800_000_000_100 }],
    takes: [{ manifest: fixture.valid, programRecordingId: 'rec_program' }]
  }
}

describe('cloud ISO wire boundary (Plan 249 S22)', () => {
  it('declares every method of §5', () => {
    for (const method of [
      'cloud.iso.status',
      'cloud.iso.enable',
      'cloud.iso.disable',
      'cloud.iso.import',
      'cloud.iso.imports',
      'cloud.iso.cancelImport'
    ]) {
      expect(isTypedBackendRpcMethod(method), method).toBe(true)
    }
  })

  it('reads the web availability and status, and refuses unknown fields', () => {
    expect(validateBackendRpcResult('cloud.iso.status', status)).toEqual(status)
    expect(validateBackendRpcResult('cloud.iso.status', { availability, iso: null })).toEqual({
      availability,
      iso: null
    })
    expect(validateBackendRpcResult('cloud.iso.enable', status)).toEqual(status)
    expect(validateBackendRpcResult('cloud.iso.disable', status)).toEqual(status)
    expect(() =>
      validateBackendRpcResult('cloud.iso.status', { ...status, url: 'https://x' })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('cloud.iso.status', {
        availability,
        iso: { ...status.iso, request: { ...status.iso.request, consentVersion: 'v2' } }
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('cloud.iso.status', {
        availability: { ...availability, qualified: true },
        iso: null
      })
    ).toThrow()
  })

  it('sends consent only as true, inside the web limits', () => {
    const params = {
      showId: 'sh_fixture',
      consent: true,
      maxActiveEntries: 12,
      maxMinutes: 120,
      costCeilingMicros: 1_440_000
    }
    expect(validateBackendRpcParams('cloud.iso.enable', params)).toEqual(params)
    expect(() =>
      validateBackendRpcParams('cloud.iso.enable', { ...params, consent: false })
    ).toThrow()
    expect(() =>
      validateBackendRpcParams('cloud.iso.enable', { ...params, consent: 'yes' })
    ).toThrow()
    const { consent: _consent, ...withoutConsent } = params
    expect(() => validateBackendRpcParams('cloud.iso.enable', withoutConsent)).toThrow()
    expect(() =>
      validateBackendRpcParams('cloud.iso.enable', { ...params, maxActiveEntries: 13 })
    ).toThrow()
    expect(() =>
      validateBackendRpcParams('cloud.iso.enable', { ...params, maxMinutes: 181 })
    ).toThrow()
    expect(() =>
      validateBackendRpcParams('cloud.iso.enable', { ...params, costCeilingMicros: 5_000_001 })
    ).toThrow()
    expect(validateBackendRpcParams('cloud.iso.disable', { showId: 'sh_fixture' })).toEqual({
      showId: 'sh_fixture'
    })
  })

  it('imports with the same folder capability as a cloud download', () => {
    const params = {
      showId: 'sh_fixture',
      takeId: 'tk_AbCdEf123456',
      outputDirectoryCapability: 'cap'
    }
    expect(validateBackendRpcParams('cloud.iso.import', params)).toEqual(params)
    expect(() =>
      validateBackendRpcParams('cloud.iso.import', { ...params, entries: ['host/host-camera/g1'] })
    ).toThrow()
    expect(validateBackendRpcResult('cloud.iso.import', { jobId: 'job_1' })).toEqual({
      jobId: 'job_1'
    })
    expect(validateBackendRpcParams('cloud.iso.imports', {})).toEqual({})
    expect(validateBackendRpcParams('cloud.iso.cancelImport', { jobId: 'job_1' })).toEqual({
      jobId: 'job_1'
    })
    expect(validateBackendRpcResult('cloud.iso.cancelImport', { ok: true })).toEqual({ ok: true })
  })

  it('reads the import journal and events, never a path', () => {
    const record = {
      entryId: 'host/host-camera/g1',
      objectKey: 'talk/u/sh/h/tk_AbCdEf123456/iso/host-camera/host-g1.webm',
      expectedBytes: 900_000,
      state: 'complete',
      attempts: 1,
      localFileName: 'tk_AbCdEf123456-iso-host-camera-host-g1.webm',
      bytes: 900_000,
      error: null
    }
    const journal = {
      showId: 'sh_fixture',
      takeId: 'tk_AbCdEf123456',
      programRecordingId: 'rec_program',
      records: [record]
    }
    expect(validateBackendRpcResult('cloud.iso.imports', [journal])).toEqual([journal])
    expect(() =>
      validateBackendRpcResult('cloud.iso.imports', [
        { ...journal, records: [{ ...record, path: '/Users/me/Movies/file.webm' }] }
      ])
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('cloud.iso.imports', [
        { ...journal, records: [{ ...record, state: 'qualified' }] }
      ])
    ).toThrow()

    const event = {
      jobId: 'job_1',
      showId: 'sh_fixture',
      takeId: 'tk_AbCdEf123456',
      entryId: 'host/host-camera/g1',
      state: 'complete',
      bytes: 900_000,
      error: null,
      localSessionId: 'cloud-iso-tk_AbCdEf123456-host-host-camera-g1'
    }
    expect(validateBackendEventPayload('cloud.iso.import', event)).toEqual(event)
    // A job-level failure may name no file; skipped Options are read too.
    const jobFailure = {
      jobId: 'job_1',
      showId: 'sh_fixture',
      takeId: 'tk_AbCdEf123456',
      entryId: null,
      state: 'failed',
      error: 'manifest unavailable'
    }
    expect(validateBackendEventPayload('cloud.iso.import', jobFailure)).toEqual(jobFailure)
    expect(() =>
      validateBackendEventPayload('cloud.iso.import', { ...event, path: '/private/file' })
    ).toThrow()
    expect(() =>
      validateBackendEventPayload('cloud.iso.import', { ...event, state: 'running' })
    ).toThrow()
  })
})
