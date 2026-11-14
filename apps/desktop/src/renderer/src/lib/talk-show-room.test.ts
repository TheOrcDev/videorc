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
    stop: vi.fn()
  })
  class FakeRoom {
    static rooms: FakeRoom[] = []
    readonly handlers = new Map<string, Handler>()
    state = 'disconnected'
    connectedWith: { url: string; token: string } | null = null
    readonly remoteParticipants = new Map()
    readonly streams: {
      topic: string
      mimeType: string
      totalSize: number
      attributes?: Record<string, string>
      bytes: number
      closed: boolean
    }[] = []
    readonly localParticipant = {
      publishTrack: vi.fn(async () => {}),
      unpublishTrack: async () => {},
      publishData: async () => {},
      streamBytes: async (options: {
        topic: string
        mimeType: string
        totalSize: number
        attributes?: Record<string, string>
      }) => {
        const stream = { ...options, bytes: 0, closed: false }
        this.streams.push(stream)
        return {
          write: async (chunk: Uint8Array) => {
            stream.bytes += chunk.byteLength
          },
          close: async () => {
            stream.closed = true
          }
        }
      }
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
  return { FakeRoom, fakeLocalTrack, video: vi.fn(), audio: vi.fn() }
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
  createLocalVideoTrack: lk.video,
  createLocalAudioTrack: lk.audio
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
  lk.video.mockReset().mockImplementation(async () => lk.fakeLocalTrack())
  lk.audio.mockReset().mockImplementation(async () => lk.fakeLocalTrack())
})

afterEach(() => {
  vi.unstubAllGlobals()
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it.each(['video', 'audio'] as const)('stops a %s track acquired after Close', async (kind) => {
  const acquired = deferred<ReturnType<typeof lk.fakeLocalTrack>>()
  const started = deferred<void>()
  lk[kind].mockImplementationOnce(() => {
    started.resolve()
    return acquired.promise
  })
  const { room } = client()
  const connecting = room.connect()
  await started.promise
  await room.disconnect()
  const track = lk.fakeLocalTrack()
  acquired.resolve(track)
  await connecting
  expect(track.stop).toHaveBeenCalled()
  expect(latestRoom().localParticipant.publishTrack).not.toHaveBeenCalledWith(
    track,
    expect.anything()
  )
  expect(room.snapshot.state).toBe('idle')
  expect(room.snapshot.local.camera).toBeNull()
  expect(room.snapshot.local.microphone).toBeNull()
  if (kind === 'video') expect(lk.audio).not.toHaveBeenCalled()
})

it('does not reconnect when Close happens while a fresh token is pending', async () => {
  const { room, requestToken } = client()
  await room.connect()
  const token = deferred<CloudRoomTokenAnswer>()
  requestToken.mockImplementationOnce(() => token.promise)
  latestRoom().emit('Disconnected')
  await vi.advanceTimersByTimeAsync(1000)
  await room.disconnect()
  token.resolve({
    hostToken: 'fresh',
    url: 'ws://localhost',
    identity: 'host:sh_talk',
    showId: 'sh_talk'
  })
  await token.promise
  await Promise.resolve()
  expect(lk.FakeRoom.rooms).toHaveLength(1)
  expect(room.snapshot.state).toBe('idle')
})

it('stops a screen acquired after Close without publishing it', async () => {
  const stream = deferred<MediaStream>()
  const started = deferred<void>()
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getDisplayMedia: () => {
        started.resolve()
        return stream.promise
      }
    }
  })
  const { room } = client()
  await room.connect()
  const sharing = room.startScreenShare()
  await started.promise
  await room.disconnect()
  const track = { stop: vi.fn() }
  stream.resolve({ getTracks: () => [track] } as unknown as MediaStream)
  await sharing
  expect(track.stop).toHaveBeenCalledOnce()
  expect(room.snapshot.local.screen).toBeNull()
})

// Plan 234 T3: a managed show's program page joins the room as LiveKit's
// recorder (`EG_…`). It is not a person: it is never listed, and its joining
// does not send the guests' stage message again.
describe("LiveKit's recorder in the room (plan 234 T3)", () => {
  const participant = (identity: string, name: string) => ({
    identity,
    name,
    trackPublications: new Map(),
    connectionQuality: 'good'
  })

  it('is never listed among the people, and a guest still is', async () => {
    const { room } = client()
    await room.connect()
    const recorder = participant('EG_a1B2c3D4e5F6', '')
    const ada = participant('g_ada', 'Ada')
    latestRoom().remoteParticipants.set(recorder.identity, recorder)
    latestRoom().emit('ParticipantConnected', recorder)
    expect(room.snapshot.people).toEqual([])
    latestRoom().remoteParticipants.set(ada.identity, ada)
    latestRoom().emit('ParticipantConnected', ada)
    expect(room.snapshot.people.map((person) => person.identity)).toEqual(['g_ada'])
    await room.disconnect()
  })

  it('gets no stage message when it joins; a guest who joins does', async () => {
    const { room } = client()
    await room.connect()
    await room.sendStage(['host:sh_talk'])
    const publishData = vi.fn(async () => {})
    latestRoom().localParticipant.publishData = publishData
    const recorder = participant('EG_a1B2c3D4e5F6', '')
    latestRoom().remoteParticipants.set(recorder.identity, recorder)
    latestRoom().emit('ParticipantConnected', recorder)
    await vi.advanceTimersByTimeAsync(0)
    expect(publishData).not.toHaveBeenCalled()
    const ada = participant('g_ada', 'Ada')
    latestRoom().remoteParticipants.set(ada.identity, ada)
    latestRoom().emit('ParticipantConnected', ada)
    await vi.advanceTimersByTimeAsync(0)
    expect(publishData).toHaveBeenCalledTimes(1)
    await room.disconnect()
  })
})

// Plan 234 T3 (wire contract 6.3): a managed show's overlays leave on the
// host's own room connection, in the order they were handed over, and never
// while the room is not connected.
describe('overlays to the program page (plan 234 T3)', () => {
  const takeover = {
    op: 'set' as const,
    showId: 'sh_talk',
    slot: 'takeover' as const,
    orientation: 'h' as const,
    rect: { x: 0, y: 0, w: 1, h: 1 },
    mimeType: 'image/png',
    imageId: 'image-1'
  }
  const clear = {
    op: 'clear' as const,
    showId: 'sh_talk',
    slot: 'takeover' as const,
    orientation: 'h' as const
  }
  const image = async () => ({ bytes: new Uint8Array(32), mimeType: 'image/png' })

  it('streams a completed set and then its clear with the contract attributes', async () => {
    const { room } = client()
    await room.connect()
    await room.sendOverlay(takeover, image)
    await room.sendOverlay(clear, image)
    const streams = latestRoom().streams
    expect(streams.map((stream) => stream.topic)).toEqual([
      'videorc.overlay.set',
      'videorc.overlay.clear'
    ])
    expect(streams[0].attributes).toEqual({
      v: '1',
      slot: 'takeover',
      o: 'h',
      x: '0.000000',
      y: '0.000000',
      w: '1.000000',
      h: '1.000000'
    })
    expect(streams[0].bytes).toBe(32)
    expect(streams[1].attributes).toBeUndefined()
    expect(streams.every((stream) => stream.closed)).toBe(true)
    await room.disconnect()
  })

  it('sends Hide immediately past a stalled set, without blocking another slot or orientation', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { room } = client()
    await room.connect()
    const stalled = room.sendOverlay(takeover, async () => new Promise(() => {}))
    await room.sendOverlay({ ...takeover, orientation: 'v' }, image)
    await room.sendOverlay({ ...takeover, slot: 'card' }, image)
    await room.sendOverlay(clear, image)
    await stalled
    expect(latestRoom().streams.map((stream) => stream.topic)).toEqual([
      'videorc.overlay.set',
      'videorc.overlay.set',
      'videorc.overlay.clear'
    ])
    expect(warning).toHaveBeenCalledTimes(1)
    await room.disconnect()
    warning.mockRestore()
  })

  it('a newer set cancels an older fetch and never sends the late image', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { room } = client()
    await room.connect()
    let release: (value: Awaited<ReturnType<typeof image>>) => void = () => {}
    const old = room.sendOverlay(
      takeover,
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    await room.sendOverlay({ ...takeover, imageId: 'new' }, image)
    release(await image())
    await old
    expect(latestRoom().streams).toHaveLength(1)
    expect(warning).toHaveBeenCalledTimes(1)
    await room.disconnect()
    warning.mockRestore()
  })

  it('sends nothing before the room is joined or after it is left', async () => {
    const { room } = client()
    await room.sendOverlay(takeover, image)
    expect(lk.FakeRoom.rooms).toHaveLength(0)
    await room.connect()
    await room.disconnect()
    await room.sendOverlay(takeover, image)
    expect(latestRoom().streams).toHaveLength(0)
  })
})
