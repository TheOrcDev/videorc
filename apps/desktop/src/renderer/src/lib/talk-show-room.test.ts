import * as microphoneSource from './room-microphone-source'
// @vitest-environment happy-dom
import type { RoomOptions } from 'livekit-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as privacyModule from './room-screen-privacy'
import { CAPABILITY_TOPIC } from './room-media-v2'
import { AVATAR_TOPIC, type AvatarLayer } from '../../../shared/cloud-avatar'
import avatarFixture from '../../../../../..//protocol-fixtures/cloud-parity-avatar.json'
import { setRoomFrameEncodeObserver } from './room-frame-test-state'
import vectors from '../../../shared/chroma-key-vectors.json'
import type { TalkShowCameraSettings } from './talk-show-camera-effects'
import type { CloudOnAir, CloudRoomClientState, CloudRoomTokenAnswer } from '@/lib/backend'
import { validateBackendRpcParams } from '../../../shared/backend-rpc-contract'
import {
  TAKEN_OVER_DETAIL,
  TAKEN_OVER_GRACE_MS,
  TalkShowRoomClient,
  cameraDeviceIdFor,
  microphoneDeviceIdFor,
  onAirElsewhere,
  stageMessage,
  talkShowRoomOptions,
  type TalkShowRoomDeps,
  type TalkShowRoomSnapshot
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
const still = vi.hoisted(() => ({
  url: vi.fn(
    (_page: unknown, _width: number, _height: number, _rows?: number) =>
      'data:image/png;base64,STILL'
  )
}))
vi.mock('./hidden-still', () => ({ hiddenStillUrl: still.url }))

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

// PH-12 (perf hunt 11-20): LiveKit fires ActiveSpeakersChanged on every
// speaker update, level-only ones too. A snapshot re-renders every room
// reader, so only a change in which guests talk publishes one.
describe('active speakers (PH-12)', () => {
  const participant = (identity: string, name: string) => ({
    identity,
    name,
    trackPublications: new Map(),
    connectionQuality: 'good'
  })

  it('publishes when the talking guests change, never for levels or the host', async () => {
    const snapshots: TalkShowRoomSnapshot[] = []
    const { room } = client(undefined, undefined, { onSnapshot: (next) => snapshots.push(next) })
    await room.connect()
    const ada = participant('g_ada', 'Ada')
    const bo = participant('g_bo', 'Bo')
    for (const guest of [ada, bo]) {
      latestRoom().remoteParticipants.set(guest.identity, guest)
      latestRoom().emit('ParticipantConnected', guest)
    }
    const host = latestRoom().localParticipant
    const speakers = (...people: { identity: string }[]): void =>
      latestRoom().emit('ActiveSpeakersChanged', people)
    const speaking = (): string[] =>
      room.snapshot.people.filter((person) => person.speaking).map((person) => person.identity)

    let before = snapshots.length
    speakers(ada)
    expect(snapshots.length).toBe(before + 1)
    expect(speaking()).toEqual(['g_ada'])

    // The same set again (a level update), in another order, or with the
    // host in it: nothing the snapshot shows changed.
    before = snapshots.length
    speakers(ada)
    speakers(host, ada)
    speakers(ada, host)
    expect(snapshots.length).toBe(before)

    speakers(bo, ada)
    expect(snapshots.length).toBe(before + 1)
    expect(speaking()).toEqual(['g_ada', 'g_bo'])
    speakers(ada, bo)
    expect(snapshots.length).toBe(before + 1)

    speakers(host)
    expect(snapshots.length).toBe(before + 2)
    expect(speaking()).toEqual([])
    speakers()
    expect(snapshots.length).toBe(before + 2)
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

it("opens the Sources camera and microphone by Chromium's decorated macOS labels (0.31.1)", async () => {
  // enumerateDevices on the owner's Mac (Electron 39): Chromium appends the
  // USB `(vid:pid)` and the transport, while Sources names the plain device.
  // 0.31.0 compared raw labels, so a real camera and mic never opened.
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => [
        {
          kind: 'audioinput',
          deviceId: 'default',
          label: 'Default - MacBook Pro Microphone (Built-in)'
        },
        { kind: 'audioinput', deviceId: 'mv7', label: 'Shure MV7+ (14ed:1019)' },
        { kind: 'audioinput', deviceId: 'zv-audio', label: 'ZV-E10M2 (054c:0ee8)' },
        { kind: 'audioinput', deviceId: 'mbp-mic', label: 'MacBook Pro Microphone (Built-in)' },
        { kind: 'videoinput', deviceId: 'zv', label: 'ZV-E10M2 (054c:0ee8)' },
        { kind: 'videoinput', deviceId: 'mbp-cam', label: 'MacBook Pro Camera (0000:0001)' },
        { kind: 'videoinput', deviceId: 'vc', label: 'Videorc Camera' }
      ]
    }
  })
  const { room } = client(undefined, undefined, {
    cameraName: 'ZV-E10M2',
    microphoneName: 'Shure MV7+'
  })
  await room.connect()
  expect(lk.video).toHaveBeenCalledWith(expect.objectContaining({ deviceId: { exact: 'zv' } }))
  expect(lk.audio).toHaveBeenCalledWith(expect.objectContaining({ deviceId: { exact: 'mv7' } }))
  expect(room.snapshot.local.problem).toBeNull()
  await room.disconnect()

  await expect(microphoneDeviceIdFor('MacBook Pro Microphone')).resolves.toBe('mbp-mic')
  await expect(cameraDeviceIdFor('MacBook Pro Camera')).resolves.toBe('mbp-cam')
  await expect(cameraDeviceIdFor('Videorc Camera')).resolves.toBeUndefined()
  await expect(microphoneDeviceIdFor('Shure MV7')).resolves.toBeUndefined()
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
  // Hide screen in a room (owner, 2026-11-20): the Show stage draws the
  // designed hidden still guests and the program draw, never a flat grey box
  // and never anything of the screen.
  it('a hide shows the hidden still at the screen size until Show; a late still is dropped', async () => {
    const { raw } = fixture()
    Object.assign(raw, { getSettings: () => ({ width: 2560, height: 1440 }) })
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: async () => ({ getVideoTracks: () => [raw], getTracks: () => [raw] })
      }
    })
    const { room } = client(undefined, undefined, { cameraName: null, microphoneName: null })
    await room.connect()
    await room.startScreenShare()
    const show = () =>
      privacyModule.roomScreenPrivacy.apply(
        { hidden: false, generation: 0 },
        privacyModule.roomScreenPrivacy.showIntent(),
        true
      )
    still.url.mockClear()
    privacyModule.roomScreenPrivacy.hide()
    // The still is drawn after the hide, never inside it.
    expect(room.snapshot.local.screenStill).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    // Rooms of earlier cases still listen to the shared gate: match this one's size.
    expect(still.url).toHaveBeenCalledWith(expect.anything(), 2560, 1440, 720)
    expect(room.snapshot.local.screenStill).toBe('data:image/png;base64,STILL')
    show()
    expect(room.snapshot.local.screenStill).toBeUndefined()
    // Shown again before the still was drawn: it never lands.
    privacyModule.roomScreenPrivacy.hide()
    show()
    await vi.advanceTimersByTimeAsync(1)
    expect(room.snapshot.local.screenStill).toBeUndefined()
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

  // Plan 251: with two screens up, `screens` names both; `screen` stays the
  // first, which is all an older guest page reads.
  it('names both screens of a two-screens stage, and one for an older guest page', () => {
    expect(read(stageMessage(['host:s', 'g_a'], ['g_a', 'host:s']))).toEqual({
      v: 1,
      onStage: ['host:s', 'g_a'],
      screen: 'g_a',
      screens: ['g_a', 'host:s']
    })
    // One on stage, one not: a plain one-screen message.
    expect(read(stageMessage(['host:s'], ['g_a', 'host:s']))).toEqual({
      v: 1,
      onStage: ['host:s'],
      screen: 'host:s'
    })
    expect(read(stageMessage(['host:s'], []))).toEqual({ v: 1, onStage: ['host:s'], screen: null })
  })

  // Guest captions: the guest page's "Live captions are on" line. Only while
  // the guests are captioned; otherwise the message is byte-for-byte the old one.
  it('says captions only while the guests are captioned', () => {
    expect(read(stageMessage(['g_a'], null, true))).toEqual({
      v: 1,
      onStage: ['g_a'],
      screen: null,
      captions: true
    })
    expect(read(stageMessage(['g_a'], null, false))).toEqual({
      v: 1,
      onStage: ['g_a'],
      screen: null
    })
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

// The owner, 2026-11-19 (0.32.1): a managed talk show's comment cards and
// captions never reached the viewers while the room's Graphics switch was
// off, its default in every new room.
describe('room graphics and the Graphics switch', () => {
  const layer = (kind: 'banner' | 'caption' | 'chat' | 'highlight', id: string) => ({
    id,
    kind,
    rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
    asset: { png: 'iVBORw0KGgo=', hash: 'a'.repeat(64), width: 1, height: 1 },
    opacity: 1,
    fade: null,
    expiresAt: kind === 'banner' ? null : Date.now() + 10_000,
    stream: true,
    recording: true
  })

  it('sends captions and the comment card with the switch off, banners only once it is on', async () => {
    const { room } = client()
    await room.connect()
    Object.assign(latestRoom().localParticipant, { sid: 'PA_host' })
    const kinds = () => room.snapshot.graphics?.preview?.layers.map((l) => l.kind) ?? []
    room.setGraphics({
      h: [
        layer('banner', 'banner:b1'),
        layer('caption', 'caption'),
        layer('highlight', 'highlight')
      ],
      v: [],
      unsupported: []
    })
    expect(room.snapshot.graphics?.enabled).toBe(false)
    expect(kinds()).toEqual(['caption', 'highlight'])
    room.setGraphicsEnabled(true)
    expect(kinds()).toEqual(['banner', 'caption', 'highlight'])
    room.setGraphicsEnabled(false)
    expect(kinds()).toEqual(['caption', 'highlight'])
    // The card expired and the captions stopped: nothing is sent.
    room.setGraphics({ h: [layer('banner', 'banner:b1')], v: [], unsupported: [] })
    expect(room.snapshot.graphics?.preview ?? null).toBeNull()
    await room.disconnect()
  })
})

// Plan 253 S4: the host measures. The numbers are the shared fixture's
// (room-latency-host.test.ts holds every rule); this is the room client's
// own part: which tracks it samples, that only the server's relay counts,
// and where the numbers land in the snapshot.
describe('latency in the room (plan 253 S4)', () => {
  const ADA = 'g_Ada0000000000000000000'
  const PAGE = 'EG_wide00000000'
  const HOST = 'host:sh_talk'

  /** A track whose stats grow by one 10 s window per read. */
  function statsTrack(
    kind: 'audio' | 'video',
    per: Record<string, number>,
    extra: (step: number) => object[] = () => []
  ) {
    let step = 0
    const reads = { count: 0 }
    const track = {
      kind,
      mediaStreamTrack: { kind } as unknown as MediaStreamTrack,
      getRTCStatsReport: async () => {
        step += 1
        reads.count += 1
        const entry = Object.fromEntries(
          Object.entries(per).map(([key, value]) => [key, value * step])
        )
        return new Map<string, object>([
          ['0', { type: 'inbound-rtp', ...entry }],
          ...extra(step).map((item, index) => [String(index + 1), item] as [string, object])
        ])
      }
    }
    return { reads, track }
  }
  const pair = [
    { type: 'transport', selectedCandidatePairId: 'CP1' },
    {
      type: 'candidate-pair',
      id: 'CP1',
      nominated: true,
      state: 'succeeded',
      currentRoundTripTime: 0.03
    }
  ]

  /** Ada in the room with a microphone and a shared screen; the page beside her. */
  function people(quality = 'good') {
    // 60 ms of jitter buffer and 20 ms of playout per sample, at 48 kHz.
    const mic = statsTrack(
      'audio',
      { jitterBufferDelay: 0.06 * 480_000, jitterBufferEmittedCount: 480_000 },
      (step) => [
        ...pair,
        {
          type: 'media-playout',
          totalPlayoutDelay: 0.02 * 480_000 * step,
          totalSamplesCount: 480_000 * step
        }
      ]
    )
    const screen = statsTrack('video', { totalProcessingDelay: 30, framesDecoded: 300 })
    latestRoom().remoteParticipants.set(ADA, {
      identity: ADA,
      name: 'Ada',
      sid: 'PA_ada',
      connectionQuality: quality,
      trackPublications: new Map([
        ['TR_mic', { source: 'microphone', isMuted: false, isSubscribed: true, track: mic.track }],
        [
          'TR_screen',
          { source: 'screen_share', isMuted: false, isSubscribed: true, track: screen.track }
        ]
      ])
    })
    latestRoom().remoteParticipants.set(PAGE, {
      identity: PAGE,
      sid: 'PA_page',
      trackPublications: new Map()
    })
    return { mic, screen }
  }
  const relay = (
    identity: string,
    net: object,
    participant?: object,
    topic = 'videorc.latency.v1'
  ) =>
    latestRoom().emit(
      'DataReceived',
      new TextEncoder().encode(JSON.stringify({ v: 1, identity, at: 1, net })),
      participant,
      undefined,
      topic
    )
  const adaBlock = {
    v: 1,
    windowMs: 10_000,
    rttMs: 42,
    playoutMs: 18,
    partial: false,
    from: [{ identity: HOST, audioMs: 61 }]
  }

  it('joins its own sample with the relayed reports into each person and the program', async () => {
    const { room } = client(undefined, undefined, { measureLatency: () => true })
    await room.connect()
    const { mic, screen } = people()
    latestRoom().emit('ParticipantConnected', latestRoom().remoteParticipants.get(ADA))
    expect(room.snapshot.people[0]?.latency).toBeUndefined()
    // Two samples 10 s apart make the host's first block.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mic.reads.count).toBeGreaterThanOrEqual(2)
    // A shared screen is not conversation: it is never sampled.
    expect(screen.reads.count).toBe(0)
    expect(room.snapshot.local.rttMs).toBe(30)
    expect(room.snapshot.people[0]?.latency).toBeUndefined()
    relay(ADA, adaBlock)
    // You to Ada: 40 + 15 + 5 + 21 + 61 + 18. Ada to you: 40 + 21 + 5 + 15 + 60 + 20.
    expect(room.snapshot.people[0]?.latency).toEqual({
      ms: 161,
      partial: false,
      toGuestMs: 160,
      fromGuestMs: 161
    })
    // The page's report: a number only once it and the host's camera have one.
    relay(PAGE, {
      v: 1,
      windowMs: 10_000,
      rttMs: 8,
      partial: true,
      from: [{ identity: HOST, audioMs: 45, videoMs: 30 }]
    })
    expect(room.snapshot.program).toBeUndefined()
    await room.disconnect()
  })

  // Plan 253 S7: each sample goes to the backend's record, in the strict
  // contract's own shape.
  it("reports each sample to the backend for the show's record", async () => {
    const reports: unknown[][] = []
    const backend = {
      requestTyped: vi.fn(async (...args: unknown[]) => {
        reports.push(args)
        return { kept: true }
      })
    } as never
    const { room } = client(undefined, undefined, { measureLatency: () => true, backend })
    await room.connect()
    people()
    latestRoom().emit('ParticipantConnected', latestRoom().remoteParticipants.get(ADA))
    // Two samples 10 s apart make the host's first block: its own round
    // trip is all there is to report until a guest's block arrives.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reports.at(-1)).toEqual([
      'cloud.room.latency.report',
      { showId: 'sh_talk', hostRttMs: 30, people: [] }
    ])
    // The relay alone reports nothing: the next sample does.
    const before = reports.length
    relay(ADA, adaBlock)
    expect(room.snapshot.people[0]?.latency?.ms).toBe(161)
    expect(reports).toHaveLength(before)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reports).toHaveLength(before + 1)
    const [method, report] = reports.at(-1)!
    expect(method).toBe('cloud.room.latency.report')
    expect(report).toEqual({
      showId: 'sh_talk',
      hostRttMs: 30,
      people: [
        { identity: ADA, name: 'Ada', ms: 161, partial: false, toGuestMs: 160, fromGuestMs: 161 }
      ]
    })
    expect(() => validateBackendRpcParams('cloud.room.latency.report', report)).not.toThrow()
    await room.disconnect()
    const after = reports.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(reports).toHaveLength(after)
  })

  it('reports nothing on a show that does not measure', async () => {
    const backend = { requestTyped: vi.fn(async () => ({ kept: true })) } as never
    const { room } = client(undefined, undefined, { measureLatency: () => false, backend })
    await room.connect()
    people()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(
      (backend as { requestTyped: ReturnType<typeof vi.fn> }).requestTyped
    ).not.toHaveBeenCalled()
    await room.disconnect()
  })

  it('counts only what the server relayed: a participant cannot send a report', async () => {
    const { room } = client(undefined, undefined, { measureLatency: () => true })
    await room.connect()
    people()
    await vi.advanceTimersByTimeAsync(20_000)
    relay(ADA, adaBlock, { identity: ADA })
    relay(ADA, adaBlock, { identity: 'g_forged' })
    relay(ADA, adaBlock, undefined, 'videorc.latency.v2')
    expect(room.snapshot.people[0]?.latency).toBeUndefined()
    relay(ADA, adaBlock)
    expect(room.snapshot.people[0]?.latency?.ms).toBe(161)
    // Ada leaves: her number goes with her, and a late report brings none back.
    const ada = latestRoom().remoteParticipants.get(ADA)
    latestRoom().remoteParticipants.delete(ADA)
    latestRoom().emit('ParticipantDisconnected', ada)
    relay(ADA, adaBlock)
    expect(room.snapshot.people).toEqual([])
    await room.disconnect()
  })

  it('a stale report disappears from the snapshot by itself', async () => {
    const { room } = client(undefined, undefined, { measureLatency: () => true })
    await room.connect()
    people()
    await vi.advanceTimersByTimeAsync(20_000)
    relay(ADA, adaBlock)
    expect(room.snapshot.people[0]?.latency?.ms).toBe(161)
    await vi.advanceTimersByTimeAsync(24_000)
    expect(room.snapshot.people[0]?.latency?.ms).toBe(161)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(room.snapshot.people[0]?.latency).toBeUndefined()
    await room.disconnect()
  })

  it('measures nothing on a node show, and keeps no timer for it (D10)', async () => {
    const { room } = client()
    await room.connect()
    const timers = vi.getTimerCount()
    const { mic } = people()
    relay(ADA, adaBlock)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mic.reads.count).toBe(0)
    expect(room.snapshot.people[0]?.latency).toBeUndefined()
    expect(room.snapshot.local.rttMs).toBeUndefined()
    expect(vi.getTimerCount()).toBe(timers)
    await room.disconnect()
  })

  it("reads LiveKit's own quality for each person and for the host", async () => {
    const { room } = client(undefined, undefined, { measureLatency: () => true })
    await room.connect()
    people('poor')
    Object.assign(latestRoom().localParticipant, { connectionQuality: 'excellent' })
    latestRoom().emit('ConnectionQualityChanged')
    expect(room.snapshot.people[0]?.quality).toBe('poor')
    expect(room.snapshot.local.quality).toBe('excellent')
    await room.disconnect()
    expect(room.snapshot.local.quality).toBeUndefined()
  })
})

// The owner, 2026-11-20 (0.35.0): "Sidekick Avatar is not showing up on our
// livestream". On a managed show the avatar's own "on stream" switch did
// nothing: the room held the avatar back until a second switch in Guests →
// Room was turned on, and that one started off in every new room.
describe('room avatar in the default setup', () => {
  const onStream = {
    h: (avatarFixture.snapshot.layers as AvatarLayer[]).filter((l) => l.kind === 'avatar'),
    v: [],
    stream: true,
    recording: false
  }
  /** The program page's receipt, relayed by the server (it names no participant). */
  const programPageCanDraw = () =>
    latestRoom().emit(
      'DataReceived',
      new TextEncoder().encode(
        JSON.stringify({
          v: 2,
          identity: 'EG_program',
          participantSid: 'PA_program',
          at: Date.now(),
          graphics: { version: 1, output: 'stream', orientation: 'h' }
        })
      ),
      undefined,
      undefined,
      CAPABILITY_TOPIC
    )
  /** Avatar snapshots that carry layers (a hide is an empty one). */
  const sentToProgram = () =>
    latestRoom().streams.filter(
      (stream) => stream.topic === AVATAR_TOPIC && stream.attributes?.empty === 'false'
    )

  afterEach(() => vi.useRealTimers())

  it('sends the avatar to the program page with no room switch pressed', async () => {
    vi.useFakeTimers()
    const { room } = client()
    await room.connect()
    Object.assign(latestRoom().localParticipant, { sid: 'PA_host' })
    // The streamer's own switch chose the stream; nothing was pressed in Guests → Room.
    room.setAvatar(onStream)
    expect(room.snapshot.avatar?.enabled).toBe(true)
    expect(room.snapshot.avatar?.preview?.layers.map((l) => l.kind)).toEqual(['avatar'])
    programPageCanDraw()
    await vi.advanceTimersByTimeAsync(1100)
    expect(sentToProgram().length).toBeGreaterThan(0)
    expect(room.snapshot.avatar?.state).toBe('waiting')
    await room.disconnect()
  })

  it('keeps an avatar that is off by its own switch off, and Guests → Room hides it per room', async () => {
    vi.useFakeTimers()
    const { room } = client()
    await room.connect()
    Object.assign(latestRoom().localParticipant, { sid: 'PA_host' })
    // "On stream" and Show in recording are both off: the hook sends no content.
    room.setAvatar(null)
    programPageCanDraw()
    await vi.advanceTimersByTimeAsync(1100)
    expect(room.snapshot.avatar).toMatchObject({ enabled: true, state: 'off', preview: null })
    expect(sentToProgram()).toEqual([])
    // Hidden for this room: content the avatar's own switch chose stays here.
    room.setAvatarEnabled(false)
    room.setAvatar(onStream)
    await vi.advanceTimersByTimeAsync(1100)
    expect(room.snapshot.avatar).toMatchObject({ enabled: false, state: 'off', preview: null })
    expect(sentToProgram()).toEqual([])
    room.setAvatarEnabled(true)
    await vi.advanceTimersByTimeAsync(1100)
    expect(room.snapshot.avatar?.preview?.layers.map((l) => l.kind)).toEqual(['avatar'])
    expect(sentToProgram().length).toBeGreaterThan(0)
    await room.disconnect()
  })
})
