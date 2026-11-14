// The host in the room (plan 224 C-G4, D6): `livekit-client` publishes the
// Sources camera and microphone and, on request, a screen picked through
// main's `desktopCapturer`; it subscribes to everyone in the room (the stage
// and the backstage voices, D11) and to the runner's return only while the
// Program monitor is on (D7). Nothing here imports React or the Studio: the
// controller hook (`hooks/use-talk-show-room.ts`) owns the lifecycle and
// hands this module's snapshot to the UI as plain `MediaStreamTrack`s.
//
// Loaded lazily, only when a room opens: `livekit-client` never joins the
// eager renderer bundle (the budget is an owner STOP).
//
// The host token is a secret. It arrives through `requestToken` (the
// backend's `cloud.room.token.refresh`, renderer role only) and is handed to
// `Room.connect`, nothing else: LiveKit refreshes a running connection's
// token itself, and every join and rejoin asks for a fresh one (review L4).
// It is never logged, stored or put in the snapshot.

import {
  ConnectionQuality,
  ConnectionState,
  DisconnectReason,
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from 'livekit-client'

import type {
  CloudRoomClientState,
  CloudRoomOverlayEvent,
  CloudRoomQuality,
  CloudRoomTokenAnswer
} from '@/lib/backend'
import { matchMicrophoneDeviceId } from '@/lib/mic-meter'
import { sendOverlay, type OverlayImage } from '@/lib/talk-show-overlays'
import {
  RemoteAudioAttachments,
  isRecorderIdentity,
  isRunnerIdentity
} from '@/lib/talk-show-room-audio'

export { isRunnerIdentity } from '@/lib/talk-show-room-audio'

/** The data topic the guest page listens on (`guest-wire.ts`, `STAGE_TOPIC`). */
export const STAGE_TOPIC = 'videorc.stage'
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]

export type TalkShowPerson = {
  identity: string
  name: string
  video: MediaStreamTrack | null
  audio: MediaStreamTrack | null
  screen: MediaStreamTrack | null
  micMuted: boolean
  cameraOff: boolean
  quality: CloudRoomQuality
  speaking: boolean
}

export type TalkShowLocalMedia = {
  camera: MediaStreamTrack | null
  microphone: MediaStreamTrack | null
  screen: MediaStreamTrack | null
  micMuted: boolean
  cameraOff: boolean
  /** Why the camera or the mic did not open, one sentence; null when both did. */
  problem: string | null
}

export type TalkShowMonitor = {
  enabled: boolean
  video: MediaStreamTrack | null
  audio: MediaStreamTrack | null
}

export type TalkShowRoomSnapshot = {
  state: CloudRoomClientState
  detail: string | null
  /** `host:<showId>` once connected. */
  identity: string | null
  people: TalkShowPerson[]
  local: TalkShowLocalMedia
  monitor: TalkShowMonitor
}

export const IDLE_TALK_SHOW_ROOM: TalkShowRoomSnapshot = {
  state: 'idle',
  detail: null,
  identity: null,
  people: [],
  local: {
    camera: null,
    microphone: null,
    screen: null,
    micMuted: false,
    cameraOff: false,
    problem: null
  },
  monitor: { enabled: false, video: null, audio: null }
}

export type TalkShowRoomDeps = {
  requestToken: () => Promise<CloudRoomTokenAnswer>
  /** `cloud.room.client.report`: the backend's status copy. */
  report: (state: CloudRoomClientState, detail?: string) => void
  onSnapshot: (snapshot: TalkShowRoomSnapshot) => void
  /** The Sources page's camera and microphone, by their plain names. */
  cameraName: string | null
  microphoneName: string | null
  /** Where remote audio plays (a hidden container the hook owns). */
  audioHost: () => HTMLElement | null
}

/** The guest page's `StageMessage` (`guest-wire.ts`): the identities on stage. */
export function stageMessage(onStage: readonly string[]): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ v: 1, onStage: [...onStage] }))
}

function qualityOf(quality: ConnectionQuality): CloudRoomQuality {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return 'excellent'
    case ConnectionQuality.Poor:
      return 'poor'
    case ConnectionQuality.Lost:
      return 'lost'
    default:
      return 'good'
  }
}

/** A Chromium device id for the Sources camera, by its plain name. */
export async function cameraDeviceIdFor(cameraName: string | null): Promise<string | undefined> {
  if (!cameraName) return undefined
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const inputs = devices
    .filter((device) => device.kind === 'videoinput')
    .map((device) => ({ deviceId: device.deviceId, label: device.label }))
  return matchMicrophoneDeviceId(cameraName, inputs)
}

export async function microphoneDeviceIdFor(
  microphoneName: string | null
): Promise<string | undefined> {
  if (!microphoneName) return undefined
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const inputs = devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({ deviceId: device.deviceId, label: device.label }))
  return matchMicrophoneDeviceId(microphoneName, inputs)
}

export class TalkShowRoomClient {
  readonly #deps: TalkShowRoomDeps
  #room: Room | null = null
  #reconnectTimer: number | null = null
  #reconnectAttempt = 0
  #closed = false
  #lastStage: string[] = []
  #monitorEnabled = false
  #micMuted = false
  #cameraOff = false
  #camera: LocalVideoTrack | null = null
  #microphone: LocalAudioTrack | null = null
  #screen: LocalVideoTrack | null = null
  #screenGeneration = 0
  #speaking = new Set<string>()
  /** Remote voices playing through the audio host; never the runner's return (H1). */
  readonly #audio: RemoteAudioAttachments<HTMLMediaElement>
  #snapshot: TalkShowRoomSnapshot = IDLE_TALK_SHOW_ROOM
  #problem: string | null = null
  /** Overlays go one at a time, in the order they were handed over. */
  #overlays: Promise<void> = Promise.resolve()

  constructor(deps: TalkShowRoomDeps) {
    this.#deps = deps
    this.#audio = new RemoteAudioAttachments<HTMLMediaElement>(() => deps.audioHost())
  }

  get snapshot(): TalkShowRoomSnapshot {
    return this.#snapshot
  }

  /** Join with a fresh token, publish the camera and the mic, send the stage. */
  async connect(): Promise<void> {
    if (this.#closed) return
    this.#setState('connecting', null)
    const token = await this.#deps.requestToken()
    if (this.#closed) return
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // The host subscribes by hand: everyone but the runner, and the runner
      // only while the monitor is on (D7, D11).
      publishDefaults: {
        videoCodec: 'vp8',
        simulcast: true,
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360]
      }
    })
    this.#room = room
    this.#bind(room)
    await room.connect(token.url, token.hostToken, { autoSubscribe: false })
    if (!this.#owns(room)) {
      await room.disconnect()
      return
    }
    this.#reconnectAttempt = 0
    this.#setState('connected', null, token.identity)
    await this.#publishLocal()
    if (!this.#owns(room)) return
    this.#applySubscriptions()
    await this.sendStage(this.#lastStage)
    this.#publish()
  }

  /** Leave: the local tracks stop first (D13 for guests; the same here). */
  async disconnect(): Promise<void> {
    this.#closed = true
    this.#screenGeneration += 1
    this.#clearTimers()
    await this.#stopLocal()
    const room = this.#room
    this.#room = null
    if (room) {
      await room.disconnect().catch(() => {})
    }
    this.#audio.clear()
    this.#snapshot = IDLE_TALK_SHOW_ROOM
    this.#deps.onSnapshot(this.#snapshot)
  }

  /** The stage, to the guest page's topic (D11): on every change and on
   * every join (data messages are not replayed). */
  async sendStage(onStage: readonly string[]): Promise<void> {
    this.#lastStage = [...onStage]
    const room = this.#room
    if (!room || room.state !== ConnectionState.Connected) return
    try {
      await room.localParticipant.publishData(stageMessage(onStage), {
        reliable: true,
        topic: STAGE_TOPIC
      })
    } catch (error) {
      console.warn('[talk-show] the stage did not reach the room', error)
    }
  }

  async setMicrophoneMuted(muted: boolean): Promise<void> {
    this.#micMuted = muted
    if (this.#microphone) {
      if (muted) await this.#microphone.mute()
      else await this.#microphone.unmute()
    }
    this.#publish()
  }

  async setCameraOff(off: boolean): Promise<void> {
    this.#cameraOff = off
    if (this.#camera) {
      if (off) await this.#camera.mute()
      else await this.#camera.unmute()
    }
    this.#publish()
  }

  /** The screen picked through main (`setTalkShowMediaGrant` named the
   * source); `getDisplayMedia` answers with it once. Published at 1080p30
   * with `detail` so shared text stays crisp (S0b). */
  async startScreenShare(): Promise<void> {
    const room = this.#room
    if (!room || !this.#owns(room)) throw new Error('The room is not open.')
    await this.stopScreenShare()
    const generation = this.#screenGeneration
    if (!this.#owns(room)) return
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false
    })
    if (!this.#owns(room) || generation !== this.#screenGeneration) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    const [mediaTrack] = stream.getVideoTracks()
    if (!mediaTrack) throw new Error('No screen was shared.')
    mediaTrack.contentHint = 'detail'
    const track = new LocalVideoTrack(mediaTrack, undefined, true)
    mediaTrack.addEventListener('ended', () => {
      if (this.#screen === track) void this.stopScreenShare()
    })
    this.#screen = track
    await room.localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShare,
      videoCodec: 'vp8',
      simulcast: false,
      videoEncoding: { maxBitrate: 4_000_000, maxFramerate: 30 }
    })
    this.#publish()
  }

  async stopScreenShare(): Promise<void> {
    this.#screenGeneration += 1
    const track = this.#screen
    this.#screen = null
    if (!track) return
    track.stop()
    try {
      await this.#room?.localParticipant.unpublishTrack(track, true)
    } catch {
      track.stop()
    }
    this.#publish()
  }

  /**
   * An overlay to a managed show's program page (plan 234 T3, wire contract
   * 6.3), as a byte stream on this connection: the page takes one only from
   * the host. In order, so a clear never overtakes its set. While the room
   * is not connected nothing is sent; the backend hands what is up over
   * again when this connection reports back.
   */
  sendOverlay(
    event: CloudRoomOverlayEvent,
    image: (imageId: string) => Promise<OverlayImage | null>
  ): Promise<void> {
    this.#overlays = this.#overlays.then(async () => {
      const room = this.#room
      if (this.#closed || !room || room.state !== ConnectionState.Connected) return
      try {
        const result = await sendOverlay(event, { publisher: room.localParticipant, image })
        if (result === 'refused') {
          console.warn('[talk-show] an overlay was not one the program page takes', event.slot)
        }
      } catch (error) {
        console.warn('[talk-show] an overlay did not reach the room', messageOf(error))
      }
    })
    return this.#overlays
  }

  /** The Program monitor (D7): the runner's return, subscribed on demand. */
  setMonitor(enabled: boolean): void {
    this.#monitorEnabled = enabled
    this.#applySubscriptions()
    this.#publish()
  }

  #bind(room: Room): void {
    room
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        this.#applySubscriptions()
        // A guest who just joined needs the stage (data is not replayed).
        if (!isRunnerIdentity(participant.identity) && !isRecorderIdentity(participant.identity)) {
          void this.sendStage(this.#lastStage)
        }
        this.#publish()
      })
      .on(RoomEvent.ParticipantDisconnected, () => this.#publish())
      .on(RoomEvent.TrackPublished, () => {
        this.#applySubscriptions()
        this.#publish()
      })
      .on(RoomEvent.TrackUnpublished, () => this.#publish())
      .on(
        RoomEvent.TrackSubscribed,
        (
          track: RemoteTrack,
          _publication: RemoteTrackPublication,
          participant: RemoteParticipant
        ) => {
          if (!this.#owns(room)) return
          if (track.kind === Track.Kind.Audio) this.#audio.subscribed(participant.identity, track)
          this.#publish()
        }
      )
      .on(
        RoomEvent.TrackUnsubscribed,
        (
          track: RemoteTrack,
          _publication: RemoteTrackPublication,
          participant: RemoteParticipant
        ) => {
          if (track.kind === Track.Kind.Audio) this.#audio.unsubscribed(participant.identity, track)
          this.#publish()
        }
      )
      .on(RoomEvent.TrackMuted, () => this.#publish())
      .on(RoomEvent.TrackUnmuted, () => this.#publish())
      .on(RoomEvent.ParticipantNameChanged, () => this.#publish())
      .on(RoomEvent.ConnectionQualityChanged, () => this.#publish())
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        this.#speaking = new Set(speakers.map((speaker) => speaker.identity))
        this.#publish()
      })
      .on(RoomEvent.Reconnecting, () => this.#setState('reconnecting', 'Reconnecting to the room.'))
      .on(RoomEvent.Reconnected, () => {
        this.#setState('connected', null)
        void this.sendStage(this.#lastStage)
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!this.#owns(room) || reason === DisconnectReason.CLIENT_INITIATED) return
        this.#scheduleReconnect(reason)
      })
  }

  #applySubscriptions(): void {
    const room = this.#room
    if (!room) return
    for (const participant of room.remoteParticipants.values()) {
      const wanted = isRunnerIdentity(participant.identity) ? this.#monitorEnabled : true
      for (const publication of participant.trackPublications.values()) {
        if (publication.isSubscribed !== wanted) {
          publication.setSubscribed(wanted)
        }
      }
    }
  }

  #owns(room: Room): boolean {
    return !this.#closed && this.#room === room
  }

  async #publishLocal(): Promise<void> {
    const room = this.#room
    if (!room) return
    if (!this.#owns(room)) return
    const problems: string[] = []
    try {
      const deviceId = await cameraDeviceIdFor(this.#deps.cameraName)
      if (!this.#owns(room)) return
      const camera = await createLocalVideoTrack({
        deviceId,
        resolution: VideoPresets.h720.resolution
      })
      if (!this.#owns(room)) {
        camera.stop()
        return
      }
      this.#camera = camera
      await room.localParticipant.publishTrack(camera, {
        source: Track.Source.Camera,
        videoCodec: 'vp8',
        simulcast: true,
        videoEncoding: VideoPresets.h720.encoding
      })
      if (!this.#owns(room)) {
        camera.stop()
        return
      }
      if (this.#cameraOff) await camera.mute()
    } catch (error) {
      problems.push(`The camera didn't open: ${messageOf(error)}`)
    }
    if (!this.#owns(room)) return
    try {
      const deviceId = await microphoneDeviceIdFor(this.#deps.microphoneName)
      if (!this.#owns(room)) return
      const microphone = await createLocalAudioTrack({
        deviceId,
        echoCancellation: true,
        noiseSuppression: true
      })
      if (!this.#owns(room)) {
        microphone.stop()
        return
      }
      this.#microphone = microphone
      await room.localParticipant.publishTrack(microphone, {
        source: Track.Source.Microphone
      })
      if (!this.#owns(room)) {
        microphone.stop()
        return
      }
      if (this.#micMuted) await microphone.mute()
    } catch (error) {
      problems.push(`The microphone didn't open: ${messageOf(error)}`)
    }
    if (!this.#owns(room)) return
    this.#problem = problems.length ? problems.join(' ') : null
    if (this.#problem) this.#deps.report('connected', this.#problem)
  }

  async #stopLocal(): Promise<void> {
    const room = this.#room
    const tracks = [this.#camera, this.#microphone, this.#screen].filter(
      (track): track is LocalVideoTrack | LocalAudioTrack => track !== null
    )
    this.#camera = null
    this.#microphone = null
    this.#screen = null
    // Stop capture synchronously, before waiting for any network unpublish.
    for (const track of tracks) track.stop()
    for (const track of tracks) {
      try {
        if (room) await room.localParticipant.unpublishTrack(track, true)
        else track.stop()
      } catch {
        track.stop()
      }
    }
  }

  #scheduleReconnect(reason?: DisconnectReason): void {
    if (this.#closed) return
    const attempt = this.#reconnectAttempt
    const terminal =
      reason === DisconnectReason.ROOM_DELETED ||
      reason === DisconnectReason.PARTICIPANT_REMOVED ||
      reason === DisconnectReason.DUPLICATE_IDENTITY
    if (terminal || attempt >= RECONNECT_BACKOFF_MS.length) {
      this.#setState('disconnected', 'Connection to the room lost.')
      return
    }
    this.#reconnectAttempt = attempt + 1
    this.#setState('reconnecting', 'Reconnecting to the room.')
    this.#reconnectTimer = window.setTimeout(() => {
      void this.#reconnect()
    }, RECONNECT_BACKOFF_MS[attempt])
  }

  async #reconnect(): Promise<void> {
    if (this.#closed) return
    const stale = this.#room
    this.#room = null
    if (stale) await stale.disconnect().catch(() => {})
    await this.#stopLocal()
    if (this.#closed) return
    try {
      // A fresh token: the old one may be past its 10 minutes.
      const token = await this.#deps.requestToken()
      if (this.#closed) return
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        publishDefaults: {
          videoCodec: 'vp8',
          simulcast: true,
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360]
        }
      })
      this.#room = room
      this.#bind(room)
      await room.connect(token.url, token.hostToken, { autoSubscribe: false })
      if (!this.#owns(room)) {
        await room.disconnect()
        return
      }
      this.#reconnectAttempt = 0
      this.#setState('connected', null, token.identity)
      await this.#publishLocal()
      if (!this.#owns(room)) return
      this.#applySubscriptions()
      await this.sendStage(this.#lastStage)
      this.#publish()
    } catch (error) {
      console.warn('[talk-show] reconnect failed', messageOf(error))
      this.#scheduleReconnect()
    }
  }

  #clearTimers(): void {
    if (this.#reconnectTimer !== null) {
      window.clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  #setState(state: CloudRoomClientState, detail: string | null, identity?: string): void {
    if (this.#closed) return
    this.#snapshot = {
      ...this.#snapshot,
      state,
      detail,
      identity: identity ?? this.#snapshot.identity
    }
    this.#deps.report(state, detail ?? undefined)
    this.#publish()
  }

  #publish(): void {
    if (this.#closed) return
    const room = this.#room
    const people: TalkShowPerson[] = []
    let monitorVideo: MediaStreamTrack | null = null
    let monitorAudio: MediaStreamTrack | null = null
    if (room) {
      for (const participant of room.remoteParticipants.values()) {
        // LiveKit's recorder is nobody (plan 234).
        if (isRecorderIdentity(participant.identity)) continue
        let video: MediaStreamTrack | null = null
        let audio: MediaStreamTrack | null = null
        let screen: MediaStreamTrack | null = null
        let micMuted = false
        let cameraOff = false
        for (const publication of participant.trackPublications.values()) {
          const track = publication.track
          if (publication.source === Track.Source.Microphone) micMuted = publication.isMuted
          if (publication.source === Track.Source.Camera) cameraOff = publication.isMuted
          if (!track || !publication.isSubscribed) continue
          if (track.kind === Track.Kind.Audio) audio = track.mediaStreamTrack
          else if (publication.source === Track.Source.ScreenShare) screen = track.mediaStreamTrack
          else if (track.kind === Track.Kind.Video) video = track.mediaStreamTrack
        }
        if (isRunnerIdentity(participant.identity)) {
          monitorVideo = video
          monitorAudio = audio
          continue
        }
        people.push({
          identity: participant.identity,
          name: participant.name || 'Guest',
          video,
          audio,
          screen,
          micMuted,
          cameraOff,
          quality: qualityOf(participant.connectionQuality),
          speaking: this.#speaking.has(participant.identity)
        })
      }
    }
    this.#snapshot = {
      ...this.#snapshot,
      people,
      local: {
        camera: this.#camera?.mediaStreamTrack ?? null,
        microphone: this.#microphone?.mediaStreamTrack ?? null,
        screen: this.#screen?.mediaStreamTrack ?? null,
        micMuted: this.#micMuted,
        cameraOff: this.#cameraOff,
        problem: this.#problem
      },
      monitor: { enabled: this.#monitorEnabled, video: monitorVideo, audio: monitorAudio }
    }
    this.#deps.onSnapshot(this.#snapshot)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** For the tests: the publication shapes the snapshot reads. */
export type { LocalTrackPublication }
