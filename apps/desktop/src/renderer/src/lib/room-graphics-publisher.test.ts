import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState, RoomEvent, type Room } from 'livekit-client'
import {
  RoomGraphicsPublisher,
  graphicsMotionCards,
  type GraphicsContent,
  type RoomGraphicsStatus
} from './room-graphics-publisher'
import { CAPABILITY_TOPIC } from './room-media-v2'
import fixture from '../../../../../..//protocol-fixtures/cloud-parity-graphics.json'
import type { GraphicsLayer } from '../../../shared/cloud-graphics'

function harness() {
  const room = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    name: 'sh_avatar',
    localParticipant: {
      sid: 'PA_host',
      streamBytes: vi.fn(async () => ({
        write: vi.fn(async () => {}),
        close: vi.fn(async () => {})
      }))
    },
    remoteParticipants: new Map([
      ['EG_program', { identity: 'EG_program', sid: 'PA_program' }],
      ['g_guest', { identity: 'g_guest', sid: 'PA_guest' }]
    ])
  })
  const statuses: RoomGraphicsStatus[] = []
  const publisher = new RoomGraphicsPublisher(room as unknown as Room, (s) => statuses.push(s))
  const receive = (graphics: unknown, participant?: unknown) =>
    room.emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(
        JSON.stringify({
          v: 2,
          identity: 'EG_program',
          participantSid: 'PA_program',
          at: Date.now(),
          ...(graphics ? { graphics } : {})
        })
      ),
      participant,
      undefined,
      CAPABILITY_TOPIC
    )
  return { room, publisher, statuses, receive }
}
afterEach(() => vi.useRealTimers())
describe('room static graphics publisher', () => {
  it('off has no timer; media v2 alone and participant-originated receipts never authorize graphics', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    h.publisher.set(null)
    expect(vi.getTimerCount()).toBe(0)
    h.publisher.set({
      h: fixture.snapshot.layers.map((l) => ({
        ...l,
        stream: true,
        recording: false
      })) as (GraphicsLayer & { stream: boolean; recording: boolean })[],
      v: [],
      unsupported: []
    })
    h.receive(undefined)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.room.localParticipant.streamBytes).not.toHaveBeenCalled()
    h.receive(
      { version: 1, output: 'stream', orientation: 'h', static: { version: 1 } },
      { identity: 'guest' }
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.room.localParticipant.streamBytes).not.toHaveBeenCalled()
    h.publisher.close()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('targets only the fresh authorized EG lane and keeps stream-only pixels out of recordings', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    const bodies: Uint8Array[] = []
    h.room.localParticipant.streamBytes.mockImplementation(async () => ({
      write: vi.fn(async (bytes: Uint8Array) => {
        bodies.push(bytes)
      }),
      close: vi.fn(async () => {})
    }))
    h.publisher.set({
      h: fixture.snapshot.layers.map((l) => ({
        ...l,
        stream: true,
        recording: false
      })) as (GraphicsLayer & { stream: boolean; recording: boolean })[],
      v: [],
      unsupported: []
    })
    h.receive({ version: 1, output: 'recording', orientation: 'h', static: { version: 1 } })
    await vi.advanceTimersByTimeAsync(1000)
    const call = h.room.localParticipant.streamBytes.mock.calls[0] as unknown as [
      { destinationIdentities: string[] }
    ]
    expect(call[0].destinationIdentities).toEqual(['EG_program'])
    const body = JSON.parse(new TextDecoder().decode(bodies[0]))
    expect(body.layers).toEqual([])
    expect(body.output).toBe('recording')
    expect(h.statuses.at(-1)?.state).toBe('waiting')
    h.receive({
      version: 1,
      output: 'recording',
      orientation: 'h',
      static: { version: 1, applied: { publisherSid: 'PA_host', revision: body.revision } }
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.statuses.at(-1)?.observed).toEqual({}) // a clear is not a visible graphic
    h.room.emit(RoomEvent.Reconnecting)
    expect(h.statuses.at(-1)?.observed).toEqual({})
    h.publisher.close()
  })
})

describe('S6 guest avatar coexistence', () => {
  it('never sends static pixels to a guest claiming static support in a server receipt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    h.publisher.set({
      h: fixture.snapshot.layers.map((layer) => ({
        ...layer,
        stream: true,
        recording: true
      })) as (GraphicsLayer & { stream: boolean; recording: boolean })[],
      v: [],
      unsupported: []
    })
    h.room.emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(
        JSON.stringify({
          v: 2,
          identity: 'g_guest',
          participantSid: 'PA_guest',
          at: Date.now(),
          graphics: { version: 1, output: 'stream', orientation: 'h', static: { version: 1 } }
        })
      ),
      undefined,
      undefined,
      CAPABILITY_TOPIC
    )
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.room.localParticipant.streamBytes).not.toHaveBeenCalled()
    expect(h.statuses.at(-1)?.observed).toEqual({})
    h.publisher.close()
  })
})

describe('managed graphics card input for the shared orientation simulation', () => {
  const rect = { x: 0.1, y: 0.6, w: 0.3, h: 0.2 }
  const content = (): GraphicsContent => ({
    h: [
      {
        ...fixture.snapshot.layers[0],
        kind: 'highlight',
        rect,
        expiresAt: 5000,
        stream: true,
        recording: true
      } as GraphicsContent['h'][number]
    ],
    v: [],
    unsupported: []
  })
  const views = [
    { identity: 'EG_stream', output: 'stream' as const, orientation: 'h' as const },
    { identity: 'EG_record', output: 'recording' as const, orientation: 'h' as const }
  ]
  const status = (): RoomGraphicsStatus => ({
    enabled: true,
    state: 'applied',
    reason: null,
    revision: 3,
    preview: null,
    observed: {
      EG_stream: { revision: 2, output: 'stream', orientation: 'h' },
      EG_record: { revision: 3, output: 'recording', orientation: 'h' }
    },
    productionQualified: false
  })
  it('uses the card only after each animated output acknowledges its own current envelope', () => {
    expect(graphicsMotionCards(content(), status(), views, 1000)).toEqual({ h: rect, v: null })
    const pending = status()
    delete pending.observed.EG_record
    expect(graphicsMotionCards(content(), pending, views, 1000).h).toBeNull()
    pending.observed.EG_record = { revision: 3, output: 'stream', orientation: 'h' }
    expect(graphicsMotionCards(content(), pending, views, 1000).h).toBeNull()
    expect(graphicsMotionCards(content(), status(), [], 1000).h).toBeNull()
  })
  it('never looks at stream-only or recording-only highlights', () => {
    for (const output of ['stream', 'recording'] as const) {
      const c = content()
      c.h[0][output] = false
      expect(graphicsMotionCards(c, status(), views, 1000).h).toBeNull()
    }
  })
  it('drops expired, cleared, failed, off and unacknowledged cards', () => {
    expect(graphicsMotionCards(content(), status(), views, 5000).h).toBeNull()
    expect(graphicsMotionCards(null, status(), views, 1000).h).toBeNull()
    expect(graphicsMotionCards({ ...content(), h: [] }, status(), views, 1000).h).toBeNull()
    for (const state of ['failed', 'off'] as const)
      expect(graphicsMotionCards(content(), { ...status(), state }, views, 1000).h).toBeNull()
    expect(graphicsMotionCards(content(), { ...status(), observed: {} }, views, 1000).h).toBeNull()
  })
  it('scopes acceptance by orientation without splitting stream and recording motion', () => {
    const c = content()
    c.v = c.h
    const wanted = [
      ...views,
      { identity: 'EG_vertical', output: 'stream' as const, orientation: 'v' as const }
    ]
    expect(graphicsMotionCards(c, status(), wanted, 1000)).toEqual({ h: rect, v: null })
  })
})
