import { describe, expect, it } from 'vitest'

import {
  backendOwnershipLineageMatches,
  backendReadyMatchesOwnershipMarker,
  observeBackendOwnershipMarker,
  parseBackendBootstrap,
  parseBackendProcessOwnership,
  publicBackendConnectionJson
} from './backend-bootstrap'

describe('backend bootstrap authority split', () => {
  it('keeps admin credential out of renderer connection and smoke serialization', () => {
    const adminToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const parsed = parseBackendBootstrap({
      host: '127.0.0.1',
      port: 9876,
      token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      adminToken,
      pid: 42
    })
    expect(parsed.renderer.token).not.toBe(adminToken)
    expect(parsed.admin.token).toBe(adminToken)
    expect(JSON.stringify(parsed.renderer)).not.toContain(adminToken)
    expect(publicBackendConnectionJson(parsed.renderer)).not.toContain(adminToken)
    expect(publicBackendConnectionJson(parsed.renderer)).not.toContain('adminToken')
  })

  it('rejects reused or malformed credentials', () => {
    const token = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    expect(() =>
      parseBackendBootstrap({
        host: '127.0.0.1',
        port: 9876,
        token,
        adminToken: token
      })
    ).toThrow(/invalid/)
    expect(() =>
      parseBackendBootstrap({
        host: '0.0.0.0',
        port: 9876,
        token,
        adminToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      })
    ).toThrow(/invalid/)
  })

  it('authenticates the early real-backend process identity independently of READY', () => {
    const token = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    expect(parseBackendProcessOwnership({ token, pid: 4242, parentPid: 101 }, token)).toEqual({
      pid: 4242,
      parentPid: 101
    })
    expect(() =>
      parseBackendProcessOwnership(
        { token: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', pid: 4242 },
        token
      )
    ).toThrow(/invalid/)
    expect(() => parseBackendProcessOwnership({ token, pid: 1 }, token)).toThrow(/invalid/)
    expect(() => parseBackendProcessOwnership({ token, pid: 4242.5 }, token)).toThrow(/invalid/)
    expect(parseBackendProcessOwnership({ token, pid: 4242, parentPid: null }, token)).toEqual({
      pid: 4242
    })
    expect(parseBackendProcessOwnership({ token, pid: 4242, parentPid: 1 }, token)).toEqual({
      pid: 4242,
      parentPid: 1
    })
  })

  it('binds one authenticated ownership PID to the later READY identity', () => {
    expect(observeBackendOwnershipMarker(undefined, 4242)).toEqual({
      markerPid: 4242,
      conflict: false
    })
    expect(observeBackendOwnershipMarker(4242, 4242)).toEqual({
      markerPid: 4242,
      conflict: false
    })
    expect(observeBackendOwnershipMarker(4242, 5252)).toEqual({
      markerPid: 4242,
      conflict: true
    })
    expect(backendReadyMatchesOwnershipMarker(undefined, 4242)).toBe(false)
    expect(backendReadyMatchesOwnershipMarker(4242, 5252)).toBe(false)
    expect(backendReadyMatchesOwnershipMarker(4242, 4242)).toBe(true)
  })

  it('treats parent PID as advisory without losing token-authenticated PID evidence', () => {
    expect(
      backendOwnershipLineageMatches({
        packaged: false,
        platform: 'darwin',
        wrapperPid: 101,
        backendPid: 4242,
        parentPid: 101
      })
    ).toBe(true)
    expect(
      backendOwnershipLineageMatches({
        packaged: false,
        platform: 'darwin',
        wrapperPid: 101,
        backendPid: 4242,
        parentPid: 1
      })
    ).toBe(false)
    expect(
      backendOwnershipLineageMatches({
        packaged: false,
        platform: 'win32',
        wrapperPid: 101,
        backendPid: 4242
      })
    ).toBe(true)
    expect(
      backendOwnershipLineageMatches({
        packaged: true,
        platform: 'darwin',
        wrapperPid: 101,
        backendPid: 4242,
        parentPid: 101
      })
    ).toBe(false)
  })
})
