import * as microphoneSource from './room-microphone-source'
// @vitest-environment happy-dom
import type { RoomOptions } from 'livekit-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as privacyModule from './room-screen-privacy'
import { setRoomFrameEncodeObserver } from './room-frame-test-state'
import vectors from '../../../shared/chroma-key-vectors.json'
import type { TalkShowCameraSettings } from './talk-show-camera-effects'
import type { CloudOnAir, CloudRoomClientState, CloudRoomTokenAnswer } from '@/lib/backend'
import {
  TAKEN_OVER_DETAIL,
  TAKEN_OVER_GRACE_MS,
  TalkShowRoomClient,
  onAirElsewhere,
  stageMessage,
  talkShowRoomOptions,
  type TalkShowRoomDeps
} from '@/lib/talk-show-room'

// Plan 224 C-G4 and the review of 2026-11-09 (L4, L9's room client): the host
// joins with one fresh token, asks for no other on a timer (LiveKit refreshes
// a running connection itself), rejoins a dropped room with a fresh one, and
// stays out after a terminal end. `livekit-client` is faked: these are the
// client's own rules, not the SDK's.

const pcm = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('./room-pcm-source', () => ({ createRoomPcmTestSource: pcm.create }))
const frames = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('./room-frame-source', () => ({ createRoomFrameTestSource: frames.create }))
const encode = vi.hoisted(() => ({ attach: vi.fn() }))
vi.mock('./room-frame-encode-observer', () => ({ attachEncodeObserver: encode.attach }))

const lk = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void
  const fakeLocalTrack = () => ({
    mediaStreamTrack: { kind: 'video' } as unknown as MediaStreamTrack,
    mute: vi.fn(async () => {}),
    unmute: vi.fn(async () => {}),
    stop: vi.fn(),
    setProcessor: vi.fn(async () => {}),
    stopProcessor: vi.fn(async () => {})
  })
  class FakeRoom {
    static rooms: FakeRoom[] = []
    readonly handlers = new Map<string, Set<Handler>>()
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
      identity: 'host:sh_talk',
      trackPublications: new Map(),
      setTrackSubscriptionPermissions: vi.fn(),
      publishTrack: vi.fn(async () => {}),
      unpublishTrack: vi.fn(async () => {}),
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
    constructor(readonly options: RoomOptions) {
      FakeRoom.rooms.push(this)
    }
    on(event: string, handler: Handler): this {
      const handlers = this.handlers.get(event) ?? new Set<Handler>()
      handlers.add(handler)
      this.handlers.set(event, handlers)
      return this
    }
    off(event: string, handler: Handler): this {
      this.handlers.get(event)?.delete(handler)
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
      for (const handler of this.handlers.get(event) ?? []) handler(...args)
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
  LocalAudioTrack: class {
    isMuted = false
    constructor(readonly mediaStreamTrack: MediaStreamTrack) {}
    stop(): void {
      this.mediaStreamTrack.stop()
    }
    async mute(): Promise<void> {
      this.isMuted = true
    }
    async unmute(): Promise<void> {
      this.isMuted = false
    }
  },
  LocalVideoTrack: class {
    constructor(readonly mediaStreamTrack: MediaStreamTrack) {}
    stop(): void {
      this.mediaStreamTrack.stop()
    }
  },
  createLocalVideoTrack: lk.video,
  createLocalAudioTrack: lk.audio
}))

function client(
  onAir?: () => CloudOnAir | undefined,
  cameraSettings?: () => TalkShowCameraSettings,
  overrides: Partial<TalkShowRoomDeps> = {}
) {
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
  const details: (string | undefined)[] = []
  const room = new TalkShowRoomClient({
    requestToken,
    report: (state, detail) => {
      reports.push(state)
      details.push(detail)
    },
    onSnapshot: () => {},
    cameraName: 'Camera',
    cameraSettings,
    microphoneName: 'Microphone',
    audioHost: () => null,
    onAir,
    ...overrides
  })
  return { room, requestToken, reports, details }
}

const latestRoom = () => lk.FakeRoom.rooms[lk.FakeRoom.rooms.length - 1]

beforeEach(() => {
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => [
        { kind: 'videoinput', deviceId: 'camera', label: 'Camera' },
        { kind: 'audioinput', deviceId: 'mic', label: 'Microphone' }
      ]
    }
  })
  vi.useFakeTimers()
  lk.FakeRoom.rooms.length = 0
  lk.video.mockReset().mockImplementation(async () => lk.fakeLocalTrack())
  lk.audio.mockReset().mockImplementation(async () => lk.fakeLocalTrack())
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the host in the room (C-G4)', () => {
  it('sets the key before publication and changes settings without republishing', async () => {
    const camera = lk.fakeLocalTrack()
    lk.video.mockResolvedValueOnce(camera)
    const settings = { layout: vectors[0].settings }
    const { room } = client(undefined, () => settings)
    await room.connect()
    expect(camera.setProcessor).toHaveBeenCalledOnce()
    expect(camera.setProcessor.mock.invocationCallOrder[0]).toBeLessThan(
      latestRoom().localParticipant.publishTrack.mock.invocationCallOrder[0]
    )
    const publishes = latestRoom().localParticipant.publishTrack.mock.calls.length
    await room.updateCameraSettings({ layout: { ...settings.layout, cameraChromaKeySpillPct: 20 } })
    expect(camera.setProcessor).toHaveBeenCalledOnce()
    expect(latestRoom().localParticipant.publishTrack).toHaveBeenCalledTimes(publishes)
    await room.updateCameraSettings({
      layout: { ...settings.layout, cameraChromaKeyEnabled: false }
    })
    expect(camera.stopProcessor).toHaveBeenCalledOnce()
    await room.disconnect()
  })

  it('never publishes raw camera when key initialization fails', async () => {
    const camera = lk.fakeLocalTrack()
    camera.setProcessor.mockRejectedValueOnce(new Error('no GPU'))
    lk.video.mockResolvedValueOnce(camera)
    const { room } = client(undefined, () => ({ layout: vectors[0].settings }))
    await room.connect()
    expect(camera.stop).toHaveBeenCalled()
    expect(room.snapshot.local.camera).toBeNull()
    expect(room.snapshot.local.problem).toContain('no GPU')
    expect(
      latestRoom().localParticipant.publishTrack.mock.calls.some(
        (args: unknown[]) => args[0] === camera
      )
    ).toBe(false)
    await room.disconnect()
  })

  it('keeps adaptive stream off for the raw-track stage and dynacast on (plan 247 D1)', () => {
    expect(talkShowRoomOptions()).toMatchObject({ adaptiveStream: false, dynacast: true })
  })

  it('joins with one fresh token and asks for no other on a timer (review L4)', async () => {
    const { room, requestToken } = client()
    await room.connect()
    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(latestRoom().connectedWith?.token).toBe('lk.host.token.1')
    expect(latestRoom().options).toMatchObject({ adaptiveStream: false, dynacast: true })
    expect(room.snapshot.state).toBe('connected')
    expect(room.snapshot.identity).toBe('host:sh_talk')
    expect(JSON.stringify(room.snapshot)).not.toContain('lk.host.token')
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await room.disconnect()
  })

  // Plan 249 S5: what the room client animates the avatar from.
  const motionSeed = () => {
    const rect = { x: 0.8, y: 0.7, w: 0.15, h: 0.25 }
    return {
      settings: { intensity: 0.45, sleepAfterSeconds: 180, breathing: true },
      inputs: {
        avatarState: 'idle' as const,
        rects: { h: rect, v: rect },
        cards: { h: null, v: null },
        atlasHash: 'a'.repeat(64),
        pack: {
          neutral: 'look-22',
          pivot: [0.5, 0.9] as const,
          headTop: 0.2,
          talk: [],
          cells: [{ id: 'look-22', kind: 'gaze' as const, gaze: [0, 0] as const }]
        }
      }
    }
  }

  it('runs the avatar motion timer only while an animated avatar is set (plan 249 S5)', async () => {
    const { room } = client()
    await room.connect()
    const timers = vi.getTimerCount()
    room.setAvatarMotion(motionSeed())
    expect(vi.getTimerCount()).toBe(timers + 1)
    // Events before any consumer are harmless; nothing is sent without targets.
    room.avatarMotionEvent({
      avatarState: 'talk',
      event: { kind: 'utterance', mood: 'talk', chars: 4, bubbleSeconds: 1 }
    })
    await vi.advanceTimersByTimeAsync(500)
    room.setAvatarMotion(null)
    expect(vi.getTimerCount()).toBe(timers)
    await room.disconnect()
  })

  it('looks only at the card each output accepted, until its clear or its time runs out (plan 249 S5)', async () => {
    const { room } = client()
    await room.connect()
    Object.assign(latestRoom().localParticipant, { sid: 'PA_host' })
    room.setAvatarMotion(motionSeed())
    await vi.advanceTimersByTimeAsync(200)
    expect(room.avatarMotionProbe()?.cards).toEqual({ h: false, v: false })
    const card = {
      op: 'set' as const,
      showId: 'sh_talk',
      slot: 'card' as const,
      orientation: 'h' as const,
      rect: { x: 0.05, y: 0.7, w: 0.3, h: 0.12 },
      ttlSeconds: 5,
      mimeType: 'image/png',
      imageId: 'card-1'
    }
    const image = async () => ({ bytes: new Uint8Array(32), mimeType: 'image/png' })
    await room.sendOverlay(card, image)
    // The vertical output never got one (its image was gone): no input there.
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await room.sendOverlay({ ...card, orientation: 'v' }, async () => null)
    warning.mockRestore()
    await vi.advanceTimersByTimeAsync(200)
    expect(room.avatarMotionProbe()?.cards).toEqual({ h: true, v: false })
    expect(room.avatarMotionProbe()).toBeTruthy()
    // Its time-to-live ends the look without a clear.
    await vi.advanceTimersByTimeAsync(5000)
    expect(room.avatarMotionProbe()?.cards).toEqual({ h: false, v: false })
    await room.sendOverlay({ ...card, ttlSeconds: undefined }, image)
    await vi.advanceTimersByTimeAsync(200)
    expect(room.avatarMotionProbe()?.cards.h).toBe(true)
    await room.sendOverlay(
      { op: 'clear', showId: 'sh_talk', slot: 'card', orientation: 'h' },
      image
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(room.avatarMotionProbe()?.cards.h).toBe(false)
    room.setAvatarMotion(null)
    await room.disconnect()
  })

  it('says under the Program preview why the avatar shows still (plan 249 S5)', async () => {
    const { room } = client()
    await room.connect()
    room.setAvatarMotion(null, 'The avatar shows still on cloud outputs: it is too detailed.')
    expect(room.snapshot.avatar?.animation).toEqual({
      state: 'still',
      reason: 'The avatar shows still on cloud outputs: it is too detailed.'
    })
    room.setAvatarMotion(motionSeed())
    expect(room.snapshot.avatar?.animation).toEqual({ state: 'animated', reason: null })
    room.setAvatarMotion(null)
    expect(room.snapshot.avatar?.animation).toBeUndefined()
    await room.disconnect()
  })

  it('draws the Program preview from its own simulation, and nothing for another atlas (plan 249 S5)', async () => {
    const { room } = client()
    await room.connect()
    expect(room.avatarMotionSource.sim).toBeNull()
    expect(room.avatarMotionSource.draw('h', 'a'.repeat(64))).toBeNull()
    Object.assign(latestRoom().localParticipant, { sid: 'PA_host' })
    room.setAvatarMotion(motionSeed())
    await vi.advanceTimersByTimeAsync(500)
    room.avatarMotionSource.advance()
    expect(room.avatarMotionSource.sim?.tick).toBeGreaterThan(0)
    expect(room.avatarMotionSource.draw('h', 'a'.repeat(64))?.cell).toBe('look-22')
    expect(room.avatarMotionSource.draw('h', 'b'.repeat(64))).toBeNull()
    room.setAvatarMotion(null)
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
    expect(latestRoom().options).toMatchObject({ adaptiveStream: false, dynacast: true })
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

// Plan 243 C5: another device takes the host seat by joining as
// `host:<showId>`, and LiveKit drops this connection with DUPLICATE_IDENTITY.
// With `onAir` naming another device now or within 3 s it is a take-over (no
// rejoin, and no device name in the report); otherwise the room is lost.
describe('a second host connection (plan 243 C5)', () => {
  const DUPLICATE_IDENTITY = 2
  const iPhone: CloudOnAir = {
    name: 'iPhone',
    kind: 'phone',
    source: 'host',
    waiting: false,
    thisDevice: false,
    since: '2026-11-16T20:01:02.000Z'
  }

  it('reads another device on air, never this one or a hand-off wait', () => {
    expect(onAirElsewhere(iPhone)).toBe(true)
    expect(onAirElsewhere(undefined)).toBe(false)
    expect(onAirElsewhere({ ...iPhone, thisDevice: true })).toBe(false)
    expect(onAirElsewhere({ ...iPhone, waiting: true })).toBe(false)
  })

  it('is taken over at once when another device is already on air', async () => {
    const { room, requestToken, reports, details } = client(() => iPhone)
    await room.connect()
    latestRoom().emit('Disconnected', DUPLICATE_IDENTITY)
    await vi.advanceTimersByTimeAsync(0)
    expect(room.snapshot).toMatchObject({ state: 'disconnected', detail: TAKEN_OVER_DETAIL })
    expect(details.at(-1)).toBe('Your show continues on another device.')
    expect(JSON.stringify(details)).not.toContain('iPhone')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requestToken).toHaveBeenCalledTimes(1)
    expect(reports).toEqual(['connecting', 'connected', 'disconnected'])
    await room.disconnect()
  })

  it('is taken over when onAir names another device within the grace', async () => {
    const status: { onAir?: CloudOnAir } = {}
    const { room, requestToken } = client(() => status.onAir)
    await room.connect()
    latestRoom().emit('Disconnected', DUPLICATE_IDENTITY)
    await vi.advanceTimersByTimeAsync(1500)
    expect(room.snapshot.state).toBe('connected')
    status.onAir = iPhone
    await vi.advanceTimersByTimeAsync(200)
    expect(room.snapshot).toMatchObject({ state: 'disconnected', detail: TAKEN_OVER_DETAIL })
    expect(requestToken).toHaveBeenCalledTimes(1)
    await room.disconnect()
  })

  it('says the room is lost when nobody else is on air within the grace', async () => {
    const { room, requestToken } = client(() => ({ ...iPhone, thisDevice: true }))
    await room.connect()
    latestRoom().emit('Disconnected', DUPLICATE_IDENTITY)
    await vi.advanceTimersByTimeAsync(TAKEN_OVER_GRACE_MS - 200)
    expect(room.snapshot.state).toBe('connected')
    await vi.advanceTimersByTimeAsync(400)
    expect(room.snapshot).toMatchObject({
      state: 'disconnected',
      detail: 'Connection to the room lost.'
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(requestToken).toHaveBeenCalledTimes(1)
    await room.disconnect()
  })

  it('stays quiet when the room is closed during the grace', async () => {
    const { room, reports } = client(() => undefined)
    await room.connect()
    latestRoom().emit('Disconnected', DUPLICATE_IDENTITY)
    await vi.advanceTimersByTimeAsync(500)
    await room.disconnect()
    await vi.advanceTimersByTimeAsync(TAKEN_OVER_GRACE_MS)
    expect(room.snapshot.state).toBe('idle')
    expect(reports).toEqual(['connecting', 'connected'])
  })
})

describe('room controls own the published tracks (249 S1)', () => {
  it('mutes before publishing and never opens a None/off camera', async () => {
    const mic = lk.fakeLocalTrack()
    lk.audio.mockResolvedValueOnce(mic)
    const { room } = client(undefined, undefined, { cameraName: null, initiallyMuted: true })
    await room.connect()
    expect(lk.video).not.toHaveBeenCalled()
    expect(mic.mute.mock.invocationCallOrder[0]).toBeLessThan(
      latestRoom().localParticipant.publishTrack.mock.invocationCallOrder[0]
    )
    expect(room.snapshot.local).toMatchObject({ micMuted: true, cameraOff: true, camera: null })
    await expect(room.setCameraOff(false)).rejects.toThrow('Choose a camera')
    await room.disconnect()
  })

  it('does not open defaults for missing device labels or no microphone', async () => {
    const { room } = client(undefined, undefined, {
      cameraName: 'Missing camera',
      microphoneName: null
    })
    await room.connect()
    expect(lk.video).not.toHaveBeenCalled()
    expect(lk.audio).not.toHaveBeenCalled()
    await expect(room.setMicrophoneMuted(false)).rejects.toThrow('No microphone')
    expect(room.snapshot.local.problem).toContain('unavailable')
    await room.disconnect()
  })

  it('keeps the last confirmed mute after rejection and serializes opposite commands', async () => {
    const mic = lk.fakeLocalTrack()
    lk.audio.mockResolvedValueOnce(mic)
    const { room } = client()
    await room.connect()
    mic.mute.mockRejectedValueOnce(new Error('publisher refused'))
    await expect(room.setMicrophoneMuted(true)).rejects.toThrow('publisher refused')
    expect(room.snapshot.local.micMuted).toBe(false)
    let release!: () => void
    mic.mute.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const mute = room.setMicrophoneMuted(true)
    const unmute = room.setMicrophoneMuted(false)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(mic.unmute).not.toHaveBeenCalled()
    release()
    await Promise.all([mute, unmute])
    expect(room.snapshot.local.micMuted).toBe(false)
    await room.disconnect()
    await expect(room.setMicrophoneMuted(true)).rejects.toThrow('not connected')
  })

  it('stops capture for None, restores a selected camera, and rejects an obsolete mute', async () => {
    const camera = lk.fakeLocalTrack(),
      mic = lk.fakeLocalTrack()
    lk.video.mockResolvedValueOnce(camera)
    lk.audio.mockResolvedValueOnce(mic)
    const { room } = client()
    await room.connect()
    await room.setCameraSelection(null, true)
    expect(camera.stop).toHaveBeenCalled()
    expect(room.snapshot.local.camera).toBeNull()
    await room.setCameraSelection('Camera', false)
    expect(lk.video).toHaveBeenCalledTimes(2)
    let release!: () => void
    mic.mute.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const pending = room.setMicrophoneMuted(true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await room.disconnect()
    release()
    await expect(pending).rejects.toThrow('microphone changed')
  })

  it('does not capture an initially off selected camera', async () => {
    const { room } = client(undefined, undefined, { initiallyCameraOff: true })
    await room.connect()
    expect(lk.video).not.toHaveBeenCalled()
    await room.setCameraOff(false)
    expect(lk.video).toHaveBeenCalledOnce()
    await room.disconnect()
  })
})

it('serializes toggle intents and refuses controls after takeover', async () => {
  const onAir: { current: CloudOnAir | undefined } = { current: undefined }
  const { room } = client(() => onAir.current)
  await room.connect()
  await Promise.all([room.setMicrophoneMode('toggle'), room.setMicrophoneMode('toggle')])
  expect(room.snapshot.local.micMuted).toBe(false)
  onAir.current = {
    thisDevice: false,
    waiting: false,
    kind: 'computer',
    source: 'host',
    since: '2026-11-16T00:00:00Z'
  }
  await expect(room.setMicrophoneMuted(true)).rejects.toThrow(TAKEN_OVER_DETAIL)
  await room.disconnect()
})

it('refuses publication if initial mute fails, and uses exact device constraints', async () => {
  const microphone = lk.fakeLocalTrack()
  microphone.mute.mockRejectedValueOnce(new Error('mute refused'))
  lk.audio.mockResolvedValueOnce(microphone)
  const { room } = client(undefined, undefined, { initiallyMuted: true })
  await room.connect()
  expect(lk.video).toHaveBeenCalledWith(expect.objectContaining({ deviceId: { exact: 'camera' } }))
  expect(lk.audio).toHaveBeenCalledWith(expect.objectContaining({ deviceId: { exact: 'mic' } }))
  expect(latestRoom().localParticipant.publishTrack).toHaveBeenCalledTimes(1)
  expect(microphone.stop).toHaveBeenCalled()
  expect(room.snapshot.local.microphone).toBeNull()
  expect(room.snapshot.local.problem).toContain('mute refused')
  await room.disconnect()
})

describe('S2 screen publication boundary', () => {
  function fixture() {
    privacyModule.roomScreenPrivacy.apply(
      { hidden: false, generation: 0 },
      privacyModule.roomScreenPrivacy.showIntent(),
      true
    )
    const raw = { stop: vi.fn(), addEventListener: vi.fn() } as unknown as MediaStreamTrack
    const outputs: { stop: ReturnType<typeof vi.fn>; kind: string }[] = []
    const adapter = vi.spyOn(privacyModule, 'createPrivateScreen').mockImplementation(() => {
      const output = { stop: vi.fn(), kind: 'video' }
      outputs.push(output)
      return {
        track: output as unknown as MediaStreamTrack,
        block: vi.fn(),
        close: output.stop,
        pixels: () => []
      }
    })
    return { raw, outputs, adapter }
  }
  it('Hide during pending capture publishes only the gated hidden generation, never raw capture', async () => {
    const { raw, adapter } = fixture()
    const pending = deferred<MediaStream>()
    const acquired = deferred<void>()
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: () => {
          acquired.resolve()
          return pending.promise
        }
      }
    })
    const { room } = client(undefined, undefined, { cameraName: null, microphoneName: null })
    await room.connect()
    const share = room.startScreenShare()
    await acquired.promise
    privacyModule.roomScreenPrivacy.hide()
    pending.resolve({
      getVideoTracks: () => [raw],
      getTracks: () => [raw]
    } as unknown as MediaStream)
    await share
    expect(adapter).toHaveBeenCalledWith(raw, privacyModule.roomScreenPrivacy, expect.any(Function))
    expect(room.snapshot.screenPrivacy?.hidden).toBe(true)
    expect(room.snapshot.local.screen).not.toBe(raw)
    expect(latestRoom().localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: expect.stringMatching(/:1$/) })
    )
    await vi.advanceTimersByTimeAsync(5001)
    expect(room.snapshot.screenPrivacy?.status).toBe('unconfirmed')
    const current = room.snapshot.screenPrivacy!
    const ack = (extra: Record<string, unknown>, participant?: object) =>
      latestRoom().emit(
        'DataReceived',
        new TextEncoder().encode(
          JSON.stringify({
            epoch: current.epoch,
            generation: current.generation,
            hidden: true,
            appliedAt: Date.now(),
            receiver: 'program:wide',
            ...extra
          })
        ),
        participant,
        undefined,
        privacyModule.PRIVACY_ACK_TOPIC
      )
    ack({ generation: current.generation - 1 })
    ack({}, { identity: 'g_forged' })
    expect(room.snapshot.screenPrivacy?.observations).toEqual({})
    ack({})
    expect(room.snapshot.screenPrivacy?.status).toBe('observed')
    expect(room.snapshot.screenPrivacy?.observations['program:wide']).toBeDefined()
    const guest = 'g_' + '1'.repeat(22)
    latestRoom().remoteParticipants.set(guest, {
      identity: guest,
      sid: 'PA_new',
      trackPublications: new Map()
    })
    ack({ receiver: guest, receiverSession: 'PA_old' })
    expect(room.snapshot.screenPrivacy?.observations[guest]).toBeUndefined()
    ack({ receiver: guest, receiverSession: 'PA_new' })
    expect(room.snapshot.screenPrivacy?.observations[guest]).toBeDefined()
    latestRoom().emit('Reconnecting')
    expect(room.snapshot.screenPrivacy?.observations).toEqual({})
    expect(room.snapshot.screenPrivacy?.status).toBe('unconfirmed')
    await room.disconnect()
    expect(raw.stop).toHaveBeenCalled()
  })
  it('S14: a scene switch captures the new source first and keeps Hide across the swap', async () => {
    const { raw, adapter } = fixture()
    const next = { stop: vi.fn(), addEventListener: vi.fn() } as unknown as MediaStreamTrack
    const captures = [raw, next]
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: async () => {
          const track = captures.shift()!
          return { getVideoTracks: () => [track], getTracks: () => [track] }
        }
      }
    })
    const { room } = client(undefined, undefined, { cameraName: null, microphoneName: null })
    await room.connect()
    await room.startScreenShare('screen:1:0')
    expect(room.screenSourceId).toBe('screen:1:0')
    expect(room.snapshot.local.screenSourceId).toBe('screen:1:0')
    privacyModule.roomScreenPrivacy.hide()
    await room.replaceScreenSource('window:42:0')
    expect(raw.stop).toHaveBeenCalled()
    expect(room.screenSourceId).toBe('window:42:0')
    expect(adapter).toHaveBeenLastCalledWith(
      next,
      privacyModule.roomScreenPrivacy,
      expect.any(Function)
    )
    expect(room.snapshot.screenPrivacy?.hidden).toBe(true)
    // Asking for the source already shared captures nothing.
    await room.replaceScreenSource('window:42:0')
    expect(captures).toHaveLength(0)
    await room.disconnect()
    expect(room.screenSourceId).toBeNull()
  })
  it('S14: a source that cannot be captured leaves the current share as it was', async () => {
    const { raw } = fixture()
    let refuse = false
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: async () => {
          if (refuse) throw new Error('NotAllowedError')
          return { getVideoTracks: () => [raw], getTracks: () => [raw] }
        }
      }
    })
    const { room } = client(undefined, undefined, { cameraName: null, microphoneName: null })
    await room.connect()
    await room.startScreenShare('screen:1:0')
    refuse = true
    await expect(room.replaceScreenSource('window:42:0')).rejects.toThrow('NotAllowedError')
    expect(raw.stop).not.toHaveBeenCalled()
    expect(room.screenSourceId).toBe('screen:1:0')
    expect(room.snapshot.local.screen).not.toBeNull()
    await room.disconnect()
  })
  it('canvas failure stops and unpublishes without publishing raw as a fallback', async () => {
    const { raw, adapter } = fixture()
    adapter.mockImplementation(() => {
      throw new Error('no canvas')
    })
    vi.stubGlobal('navigator', {
      mediaDevices: { getDisplayMedia: async () => ({ getVideoTracks: () => [raw] }) }
    })
    const { room } = client(undefined, undefined, { cameraName: null, microphoneName: null })
    await room.connect()
    await room.startScreenShare()
    expect(latestRoom().localParticipant.publishTrack).not.toHaveBeenCalled()
    expect(room.snapshot.screenPrivacy?.status).toBe('paused')
    expect(room.snapshot.local.screen).toBeNull()
    expect(room.snapshot.local.problem).toContain('privacy')
    await room.disconnect()
  })
})

describe('S7a opt-in microphone producer', () => {
  it('publishes only the PCM microphone lane, keeps initial mute, and closes before reconnect replacement', async () => {
    const signals: AbortSignal[] = []
    const sources: { track: MediaStreamTrack; close: ReturnType<typeof vi.fn> }[] = []
    vi.stubGlobal('window', { videorc: { roomPcmTest: vi.fn() } })
    pcm.create.mockImplementation(async (_api, signal: AbortSignal) => {
      signals.push(signal)
      const source = {
        track: { kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack,
        close: vi.fn(async () => {})
      }
      sources.push(source)
      return source
    })
    const { room } = client(undefined, undefined, {
      cameraName: null,
      microphoneName: null,
      pcmTestSource: true,
      initiallyMuted: true
    })
    await room.connect()
    expect(lk.audio).not.toHaveBeenCalled()
    const transport = latestRoom()
    expect(transport.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.objectContaining({ isMuted: true }),
      { source: 'microphone' }
    )
    transport.emit('Reconnecting')
    expect(signals[0].aborted).toBe(true)
    expect(sources[0].close).toHaveBeenCalled()
    transport.emit('Reconnected')
    await vi.waitFor(() => expect(sources).toHaveLength(2))
    expect(transport.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1)
    await room.disconnect()
    expect(signals[1].aborted).toBe(true)
    expect(sources[1].track.stop).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('cancels a source that resolves after the room closes without publishing', async () => {
    vi.stubGlobal('window', { videorc: { roomPcmTest: vi.fn() } })
    let release!: (source: { track: MediaStreamTrack; close: () => Promise<void> }) => void
    pcm.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const { room } = client(undefined, undefined, {
      cameraName: null,
      microphoneName: null,
      pcmTestSource: true
    })
    const joining = room.connect()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await room.disconnect()
    const close = vi.fn(async () => {})
    release({ track: { kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack, close })
    await joining
    expect(close).toHaveBeenCalledOnce()
    expect(latestRoom().localParticipant.publishTrack).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

// Plan 249 S6 (D4): guests learn which screen the program shows, so they see
// and hear that one screen. Always present, so a guest can tell a current
// desktop (null: none) from an older one (absent).
describe('the stage message (plan 249 S6)', () => {
  const read = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown
  it('names the selected screen only when it is on stage', () => {
    expect(read(stageMessage(['host:s', 'g_a'], 'g_a'))).toEqual({
      v: 1,
      onStage: ['host:s', 'g_a'],
      screen: 'g_a'
    })
    expect(read(stageMessage(['host:s'], 'g_a'))).toEqual({
      v: 1,
      onStage: ['host:s'],
      screen: null
    })
    expect(read(stageMessage(['host:s']))).toEqual({ v: 1, onStage: ['host:s'], screen: null })
  })
})

describe('processed microphone room ownership', () => {
  const choice = {
    mode: 'browser-aec' as const,
    deviceId: 'one',
    name: 'One',
    gainDb: 0,
    muted: false,
    noise: 'off' as const,
    offsetMs: 0
  }
  it('attaches speech to the published processed host track and revokes it on mute and loss', async () => {
    const track = { kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack
    const source = {
      track,
      close: vi.fn(async () => {}),
      update: vi.fn(),
      published: vi.fn(),
      disconnectFixture: vi.fn(async () => {})
    }
    const factory = vi
      .spyOn(microphoneSource, 'createRoomMicrophoneSource')
      .mockResolvedValue(source)
    const tap = { close: vi.fn(async () => {}), setMuted: vi.fn(async () => {}) }
    let current!: () => boolean
    const attachHostSpeech = vi.fn((published, show, muted, owns) => {
      expect(latestRoom().localParticipant.publishTrack).toHaveBeenCalledOnce()
      expect(published).toBe(track)
      expect(show).toBe('sh_talk')
      expect(muted).toBe(false)
      current = owns
      return tap
    })
    const { room } = client(undefined, undefined, {
      cameraName: null,
      microphoneName: 'One',
      microphoneChoice: choice,
      attachHostSpeech
    })
    await room.connect()
    expect(attachHostSpeech).toHaveBeenCalledOnce()
    expect(current()).toBe(true)
    await room.setMicrophoneMuted(true)
    expect(tap.setMuted).toHaveBeenLastCalledWith(true)
    await room.setMicrophoneMuted(false)
    expect(tap.setMuted).toHaveBeenLastCalledWith(false)
    latestRoom().emit('Disconnected', 2)
    expect(current()).toBe(false)
    expect(tap.close).toHaveBeenCalledOnce()
    await room.disconnect()
    factory.mockRestore()
  })
  it('retires the old producer before switch and None releases publication', async () => {
    const order: string[] = []
    const sources: { close: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }[] = []
    const factory = vi
      .spyOn(microphoneSource, 'createRoomMicrophoneSource')
      .mockImplementation(async (selected) => {
        order.push('open:' + selected.deviceId)
        const source = {
          track: { kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack,
          close: vi.fn(async () => {
            order.push('close:' + selected.deviceId)
          }),
          update: vi.fn(),
          published: vi.fn(),
          disconnectFixture: vi.fn(async () => {})
        }
        sources.push(source)
        return source
      })
    const { room } = client(undefined, undefined, {
      cameraName: null,
      microphoneName: 'One',
      microphoneChoice: choice
    })
    await room.connect()
    await room.updateMicrophone({ ...choice, gainDb: 6, noise: 'rnnoise' })
    expect(sources[0].update).toHaveBeenCalled()
    expect(factory).toHaveBeenCalledTimes(1)
    await room.setMicrophoneSelection('two', 'Two')
    expect(order).toEqual(['open:one', 'close:one', 'open:two'])
    await room.setMicrophoneSelection(null, null)
    expect(room.snapshot.local.microphone).toBeNull()
    expect(factory).toHaveBeenCalledTimes(2)
    expect(latestRoom().localParticipant.unpublishTrack).toHaveBeenCalledTimes(2)
    await room.disconnect()
    factory.mockRestore()
  })
  it('failed producer cleanup fences replacement while room teardown still disconnects', async () => {
    const factory = vi.spyOn(microphoneSource, 'createRoomMicrophoneSource').mockResolvedValue({
      track: { kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack,
      close: vi.fn(async () => {
        throw new Error('Native close unconfirmed')
      }),
      update: vi.fn(),
      published: vi.fn(),
      disconnectFixture: vi.fn(async () => {})
    })
    const { room } = client(undefined, undefined, {
      cameraName: null,
      microphoneName: 'One',
      microphoneChoice: choice
    })
    await room.connect()
    await expect(room.setMicrophoneSelection('two', 'Two')).rejects.toThrow(
      'cleanup is unconfirmed'
    )
    expect(factory).toHaveBeenCalledTimes(1)
    const disconnect = vi.spyOn(latestRoom(), 'disconnect')
    await room.disconnect()
    expect(disconnect).toHaveBeenCalled()
    factory.mockRestore()
  })
  it.each([2, 4])(
    'SDK ownership loss %s disarms immediately and rejects stale reconnect callbacks',
    async (reason) => {
      const close = vi.fn(async () => {})
      const factory = vi.spyOn(microphoneSource, 'createRoomMicrophoneSource').mockResolvedValue({
        track: { kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack,
        close,
        update: vi.fn(),
        published: vi.fn(),
        disconnectFixture: vi.fn(async () => {})
      })
      const { room, requestToken } = client(undefined, undefined, {
        cameraName: null,
        microphoneName: 'One',
        microphoneChoice: choice
      })
      await room.connect()
      const oldRoom = latestRoom()
      oldRoom.emit('Disconnected', reason)
      expect(close).toHaveBeenCalledOnce()
      await expect(room.setMicrophoneSelection('two', 'Two')).rejects.toThrow('not connected')
      oldRoom.emit('Reconnecting')
      oldRoom.emit('Reconnected')
      await vi.advanceTimersByTimeAsync(60000)
      expect(factory).toHaveBeenCalledTimes(1)
      expect(requestToken).toHaveBeenCalledTimes(1)
      expect(oldRoom.localParticipant.unpublishTrack).toHaveBeenCalled()
      await room.disconnect()
      factory.mockRestore()
    }
  )
  it('loss does not reopen on a gain update; explicit selection and reconnect create fresh owners', async () => {
    let fail!: (reason: string) => void
    const factory = vi
      .spyOn(microphoneSource, 'createRoomMicrophoneSource')
      .mockImplementation(async (_choice, _show, _signal, _resolve, onFailure) => {
        fail = onFailure
        return {
          track: { kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack,
          close: vi.fn(async () => {}),
          update: vi.fn(),
          published: vi.fn(),
          disconnectFixture: vi.fn(async () => {})
        }
      })
    const { room } = client(undefined, undefined, {
      cameraName: null,
      microphoneName: 'One',
      microphoneChoice: choice
    })
    await room.connect()
    fail('Device lost')
    await room.updateMicrophone({ ...choice, gainDb: 3 })
    expect(factory).toHaveBeenCalledTimes(1)
    await room.setMicrophoneSelection('one', 'One')
    expect(factory).toHaveBeenCalledTimes(2)
    latestRoom().emit('Reconnecting')
    latestRoom().emit('Reconnected')
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(3))
    await room.disconnect()
    factory.mockRestore()
  })
})

describe('native camera-role frame test source (S13a)', () => {
  const frameSource = (generation: number) => ({
    track: { kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack,
    generation,
    opened: { generation, surfaceEpoch: 1, originUs: null, incarnation: null },
    close: vi.fn(async () => {}),
    resetSurface: vi.fn(async () => {})
  })
  it('is the only camera producer, skips browser key effects and reopens a new generation', async () => {
    const signals: AbortSignal[] = []
    const sources: ReturnType<typeof frameSource>[] = []
    vi.stubGlobal('window', { videorc: { roomFrameTest: vi.fn() } })
    frames.create.mockImplementation(async (_api, signal: AbortSignal) => {
      signals.push(signal)
      const source = frameSource(sources.length + 1)
      sources.push(source)
      return source
    })
    const { room } = client(undefined, undefined, {
      cameraName: null,
      microphoneName: null,
      frameTestSource: true
    })
    // The SFU's own answer: participant SID, permissions and the track SID.
    const push = lk.FakeRoom.rooms.push.bind(lk.FakeRoom.rooms)
    const made = vi.spyOn(lk.FakeRoom.rooms, 'push').mockImplementation((made) => {
      Object.assign(made, { name: 'sh_talk' })
      Object.assign(made.localParticipant, {
        sid: 'PA_host',
        permissions: { canPublish: true, canPublishSources: [1, 2] }
      })
      // The SFU answers publish with the track's SID (the fake's default is void).
      made.localParticipant.publishTrack.mockImplementation((async () => ({
        trackSid: 'TR_camera'
      })) as never)
      return push(made)
    })
    await room.connect()
    made.mockRestore()
    const transport = latestRoom()
    expect(lk.video).not.toHaveBeenCalled()
    expect(room.snapshot.local.cameraFrame?.authority).toMatchObject({
      publisherSid: 'PA_host',
      trackSid: 'TR_camera',
      generation: 1,
      hostIdentity: 'host:sh_talk',
      canPublishSources: ['camera', 'microphone']
    })
    expect(room.snapshot.local.cameraFrame?.descriptor).toMatchObject({
      alphaMode: 'packed',
      logicalWidth: 640,
      geometryApplied: 'none'
    })
    expect(transport.localParticipant.publishTrack).toHaveBeenCalledWith(
      expect.objectContaining({ mediaStreamTrack: sources[0].track }),
      expect.objectContaining({
        source: 'camera',
        simulcast: false,
        name: 'videorc:camera-frame:v1;frameLayout=rgb-left-alpha-right:g8;generation=1'
      })
    )
    await room.updateCameraSettings(undefined)
    expect(room.snapshot.local.cameraOff).toBe(false)
    transport.emit('Reconnecting')
    expect(signals[0].aborted).toBe(true)
    expect(sources[0].close).toHaveBeenCalled()
    transport.emit('Reconnected')
    await vi.waitFor(() => expect(sources).toHaveLength(2))
    expect(transport.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1)
    await room.setCameraOff(true)
    expect(sources[1].close).toHaveBeenCalled()
    expect(room.snapshot.local.cameraOff).toBe(true)
    expect(room.snapshot.local.cameraFrame).toBeUndefined()
    await room.disconnect()
    expect(sources).toHaveLength(2)
    vi.unstubAllGlobals()
  })
  it('attaches the encode observer only with the DEV flag and a sink; camera off detaches it', async () => {
    vi.stubGlobal('window', { videorc: { roomFrameTest: vi.fn() } })
    let made = 0
    frames.create.mockImplementation(async () => frameSource(++made))
    const detach = vi.fn(async () => {})
    encode.attach.mockReset().mockImplementation(() => ({ status: 'observing', detach }))
    const onFrameDiagnostic = vi.fn()
    const deps = { cameraName: null, microphoneName: null, frameTestSource: true }
    const unflagged = client(undefined, undefined, { ...deps, onFrameDiagnostic }).room
    await unflagged.connect()
    await vi.dynamicImportSettled()
    expect(encode.attach).not.toHaveBeenCalled()
    await unflagged.disconnect()
    setRoomFrameEncodeObserver(true)
    try {
      const sinkless = client(undefined, undefined, deps).room
      await sinkless.connect()
      await vi.dynamicImportSettled()
      expect(encode.attach).not.toHaveBeenCalled()
      await sinkless.disconnect()

      const { room } = client(undefined, undefined, { ...deps, onFrameDiagnostic })
      await room.connect()
      await vi.waitFor(() => expect(encode.attach).toHaveBeenCalledTimes(1))
      // The observer is fenced to the published source's generation.
      expect(encode.attach).toHaveBeenCalledWith(undefined, 3, onFrameDiagnostic)
      await room.setCameraOff(true)
      expect(detach).toHaveBeenCalledOnce()
      await room.disconnect()
      expect(detach).toHaveBeenCalledOnce()
    } finally {
      setRoomFrameEncodeObserver(false)
      vi.unstubAllGlobals()
    }
  })
  it('closes a source that resolves after the room closes without publishing', async () => {
    vi.stubGlobal('window', { videorc: { roomFrameTest: vi.fn() } })
    let release!: (source: ReturnType<typeof frameSource>) => void
    frames.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const { room } = client(undefined, undefined, {
      cameraName: null,
      microphoneName: null,
      frameTestSource: true
    })
    const joining = room.connect()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await room.disconnect()
    const late = frameSource(9)
    release(late)
    await joining
    expect(late.close).toHaveBeenCalledOnce()
    expect(latestRoom().localParticipant.publishTrack).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('a failed source reports a problem and never falls back to a browser camera', async () => {
    vi.stubGlobal('window', { videorc: { roomFrameTest: vi.fn() } })
    frames.create.mockRejectedValue(new Error('Camera bridge unsupported'))
    const { room } = client(undefined, undefined, {
      cameraName: 'Camera',
      microphoneName: null,
      frameTestSource: true
    })
    await room.connect()
    expect(lk.video).not.toHaveBeenCalled()
    expect(room.snapshot.local.cameraOff).toBe(true)
    expect(latestRoom().localParticipant.publishTrack).not.toHaveBeenCalled()
    await room.disconnect()
    vi.unstubAllGlobals()
  })
})

describe('processed camera contribution (S13b)', () => {
  const frameSource = (generation: number) => ({
    track: { kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack,
    generation,
    opened: { generation, surfaceEpoch: 1, originUs: null, incarnation: null },
    close: vi.fn(async () => {}),
    resetSurface: vi.fn(async () => {})
  })
  const resources = (logical: { width: number; height: number } | null) => ({
    nativeSources: 0,
    nativeLeases: 0,
    sockets: 0,
    ipcRequests: 0,
    timers: 0,
    logicalWidth: logical?.width ?? null,
    logicalHeight: logical?.height ?? null,
    keptForRoom: true,
    lentToBrowserRoom: false,
    fixture: true
  })
  it('publishes the native processed camera at its logical size and never a browser camera', async () => {
    const roomProcessedCamera = vi.fn()
    vi.stubGlobal('window', {
      videorc: {
        roomProcessedCamera,
        roomFrameTest: vi.fn(),
        getRoomProcessedCameraResources: vi.fn(async () => resources({ width: 554, height: 414 }))
      }
    })
    frames.create.mockImplementation(async () => frameSource(1))
    const push = lk.FakeRoom.rooms.push.bind(lk.FakeRoom.rooms)
    const made = vi.spyOn(lk.FakeRoom.rooms, 'push').mockImplementation((made) => {
      Object.assign(made, { name: 'sh_talk' })
      Object.assign(made.localParticipant, {
        sid: 'PA_host',
        permissions: { canPublish: true, canPublishSources: [1, 2] }
      })
      made.localParticipant.publishTrack.mockImplementation((async () => ({
        trackSid: 'TR_camera'
      })) as never)
      return push(made)
    })
    const { room } = client(undefined, undefined, {
      cameraName: 'Camera',
      microphoneName: null,
      processedCamera: true
    })
    await room.connect()
    made.mockRestore()
    expect(lk.video).not.toHaveBeenCalled()
    const call = frames.create.mock.calls[0]!
    expect(call[0]).toBe(roomProcessedCamera)
    expect(call[5]).toEqual({ width: 554, height: 414, fps: 30 })
    expect(room.snapshot.local.cameraFrame?.descriptor).toMatchObject({
      logicalWidth: 554,
      logicalHeight: 414,
      alphaMode: 'packed',
      geometryApplied: 'none'
    })
    await room.disconnect()
    vi.unstubAllGlobals()
  })

  it('a camera giving no native frame pauses with a problem, never a browser fallback', async () => {
    vi.stubGlobal('window', {
      videorc: {
        roomProcessedCamera: vi.fn(),
        getRoomProcessedCameraResources: vi.fn(async () => resources(null))
      }
    })
    frames.create.mockClear()
    const { room } = client(undefined, undefined, {
      cameraName: 'Camera',
      microphoneName: null,
      processedCamera: true
    })
    await room.connect()
    expect(frames.create).not.toHaveBeenCalled()
    expect(lk.video).not.toHaveBeenCalled()
    expect(room.snapshot.local.cameraOff).toBe(true)
    expect(room.snapshot.local.problem).toContain('camera')
    await room.disconnect()
    vi.unstubAllGlobals()
  })
})
