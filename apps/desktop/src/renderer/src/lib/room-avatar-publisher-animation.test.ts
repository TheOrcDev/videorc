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

/** Plan 249 S5: the atlas variant goes only where `graphics.animation: 1` asked for it. */
function harness() {
  const bodies = new Map<string, unknown[]>()
  const room = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    name: 'sh_avatar',
    localParticipant: {
      sid: 'PA_host',
      streamBytes: vi.fn(async (options: { destinationIdentities: string[] }) => {
        const chunks: Uint8Array[] = []
        return {
          write: vi.fn(async (bytes: Uint8Array) => void chunks.push(bytes)),
          close: vi.fn(async () => {
            const text = chunks.map((c) => new TextDecoder().decode(c)).join('')
            if (text) {
              const to = options.destinationIdentities[0]!
              bodies.set(to, [...(bodies.get(to) ?? []), JSON.parse(text)])
            }
          })
        }
      })
    },
    remoteParticipants: new Map([
      ['EG_old', { identity: 'EG_old', sid: 'PA_old' }],
      ['EG_new', { identity: 'EG_new', sid: 'PA_new' }],
      ['g_guest', { identity: 'g_guest', sid: 'PA_guest' }]
    ])
  })
  const statuses: RoomAvatarStatus[] = []
  const accepted: AcceptedAvatarView[] = []
  const publisher = new RoomAvatarPublisher(
    room as unknown as Room,
    (status) => statuses.push(status),
    (view) => accepted.push(view)
  )
  const receive = (identity: string, sid: string, graphics: unknown) =>
    room.emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(
        JSON.stringify({ v: 2, identity, participantSid: sid, at: Date.now(), graphics })
      ),
      undefined,
      undefined,
      CAPABILITY_TOPIC
    )
  return { room, publisher, receive, bodies, statuses, accepted }
}
afterEach(() => vi.useRealTimers())

describe('room avatar publisher, animated variant', () => {
  it('sends atlas layers to animation consumers, static ones to the rest, and lists only them for motion', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    const still = fixture.snapshot.layers as AvatarLayer[]
    // The variant differs by content (avatar only), which is what the routing check needs.
    const animated = { h: [still[0]!], v: [] }
    h.publisher.set({ h: still, v: [], stream: true, recording: false, animated })
    expect(h.publisher.motionTargets()).toEqual([])
    h.receive('EG_old', 'PA_old', { version: 1, output: 'stream', orientation: 'h' })
    h.receive('EG_new', 'PA_new', { version: 1, output: 'stream', orientation: 'h', animation: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.publisher.motionTargets()).toEqual(['EG_new'])
    // The page from before animation draws it still, and the room can say so.
    expect(h.publisher.motionCoverage()).toEqual({ animated: ['EG_new'], still: 1 })
    // The desktop's Program preview reconstructs what an animating output draws.
    expect(h.statuses.at(-1)?.preview?.layers.map((l) => l.kind)).toEqual(['avatar'])
    const old = h.bodies.get('EG_old')?.at(-1) as { layers: AvatarLayer[] }
    const fresh = h.bodies.get('EG_new')?.at(-1) as { layers: AvatarLayer[] }
    expect(old.layers.map((l) => l.kind)).toEqual(['avatar', 'bubble'])
    expect(fresh.layers.map((l) => l.kind)).toEqual(['avatar'])
    expect(h.bodies.has('g_guest')).toBe(false)
    // An output the content does not show gets no motion, and disabling clears targets.
    h.receive('EG_new', 'PA_new', {
      version: 1,
      output: 'recording',
      orientation: 'h',
      animation: 1
    })
    expect(h.publisher.motionTargets()).toEqual([])
    h.publisher.set(null)
    expect(h.publisher.motionTargets()).toEqual([])
    h.publisher.close()
  })
  it('keeps for each page the variant that page applied (plan 249 S24)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness()
    const still = fixture.snapshot.layers as AvatarLayer[]
    const animated = { h: [still[0]!], v: [] }
    h.publisher.set({ h: still, v: [], stream: true, recording: false, animated })
    h.receive('EG_old', 'PA_old', { version: 1, output: 'stream', orientation: 'h' })
    h.receive('EG_new', 'PA_new', { version: 1, output: 'stream', orientation: 'h', animation: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    const old = h.bodies.get('EG_old')?.at(-1) as { revision: number; layers: AvatarLayer[] }
    const fresh = h.bodies.get('EG_new')?.at(-1) as { revision: number; layers: AvatarLayer[] }
    const applied = (revision: number) => ({ publisherSid: 'PA_host', revision })
    const ack = (identity: string, sid: string, revision: number, animation?: 1) =>
      h.receive(identity, sid, {
        version: 1,
        output: 'stream',
        orientation: 'h',
        ...(animation ? { animation } : {}),
        applied: applied(revision)
      })
    // Both pages show one view (stream, h): each kept as that page got it,
    // in revision order; a late ack of the older one replaces nothing.
    const [first, second] =
      old.revision < fresh.revision
        ? ([
            ['EG_old', 'PA_old', old, undefined],
            ['EG_new', 'PA_new', fresh, 1]
          ] as const)
        : ([
            ['EG_new', 'PA_new', fresh, 1],
            ['EG_old', 'PA_old', old, undefined]
          ] as const)
    ack(first[0], first[1], first[2].revision, first[3])
    ack(second[0], second[1], second[2].revision, second[3])
    ack(first[0], first[1], first[2].revision, first[3])
    await vi.advanceTimersByTimeAsync(100)
    expect(h.accepted.map((view) => view.layers)).toEqual([first[2].layers, second[2].layers])
    expect(h.accepted.map((view) => view.revision)).toEqual([first[2].revision, second[2].revision])
    h.publisher.close()
  })
})
