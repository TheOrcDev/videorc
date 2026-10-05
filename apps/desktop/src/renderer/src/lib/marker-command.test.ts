import { describe, expect, it, vi } from 'vitest'
import {
  createCommentsMarker,
  markerCreateParams,
  markerRetryAvailable,
  MarkerRemovedError
} from './marker-command'
import type { MarkerRelayCommand, MarkerRelayResult, SessionMarker } from '@/lib/backend'
const params = {
  sessionId: 'capture-a',
  operationId: 'c113b787-9ffe-48ef-b9a8-d07c4b44b3c0',
  label: 'Topic'
}
const marker: SessionMarker = {
  id: params.operationId,
  sessionId: params.sessionId,
  label: 'Renamed topic',
  atSeconds: 24.1,
  source: 'manual',
  createdAt: 'now',
  revision: 2
}
describe('marker outcome recovery', () => {
  it('recovers the persisted current revision after a lost create reply', async () => {
    const relay = vi.fn(async (command: MarkerRelayCommand): Promise<MarkerRelayResult> => {
      if (command.action === 'create') throw new Error('Disconnected')
      expect(command.params).toEqual({ sessionId: 'capture-a', markerId: params.operationId })
      return { status: 'found', marker }
    })
    expect(await createCommentsMarker({ markerFromCommentsWindow: relay }, params)).toEqual(marker)
    const [create, get] = relay.mock.calls.map(([command]) => command)
    expect(create.requestId).not.toBe(get.requestId)
    expect(create.action).toBe('create')
    if (create.action === 'create') expect(create.params.operationId).toBe(params.operationId)
  })
  it('refuses a deleted receipt and never replays create after Undo', async () => {
    const relay = vi.fn(async (command: MarkerRelayCommand): Promise<MarkerRelayResult> => {
      if (command.action === 'create') throw new Error('Lost reply')
      return { status: 'deleted', revision: 3 }
    })
    await expect(createCommentsMarker({ markerFromCommentsWindow: relay }, params)).rejects.toThrow(
      MarkerRemovedError
    )
    expect(relay).toHaveBeenCalledTimes(2)
  })
  it('retains the failure when no saved outcome can be proven', async () => {
    const relay = vi.fn(async (command: MarkerRelayCommand): Promise<MarkerRelayResult> => {
      if (command.action === 'create') throw new Error('Disk full')
      return { status: 'absent' }
    })
    await expect(createCommentsMarker({ markerFromCommentsWindow: relay }, params)).rejects.toThrow(
      'Disk full'
    )
  })
  it('retries the same intent after Stop but starts a new intent in the next capture', () => {
    expect(markerCreateParams(params, null, 'Topic')).toBe(params)
    expect(markerRetryAvailable('capture-a', null)).toBe(true)
    const context = { sessionId: 'capture-b', available: true }
    expect(markerRetryAvailable('capture-a', context)).toBe(false)
    const next = markerCreateParams(params, context, 'Topic')
    expect(next.sessionId).toBe('capture-b')
    expect(next.operationId).not.toBe(params.operationId)
    expect(next.label).toBe('Topic')
    expect(markerCreateParams(next, context, 'Topic')).toBe(next)
  })
  it('does not enable stale retries while a new capture is unavailable', () => {
    const context = { sessionId: 'capture-b', available: false }
    expect(() => markerCreateParams(params, context, 'Topic')).toThrow('No active capture')
    expect(() => markerCreateParams(params, null, 'Another topic')).toThrow('No active capture')
    expect(markerRetryAvailable(null, null)).toBe(false)
  })
})
