// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CohostReportPayload } from '@/lib/backend'

import { BUDDY_REPORT_READ_ERROR, useBuddyReport, type BuddyReportState } from './use-buddy-report'

interface PendingRequest {
  method: string
  params: unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const fake = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  clients: [] as Array<{
    connection: unknown
    closed: boolean
    requests: PendingRequest[]
    emit: (event: string, payload: unknown) => void
  }>,
  failConnect: false
}))

vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => fake.core }))
vi.mock('@/backendClient', () => ({
  BackendClient: class {
    closed = false
    requests: PendingRequest[] = []
    private handlers = new Map<string, Set<(payload: unknown) => void>>()

    constructor(readonly connection: unknown) {
      fake.clients.push(this)
    }

    connect(): Promise<void> {
      return fake.failConnect ? Promise.reject(new Error('refused')) : Promise.resolve()
    }

    close(): void {
      this.closed = true
    }

    on(event: string, handler: (payload: unknown) => void): () => void {
      const handlers = this.handlers.get(event) ?? new Set()
      handlers.add(handler)
      this.handlers.set(event, handlers)
      return () => handlers.delete(handler)
    }

    emit(event: string, payload: unknown): void {
      for (const handler of this.handlers.get(event) ?? []) handler(payload)
    }

    requestTyped(method: string, params?: unknown): Promise<unknown> {
      return new Promise((resolve, reject) =>
        this.requests.push({ method, params, resolve, reject })
      )
    }
  }
}))

const CONNECTION = { host: '127.0.0.1', port: 4000, token: 't' }

function payload(sessionId: string): CohostReportPayload {
  return { sessionId, report: null, moments: [], chat: { messages: 0, byPlatform: [] } }
}

let root: Root
let container: HTMLDivElement
let state: BuddyReportState

function Probe({ sessionId }: { sessionId: string | null }): null {
  state = useBuddyReport(sessionId)
  return null
}

async function render(sessionId: string | null): Promise<void> {
  await act(async () => root.render(createElement(Probe, { sessionId })))
}

function client(index = 0): (typeof fake.clients)[number] {
  const found = fake.clients[index]
  expect(found, `client ${index}`).toBeTruthy()
  return found
}

async function answer(request: PendingRequest, value: unknown): Promise<void> {
  await act(async () => request.resolve(value))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fake.core = { connection: CONNECTION, wsStatus: 'connected' }
  fake.clients = []
  fake.failConnect = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('useBuddyReport (plan 119 S3)', () => {
  it('asks for the latest stream without a session, on its own client', async () => {
    await render(null)
    expect(state.loading).toBe(true)
    expect(client().connection).toBe(CONNECTION)
    expect(client().requests.map((request) => [request.method, request.params])).toEqual([
      ['cohost.report.latest', undefined]
    ])
    await answer(client().requests[0], payload('stream-9'))
    expect(state).toMatchObject({ loading: false, error: null, payload: payload('stream-9') })
  })

  it('asks for one session, and keeps the shown report while the next one loads', async () => {
    await render('stream-1')
    expect(client().requests[0]).toMatchObject({
      method: 'cohost.report.get',
      params: { sessionId: 'stream-1' }
    })
    await answer(client().requests[0], payload('stream-1'))

    await render('stream-2')
    expect(state.loading).toBe(true)
    expect(state.payload?.sessionId).toBe('stream-1')
    await answer(client().requests[1], payload('stream-2'))
    expect(state).toMatchObject({ loading: false, payload: payload('stream-2') })
  })

  it('ignores the answer for a session it no longer shows', async () => {
    await render('stream-1')
    await render('stream-2')
    const [first, second] = client().requests
    await answer(second, payload('stream-2'))
    await answer(first, payload('stream-1'))
    expect(state.payload?.sessionId).toBe('stream-2')
  })

  it('asks again when a report is saved, so a stream that just ended shows up', async () => {
    await render(null)
    await answer(client().requests[0], null)
    expect(state).toMatchObject({ loading: false, payload: null })

    await act(async () => client().emit('cohost.report.saved', { sessionId: 'stream-3' }))
    expect(client().requests).toHaveLength(2)
    expect(client().requests[1].method).toBe('cohost.report.latest')
    expect(state.loading).toBe(false)
    await answer(client().requests[1], payload('stream-3'))
    expect(state.payload?.sessionId).toBe('stream-3')
  })

  it('reports a failed read and tries again on request', async () => {
    await render('stream-1')
    await act(async () => client().requests[0].reject(new Error('cohost-report-failed')))
    expect(state).toMatchObject({ loading: false, error: BUDDY_REPORT_READ_ERROR, payload: null })

    await act(async () => state.reload())
    expect(client().requests).toHaveLength(2)
    await answer(client().requests[1], payload('stream-1'))
    expect(state).toMatchObject({ error: null, payload: payload('stream-1') })
  })

  it('reconnects on Try again when the backend refused the connection', async () => {
    fake.failConnect = true
    await render(null)
    expect(state).toMatchObject({ loading: false, error: BUDDY_REPORT_READ_ERROR })

    fake.failConnect = false
    await act(async () => state.reload())
    expect(fake.clients).toHaveLength(2)
    expect(client(0).closed).toBe(true)
    expect(client(1).requests[0].method).toBe('cohost.report.latest')
  })

  it('waits for the studio connection and closes its client with the tab', async () => {
    fake.core = { connection: null, wsStatus: 'connecting' }
    await render(null)
    expect(fake.clients).toHaveLength(0)
    expect(state.loading).toBe(true)

    fake.core = { connection: CONNECTION, wsStatus: 'connected' }
    await render(null)
    expect(fake.clients).toHaveLength(1)
    await act(async () => root.unmount())
    expect(client().closed).toBe(true)
    root = createRoot(container)
  })
})
