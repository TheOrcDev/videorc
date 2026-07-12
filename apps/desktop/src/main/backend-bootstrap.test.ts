import { describe, expect, it } from 'vitest'

import { parseBackendBootstrap, publicBackendConnectionJson } from './backend-bootstrap'

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
})
