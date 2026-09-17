import { describe, expect, it } from 'vitest'

import { BackendClient } from '@/backendClient'

import { isReplacementPermissionClient } from './system-permission-orchestration'

function client(port: number, pid: number): BackendClient {
  return new BackendClient({ host: '127.0.0.1', port, pid, token: `token-${pid}` })
}

describe('isReplacementPermissionClient', () => {
  it('rejects both the renderer client from before the prompt and an unpublished stale backend', () => {
    const beforePrompt = client(9988, 101)
    const staleBackend = { port: 9989, pid: 202 }
    const proof = { previousClient: beforePrompt, staleBackend }

    expect(isReplacementPermissionClient(beforePrompt, proof)).toBe(false)
    expect(isReplacementPermissionClient(client(9989, 202), proof)).toBe(false)
    expect(isReplacementPermissionClient(client(9990, 303), proof)).toBe(true)
  })
})
