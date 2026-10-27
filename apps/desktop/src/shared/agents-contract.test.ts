import { describe, expect, it } from 'vitest'

import {
  validateBackendEventPayload,
  validateBackendRpcParams,
  validateBackendRpcResult
} from './backend-rpc-contract'

// Plan 209 S2/S3: the Agents RPCs and events are strict. The shapes below are
// what the backend serializes (`agent_mcp.rs`, `agent_call.rs`): no nulls, no
// token outside `agents.create`, no unknown field.

const agent = {
  id: '6f1c2c1e-1f7a-4a59-9f43-6a3d6f1b9c11',
  name: 'Claude Desktop',
  client: 'claude-desktop',
  createdAt: '2026-10-27T10:00:00+00:00',
  lastUsedAt: '2026-10-27T10:01:00+00:00',
  lastAction: { tool: 'notify', at: '2026-10-27T10:01:00+00:00', outcome: 'ok' },
  connected: true
}

const status = {
  enabled: true,
  port: 7440,
  discoveryPath: '/Users/streamer/Library/Application Support/Videorc/agents.json',
  agents: [agent],
  connectedCount: 1,
  studioOpen: true
}

describe('Agents contract (plan 209)', () => {
  it('accepts the status the backend sends, on and off', () => {
    expect(validateBackendRpcResult('agents.status', status)).toEqual(status)
    const off = { enabled: false, agents: [], connectedCount: 0, studioOpen: false }
    expect(validateBackendRpcResult('agents.disable', off)).toEqual(off)
    expect(validateBackendEventPayload('agents.status', status)).toEqual(status)
    const busy = { ...off, enabled: true, bindError: 'Ports 7440–7449 are all in use.' }
    expect(validateBackendRpcResult('agents.enable', busy)).toEqual(busy)
  })

  it('refuses nulls, token hashes and tokens outside agents.create', () => {
    expect(() => validateBackendRpcResult('agents.status', { ...status, port: null })).toThrow()
    expect(() =>
      validateBackendRpcResult('agents.status', {
        ...status,
        agents: [{ ...agent, tokenHash: '0'.repeat(64) }]
      })
    ).toThrow()
    expect(() =>
      validateBackendRpcResult('agents.status', { ...status, token: 'vrc_agent_x' })
    ).toThrow()
    const created = { agent, token: `vrc_agent_${'a'.repeat(64)}` }
    expect(validateBackendRpcResult('agents.create', created)).toEqual(created)
  })

  it('checks the create, remove and activity params', () => {
    expect(validateBackendRpcParams('agents.create', { name: 'Cursor', client: 'cursor' })).toEqual(
      { name: 'Cursor', client: 'cursor' }
    )
    expect(() => validateBackendRpcParams('agents.create', { name: 'X', client: 'zed' })).toThrow()
    expect(() => validateBackendRpcParams('agents.remove', {})).toThrow()
    expect(validateBackendRpcParams('agents.activity.list', undefined)).toBeUndefined()
    expect(() => validateBackendRpcParams('agents.activity.list', { limit: 5000 })).toThrow()
  })

  it('accepts an activity row and an intent, and the renderer-only answers', () => {
    const entry = {
      id: 'b5d0a4b0-0000-4000-8000-000000000001',
      at: '2026-10-27T10:02:00+00:00',
      agentId: agent.id,
      agentName: agent.name,
      tool: 'set_banner',
      summary: '{"shown":false}',
      outcome: 'ok',
      message: 'Every banner is hidden.'
    }
    expect(validateBackendEventPayload('agents.activity', entry)).toEqual(entry)
    expect(validateBackendRpcResult('agents.activity.list', { entries: [entry] })).toEqual({
      entries: [entry]
    })
    expect(() =>
      validateBackendEventPayload('agents.activity', { ...entry, outcome: 'maybe' })
    ).toThrow()

    const intent = {
      intentId: 'ai-1',
      agentId: agent.id,
      agentName: agent.name,
      tool: 'notify',
      args: { message: 'the sponsor banner is up' }
    }
    expect(validateBackendEventPayload('agent.intent', intent)).toEqual(intent)
    expect(() => validateBackendEventPayload('agent.intent', { ...intent, token: 'x' })).toThrow()

    const ack = { intentId: 'ai-1', ok: true, message: 'Shown.', result: { shown: true } }
    expect(validateBackendRpcParams('agent.intent.ack', ack)).toEqual(ack)
    expect(validateBackendRpcResult('agent.intent.ack', { ok: true })).toEqual({ ok: true })
    expect(validateBackendRpcParams('agent.surface.publish', { surface: { scenes: [] } })).toEqual({
      surface: { scenes: [] }
    })
    expect(() => validateBackendRpcParams('agent.surface.publish', {})).toThrow()
  })
})
