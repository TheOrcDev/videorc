import { describe, expect, it, vi } from 'vitest'

import type { BuddyLibraryState } from '@/lib/backend'

import { createBuddyLibraryController, type BuddyLibraryClient } from './use-buddy-library'

const AVATAR = '7c9e6679-7425-40de-944b-e07fc1ee9a51'

function library(patch: Partial<BuddyLibraryState> = {}): BuddyLibraryState {
  return {
    signedIn: true,
    official: [],
    mine: null,
    activeAvatarId: 'official:golem',
    serverActiveAvatarId: null,
    limit: 30,
    busy: null,
    ...patch
  }
}

class Refused extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

function fakeClient(initial: BuddyLibraryState = library()) {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  let refuse: Refused | null = null
  const requestTyped = vi.fn(async (method: string, _params?: unknown) => {
    if (refuse) throw refuse
    switch (method) {
      case 'cohost.library.get':
        return initial
      case 'cohost.library.sync':
      case 'cohost.library.use':
      case 'cohost.library.update':
      case 'cohost.library.delete':
      case 'cohost.library.saveToLibrary':
        return { accepted: true }
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
  const client = {
    requestTyped,
    on: (event: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    }
  } as unknown as BuddyLibraryClient
  return {
    client,
    requestTyped,
    refuseWith: (error: Refused | null) => {
      refuse = error
    },
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    listeners: (event: string) => handlers.get(event)?.size ?? 0
  }
}

describe('createBuddyLibraryController (plan 170 D12, D13)', () => {
  it('loads the cached library, then follows cohost.library.changed', async () => {
    const fake = fakeClient()
    const controller = createBuddyLibraryController(fake.client)
    expect(controller.getState().loading).toBe(true)
    await controller.refresh()
    expect(controller.getState()).toMatchObject({ loading: false, pending: null })
    expect(controller.getState().library?.activeAvatarId).toBe('official:golem')

    const changed = library({ activeAvatarId: AVATAR, busy: { kind: 'use', avatarId: AVATAR } })
    fake.emit('cohost.library.changed', changed)
    expect(controller.getState().library).toBe(changed)
    controller.dispose()
    expect(fake.listeners('cohost.library.changed')).toBe(0)
  })

  it('sends each call with its params and clears pending once accepted', async () => {
    const fake = fakeClient()
    const controller = createBuddyLibraryController(fake.client)
    expect(await controller.sync('tab')).toBe(true)
    expect(await controller.use('official:orc')).toBe(true)
    expect(await controller.update({ avatarId: AVATAR, name: 'Grum' })).toBe(true)
    expect(await controller.remove(AVATAR)).toBe(true)
    // Plan 172 D10: Save to my library takes no params.
    const saving = controller.saveToLibrary()
    expect(controller.getState().pending).toBe('import')
    expect(await saving).toBe(true)
    expect(fake.requestTyped.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ['cohost.library.sync', { reason: 'tab' }],
      ['cohost.library.use', { avatarId: 'official:orc' }],
      ['cohost.library.update', { avatarId: AVATAR, name: 'Grum' }],
      ['cohost.library.delete', { avatarId: AVATAR }],
      ['cohost.library.saveToLibrary', undefined]
    ])
    expect(controller.getState().pending).toBeNull()
    controller.dispose()
  })

  it('keeps one call in flight and shows a refusal as the problem', async () => {
    const fake = fakeClient()
    const controller = createBuddyLibraryController(fake.client)
    const first = controller.sync('focus')
    expect(controller.getState().pending).toBe('sync')
    expect(await controller.use('official:orc')).toBe(false)
    await first
    fake.refuseWith(new Refused('cohost-library-not-implemented', 'Not available yet.'))
    expect(await controller.use('official:orc')).toBe(false)
    expect(controller.getState()).toMatchObject({
      pending: null,
      problem: { code: 'cohost-library-not-implemented', message: 'Not available yet.' }
    })
    controller.dispose()
  })
})
