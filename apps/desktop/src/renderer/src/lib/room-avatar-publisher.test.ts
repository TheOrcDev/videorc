import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState, RoomEvent, type Room } from 'livekit-client'
import {
  RoomAvatarPublisher,
  type AcceptedAvatarView,
  type RoomAvatarStatus
} from './room-avatar-publisher'
import { CAPABILITY_TOPIC } from './room-media-v2'
import fixture from '../../../../../..//protocol-fixtures/cloud-parity-avatar.json'
import type { AvatarLayer } from '../../../shared/cloud-avatar'

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
  const statuses: RoomAvatarStatus[] = []
  const accepted: AcceptedAvatarView[] = []
  const publisher = new RoomAvatarPublisher(
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
  const receiveFrom = (identity: string, sid: string, graphics: unknown) =>
    room.emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(
        JSON.stringify({ v: 2, identity, participantSid: sid, at: Date.now(), graphics })
      ),
      undefined,
      undefined,
      CAPABILITY_TOPIC
    )
  return { room, publisher, statuses, receive, receiveFrom, accepted }
}
afterEach(() => vi.useRealTimers())
describe('room avatar publisher', () => {
  it('serves a hidden program egress known only by its server-relayed receipt, never a hidden guest (QA F2)', async () => {
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
    h.publisher.guests(true)
    h.publisher.set({
      h: fixture.snapshot.layers as AvatarLayer[],
      v: [],
      stream: true,
      recording: false
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.statuses.at(-1)?.state).toBe('preview')
    // A participant cannot claim a hidden lane, and a guest must be visible.
    h.receive({ version: 1, output: 'stream', orientation: 'h' }, { identity: 'g_guest' })
    h.receiveFrom('g_hidden', 'PA_hidden', { version: 1, output: 'stream', orientation: 'h' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.room.localParticipant.streamBytes).not.toHaveBeenCalled()
    h.receive({ version: 1, output: 'stream', orientation: 'h' })
    await vi.advanceTimersByTimeAsync(1000)
    const targets = h.room.localParticipant.streamBytes.mock.calls.map(
      (call) => (call as unknown as [{ destinationIdentities: string[] }])[0].destinationIdentities
    )
    expect(targets.flat()).toEqual(['EG_program'])
    const body = JSON.parse(new TextDecoder().decode(bodies[0]))
    expect(body.layers.some((l: AvatarLayer) => l.kind === 'avatar')).toBe(true)
    expect(h.statuses.at(-1)?.state).toBe('waiting')
    h.receive({
      version: 1,
      output: 'stream',
      orientation: 'h',
      applied: { publisherSid: 'PA_host', revision: body.revision }
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.statuses.at(-1)?.state).toBe('applied')
    expect(Object.keys(h.statuses.at(-1)?.observed ?? {})).toEqual(['EG_program'])
    expect(h.publisher.motionCoverage()).toEqual({ animated: [], still: 0 })
    // With no renewed receipt the hidden page is gone after the receipt TTL.
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
      h: fixture.snapshot.layers as AvatarLayer[],
      v: [],
      stream: true,
      recording: false
    })
    h.receive(undefined)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.room.localParticipant.streamBytes).not.toHaveBeenCalled()
    h.receive({ version: 1, output: 'stream', orientation: 'h' }, { identity: 'guest' })
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
      h: fixture.snapshot.layers as AvatarLayer[],
      v: [],
      stream: true,
      recording: false
    })
    h.receive({ version: 1, output: 'recording', orientation: 'h' })
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
      applied: { publisherSid: 'PA_host', revision: body.revision }
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.statuses.at(-1)?.observed).toEqual({}) // a clear is not a visible avatar / AI-spend permission
    h.room.emit(RoomEvent.Reconnecting)
    expect(h.statuses.at(-1)?.observed).toEqual({})
    h.publisher.close()
  })
  it('reports each applied view once, exactly as that output got it (plan 249 S24)', async () => {
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
      h: fixture.snapshot.layers as AvatarLayer[],
      v: [],
      stream: true,
      recording: false
    })
    h.receive({ version: 1, output: 'stream', orientation: 'h' })
    await vi.advanceTimersByTimeAsync(1000)
    const body = JSON.parse(new TextDecoder().decode(bodies[0]))
    // Received but not applied: nothing is kept yet.
    expect(h.accepted).toEqual([])
    const applied = {
      version: 1,
      output: 'stream',
      orientation: 'h',
      applied: { publisherSid: 'PA_host', revision: body.revision }
    }
    h.receive(applied)
    h.receive(applied)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted).toEqual([
      {
        output: 'stream',
        orientation: 'h',
        publisherSid: 'PA_host',
        revision: body.revision,
        layers: body.layers
      }
    ])
    // A receipt naming another publisher (an old host session) is never kept.
    h.receive({ ...applied, applied: { publisherSid: 'PA_old', revision: body.revision } })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted).toHaveLength(1)
    h.publisher.close()
  })
  it('a clear a page applied reaches the cloud too, and an older ack never replaces a newer view (plan 249 S24)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    const bodies: { revision: number; layers: AvatarLayer[]; expiresAt: number }[] = []
    h.room.localParticipant.streamBytes.mockImplementation(async () => {
      const chunks: Uint8Array[] = []
      return {
        write: vi.fn(async (bytes: Uint8Array) => {
          chunks.push(bytes)
        }),
        close: vi.fn(async () => {
          const text = chunks.map((c) => new TextDecoder().decode(c)).join('')
          if (text) bodies.push(JSON.parse(text))
        })
      }
    })
    const lane = { version: 1, output: 'stream', orientation: 'h' }
    const ack = (revision: number) =>
      h.receive({ ...lane, applied: { publisherSid: 'PA_host', revision } })
    const layers = fixture.snapshot.layers as AvatarLayer[]
    h.publisher.set({ h: layers, v: [], stream: true, recording: true })
    h.receive(lane)
    await vi.advanceTimersByTimeAsync(1000)
    const shown = bodies.at(-1)!
    ack(shown.revision)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted.map((v) => v.layers.length)).toEqual([shown.layers.length])
    // Record only: the stream lane is sent an empty view; once applied, the
    // cloud forgets the stream's avatar instead of keeping it for a takeover.
    h.publisher.set({ h: layers, v: [], stream: false, recording: true })
    await vi.advanceTimersByTimeAsync(1000)
    const recordOnly = bodies.at(-1)!
    expect(recordOnly.layers).toEqual([])
    ack(recordOnly.revision)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted.at(-1)).toMatchObject({
      output: 'stream',
      revision: recordOnly.revision,
      layers: []
    })
    // A late ack of the older, visible revision changes nothing.
    ack(shown.revision)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted).toHaveLength(2)
    // Hide while an upload may still be pending: the clear is reported too.
    h.publisher.set({ h: layers, v: [], stream: true, recording: true })
    await vi.advanceTimersByTimeAsync(1000)
    h.publisher.set(null)
    await vi.advanceTimersByTimeAsync(1000)
    const hidden = bodies.at(-1)!
    expect(hidden.layers).toEqual([])
    ack(hidden.revision)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted.at(-1)).toMatchObject({ revision: hidden.revision, layers: [] })
    // An ack after the sent envelope expired is never kept.
    const count = h.accepted.length
    h.publisher.set({ h: layers, v: [], stream: true, recording: true })
    await vi.advanceTimersByTimeAsync(1000)
    const late = bodies.at(-1)!
    vi.setSystemTime(late.expiresAt + 1)
    ack(late.revision)
    expect(h.accepted).toHaveLength(count)
    h.publisher.close()
  })
  it('plan 249 S6: guests get the stream landscape layers only after the host opts in, then one clear', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    const sent: { to: string; body: { layers: unknown[]; output: string; revision: number } }[] = []
    h.room.localParticipant.streamBytes.mockImplementation((async (options: {
      destinationIdentities: string[]
    }) => {
      const chunks: Uint8Array[] = []
      return {
        write: vi.fn(async (bytes: Uint8Array) => {
          chunks.push(bytes)
        }),
        close: vi.fn(async () => {
          sent.push({
            to: options.destinationIdentities[0]!,
            body: JSON.parse(new TextDecoder().decode(chunks[0]))
          })
        })
      }
    }) as never)
    const guestLane = { version: 1, output: 'stream', orientation: 'h' }
    h.publisher.set({
      h: fixture.snapshot.layers as AvatarLayer[],
      v: [],
      stream: true,
      recording: true
    })
    h.receiveFrom('g_guest', 'PA_guest', guestLane)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent.filter((s) => s.to === 'g_guest')).toEqual([])
    expect(h.statuses.at(-1)?.guests).toEqual({ enabled: false, capable: 1, applied: 0 })

    h.publisher.guests(true)
    await vi.advanceTimersByTimeAsync(1000)
    const shown = sent.filter((s) => s.to === 'g_guest')
    expect(shown).toHaveLength(1)
    expect(shown[0]!.body.output).toBe('stream')
    expect(shown[0]!.body.layers).toHaveLength(2)
    // The guest confirms that revision; it counts for guests, never the egress state.
    h.receiveFrom('g_guest', 'PA_guest', {
      ...guestLane,
      applied: { publisherSid: 'PA_host', revision: shown[0]!.body.revision }
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.statuses.at(-1)?.guests).toEqual({ enabled: true, capable: 1, applied: 1 })
    // The program egress has not confirmed: a guest never stands in for it.
    expect(h.statuses.at(-1)?.state).toBe('waiting')
    expect(h.statuses.at(-1)?.observed).toEqual({})

    // Recording only: nothing for guests, so they are cleared once.
    h.publisher.set({
      h: fixture.snapshot.layers as AvatarLayer[],
      v: [],
      stream: false,
      recording: true
    })
    await vi.advanceTimersByTimeAsync(1000)
    const cleared = sent.filter((s) => s.to === 'g_guest')
    expect(cleared).toHaveLength(2)
    expect(cleared[1]!.body.layers).toEqual([])
    await vi.advanceTimersByTimeAsync(12_000)
    expect(sent.filter((s) => s.to === 'g_guest')).toHaveLength(2)

    // Shown again, then the host opts out: one clear.
    h.publisher.set({
      h: fixture.snapshot.layers as AvatarLayer[],
      v: [],
      stream: true,
      recording: false
    })
    h.receiveFrom('g_guest', 'PA_guest', guestLane)
    await vi.advanceTimersByTimeAsync(1000)
    // The bubble's own expiry has passed by now; the avatar remains.
    expect(
      (sent.filter((s) => s.to === 'g_guest').at(-1)!.body.layers as { kind: string }[]).map(
        (l) => l.kind
      )
    ).toEqual(['avatar'])
    h.publisher.guests(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sent.filter((s) => s.to === 'g_guest').at(-1)!.body.layers).toEqual([])
    h.publisher.close()
  })
  it('plan 249 S6: a guest cannot claim the recording or a portrait lane', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    h.publisher.guests(true)
    h.publisher.set({
      h: fixture.snapshot.layers as AvatarLayer[],
      v: fixture.snapshot.layers as AvatarLayer[],
      stream: true,
      recording: true
    })
    h.receiveFrom('g_guest', 'PA_guest', { version: 1, output: 'recording', orientation: 'h' })
    h.receiveFrom('g_guest', 'PA_guest', { version: 1, output: 'stream', orientation: 'v' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.room.localParticipant.streamBytes).not.toHaveBeenCalled()
    expect(h.statuses.at(-1)?.guests).toEqual({ enabled: true, capable: 0, applied: 0 })
    h.publisher.close()
  })
})
