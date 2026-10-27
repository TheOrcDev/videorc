import { describe, expect, it, vi } from 'vitest'

import type {
  AgentActivityEntry,
  AgentSummary,
  AgentsStatus,
  BackendConnection
} from '@/lib/backend'

import {
  AGENTS_STORE_EVENTS,
  createAgentsStore,
  type AgentsClient,
  type AgentsStoreEvent
} from './agents-store'

// Plan 209 S7: one Agents store for the main window. It seeds from the
// backend, follows the pushed events (the backend publishes the status when
// an agent's presence lapses, so nothing polls), never asks for agent intents
// (only the Studio's socket runs them), and reconnects with main.

const CONNECTION: BackendConnection = {
  host: '127.0.0.1',
  port: 7000,
  token: 't'
} as BackendConnection

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: 'a1',
    name: 'Claude Desktop',
    client: 'claude-desktop',
    createdAt: '2026-10-27T12:00:00Z',
    connected: false,
    ...overrides
  }
}

function status(overrides: Partial<AgentsStatus> = {}): AgentsStatus {
  return {
    enabled: true,
    port: 7440,
    agents: [agent()],
    connectedCount: 0,
    studioOpen: true,
    ...overrides
  }
}

function entry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    id: 'e1',
    at: '2026-10-27T14:00:00Z',
    agentId: 'a1',
    agentName: 'Claude Desktop',
    tool: 'add_marker',
    summary: '{"title":"Intro"}',
    outcome: 'ok',
    ...overrides
  }
}

type Handler = (payload: unknown) => void

function fakeClient(answers: Record<string, unknown>) {
  const handlers = new Map<string, Set<Handler>>()
  const requests: Array<{ method: string; params: unknown }> = []
  const answer = async (method: string, params?: unknown): Promise<unknown> => {
    requests.push({ method, params })
    const value = answers[method]
    if (value instanceof Error) throw value
    return typeof value === 'function' ? (value as (p: unknown) => unknown)(params) : value
  }
  const client = {
    connect: vi.fn(async () => undefined),
    close: vi.fn(() => {
      for (const handler of handlers.get('connection.closed') ?? []) handler(null)
    }),
    on: vi.fn((event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set<Handler>()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    }),
    request: vi.fn(answer),
    requestTyped: vi.fn(answer)
  }
  return {
    client: client as unknown as AgentsClient,
    raw: client,
    requests,
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }
  }
}

function fakeTimers() {
  const timeouts = new Map<number, () => void>()
  let next = 1
  return {
    timeouts,
    timers: {
      setTimeout: (run: () => void) => {
        timeouts.set(next, run)
        return next++
      },
      clearTimeout: (handle: unknown) => void timeouts.delete(handle as number)
    },
    fireTimeouts: () => {
      const due = [...timeouts.values()]
      timeouts.clear()
      for (const run of due) run()
    }
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

function setup(answers: Record<string, unknown> = {}) {
  const fake = fakeClient({
    'events.setIncluded': { ok: true },
    'agents.status': status(),
    'agents.activity.list': { entries: [entry()] },
    ...answers
  })
  const time = fakeTimers()
  let connectionListener: ((connection: BackendConnection) => void) | null = null
  const clients: Array<ReturnType<typeof fakeClient>> = [fake]
  let created = 0
  const store = createAgentsStore({
    getConnection: async () => CONNECTION,
    onConnection: (listener) => {
      connectionListener = listener
      return () => {
        connectionListener = null
      }
    },
    createClient: () => clients[Math.min(created++, clients.length - 1)].client,
    getBridge: vi.fn(async (install: boolean) => ({
      path: install ? '/installed/videorc-mcp' : '/bundled/videorc-mcp',
      exists: true
    })),
    timers: time.timers
  })
  return {
    store,
    fake,
    time,
    clients,
    newConnection: (connection: BackendConnection) => connectionListener?.(connection)
  }
}

describe('agents store (plan 209 S7)', () => {
  it('opens on the first subscriber: narrows its events, then seeds status, activity and the bridge', async () => {
    const { store, fake } = setup()
    expect(store.getSnapshot().status).toBeNull()
    store.subscribe(() => undefined)
    await flush()
    expect(fake.requests[0]).toEqual({
      method: 'events.setIncluded',
      params: { events: [...AGENTS_STORE_EVENTS] }
    })
    // Agent intents are the Studio socket's alone: a socket that asked for
    // them would look like a Studio that never answers.
    expect(AGENTS_STORE_EVENTS).toEqual(['agents.status', 'agents.activity'])
    expect(fake.raw.on).not.toHaveBeenCalledWith('agent.intent', expect.anything())
    expect(fake.requests.map((request) => request.method)).not.toContain('agent.intent.listen')
    expect(fake.requests.map((request) => request.method)).toContain('agents.activity.list')
    expect(fake.requests.find((r) => r.method === 'agents.activity.list')?.params).toEqual({
      limit: 100
    })
    const snapshot = store.getSnapshot()
    expect(snapshot.status?.enabled).toBe(true)
    expect(snapshot.activity).toHaveLength(1)
    expect(snapshot.activityLoaded).toBe(true)
    expect(snapshot.bridge).toEqual({ path: '/bundled/videorc-mcp', exists: true })
    expect(snapshot.offline).toBe(false)
  })

  it('follows pushed status, prepends activity, and gives the agent its last action', async () => {
    const { store, fake } = setup()
    const events: AgentsStoreEvent[] = []
    store.onEvent((event) => events.push(event))
    store.subscribe(() => undefined)
    await flush()
    fake.emit('agents.status', status({ enabled: false }))
    expect(store.getSnapshot().status?.enabled).toBe(false)

    fake.emit('agents.status', status())
    const next = entry({ id: 'e2', tool: 'set_banner', at: '2026-10-27T14:05:00Z' })
    fake.emit('agents.activity', next)
    const snapshot = store.getSnapshot()
    expect(snapshot.activity.map((row) => row.id)).toEqual(['e2', 'e1'])
    expect(snapshot.status?.agents[0].lastAction).toEqual({
      tool: 'set_banner',
      at: '2026-10-27T14:05:00Z',
      outcome: 'ok'
    })
    expect(events).toEqual([{ kind: 'activity', entry: next }])
  })

  it("keeps at most 100 rows, and only the filtered agent's while filtered", async () => {
    const { store, fake } = setup({
      'agents.activity.list': (params: unknown) =>
        (params as { agentId?: string }).agentId
          ? { entries: [entry({ id: 'only-a1' })] }
          : { entries: Array.from({ length: 100 }, (_, index) => entry({ id: `r${index}` })) }
    })
    store.subscribe(() => undefined)
    await flush()
    fake.emit('agents.activity', entry({ id: 'new' }))
    expect(store.getSnapshot().activity).toHaveLength(100)
    expect(store.getSnapshot().activity[0].id).toBe('new')

    await store.showActivityFor('a1')
    expect(store.getSnapshot().activityAgentId).toBe('a1')
    expect(store.getSnapshot().activity.map((row) => row.id)).toEqual(['only-a1'])
    fake.emit('agents.activity', entry({ id: 'other-agent', agentId: 'a2' }))
    expect(store.getSnapshot().activity.map((row) => row.id)).toEqual(['only-a1'])
  })

  it('never polls while an agent is connected: the lapse arrives as a pushed status', async () => {
    const { store, fake, time } = setup({
      'agents.status': status({ connectedCount: 1, agents: [agent({ connected: true })] })
    })
    store.subscribe(() => undefined)
    await flush()
    expect(store.getSnapshot().status?.connectedCount).toBe(1)
    expect(time.timeouts.size).toBe(0)
    const reads = fake.requests.filter((r) => r.method === 'agents.status').length

    fake.emit('agents.status', status({ connectedCount: 0, agents: [agent({ connected: false })] }))
    expect(store.getSnapshot().status?.agents[0].connected).toBe(false)
    expect(fake.requests.filter((r) => r.method === 'agents.status').length).toBe(reads)
  })

  it('runs the actions and keeps the answered status', async () => {
    const created = { agent: agent({ id: 'a2', name: 'Cursor' }), token: 'vrc_agent_x' }
    const { store, fake } = setup({
      'agents.stop': status({ enabled: false }),
      'agents.create': created,
      'agents.remove': status({ agents: [] })
    })
    store.subscribe(() => undefined)
    await flush()
    await store.stop()
    expect(store.getSnapshot().status?.enabled).toBe(false)
    await expect(store.create('Cursor', 'cursor')).resolves.toEqual(created)
    expect(fake.requests.find((r) => r.method === 'agents.create')?.params).toEqual({
      name: 'Cursor',
      client: 'cursor'
    })
    await store.remove('a1')
    expect(store.getSnapshot().status?.agents).toEqual([])
    await expect(store.prepareBridge()).resolves.toEqual({
      path: '/installed/videorc-mcp',
      exists: true
    })
  })

  it('refuses an action as offline before Videorc answers', async () => {
    const { store } = setup()
    await expect(store.stop()).rejects.toMatchObject({ name: 'VideorcOfflineError' })
  })

  it('opens Connect on request, counting each ask', () => {
    const { store } = setup()
    store.openConnect()
    store.openConnect()
    expect(store.getSnapshot()).toMatchObject({ connectOpen: true, connectRequest: 2 })
    store.closeConnect()
    expect(store.getSnapshot().connectOpen).toBe(false)
  })

  it('says offline when the socket closes, retries, and moves to a new connection from main', async () => {
    const { store, fake, time, clients, newConnection } = setup()
    const second = fakeClient({
      'events.setIncluded': { ok: true },
      'agents.status': status({ enabled: false }),
      'agents.activity.list': { entries: [] }
    })
    clients.push(second)
    store.subscribe(() => undefined)
    await flush()
    fake.emit('connection.closed', null)
    expect(store.getSnapshot().offline).toBe(true)
    time.fireTimeouts()
    await flush()
    expect(store.getSnapshot().offline).toBe(false)

    newConnection({ ...CONNECTION, port: 7001 } as BackendConnection)
    await flush()
    expect(fake.raw.close).toHaveBeenCalled()
    expect(store.getSnapshot().status?.enabled).toBe(false)
  })

  it('closes a moment after the last subscriber leaves, not on a remount', async () => {
    const { store, fake, time } = setup()
    const leave = store.subscribe(() => undefined)
    await flush()
    leave()
    const again = store.subscribe(() => undefined)
    time.fireTimeouts()
    expect(fake.raw.close).not.toHaveBeenCalled()
    again()
    time.fireTimeouts()
    expect(fake.raw.close).toHaveBeenCalledOnce()
  })
})
