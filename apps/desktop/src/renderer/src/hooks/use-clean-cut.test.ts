// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CleanCutJob } from '@/lib/backend'

import { CLEAN_CUT_OFFLINE_MESSAGE, useCleanCut, type CleanCutClient } from './use-clean-cut'

interface Sent {
  method: string
  params: unknown
}

const fake = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  clients: [] as Array<{
    connection: unknown
    closed: boolean
    sent: Sent[]
    emit: (event: string, payload: unknown) => void
  }>,
  answers: new Map<string, unknown>()
}))

vi.mock('@/hooks/use-studio', () => ({ useStudioCore: () => fake.core }))
vi.mock('@/backendClient', () => ({
  BackendClient: class {
    closed = false
    sent: Sent[] = []
    private handlers = new Map<string, Set<(payload: unknown) => void>>()

    constructor(readonly connection: unknown) {
      fake.clients.push(this)
    }

    connect(): Promise<void> {
      return Promise.resolve()
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

    request(method: string, params?: unknown): Promise<unknown> {
      this.sent.push({ method, params })
      return Promise.resolve(fake.answers.get(method) ?? null)
    }

    requestTyped(method: string, params?: unknown): Promise<unknown> {
      return this.request(method, params)
    }
  }
}))

const CONNECTION = { host: '127.0.0.1', port: 4000, token: 't' }

function job(overrides: Partial<CleanCutJob> = {}): CleanCutJob {
  return {
    id: 'job-1',
    sourceSessionId: 'rec-1',
    mode: 'clean',
    state: 'queued',
    progress: 0,
    edlRevision: 0,
    createdAt: '2026-10-03T15:00:00Z',
    updatedAt: '2026-10-03T15:00:00Z',
    ...overrides
  }
}

let root: Root
let container: HTMLDivElement
let state: CleanCutClient

function Probe(): null {
  state = useCleanCut()
  return null
}

async function render(): Promise<void> {
  await act(async () => root.render(createElement(Probe)))
  await act(async () => {
    await Promise.resolve()
  })
}

function client(index = 0): (typeof fake.clients)[number] {
  const found = fake.clients[index]
  expect(found, `client ${index}`).toBeTruthy()
  return found
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  fake.core = {
    connection: CONNECTION,
    wsStatus: 'connected',
    account: { status: 'signed-in' },
    aiCapabilities: null
  }
  fake.clients = []
  fake.answers = new Map<string, unknown>([
    [
      'cleanCut.list',
      [job({ id: 'job-old', state: 'completed', updatedAt: '2026-10-02T00:00:00Z' })]
    ],
    [
      'ai.capabilities.get',
      { cleanCut: { supported: true, available: true, remainingSeconds: 3_600 } }
    ]
  ])
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('useCleanCut (plan 119 S14)', () => {
  it('opens its own client, lists the jobs and reads the allowance', async () => {
    await render()
    expect(client().connection).toBe(CONNECTION)
    expect(client().sent.map((entry) => entry.method)).toEqual([
      'cleanCut.list',
      'ai.capabilities.get'
    ])
    expect(state.connected).toBe(true)
    expect(state.jobsLoaded).toBe(true)
    expect(state.jobs.map((entry) => entry.id)).toEqual(['job-old'])
    expect(state.capabilities).toMatchObject({ available: true, remainingSeconds: 3_600 })
  })

  it('keeps jobs current from cleanCut.status, tells subscribers, and reads the allowance again when one ends', async () => {
    await render()
    const heard: string[] = []
    const off = state.subscribe((snapshot) => heard.push(`${snapshot.id}:${snapshot.state}`))
    await act(async () => client().emit('cleanCut.status', job({ state: 'transcribing' })))
    expect(state.jobs.map((entry) => [entry.id, entry.state])).toEqual([
      ['job-1', 'transcribing'],
      ['job-old', 'completed']
    ])
    await act(async () =>
      client().emit(
        'cleanCut.status',
        job({ state: 'completed', updatedAt: '2026-10-03T15:20:00Z' })
      )
    )
    expect(heard).toEqual(['job-1:transcribing', 'job-1:completed'])
    expect(client().sent.filter((entry) => entry.method === 'ai.capabilities.get')).toHaveLength(2)
    off()
  })

  it('sends each action with its params', async () => {
    fake.answers.set('cleanCut.start', job({ id: 'job-new' }))
    fake.answers.set(
      'cleanCut.cancel',
      job({ id: 'job-new', state: 'cancelled', updatedAt: '2026-10-03T16:00:00Z' })
    )
    fake.answers.set(
      'cleanCut.render',
      job({ id: 'job-new', state: 'queued', step: 'render', updatedAt: '2026-10-03T17:00:00Z' })
    )
    fake.answers.set('cleanCut.get', { sessionId: 'rec-1', jobs: [] })
    fake.answers.set('cleanCut.updateEdl', {
      job: job({ id: 'job-new', edlRevision: 2, updatedAt: '2026-10-03T18:00:00Z' })
    })
    fake.answers.set('cleanCut.transcript', {
      jobId: 'job-new',
      language: 'en',
      words: [],
      segments: []
    })
    await render()
    await act(async () => {
      await state.start({ sessionId: 'rec-1', mode: 'clean', consentToUploadAudio: true })
    })
    expect(state.jobs[0].id).toBe('job-new')
    await act(async () => {
      await state.cancel('job-new')
      await state.render('job-new')
      await state.get('rec-1')
      await state.updateEdl({
        jobId: 'job-new',
        revision: 1,
        removals: [{ id: 'r1', enabled: false }]
      })
      await state.transcript('job-new')
    })
    expect(client().sent.slice(2)).toEqual([
      {
        method: 'cleanCut.start',
        params: { sessionId: 'rec-1', mode: 'clean', consentToUploadAudio: true }
      },
      { method: 'cleanCut.cancel', params: { jobId: 'job-new' } },
      { method: 'cleanCut.render', params: { jobId: 'job-new' } },
      { method: 'cleanCut.get', params: { sessionId: 'rec-1' } },
      {
        method: 'cleanCut.updateEdl',
        params: { jobId: 'job-new', revision: 1, removals: [{ id: 'r1', enabled: false }] }
      },
      { method: 'cleanCut.transcript', params: { jobId: 'job-new' } }
    ])
    expect(state.jobs.find((entry) => entry.id === 'job-new')?.edlRevision).toBe(2)
  })

  it('reads no allowance when signed out, and refuses actions while offline', async () => {
    fake.core = { ...fake.core, account: { status: 'signed-out' } }
    await render()
    expect(client().sent.map((entry) => entry.method)).toEqual(['cleanCut.list'])
    expect(state.capabilities).toBeNull()

    fake.core = { ...fake.core, wsStatus: 'reconnecting' }
    await render()
    expect(client().closed).toBe(true)
    await expect(
      state.start({ sessionId: 'rec-1', mode: 'clean', consentToUploadAudio: true })
    ).rejects.toThrow(CLEAN_CUT_OFFLINE_MESSAGE)
  })
})
