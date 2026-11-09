// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudRoomClientState, CloudRoomTokenAnswer } from '@/lib/backend'
import { TalkShowRoomClient } from '@/lib/talk-show-room'

// Plan 224 C-G4 and the review of 2026-11-09 (L4, L9's room client): the host
// joins with one fresh token, asks for no other on a timer (LiveKit refreshes
// a running connection itself), rejoins a dropped room with a fresh one, and
// stays out after a terminal end. `livekit-client` is faked: these are the
// client's own rules, not the SDK's.

const lk = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void
  const fakeLocalTrack = () => ({
    mediaStreamTrack: { kind: 'video' } as unknown as MediaStreamTrack,
    mute: async () => {},
    unmute: async () => {},
    stop: () => {}
  })
  class FakeRoom {
    static rooms: FakeRoom[] = []
    readonly handlers = new Map<string, Handler>()
    state = 'disconnected'
    connectedWith: { url: string; token: string } | null = null
    readonly remoteParticipants = new Map()
    readonly localParticipant = {
      publishTrack: async () => {},
      unpublishTrack: async () => {},
      publishData: async () => {}
    }
    constructor() {
      FakeRoom.rooms.push(this)
    }
    on(event: string, handler: Handler): this {
      this.handlers.set(event, handler)
      return this
    }
    async connect(url: string, token: string): Promise<void> {
      this.connectedWith = { url, token }
      this.state = 'connected'
    }
    async disconnect(): Promise<void> {
      this.state = 'disconnected'
    }
    emit(event: string, ...args: unknown[]): void {
      this.handlers.get(event)?.(...args)
    }
  }
  return { FakeRoom, fakeLocalTrack }
})

vi.mock('livekit-client', () => ({
  Room: lk.FakeRoom,
  RoomEvent: new Proxy({}, { get: (_target, name) => String(name) }),
  ConnectionState: { Connected: 'connected' },
  ConnectionQuality: { Excellent: 'excellent', Good: 'good', Poor: 'poor', Lost: 'lost' },
  DisconnectReason: {
    CLIENT_INITIATED: 1,
    DUPLICATE_IDENTITY: 2,
    PARTICIPANT_REMOVED: 4,
    ROOM_DELETED: 5
  },
  Track: {
    Source: { Camera: 'camera', Microphone: 'microphone', ScreenShare: 'screen_share' },
    Kind: { Audio: 'audio', Video: 'video' }
  },
  VideoPresets: {
    h180: {},
    h360: {},
    h720: { resolution: { width: 1280, height: 720 }, encoding: {} }
  },
  LocalAudioTrack: class {},
  LocalVideoTrack: class {},
  createLocalVideoTrack: async () => lk.fakeLocalTrack(),
  createLocalAudioTrack: async () => lk.fakeLocalTrack()
}))

function client() {
  let minted = 0
  const requestToken = vi.fn(async (): Promise<CloudRoomTokenAnswer> => {
    minted += 1
    return {
      hostToken: `lk.host.token.${minted}`,
      url: 'ws://127.0.0.1:7880',
      identity: 'host:sh_talk',
      showId: 'sh_talk'
    }
  })
  const reports: CloudRoomClientState[] = []
  const room = new TalkShowRoomClient({
    requestToken,
    report: (state) => reports.push(state),
    onSnapshot: () => {},
    cameraName: null,
    microphoneName: null,
    audioHost: () => null
  })
  return { room, requestToken, reports }
}

const latestRoom = () => lk.FakeRoom.rooms[lk.FakeRoom.rooms.length - 1]

beforeEach(() => {
  vi.useFakeTimers()
  lk.FakeRoom.rooms.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the host in the room (C-G4)', () => {
  it('joins with one fresh token and asks for no other on a timer (review L4)', async () => {
    const { room, requestToken } = client()
    await room.connect()
    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(latestRoom().connectedWith?.token).toBe('lk.host.token.1')
    expect(room.snapshot.state).toBe('connected')
    expect(room.snapshot.identity).toBe('host:sh_talk')
    expect(JSON.stringify(room.snapshot)).not.toContain('lk.host.token')
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await room.disconnect()
  })

  it('rejoins a dropped room with a fresh token', async () => {
    const { room, requestToken, reports } = client()
    await room.connect()
    const first = latestRoom()
    first.emit('Disconnected', undefined)
    expect(room.snapshot.state).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(requestToken).toHaveBeenCalledTimes(2)
    expect(latestRoom()).not.toBe(first)
    expect(latestRoom().connectedWith?.token).toBe('lk.host.token.2')
    expect(room.snapshot.state).toBe('connected')
    expect(reports).toEqual(['connecting', 'connected', 'reconnecting', 'connected'])
    await room.disconnect()
  })

  it('stays out after the host is removed, and a Leave asks for nothing', async () => {
    const { room, requestToken } = client()
    await room.connect()
    latestRoom().emit('Disconnected', 4)
    expect(room.snapshot.state).toBe('disconnected')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requestToken).toHaveBeenCalledTimes(1)
    await room.disconnect()
    expect(room.snapshot.state).toBe('idle')
    await room.connect()
    expect(requestToken).toHaveBeenCalledTimes(1)
  })
})
