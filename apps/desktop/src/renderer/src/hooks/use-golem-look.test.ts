import { describe, expect, it, vi } from 'vitest'

import type { CohostAvatarDraft, CohostAvatarDraftStatus } from '@/lib/backend'

import { createGolemLookController, type GolemLookClient } from './use-golem-look'

const ID = '3f2a1c4e-8b7d-4e6f-a1b2-c3d4e5f6a7b8'
const NEXT = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

function draft(requestId = ID, failed: CohostAvatarDraft['failed'] = {}): CohostAvatarDraft {
  const images: CohostAvatarDraft['images'] = {}
  for (const state of ['idle', 'talk', 'laugh', 'think'] as const) {
    if (!failed[state]) images[state] = `default/drafts/${requestId}/${state}.png`
  }
  return { requestId, images, failed }
}

function fakeClient(status: CohostAvatarDraftStatus = {}) {
  let current = status
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const requestTyped = vi.fn(async (method: string, params?: unknown) => {
    switch (method) {
      case 'cohost.avatar.draft.get':
        return current
      case 'cohost.avatar.create':
        return { requestId: NEXT }
      case 'cohost.avatar.redo':
        return { requestId: (params as { requestId: string }).requestId }
      case 'cohost.avatar.keep':
        return { persona: { id: 'default', images: { idle: 'default/idle.png' } } }
      case 'cohost.avatar.discard':
        current = {}
        return {}
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
  const request = vi.fn(async () => ({
    cohost: { avatar: { enabled: true, remainingToday: 20, dailyLimit: 24 } }
  }))
  const client = {
    requestTyped,
    request,
    on: (event: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    }
  } as unknown as GolemLookClient
  return {
    client,
    requestTyped,
    request,
    set: (next: CohostAvatarDraftStatus) => {
      current = next
    },
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }
  }
}

describe('createGolemLookController (plan 169 D9)', () => {
  it('offers a draft left on disk, and picks up a job already running', async () => {
    const fake = fakeClient({
      draft: draft(),
      running: { requestId: ID, kind: 'redo', state: 'laugh' }
    })
    const controller = createGolemLookController(fake.client)
    await controller.refresh()
    const state = controller.getState()
    expect(state.loading).toBe(false)
    expect(state.draft?.requestId).toBe(ID)
    expect(state.running).toEqual({ requestId: ID, kind: 'redo', state: 'laugh' })
    expect(state.phases).toEqual({ laugh: 'working' })
    expect(state.capabilities?.cohost?.avatar?.remainingToday).toBe(20)
    controller.dispose()
  })

  it('creates: idle working, every state reported, then the draft ends the run', async () => {
    const fake = fakeClient()
    const controller = createGolemLookController(fake.client)
    await controller.refresh()
    await controller.create({ description: 'a goblin', inspirationBase64: 'AAAA' })
    expect(fake.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.create',
      { description: 'a goblin', inspirationBase64: 'AAAA' },
      { timeoutMs: 15_000 }
    )
    expect(controller.getState().running).toEqual({ requestId: NEXT, kind: 'create' })
    fake.emit('cohost.avatar.progress', { requestId: NEXT, state: 'idle', phase: 'working' })
    expect(controller.getState().phases.idle).toBe('working')
    fake.emit('cohost.avatar.progress', {
      requestId: NEXT,
      state: 'think',
      phase: 'failed',
      error: { code: 'ai-gateway-error', message: 'The model failed.' }
    })
    const made = draft(NEXT, { think: { code: 'ai-gateway-error', message: 'The model failed.' } })
    fake.emit('cohost.avatar.draft', made)
    const state = controller.getState()
    expect(state.running).toBeNull()
    expect(state.draft).toEqual(made)
    expect(state.stateErrors).toEqual({ think: 'The model failed.' })
    expect(fake.request).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('a create that fails its idle makes nothing and says why', async () => {
    const fake = fakeClient({ draft: draft() })
    const controller = createGolemLookController(fake.client)
    await controller.refresh()
    await controller.create({ description: 'a troll' })
    fake.emit('cohost.avatar.progress', {
      requestId: NEXT,
      state: 'idle',
      phase: 'failed',
      error: { code: 'quota-exhausted', message: 'Daily avatar limit reached. More in 2 h.' }
    })
    const state = controller.getState()
    expect(state.running).toBeNull()
    expect(state.problem?.message).toBe('Daily avatar limit reached. More in 2 h.')
    // The earlier draft is still the one on offer.
    expect(state.draft?.requestId).toBe(ID)
    controller.dispose()
  })

  it('redoes one state and versions the pictures; keep and discard call their RPCs', async () => {
    const fake = fakeClient({ draft: draft() })
    const controller = createGolemLookController(fake.client)
    await controller.refresh()
    await controller.redo('laugh')
    expect(fake.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.redo',
      { requestId: ID, state: 'laugh' },
      { timeoutMs: 15_000 }
    )
    expect(controller.getState().running).toEqual({ requestId: ID, kind: 'redo', state: 'laugh' })
    fake.emit('cohost.avatar.progress', {
      requestId: ID,
      state: 'laugh',
      phase: 'done',
      path: `default/drafts/${ID}/laugh.png`
    })
    fake.emit('cohost.avatar.draft', draft())
    expect(controller.getState().running).toBeNull()
    expect(controller.getState().revision).toBe(1)

    const settings = await controller.keep()
    expect(fake.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.keep',
      { requestId: ID },
      { timeoutMs: 35_000 }
    )
    expect(settings?.persona.id).toBe('default')
    expect(controller.getState().draft).toBeNull()

    fake.set({ draft: draft() })
    await controller.refresh()
    await controller.discard()
    expect(fake.requestTyped).toHaveBeenCalledWith(
      'cohost.avatar.discard',
      { requestId: ID },
      { timeoutMs: 15_000 }
    )
    expect(controller.getState().draft).toBeNull()
    controller.dispose()
  })

  it('shows a refusal and frees the panel', async () => {
    const fake = fakeClient({ draft: draft() })
    fake.requestTyped.mockImplementationOnce(async () => ({ draft: draft() }))
    const controller = createGolemLookController(fake.client)
    await controller.refresh()
    fake.requestTyped.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Your Golem’s look is already being made.'), {
        code: 'cohost-avatar-busy'
      })
    })
    await controller.redo('talk')
    const state = controller.getState()
    expect(state.problem?.code).toBe('cohost-avatar-busy')
    expect(state.running).toBeNull()
    expect(state.pending).toBeNull()
    controller.dispose()
  })
})
