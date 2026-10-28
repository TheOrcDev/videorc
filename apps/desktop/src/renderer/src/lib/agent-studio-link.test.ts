import { describe, expect, it, vi } from 'vitest'

import { AgentStudioLink, type AgentStudioLinkHooks } from './agent-studio-link'
import type { AgentSurfacePublisher } from './agent-surface'
import type { AgentIntent } from './studio-actions/agent'

// Plan 209 S6: the Studio's link to agents, loaded lazily with each Studio
// socket: it says the socket runs agent intents, follows Agents on and off,
// and acks every tool call it runs.

function fakeClient(status = { enabled: true }) {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === 'agents.status') return status
    return { ok: true }
  })
  const requestTyped = vi.fn(async (_method: string) => ({ acknowledged: true }))
  return {
    request,
    requestTyped,
    on(event: string, handler: (payload: unknown) => void) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    },
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    listeners: (event: string) => handlers.get(event)?.size ?? 0
  }
}

function fakePublisher() {
  return {
    attach: vi.fn(),
    markConnected: vi.fn(),
    setEnabled: vi.fn(),
    sync: vi.fn(),
    detach: vi.fn()
  }
}

function link(
  client = fakeClient(),
  hooks: Partial<AgentStudioLinkHooks> = {},
  publisher = fakePublisher()
) {
  const allHooks: AgentStudioLinkHooks = {
    run: vi.fn(async () => ({ ok: true, message: 'Recording.' })),
    recordingRenamed: vi.fn(),
    reportError: vi.fn(),
    ...hooks
  }
  const instance = new AgentStudioLink(
    client as never,
    allHooks,
    publisher as unknown as AgentSurfacePublisher
  )
  return { instance, client, hooks: allHooks, publisher }
}

const intent: AgentIntent = {
  intentId: 'intent-1',
  agentId: 'agent-1',
  agentName: 'Claude',
  tool: 'start_recording',
  args: {}
}

describe('AgentStudioLink (plan 209 S6)', () => {
  it('listens for agent intents and reads Agents on every (re)connect', async () => {
    const { instance, client, publisher } = link()
    expect(publisher.attach).toHaveBeenCalledWith(client)
    expect(client.requestTyped).not.toHaveBeenCalled()

    instance.markConnected()
    expect(publisher.markConnected).toHaveBeenCalledTimes(1)
    expect(client.requestTyped).toHaveBeenCalledWith('agent.intent.listen')
    await vi.waitFor(() => expect(publisher.setEnabled).toHaveBeenCalledWith(true))

    instance.markConnected()
    expect(client.requestTyped).toHaveBeenCalledTimes(2)
  })

  it('follows agents.status events', () => {
    const { client, publisher } = link()
    client.emit('agents.status', { enabled: false })
    expect(publisher.setEnabled).toHaveBeenLastCalledWith(false)
  })

  it("runs an agent's tool on its lane and acks the outcome", async () => {
    const { client, hooks } = link()
    client.emit('agent.intent', intent)
    expect(hooks.run).toHaveBeenCalledWith(intent)
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith('agent.intent.ack', {
        intentId: 'intent-1',
        ok: true,
        message: 'Recording.'
      })
    )
  })

  it('acks a tool that threw with a plain sentence and reports the error', async () => {
    const error = new Error('boom')
    const { client, hooks } = link(fakeClient(), { run: vi.fn(async () => Promise.reject(error)) })
    client.emit('agent.intent', intent)
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith('agent.intent.ack', {
        intentId: 'intent-1',
        ok: false,
        message: 'Something went wrong in Videorc.'
      })
    )
    expect(hooks.reportError).toHaveBeenCalledWith(error)
  })

  it('refreshes the Library only for a successful rename', () => {
    const { client, hooks } = link()
    client.emit('agents.activity', { tool: 'rename_recording', outcome: 'refused' })
    client.emit('agents.activity', { tool: 'set_banner', outcome: 'ok' })
    expect(hooks.recordingRenamed).not.toHaveBeenCalled()
    client.emit('agents.activity', { tool: 'rename_recording', outcome: 'ok' })
    expect(hooks.recordingRenamed).toHaveBeenCalledTimes(1)
  })

  it('hands the Studio inputs to the projection, and lets go of the socket on detach', () => {
    const { instance, client, publisher } = link()
    const input = { recordBlockedReason: null } as never
    instance.sync(input)
    expect(publisher.sync).toHaveBeenCalledWith(input)

    instance.detach()
    expect(publisher.detach).toHaveBeenCalled()
    expect(client.listeners('agent.intent')).toBe(0)
    expect(client.listeners('agents.status')).toBe(0)
    expect(client.listeners('agents.activity')).toBe(0)
  })
})
