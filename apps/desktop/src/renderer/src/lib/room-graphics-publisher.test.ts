import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState, RoomEvent, type Room } from 'livekit-client'
import {
  type AcceptedGraphicsView,
  type GraphicsContent,
  graphicsLayers,
  RoomGraphicsPublisher,
  roomGraphicsContent,
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
  const accepted: AcceptedGraphicsView[] = []
  const publisher = new RoomGraphicsPublisher(
    room as unknown as Room,
    (s) => statuses.push(s),
    (view) => accepted.push(view)
  )
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
  return { room, publisher, statuses, receive, accepted }
}
afterEach(() => vi.useRealTimers())
describe('room static graphics publisher', () => {
  it('serves a hidden program egress known only by its server-relayed receipt (QA F2)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    // LiveKit leaves `hidden: true` recorder grants out of remoteParticipants.
    h.room.remoteParticipants.delete('EG_program')
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
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.statuses.at(-1)?.state).toBe('preview')
    const lane = { version: 1, output: 'stream', orientation: 'h', static: { version: 1 } }
    h.receive(lane, { identity: 'g_guest' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.room.localParticipant.streamBytes).not.toHaveBeenCalled()
    h.receive(lane)
    await vi.advanceTimersByTimeAsync(1000)
    const call = h.room.localParticipant.streamBytes.mock.calls[0] as unknown as [
      { destinationIdentities: string[] }
    ]
    expect(call[0].destinationIdentities).toEqual(['EG_program'])
    const body = JSON.parse(new TextDecoder().decode(bodies[0]))
    expect(body.layers.length).toBeGreaterThan(0)
    h.receive({
      ...lane,
      static: { version: 1, applied: { publisherSid: 'PA_host', revision: body.revision } }
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.statuses.at(-1)?.state).toBe('applied')
    await vi.advanceTimersByTimeAsync(26_000)
    expect(h.statuses.at(-1)?.state).toBe('preview')
    h.publisher.close()
  })
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

describe('kept static views for the next controller (plan 249 S24)', () => {
  type Body = { revision: number; layers: GraphicsLayer[]; expiresAt: number }
  function capture(h: ReturnType<typeof harness>) {
    const bodies: Body[] = []
    let gate: Promise<void> | null = null
    let release = () => {}
    h.room.localParticipant.streamBytes.mockImplementation(async () => {
      const chunks: Uint8Array[] = []
      const held = gate
      return {
        write: vi.fn(async (bytes: Uint8Array) => {
          if (held) await held
          chunks.push(bytes)
        }),
        close: vi.fn(async () => {
          const text = chunks.map((c) => new TextDecoder().decode(c)).join('')
          if (text) bodies.push(JSON.parse(text))
        })
      }
    })
    return {
      bodies,
      holdUploads() {
        gate = new Promise<void>((resolve) => (release = resolve))
      },
      releaseUploads() {
        gate = null
        release()
      }
    }
  }
  const lane = { version: 1, output: 'stream', orientation: 'h' }
  const content = (stream: boolean, recording: boolean, kinds?: string[]): GraphicsContent => ({
    h: fixture.snapshot.layers
      .filter((l) => !kinds || kinds.includes(l.kind))
      .map((l) => ({ ...l, stream, recording })) as GraphicsContent['h'],
    v: [],
    unsupported: []
  })
  it('reports applied views as sent, clears too, and never an older one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    const c = capture(h)
    const ack = (revision: number) =>
      h.receive({ ...lane, static: { version: 1, applied: { publisherSid: 'PA_host', revision } } })
    h.publisher.set(content(true, true))
    h.receive({ ...lane, static: { version: 1 } })
    await vi.advanceTimersByTimeAsync(1000)
    const shown = c.bodies.at(-1)!
    // Sent but not applied: nothing yet; the upload alone never counts.
    expect(h.accepted).toEqual([])
    ack(shown.revision)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted).toEqual([
      {
        output: 'stream',
        orientation: 'h',
        publisherSid: 'PA_host',
        revision: shown.revision,
        layers: shown.layers
      }
    ])
    // Record only: the stream lane gets an empty view, and its applied clear
    // is reported although nothing is visible there.
    h.publisher.set(content(false, true))
    await vi.advanceTimersByTimeAsync(1000)
    const recordOnly = c.bodies.at(-1)!
    expect(recordOnly.layers).toEqual([])
    ack(recordOnly.revision)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted.at(-1)).toMatchObject({ revision: recordOnly.revision, layers: [] })
    // A late ack of the older, visible revision changes nothing.
    ack(shown.revision)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted).toHaveLength(2)
    // No banner left (chat only): reported, so the kept banner is replaced.
    h.publisher.set(content(true, true, ['chat']))
    await vi.advanceTimersByTimeAsync(1000)
    const chatOnly = c.bodies.at(-1)!
    expect(chatOnly.layers.map((l) => l.kind)).toEqual(['chat'])
    ack(chatOnly.revision)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted.at(-1)?.layers.map((l) => l.kind)).toEqual(['chat'])
    h.publisher.close()
  })
  it('Hide while an upload is pending: the clear is applied and reported', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    const c = capture(h)
    h.receive({ ...lane, static: { version: 1 } })
    c.holdUploads()
    h.publisher.set(content(true, true))
    await vi.advanceTimersByTimeAsync(100)
    // The banner upload is still writing; Hide goes on its own.
    c.releaseUploads()
    h.publisher.set(null)
    await vi.advanceTimersByTimeAsync(1000)
    const hidden = c.bodies.find((body) => body.layers.length === 0)
    expect(hidden).toBeDefined()
    h.receive({
      ...lane,
      static: { version: 1, applied: { publisherSid: 'PA_host', revision: hidden!.revision } }
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted.at(-1)).toMatchObject({ revision: hidden!.revision, layers: [] })
    // Nothing from the superseded upload is ever reported as kept.
    expect(h.accepted.every((view) => view.layers.length === 0)).toBe(true)
    h.publisher.close()
  })
  it('an ack after the sent envelope expired, or for another session, is never kept', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    const c = capture(h)
    h.publisher.set(content(true, true))
    h.receive({ ...lane, static: { version: 1 } })
    await vi.advanceTimersByTimeAsync(1000)
    const sent = c.bodies.at(-1)!
    h.receive({
      ...lane,
      static: { version: 1, applied: { publisherSid: 'PA_other', revision: sent.revision } }
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted).toEqual([])
    vi.setSystemTime(sent.expiresAt + 1)
    h.receive({
      ...lane,
      static: { version: 1, applied: { publisherSid: 'PA_host', revision: sent.revision } }
    })
    expect(h.accepted).toEqual([])
    h.publisher.close()
  })
})

// The owner, 2026-11-19 (0.32.1): on a managed talk show the comment cards
// and the captions never reached the viewers. Both ride this envelope, and
// it sent nothing while the room's Graphics switch (banners, timers and the
// chat box) was off, which it is in every new room.
describe('what the room sends with its Graphics switch off', () => {
  const layer = (kind: GraphicsLayer['kind'], id: string) => ({
    id,
    kind,
    rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
    asset: { png: 'iVBORw0KGgo=', hash: 'a'.repeat(64), width: 1, height: 1 },
    opacity: 1,
    fade: null,
    expiresAt: kind === 'banner' || kind === 'chat' ? null : 10_000,
    stream: true,
    recording: true
  })
  const content: GraphicsContent = {
    h: [layer('banner', 'banner:b1'), layer('caption', 'caption'), layer('chat', 'chat')],
    v: [layer('highlight', 'highlight'), layer('banner', 'banner:b1')],
    unsupported: ['HTML graphics require the separately qualified dynamic transport.'],
    html: { h: [], v: [] }
  }

  it('keeps everything with the switch on', () => {
    expect(roomGraphicsContent(content, true)).toBe(content)
    expect(roomGraphicsContent(null, true)).toBeNull()
  })

  it('sends only captions and the comment card with it off, and nothing else', () => {
    const off = roomGraphicsContent(content, false)
    expect(off?.h.map((l) => l.kind)).toEqual(['caption'])
    expect(off?.v.map((l) => l.kind)).toEqual(['highlight'])
    // A banner's refusal and the HTML placements speak for banners alone.
    expect(off?.unsupported).toEqual([])
    expect(off).not.toHaveProperty('html')
    expect(roomGraphicsContent({ ...content, h: [content.h[0]!], v: [] }, false)).toBeNull()
    expect(roomGraphicsContent(null, false)).toBeNull()
  })
})
