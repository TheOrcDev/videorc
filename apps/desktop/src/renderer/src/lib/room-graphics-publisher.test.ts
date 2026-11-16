import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState, RoomEvent, type Room } from 'livekit-client'
import {
  graphicsLayers,
  RoomGraphicsPublisher,
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
  it('does not send caption pixels to a loaded old page until a fresh caption capability arrives', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    const bodies: Uint8Array[] = []
    h.room.localParticipant.streamBytes.mockImplementation(async () => ({
      write: vi.fn(async (b: Uint8Array) => {
        bodies.push(b)
      }),
      close: vi.fn(async () => {})
    }))
    h.publisher.set({
      h: [
        {
          ...fixture.snapshot.layers[0],
          id: 'caption',
          kind: 'caption',
          fade: null,
          expiresAt: 9000,
          stream: true,
          recording: false
        }
      ],
      v: [],
      unsupported: []
    })
    h.receive({ version: 1, output: 'stream', orientation: 'h', static: { version: 1 } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(JSON.parse(new TextDecoder().decode(bodies.at(-1))).layers).toEqual([])
    expect(h.statuses.at(-1)?.state).toBe('waiting')
    h.receive({
      version: 1,
      output: 'stream',
      orientation: 'h',
      static: { version: 1, captions: 1 }
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(
      JSON.parse(new TextDecoder().decode(bodies.at(-1))).layers.map((l: GraphicsLayer) => l.kind)
    ).toEqual(['caption'])
    h.publisher.close()
  })
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

it('selects output-specific caption placement and strips captions for old consumers', () => {
  const caption = {
    ...fixture.snapshot.layers[0],
    kind: 'caption' as const,
    id: 'caption',
    fade: null,
    expiresAt: 2000,
    stream: true,
    recording: true,
    outputRects: {
      stream: { x: 0, y: 0.6, w: 1, h: 0.1 },
      recording: { x: 0, y: 0.8, w: 1, h: 0.1 }
    }
  }
  const content = { h: [caption], v: [], unsupported: [] }
  expect(graphicsLayers(content, 'stream', 'h', false)).toEqual([])
  expect(graphicsLayers(content, 'stream', 'h', true)[0].rect.y).toBe(0.6)
  expect(graphicsLayers(content, 'recording', 'h', true)[0].rect.y).toBe(0.8)
  expect(graphicsLayers(content, 'stream', 'h', true)[0]).not.toHaveProperty('outputRects')
})
