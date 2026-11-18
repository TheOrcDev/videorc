import manifest from '../../../../../../protocol-fixtures/cloud-parity-media-v2.json'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { RoomEvent, type Room } from 'livekit-client'
import { RoomAuxPublisher, auxiliaryBlockedReason } from './room-aux-publisher'
import {
  AUX_TRACK_NAME,
  CAPABILITY_TOPIC,
  ROOM_MEDIA_MANIFEST,
  parseConsumerCapability
} from './room-media-v2'
import { soundboard } from './soundboard-store'
const sinks = vi.hoisted(() => ({
  made: [] as {
    track: MediaStreamTrack
    close: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    problem: () => null
    queued: () => string[]
  }[]
}))
vi.mock('./room-aux-sink', () => ({
  createRoomAuxSink: () => {
    const sink = {
      track: {
        kind: 'audio',
        id: 'aux',
        enabled: true,
        stop: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        getSettings: () => ({}),
        getConstraints: () => ({})
      } as unknown as MediaStreamTrack,
      close: vi.fn(),
      update: vi.fn(),
      problem: () => null,
      queued: (): string[] => []
    }
    sinks.made.push(sink)
    return sink
  }
}))
vi.mock('livekit-client', async (original) => {
  const sdk = await original<typeof import('livekit-client')>()
  return {
    ...sdk,
    LocalAudioTrack: class {
      constructor(readonly mediaStreamTrack: MediaStreamTrack) {}
      stop() {
        this.mediaStreamTrack.stop()
      }
    }
  }
})
const now = 100_000
const capable = { v: 2 as const, identity: 'g_one', participantSid: 'PA_one', at: now }
const peer = { identity: 'g_one', sid: 'PA_one' }
function fakeRoom() {
  const room = Object.assign(new EventEmitter(), {
    state: 'connected',
    remoteParticipants: new Map([[peer.identity, peer]]),
    localParticipant: {
      trackPublications: new Map([['TR_mic', { trackName: 'mic', trackSid: 'TR_mic' }]]),
      setTrackSubscriptionPermissions: vi.fn(),
      publishTrack: vi.fn(async (_track, options) => {
        expect(options).toMatchObject({ name: AUX_TRACK_NAME, forceStereo: true, dtx: false })
        return { trackSid: 'TR_aux' }
      }),
      unpublishTrack: vi.fn(async () => {})
    }
  })
  return room
}
function receipt(room: EventEmitter, value: unknown = capable, participant?: unknown) {
  room.emit(
    RoomEvent.DataReceived,
    new TextEncoder().encode(JSON.stringify(value)),
    participant,
    undefined,
    CAPABILITY_TOPIC
  )
}
afterEach(() => {
  vi.useRealTimers()
  sinks.made.length = 0
  soundboard.setRoomAux(undefined)
})
describe('media v2 compatibility', () => {
  it('pins an unqualified stereo role and refuses old or malformed consumers', () => {
    expect(ROOM_MEDIA_MANIFEST).toEqual(manifest)
    expect(ROOM_MEDIA_MANIFEST.productionQualified).toBe(false)
    expect(parseConsumerCapability({ ...capable, v: 1 })).toBeNull()
    expect(parseConsumerCapability({ ...capable, identity: 'host:show' })).toBeNull()
    expect(
      parseConsumerCapability({
        ...capable,
        auxiliary: { trackSid: 'TR_aux', rms: NaN, observedAt: now }
      })
    ).toBeNull()
    expect(auxiliaryBlockedReason(true, true, [peer], new Map(), now)).toContain('Reload')
    expect(
      auxiliaryBlockedReason(true, true, [peer], new Map([[peer.identity, capable]]), now)
    ).toBeNull()
    expect(
      auxiliaryBlockedReason(
        true,
        true,
        [{ ...peer, sid: 'PA_rejoin' }],
        new Map([[peer.identity, capable]]),
        now
      )
    ).toContain('Reload')
    expect(
      auxiliaryBlockedReason(true, true, [peer], new Map([[peer.identity, capable]]), now + 25000)
    ).toContain('Reload')
  })
  it('defaults off, rejects guest-forged receipts, publishes once and denies a newly joined old page', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const room = fakeRoom()
    const publisher = new RoomAuxPublisher(room as unknown as Room)
    receipt(room)
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled()
    soundboard.setRoomAuxEnabled(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1)
    expect(soundboard.getSnapshot().roomAux?.state).toBe('published')
    expect(soundboard.getSnapshot().roomAux?.observed).toEqual({})
    expect(room.localParticipant.setTrackSubscriptionPermissions).toHaveBeenLastCalledWith(false, [
      { participantSid: 'PA_one', allowAll: false, allowedTrackSids: ['TR_mic', 'TR_aux'] }
    ])
    room.remoteParticipants.set('g_old', { identity: 'g_old', sid: 'PA_old' })
    room.emit(RoomEvent.ParticipantConnected)
    expect(soundboard.getSnapshot().roomAux?.state).toBe('blocked')
    expect(sinks.made[0]?.close).toHaveBeenCalled()
    receipt(
      room,
      { ...capable, identity: 'g_old', participantSid: 'PA_old' },
      { identity: 'g_old' }
    )
    expect(soundboard.getSnapshot().roomAux?.state).toBe('blocked')
    publisher.close()
  })
  it('expires receipts, clears audibility on reconnect and never inherits capability by identity', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const room = fakeRoom()
    const publisher = new RoomAuxPublisher(room as unknown as Room)
    soundboard.setRoomAuxEnabled(true)
    receipt(room)
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(now + 1)
    receipt(room, {
      ...capable,
      at: now + 1,
      auxiliary: { trackSid: 'TR_aux', rms: 0.1, observedAt: now + 1 }
    })
    expect(soundboard.getSnapshot().roomAux?.observed).toEqual({ g_one: now + 1 })
    room.state = 'reconnecting'
    room.emit(RoomEvent.Reconnecting)
    expect(soundboard.getSnapshot().roomAux?.observed).toEqual({})
    room.state = 'connected'
    room.remoteParticipants.set('g_one', { ...peer, sid: 'PA_new' })
    room.emit(RoomEvent.Reconnected)
    receipt(room, { ...capable, at: now + 2 })
    expect(soundboard.getSnapshot().roomAux?.state).toBe('blocked')
    publisher.close()
  })
  it('S8: runs its 1 s pulse only for an enabled source or a routing-capable program lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const room = fakeRoom()
    const program = { identity: 'EG_program', sid: 'PA_program' }
    room.remoteParticipants.set(program.identity, program)
    const publishData = vi.fn(async () => {})
    Object.assign(room.localParticipant, { sid: 'PA_host', publishData })
    const publisher = new RoomAuxPublisher(room as unknown as Room)
    // Nothing on and no program page that negotiated routing: no timer.
    expect(vi.getTimerCount()).toBe(0)
    receipt(room, {
      ...capable,
      identity: program.identity,
      participantSid: program.sid,
      audioRouting: 1
    })
    expect(vi.getTimerCount()).toBe(1)
    expect(publishData).toHaveBeenCalled()
    room.remoteParticipants.delete(program.identity)
    room.emit(RoomEvent.ParticipantDisconnected, program)
    expect(vi.getTimerCount()).toBe(0)
    publisher.close()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('QA F2: a hidden program egress is a consumer by its relayed receipt; a hidden guest never is', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const room = fakeRoom()
    const publishData = vi.fn(async () => {})
    Object.assign(room.localParticipant, { sid: 'PA_host', publishData })
    const publisher = new RoomAuxPublisher(room as unknown as Room)
    soundboard.setRoomAuxEnabled(true)
    receipt(room)
    // A guest LiveKit does not show is never served.
    receipt(room, { ...capable, identity: 'g_hidden', participantSid: 'PA_hidden' })
    receipt(room, {
      ...capable,
      identity: 'EG_program',
      participantSid: 'PA_program',
      audioRouting: 1
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(publishData).toHaveBeenCalled()
    expect(soundboard.getSnapshot().roomAux?.state).toBe('published')
    expect(room.localParticipant.setTrackSubscriptionPermissions).toHaveBeenLastCalledWith(false, [
      { participantSid: 'PA_one', allowAll: false, allowedTrackSids: ['TR_mic', 'TR_aux'] },
      { participantSid: 'PA_program', allowAll: false, allowedTrackSids: ['TR_mic', 'TR_aux'] }
    ])
    // Its lease ends with the receipt TTL.
    vi.setSystemTime(now + 25_000)
    receipt(room, { ...capable, at: now + 25_000 })
    expect(room.localParticipant.setTrackSubscriptionPermissions).toHaveBeenLastCalledWith(false, [
      { participantSid: 'PA_one', allowAll: false, allowedTrackSids: ['TR_mic', 'TR_aux'] }
    ])
    publisher.close()
  })
  it('cancels a pending publish and retires it before any replacement can start', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const room = fakeRoom()
    let finish!: (value: { trackSid: string }) => void
    room.localParticipant.publishTrack.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const publisher = new RoomAuxPublisher(room as unknown as Room)
    soundboard.setRoomAuxEnabled(true)
    receipt(room)
    await vi.advanceTimersByTimeAsync(0)
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1)
    soundboard.setRoomAuxEnabled(false)
    expect(sinks.made[0]?.track.stop).toHaveBeenCalled()
    finish({ trackSid: 'TR_stale' })
    await vi.advanceTimersByTimeAsync(0)
    expect(soundboard.getSnapshot().roomAux?.trackSid).toBeNull()
    expect(soundboard.getSnapshot().roomAux?.state).toBe('off')
    soundboard.setRoomAuxEnabled(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2)
    publisher.close()
  })
})
