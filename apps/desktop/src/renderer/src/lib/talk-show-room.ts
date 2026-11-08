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
// backend's `cloud.room.token.refresh`, renderer role only), is handed to
// `Room.connect` and kept in memory for the next reconnect; it is never
// logged, stored or put in the snapshot.

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

import type { CloudRoomClientState, CloudRoomQuality, CloudRoomTokenAnswer } from '@/lib/backend'
import { matchMicrophoneDeviceId } from '@/lib/mic-meter'

/** The data topic the guest page listens on (`guest-wire.ts`, `STAGE_TOPIC`). */
export const STAGE_TOPIC = 'videorc.stage'
/** The runner's identity prefix: its tracks are the return (R-G5). */
const RUNNER_IDENTITY_PREFIX = 'runner:'
/** Host tokens live 10 minutes (the web); refresh with a margin. */
const TOKEN_REFRESH_MS = 8 * 60 * 1000
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

export function isRunnerIdentity(identity: string): boolean {
  return identity.startsWith(RUNNER_IDENTITY_PREFIX)
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
  #token: CloudRoomTokenAnswer | null = null
  #refreshTimer: number | null = null
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
  #speaking = new Set<string>()
  #attached = new Map<string, HTMLMediaElement[]>()
  #snapshot: TalkShowRoomSnapshot = IDLE_TALK_SHOW_ROOM
  #problem: string | null = null

  constructor(deps: TalkShowRoomDeps) {
    this.#deps = deps
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
    this.#token = token
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
    if (this.#closed) {
      await room.disconnect()
      return
    }
    this.#reconnectAttempt = 0
    this.#armTokenRefresh()
    this.#setState('connected', null, token.identity)
    await this.#publishLocal()
    this.#applySubscriptions()
    await this.sendStage(this.#lastStage)
    this.#publish()
  }

  /** Leave: the local tracks stop first (D13 for guests; the same here). */
  async disconnect(): Promise<void> {
    this.#closed = true
    this.#clearTimers()
    await this.#stopLocal()
    const room = this.#room
    this.#room = null
    if (room) {
      await room.disconnect().catch(() => {})
    }
    for (const elements of this.#attached.values()) {
      for (const element of elements) {
        element.remove()
      }
    }
    this.#attached.clear()
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
    if (!room) throw new Error('The room is not open.')
    await this.stopScreenShare()
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false
    })
    const [mediaTrack] = stream.getVideoTracks()
    if (!mediaTrack) throw new Error('No screen was shared.')
    mediaTrack.contentHint = 'detail'
    const track = new LocalVideoTrack(mediaTrack, undefined, true)
    mediaTrack.addEventListener('ended', () => void this.stopScreenShare())
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
    const track = this.#screen
    this.#screen = null
    if (!track) return
    try {
      await this.#room?.localParticipant.unpublishTrack(track, true)
    } catch {
      track.stop()
    }
    this.#publish()
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
        if (!isRunnerIdentity(participant.identity)) {
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
          if (track.kind === Track.Kind.Audio) this.#attachAudio(participant.identity, track)
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
          if (track.kind === Track.Kind.Audio) this.#detachAudio(participant.identity, track)
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
        if (this.#closed || reason === DisconnectReason.CLIENT_INITIATED) return
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

  async #publishLocal(): Promise<void> {
    const room = this.#room
    if (!room) return
    const problems: string[] = []
    try {
      const deviceId = await cameraDeviceIdFor(this.#deps.cameraName)
      const camera = await createLocalVideoTrack({
        deviceId,
        resolution: VideoPresets.h720.resolution
      })
      this.#camera = camera
      await room.localParticipant.publishTrack(camera, {
        source: Track.Source.Camera,
        videoCodec: 'vp8',
        simulcast: true,
        videoEncoding: VideoPresets.h720.encoding
      })
      if (this.#cameraOff) await camera.mute()
    } catch (error) {
      problems.push(`The camera didn't open: ${messageOf(error)}`)
    }
    try {
      const deviceId = await microphoneDeviceIdFor(this.#deps.microphoneName)
      const microphone = await createLocalAudioTrack({
        deviceId,
        echoCancellation: true,
        noiseSuppression: true
      })
      this.#microphone = microphone
      await room.localParticipant.publishTrack(microphone, {
        source: Track.Source.Microphone
      })
      if (this.#micMuted) await microphone.mute()
    } catch (error) {
      problems.push(`The microphone didn't open: ${messageOf(error)}`)
    }
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
    for (const track of tracks) {
      try {
        if (room) await room.localParticipant.unpublishTrack(track, true)
        else track.stop()
      } catch {
        track.stop()
      }
    }
  }

  #attachAudio(identity: string, track: RemoteTrack): void {
    const host = this.#deps.audioHost()
    if (!host) return
    const element = track.attach()
    element.setAttribute('data-talk-show-audio', identity)
    host.appendChild(element)
    const list = this.#attached.get(identity) ?? []
    list.push(element)
    this.#attached.set(identity, list)
  }

  #detachAudio(identity: string, track: RemoteTrack): void {
    const detached = track.detach()
    for (const element of detached) element.remove()
    const list = (this.#attached.get(identity) ?? []).filter(
      (element) => !detached.includes(element)
    )
    if (list.length) this.#attached.set(identity, list)
    else this.#attached.delete(identity)
  }

  #armTokenRefresh(): void {
    this.#clearRefresh()
    this.#refreshTimer = window.setTimeout(() => {
      void this.#deps
        .requestToken()
        .then((token) => {
          this.#token = token
        })
        .catch((error: unknown) => {
          console.warn('[talk-show] token refresh failed', messageOf(error))
        })
        .finally(() => {
          if (!this.#closed) this.#armTokenRefresh()
        })
    }, TOKEN_REFRESH_MS)
  }

  #scheduleReconnect(reason?: DisconnectReason): void {
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
    try {
      // A fresh token: the old one may be past its 10 minutes.
      const token = await this.#deps.requestToken()
      this.#token = token
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
      this.#reconnectAttempt = 0
      this.#armTokenRefresh()
      this.#setState('connected', null, token.identity)
      await this.#publishLocal()
      this.#applySubscriptions()
      await this.sendStage(this.#lastStage)
      this.#publish()
    } catch (error) {
      console.warn('[talk-show] reconnect failed', messageOf(error))
      this.#scheduleReconnect()
    }
  }

  #clearRefresh(): void {
    if (this.#refreshTimer !== null) {
      window.clearTimeout(this.#refreshTimer)
      this.#refreshTimer = null
    }
  }

  #clearTimers(): void {
    this.#clearRefresh()
    if (this.#reconnectTimer !== null) {
      window.clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  #setState(state: CloudRoomClientState, detail: string | null, identity?: string): void {
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
    const room = this.#room
    const people: TalkShowPerson[] = []
    let monitorVideo: MediaStreamTrack | null = null
    let monitorAudio: MediaStreamTrack | null = null
    if (room) {
      for (const participant of room.remoteParticipants.values()) {
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
