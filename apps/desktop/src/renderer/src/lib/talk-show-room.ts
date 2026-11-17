import {
  createRoomMicrophoneSource,
  microphoneRequiresReplacement,
  type RoomMicrophoneChoice,
  type RoomMicrophoneSource
} from './room-microphone-source'
import { RoomAuxPublisher } from './room-aux-publisher'
import { createRoomPcmTestSource, type RoomPcmSource } from './room-pcm-source'
import {
  RoomAvatarPublisher,
  type AvatarContent,
  type RoomAvatarAnimation,
  type RoomAvatarStatus
} from './room-avatar-publisher'
import { RoomAvatarMotion, ROOM_AVATAR_MOTION_FLUSH_MS } from './room-avatar-motion'
import {
  AVATAR_MOTION_TOPIC,
  type MotionInputs,
  type MotionOrientation,
  type MotionRect
} from '../../../shared/cloud-avatar-motion'
import type { AvatarMotionSource } from '../../../shared/cloud-avatar-view'
import type { AnimatorSettings } from '../../../shared/buddy-animator'
import type { CohostPetAnimatorEvent } from '../../../shared/buddy-animator-public'
import {
  createPrivateScreen,
  roomScreenPrivacy,
  privacyTrackName,
  privacyObservationMatches,
  PRIVACY_ACK_TOPIC,
  PRIVACY_TOPIC,
  type ScreenPrivacyPublication
} from './room-screen-privacy'
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
  type RemoteTrackPublication,
  type RoomOptions
} from 'livekit-client'

import type {
  CloudOnAir,
  CloudRoomClientState,
  CloudRoomOverlayEvent,
  CloudRoomQuality,
  CloudRoomTokenAnswer
} from '@/lib/backend'
import {
  TalkShowCameraEffects,
  TalkShowKeyProcessor,
  type TalkShowCameraSettings
} from '@/lib/talk-show-camera-effects'
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
/** Plan 243 C5: how long a duplicate host waits for `onAir` to name the new device. */
export const TAKEN_OVER_GRACE_MS = 3000
const TAKEN_OVER_POLL_MS = 100
/** The room's line once another device holds the host seat (no device name). */
export const TAKEN_OVER_DETAIL = 'Your show continues on another device.'
const ROOM_LOST_DETAIL = 'Connection to the room lost.'

/** Another device is on air (it holds the host seat), not a hand-off's wait. */
export function onAirElsewhere(onAir: CloudOnAir | undefined): boolean {
  return Boolean(onAir && !onAir.thisDevice && !onAir.waiting)
}

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
  avatar?: RoomAvatarStatus
  screenPrivacy?: ScreenPrivacyPublication & {
    sourceBlockedAt: number | null
    status: 'visible' | 'hiding' | 'observed' | 'unconfirmed' | 'paused'
    observations: Record<string, number>
  }
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
  /** S7a explicit dev fixture; not inferred from media-v2 or exposed as production mode. */
  pcmTestSource?: boolean
  onPcmDiagnostic?: (value: unknown) => void
  requestToken: () => Promise<CloudRoomTokenAnswer>
  /** `cloud.room.client.report`: the backend's status copy. */
  report: (state: CloudRoomClientState, detail?: string) => void
  onSnapshot: (snapshot: TalkShowRoomSnapshot) => void
  /** The Sources page's camera and microphone, by their plain names. */
  cameraName: string | null
  initiallyMuted?: boolean
  initiallyCameraOff?: boolean
  cameraSettings?: () => TalkShowCameraSettings | undefined
  microphoneName: string | null
  microphoneChoice?: RoomMicrophoneChoice
  /** Where remote audio plays (a hidden container the hook owns). */
  audioHost: () => HTMLElement | null
  /**
   * Plan 243 C5: the device on air, from the latest `cloud.state`, so a
   * second host connection that drops this one reads as taken over.
   */
  onAir?: () => CloudOnAir | undefined
}

export function talkShowRoomOptions(): RoomOptions {
  return {
    // The stage renders raw tracks without track.attach(), so adaptive stream must stay off.
    adaptiveStream: false,
    dynacast: true,
    publishDefaults: {
      videoCodec: 'vp8',
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360]
    }
  }
}

/** The guest page's `StageMessage` (`guest-wire.ts`): the identities on stage. */
/** Plan 249 S6 (D4): the screen the program shows rides along, so a guest
 * sees the same shared screen. Always present (null: none), so a guest can
 * tell a current desktop from an older one; only a screen on the stage is
 * named. An older guest page reads `onStage` and ignores the rest. */
export function stageMessage(
  onStage: readonly string[],
  screen: string | null = null
): Uint8Array<ArrayBuffer> {
  const named = screen && onStage.includes(screen) ? screen : null
  return new TextEncoder().encode(JSON.stringify({ v: 1, onStage: [...onStage], screen: named }))
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
  return inputs.find(
    (input) => input.label.trim().toLowerCase() === cameraName.trim().toLowerCase()
  )?.deviceId
}

export async function microphoneDeviceIdFor(
  microphoneName: string | null
): Promise<string | undefined> {
  if (!microphoneName) return undefined
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const inputs = devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({ deviceId: device.deviceId, label: device.label }))
  return inputs.find(
    (input) => input.label.trim().toLowerCase() === microphoneName.trim().toLowerCase()
  )?.deviceId
}

export class TalkShowRoomClient {
  readonly #deps: TalkShowRoomDeps
  #room: Room | null = null
  #aux: RoomAuxPublisher | null = null
  #reconnectTimer: number | null = null
  #reconnectAttempt = 0
  #closed = false
  #localOwnershipLost = false
  #lastStage: string[] = []
  #lastScreen: string | null = null
  #monitorEnabled = false
  #micMuted = false
  #cameraOff = false
  #cameraName: string | null
  #controls: Promise<void> = Promise.resolve()
  #camera: LocalVideoTrack | null = null
  #cameraEffects: TalkShowCameraEffects | null = null
  #cameraEffectError = false
  #cameraSettingsRevision = 0
  #microphone: LocalAudioTrack | null = null
  #pcmSource: RoomPcmSource | null = null
  #pcmAbort: AbortController | null = null
  #pcmRetiring: Promise<unknown> = Promise.resolve()
  #processedMicrophone: RoomMicrophoneSource | null = null
  #microphoneChoice: RoomMicrophoneChoice | undefined
  #microphoneOpening: Promise<void> = Promise.resolve()
  #microphoneCleanupFailed = false
  #microphoneGeneration = 0
  #screen: LocalVideoTrack | null = null
  #screenGeneration = 0
  #screenRaw: MediaStreamTrack | null = null
  #privateScreen: ReturnType<typeof createPrivateScreen> | null = null
  #privacyOff: (() => void) | null = null
  #privacyTimer: ReturnType<typeof setTimeout> | null = null
  #privacy: TalkShowRoomSnapshot['screenPrivacy']
  #privacyEpoch = crypto.randomUUID().replaceAll('-', '')
  #privacyGeneration = 0
  #screenWork: Promise<void> = Promise.resolve()
  #speaking = new Set<string>()
  /** Remote voices playing through the audio host; never the runner's return (H1). */
  readonly #audio: RemoteAudioAttachments<HTMLMediaElement>
  #snapshot: TalkShowRoomSnapshot = IDLE_TALK_SHOW_ROOM
  #problem: string | null = null
  #avatar: RoomAvatarPublisher | null = null
  #avatarContent: AvatarContent | null = null
  #avatarEnabled = false
  /** Plan 249 S5: the avatar's motion stream, per bound room. */
  #motion: RoomAvatarMotion | null = null
  #motionTimer: ReturnType<typeof setInterval> | null = null
  /** What a new producer starts from (a re-bind keeps state, not history). */
  #motionSeed: { settings: AnimatorSettings; inputs: MotionInputs } | null = null
  /** Why the worn avatar shows still on cloud outputs (its atlas was refused). */
  #motionRefused: string | null = null
  /**
   * The highlight card each output accepted (the relay took its bytes), per
   * orientation, until its clear or its time-to-live. The avatar looks at
   * these only: a card an output never got is no input (`null`).
   */
  #cards: Record<MotionOrientation, { rect: MotionRect; until: number | null } | null> = {
    h: null,
    v: null
  }
  #cardsSent = ''
  /** The publisher's last status, merged with the animation facts above. */
  #avatarStatus: RoomAvatarStatus | null = null
  #animationKey = ''
  /** Plan 249 S6 (D4): the host shows the stream's public layers to guests. Off per room. */
  #avatarGuests = false
  /** Overlays go one at a time, in the order they were handed over. */
  #overlays = new Map<string, AbortController>()

  constructor(deps: TalkShowRoomDeps) {
    this.#deps = deps
    this.#privacyOff = roomScreenPrivacy.subscribe(() => {
      if (!this.#screenRaw) return
      // Close the publication before any async work, including an in-flight publish.
      try {
        this.#privateScreen?.block()
      } catch {
        this.#privacyFailed()
      }
      this.#screen?.stop()
      void this.#refreshPrivateScreen()
    })
    this.#microphoneChoice = deps.microphoneChoice
    this.#cameraName = deps.cameraName
    this.#micMuted = deps.initiallyMuted === true || !deps.microphoneName
    this.#cameraOff = deps.initiallyCameraOff === true || !deps.cameraName
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
    const room = new Room(talkShowRoomOptions())
    this.#room = room
    this.#bind(room)
    const auxiliaryEnabled = this.#aux?.enabled ?? false
    this.#aux?.close()
    this.#aux = new RoomAuxPublisher(room, auxiliaryEnabled)
    // The host subscribes by hand: everyone but the runner, and the runner
    // only while the monitor is on (D7, D11).
    await room.connect(token.url, token.hostToken, { autoSubscribe: false })
    if (!this.#owns(room)) {
      await room.disconnect()
      return
    }
    this.#reconnectAttempt = 0
    await this.#publishLocal()
    if (!this.#owns(room)) return
    this.#setState('connected', null, token.identity)
    this.#applySubscriptions()
    await this.sendStage(this.#lastStage, this.#lastScreen)
    this.#publish()
  }

  /** Leave: the local tracks stop first (D13 for guests; the same here). */
  async disconnect(): Promise<void> {
    this.#closed = true
    this.#aux?.close()
    this.#aux = null
    this.#avatar?.close()
    this.#avatar = null
    this.#avatarContent = null
    this.#stopMotion()
    this.#motionSeed = null
    this.#motionRefused = null
    this.#cards = { h: null, v: null }
    this.#privacyOff?.()
    this.#privacyOff = null
    if (this.#privacyTimer) clearTimeout(this.#privacyTimer)
    for (const pending of this.#overlays.values()) pending.abort()
    this.#overlays.clear()
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
  async sendStage(onStage: readonly string[], screen: string | null = null): Promise<void> {
    this.#lastStage = [...onStage]
    this.#lastScreen = screen
    const room = this.#room
    if (!room || room.state !== ConnectionState.Connected) return
    try {
      await room.localParticipant.publishData(stageMessage(onStage, screen), {
        reliable: true,
        topic: STAGE_TOPIC
      })
    } catch (error) {
      console.warn('[talk-show] the stage did not reach the room', error)
    }
  }

  #control(run: (room: Room) => Promise<void>): Promise<void> {
    const room = this.#room
    const next = this.#controls
      .catch(() => {})
      .then(async () => {
        if (!room || !this.#owns(room) || this.#snapshot.state !== 'connected')
          throw new Error('The room is not connected.')
        if (onAirElsewhere(this.#deps.onAir?.())) throw new Error(TAKEN_OVER_DETAIL)
        await run(room)
        if (!this.#owns(room)) throw new Error('The room changed before the control completed.')
        this.#publish()
      })
    this.#controls = next
    return next
  }

  async disconnectMicrophoneFixture(mode?: 'disconnect' | 'starve' | 'resume'): Promise<void> {
    if (!import.meta.env.DEV || !this.#processedMicrophone)
      throw new Error('No microphone fixture is active.')
    await this.#processedMicrophone.disconnectFixture(mode)
  }

  setMicrophoneSelection(deviceId: string | null, name: string | null): Promise<void> {
    const current = this.#microphoneChoice ?? {
      mode: 'browser-aec' as const,
      deviceId: null,
      name: null,
      gainDb: 0,
      muted: this.#micMuted,
      noise: 'off' as const,
      offsetMs: 0
    }
    return this.updateMicrophone({ ...current, deviceId, name }, true)
  }

  updateMicrophone(choice: RoomMicrophoneChoice, retry = false): Promise<void> {
    if (this.#deps.pcmTestSource) return Promise.resolve()
    return this.#control(async (room) => {
      const previous = this.#microphoneChoice
      this.#microphoneChoice = choice
      this.#deps.microphoneName = choice.name
      this.#micMuted = choice.muted || !choice.deviceId
      if (
        !previous ||
        microphoneRequiresReplacement(previous, choice) ||
        (retry && !this.#microphone)
      ) {
        this.#retirePcm(room)
        await this.#pcmRetiring
        await this.#microphoneOpening
        if (!this.#owns(room)) return
        if (choice.deviceId && choice.name) await this.#publishMicrophone(room)
      } else {
        this.#processedMicrophone?.update(choice)
        if (choice.muted) await this.#microphone?.mute()
        else await this.#microphone?.unmute()
      }
    })
  }

  setMicrophoneMuted(muted: boolean): Promise<void> {
    return this.setMicrophoneMode(muted ? 'mute' : 'unmute')
  }

  setMicrophoneMode(mode: 'mute' | 'unmute' | 'toggle'): Promise<void> {
    return this.#control(async (room) => {
      const muted = mode === 'toggle' ? !this.#micMuted : mode === 'mute'
      const track = this.#microphone
      if (!track) throw new Error('No microphone is published in the room.')
      if (this.#microphoneChoice) {
        this.#microphoneChoice = { ...this.#microphoneChoice, muted }
        this.#processedMicrophone?.update(this.#microphoneChoice)
      }
      if (muted) await track.mute()
      else await track.unmute()
      if (!this.#owns(room) || track !== this.#microphone)
        throw new Error('The microphone changed.')
      this.#micMuted = muted
    })
  }

  setCameraOff(off: boolean): Promise<void> {
    return this.setCameraSelection(this.#cameraName, off)
  }

  setCameraSelection(name: string | null, off: boolean): Promise<void> {
    return this.#control(async (room) => {
      // Release capture, not just its publication, for None/off.
      this.#cameraEffects?.close()
      this.#cameraEffects = null
      const old = this.#camera
      this.#camera = null
      this.#cameraOff = true
      if (old) {
        old.stop()
        await room.localParticipant.unpublishTrack(old, true)
      }
      this.#cameraName = name
      this.#publish()
      if (!off && name) {
        await this.#publishCamera(room)
        this.#cameraOff = false
      } else if (!off) {
        this.#publish()
        throw new Error('Choose a camera before turning it on.')
      }
    })
  }

  /** The screen picked through main (`setTalkShowMediaGrant` named the
   * source); `getDisplayMedia` answers with it once. Published at 1080p30
   * with `detail` so shared text stays crisp (S0b). */
  async startScreenShare(): Promise<void> {
    const room = this.#room
    if (!room || !this.#owns(room)) throw new Error('The room is not open.')
    const stopping = this.stopScreenShare()
    const generation = this.#screenGeneration
    await stopping
    if (!this.#owns(room) || generation !== this.#screenGeneration) return
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
    this.#screenRaw = mediaTrack
    this.#privacyEpoch = crypto.randomUUID().replaceAll('-', '')
    mediaTrack.addEventListener('ended', () => {
      if (this.#screenRaw === mediaTrack) void this.stopScreenShare()
    })
    await this.#refreshPrivateScreen()
  }

  #refreshPrivateScreen(): Promise<void> {
    const raw = this.#screenRaw
    const room = this.#room
    const generation = ++this.#privacyGeneration
    const expected: ScreenPrivacyPublication = {
      epoch: this.#privacyEpoch,
      generation,
      hidden: roomScreenPrivacy.hidden
    }
    const old = this.#screen
    this.#screen = null
    old?.stop()
    this.#privateScreen?.close()
    this.#privateScreen = null
    this.#privacy = {
      ...expected,
      sourceBlockedAt: expected.hidden ? Date.now() : null,
      status: expected.hidden ? 'hiding' : 'visible',
      observations: {}
    }
    if (this.#privacyTimer) clearTimeout(this.#privacyTimer)
    if (expected.hidden)
      this.#privacyTimer = setTimeout(() => {
        if (this.#privacy?.generation !== generation) return
        this.#privacy.status = Object.keys(this.#privacy.observations).length
          ? 'observed'
          : 'unconfirmed'
        this.#publish()
      }, 5000)
    // Tell receivers to discard cached pictures; this is not an applied acknowledgement.
    if (room)
      void room.localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(expected)), {
          reliable: true,
          topic: PRIVACY_TOPIC
        })
        .catch(() => {})
    this.#publish()
    const current = () =>
      !!raw &&
      raw === this.#screenRaw &&
      !!room &&
      this.#owns(room) &&
      generation === this.#privacyGeneration
    const next = this.#screenWork
      .catch(() => {})
      .then(async () => {
        if (old && room) await room.localParticipant.unpublishTrack(old, true).catch(() => {})
        if (!current() || !raw || !room) return
        try {
          const guarded = createPrivateScreen(raw, roomScreenPrivacy, () => {
            if (!current()) return
            this.#privacyFailed()
          })
          if (!current()) {
            guarded.close()
            return
          }
          this.#privateScreen = guarded
          guarded.track.contentHint = 'detail'
          const track = new LocalVideoTrack(guarded.track, undefined, true)
          this.#screen = track
          await room.localParticipant.publishTrack(track, {
            name: privacyTrackName(expected),
            source: Track.Source.ScreenShare,
            videoCodec: 'vp8',
            simulcast: false,
            videoEncoding: { maxBitrate: 4_000_000, maxFramerate: 30 }
          })
          if (!current()) {
            track.stop()
            await room.localParticipant.unpublishTrack(track, true).catch(() => {})
          }
        } catch {
          if (current()) this.#privacyFailed()
        }
        this.#publish()
      })
    this.#screenWork = next
    return next
  }

  #privacyFailed(): void {
    this.#screenRaw?.stop()
    this.#screenRaw = null
    this.#privateScreen?.close()
    this.#privateScreen = null
    const track = this.#screen
    this.#screen = null
    track?.stop()
    if (track) void this.#room?.localParticipant.unpublishTrack(track, true).catch(() => {})
    if (this.#privacyTimer) clearTimeout(this.#privacyTimer)
    if (this.#privacy) this.#privacy.status = 'paused'
    this.#problem =
      'Screen share paused: privacy processing is unavailable. Choose the screen again to retry.'
    this.#publish()
  }

  screenPrivacyPixels(): number[] | null {
    return this.#privateScreen?.pixels() ?? null
  }

  async stopScreenShare(): Promise<void> {
    this.#screenGeneration += 1
    ++this.#privacyGeneration
    this.#screenRaw?.stop()
    this.#screenRaw = null
    this.#privateScreen?.close()
    this.#privateScreen = null
    if (this.#privacyTimer) clearTimeout(this.#privacyTimer)
    this.#privacy = undefined
    const track = this.#screen
    this.#screen = null
    track?.stop()
    if (track) await this.#room?.localParticipant.unpublishTrack(track, true).catch(() => {})
    this.#publish()
  }

  /** Latest wins per slot and orientation. Hide cancels a pending set
   * immediately and opens its own clear stream without waiting for it. */
  async sendOverlay(
    event: CloudRoomOverlayEvent,
    image: (imageId: string, signal?: AbortSignal) => Promise<OverlayImage | null>
  ): Promise<void> {
    const room = this.#room
    // Plan 249 S5: a card coming down stops the avatar's look at once.
    if (event.slot === 'card' && event.op === 'clear') this.#acceptCard(event.orientation, null)
    if (this.#closed || !room || room.state !== ConnectionState.Connected) return
    const key = `${event.showId}:${event.slot}:${event.orientation}`
    this.#overlays.get(key)?.abort()
    const controller = new AbortController()
    this.#overlays.set(key, controller)
    let sent = false
    try {
      const result = await sendOverlay(event, {
        publisher: room.localParticipant,
        image,
        signal: controller.signal
      })
      sent = result === 'sent'
      if (!sent) console.warn('[talk-show] overlay dropped', event.slot, event.orientation)
    } catch {
      console.warn('[talk-show] overlay dropped', event.slot, event.orientation)
    } finally {
      // The output got this card (or did not): where the avatar may look.
      if (event.slot === 'card' && event.op === 'set' && this.#overlays.get(key) === controller)
        this.#acceptCard(
          event.orientation,
          sent
            ? {
                rect: { ...event.rect },
                until: event.ttlSeconds ? Date.now() + event.ttlSeconds * 1000 : null
              }
            : null
        )
      if (this.#overlays.get(key) === controller) this.#overlays.delete(key)
    }
  }

  /** The Program monitor (D7): the runner's return, subscribed on demand. */
  setMonitor(enabled: boolean): void {
    this.#monitorEnabled = enabled
    this.#applySubscriptions()
    this.#publish()
  }

  setAvatar(content: AvatarContent | null): void {
    this.#avatarContent = content
    this.#avatar?.set(this.#avatarEnabled ? content : null)
  }

  failAvatar(): void {
    this.#avatarContent = null
    if (this.#avatarEnabled) this.#avatar?.fail()
  }

  setAvatarEnabled(enabled: boolean): void {
    this.#avatarEnabled = enabled
    this.#avatar?.set(enabled ? this.#avatarContent : null)
  }

  /**
   * Plan 249 S5: animate the avatar for consumers that can. A new seed on a
   * running stream is a persona switch: the same clock continues. `null`
   * stops it; with `refused` the avatar shows still and the room says why.
   */
  setAvatarMotion(
    seed: { settings: AnimatorSettings; inputs: MotionInputs } | null,
    refused: string | null = null
  ): void {
    const previous = this.#motionSeed
    this.#motionSeed = seed
      ? {
          ...seed,
          inputs: {
            ...seed.inputs,
            avatarState: previous?.inputs.avatarState ?? seed.inputs.avatarState,
            cards: this.#currentCards()
          }
        }
      : null
    this.#motionRefused = seed ? null : refused
    this.#publishAvatar()
    if (!seed) {
      this.#stopMotion()
      return
    }
    if (this.#motion) {
      this.#motion.layout(seed.inputs.rects)
      if (previous?.inputs.atlasHash !== seed.inputs.atlasHash)
        this.#motion.pack(seed.inputs.atlasHash, seed.inputs.pack)
      if (JSON.stringify(previous?.settings) !== JSON.stringify(seed.settings))
        this.#motion.backend({ event: { kind: 'settings', settings: seed.settings } })
    } else if (this.#room && !this.#motionTimer) {
      this.#startMotion(this.#room)
    }
  }

  /**
   * Plan 249 S5 acceptance: the producer's own simulation, the local
   * reference program pages are compared with at the same tick. Public
   * cell ids only.
   */
  avatarMotionProbe(): {
    epoch: string
    tick: number
    cells: Record<MotionOrientation, string | null>
    /** Which outputs have an accepted card the avatar may look at. */
    cards: Record<MotionOrientation, boolean>
  } | null {
    const motion = this.#motion
    if (!motion) return null
    const sim = motion.sim
    return {
      epoch: motion.epoch,
      tick: sim.tick,
      cells: { h: sim.draw('h')?.cell ?? null, v: sim.draw('v')?.cell ?? null },
      cards: { h: sim.inputs.cards.h !== null, v: sim.inputs.cards.v !== null }
    }
  }

  /**
   * Plan 249 S5: the producer's own simulation for the desktop's Program
   * preview (`createAvatarView`), the poses the outputs replay a moment
   * later. Draws nothing while no stream runs or for another atlas.
   */
  readonly avatarMotionSource: AvatarMotionSource = (() => {
    const motion = () => this.#motion
    return {
      advance: () => motion()?.advance(),
      draw: (orientation: MotionOrientation, atlasHash: string) => {
        const sim = motion()?.sim
        return sim && sim.inputs.atlasHash === atlasHash ? sim.draw(orientation) : null
      },
      get sim() {
        return motion()?.sim ?? null
      }
    }
  })()

  /** `cohost.pet.animator`: the backend's public projection, nothing else. */
  avatarMotionEvent(payload: CohostPetAnimatorEvent): void {
    const seed = this.#motionSeed
    if (!seed) return
    if (payload.avatarState) seed.inputs.avatarState = payload.avatarState
    if (payload.event?.kind === 'settings') seed.settings = payload.event.settings
    this.#motion?.backend(payload)
  }

  #acceptCard(
    orientation: MotionOrientation,
    card: { rect: MotionRect; until: number | null } | null
  ): void {
    this.#cards = { ...this.#cards, [orientation]: card }
    this.#pushCards()
  }

  /** Accepted cards still up; a card past its time-to-live is gone from its output. */
  #currentCards(): Record<MotionOrientation, MotionRect | null> {
    const now = Date.now()
    const live = (card: { rect: MotionRect; until: number | null } | null) =>
      card && (card.until === null || card.until > now) ? { ...card.rect } : null
    return { h: live(this.#cards.h), v: live(this.#cards.v) }
  }

  #pushCards(): void {
    const cards = this.#currentCards()
    const key = JSON.stringify(cards)
    if (this.#motionSeed) this.#motionSeed.inputs.cards = cards
    if (!this.#motion || key === this.#cardsSent) return
    this.#cardsSent = key
    this.#motion.cards(cards)
  }

  /** What the Program preview says about animation (absent for a still avatar). */
  #animation(): RoomAvatarAnimation | undefined {
    if (this.#motionRefused) return { state: 'still', reason: this.#motionRefused }
    if (!this.#motionSeed) return undefined
    const failed = this.#motion?.status().failed ?? null
    const still = this.#avatar?.motionCoverage().still ?? 0
    return {
      state: 'animated',
      reason:
        failed ?? (still ? 'Some outputs show the avatar still. Reload them to animate it.' : null)
    }
  }

  #publishAvatar(): void {
    const avatar = this.#avatarStatus
    if (!avatar || !this.#room || !this.#owns(this.#room)) return
    const animation = this.#animation()
    this.#animationKey = JSON.stringify(animation ?? null)
    this.#snapshot = {
      ...this.#snapshot,
      avatar: { ...avatar, enabled: this.#avatarEnabled, ...(animation ? { animation } : {}) }
    }
    this.#publish()
  }

  /**
   * The producer needs the host SID, which exists only once connected, and a
   * full reconnect can change it (consumers fence on it): create lazily,
   * recreate on a new SID. Each tick also refreshes the authorized targets.
   */
  #startMotion(room: Room): void {
    this.#stopMotion()
    let sid = ''
    this.#motionTimer = setInterval(() => {
      const seed = this.#motionSeed
      if (!seed || !this.#owns(room)) return
      const current = room.localParticipant.sid
      if (!current) return
      if (!this.#motion || sid !== current) {
        this.#motion?.close()
        sid = current
        seed.inputs.cards = this.#currentCards()
        this.#cardsSent = JSON.stringify(seed.inputs.cards)
        this.#motion = new RoomAvatarMotion(
          {
            show: room.name,
            publisherSid: current,
            now: Date.now,
            send: (bytes, identities) =>
              room.localParticipant.publishData(bytes, {
                reliable: true,
                topic: AVATAR_MOTION_TOPIC,
                destinationIdentities: identities
              })
          },
          seed.settings,
          seed.inputs
        )
      }
      this.#pushCards()
      this.#motion.setConsumers(this.#avatar?.motionTargets() ?? [])
      void this.#motion.flush()
      // A delivery problem or an older output shows under the Program preview.
      if (JSON.stringify(this.#animation() ?? null) !== this.#animationKey) this.#publishAvatar()
    }, ROOM_AVATAR_MOTION_FLUSH_MS)
  }

  #stopMotion(): void {
    if (this.#motionTimer) clearInterval(this.#motionTimer)
    this.#motionTimer = null
    this.#motion?.close()
    this.#motion = null
  }

  setAvatarGuests(enabled: boolean): void {
    this.#avatarGuests = enabled
    this.#avatar?.guests(enabled)
  }

  #bind(room: Room): void {
    this.#avatar?.close()
    this.#avatarStatus = null
    this.#avatar = new RoomAvatarPublisher(room, (avatar) => {
      if (!this.#owns(room)) return
      this.#avatarStatus = avatar
      this.#publishAvatar()
    })
    this.#avatar.set(this.#avatarEnabled ? this.#avatarContent : null)
    // No timer without an animated avatar (an idle room keeps no intervals).
    if (this.#motionSeed) this.#startMotion(room)
    else this.#stopMotion()
    this.#avatar.guests(this.#avatarGuests)
    room
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        // Only server-relayed observations. A participant cannot impersonate this API.
        if (
          participant ||
          topic !== PRIVACY_ACK_TOPIC ||
          !this.#owns(room) ||
          !this.#privacy?.hidden ||
          payload.length > 2048
        )
          return
        try {
          const value: unknown = JSON.parse(new TextDecoder().decode(payload))
          if (!privacyObservationMatches(value, this.#privacy)) return
          if (
            !/^program:(wide|tall)(:recording)?$/.test(value.receiver) &&
            (!room.remoteParticipants.has(value.receiver) ||
              !value.receiverSession ||
              room.remoteParticipants.get(value.receiver)?.sid !== value.receiverSession)
          )
            return
          this.#privacy.observations[value.receiver] = value.appliedAt
          this.#privacy.status = 'observed'
          this.#publish()
        } catch {
          /* Malformed or legacy observations stay unconfirmed. */
        }
      })
      .on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
        this.#applySubscriptions()
        // A guest who just joined needs the stage (data is not replayed).
        if (!isRunnerIdentity(participant.identity) && !isRecorderIdentity(participant.identity)) {
          void this.sendStage(this.#lastStage, this.#lastScreen)
        }
        this.#publish()
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (this.#privacy) {
          delete this.#privacy.observations[participant.identity]
          if (isRecorderIdentity(participant.identity)) {
            for (const key of Object.keys(this.#privacy.observations))
              if (key.startsWith('program:')) delete this.#privacy.observations[key]
          }
          if (this.#privacy.hidden) this.#privacy.status = 'unconfirmed'
        }
        this.#publish()
      })
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
      .on(RoomEvent.Reconnecting, () => {
        if (!this.#owns(room)) return
        if ((this.#deps.pcmTestSource || this.#microphoneChoice) && this.#owns(room))
          this.#retirePcm(room)
        if (this.#privacy) {
          this.#privacy.observations = {}
          this.#privacy.status = 'unconfirmed'
        }
        this.#setState('reconnecting', 'Reconnecting to the room.')
      })
      .on(RoomEvent.Reconnected, () => {
        if (!this.#owns(room)) return
        if (this.#deps.pcmTestSource || this.#microphoneChoice) {
          const generation = this.#microphoneGeneration
          void Promise.all([this.#pcmRetiring, this.#microphoneOpening]).then(async () => {
            if (!this.#owns(room) || generation !== this.#microphoneGeneration) return
            try {
              await this.#publishMicrophone(room)
            } catch (error) {
              this.#problem = `The PCM test microphone didn't reopen: ${messageOf(error)}`
            }
            if (this.#owns(room)) this.#publish()
          })
        }
        this.#setState('connected', null)
        void this.sendStage(this.#lastStage, this.#lastScreen)
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!this.#owns(room) || reason === DisconnectReason.CLIENT_INITIATED) return
        if (
          reason === DisconnectReason.DUPLICATE_IDENTITY ||
          reason === DisconnectReason.PARTICIPANT_REMOVED ||
          reason === DisconnectReason.ROOM_DELETED
        )
          this.#localOwnershipLost = true
        // Native capture is independent of the SDK's track disposal. Retire it
        // now, before a takeover grace period or reconnect backoff can wait.
        if (this.#deps.pcmTestSource || this.#microphoneChoice) this.#retirePcm(room)
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
    return !this.#closed && !this.#localOwnershipLost && this.#room === room
  }

  async updateCameraSettings(settings: TalkShowCameraSettings | undefined): Promise<void> {
    const camera = this.#camera
    const revision = ++this.#cameraSettingsRevision
    try {
      await this.#cameraEffects?.update(settings)
      if (revision !== this.#cameraSettingsRevision || camera !== this.#camera) return
      if (!settings?.layout.cameraChromaKeyEnabled && this.#cameraEffectError) {
        this.#cameraEffectError = false
        this.#problem = null
      }
      this.#publish()
    } catch (error) {
      if (camera && this.#camera === camera) this.#cameraEffectFailed(camera, error)
    }
  }

  #cameraEffectFailed(camera: LocalVideoTrack, error: unknown): void {
    if (this.#camera !== camera) return
    this.#cameraOff = true
    this.#cameraEffectError = true
    void camera.mute().catch(() => camera.stop())
    this.#problem = `Green screen failed: ${messageOf(error)} Turn off green screen or reopen the room to retry.`
    this.#deps.report('connected', this.#problem)
    this.#publish()
  }

  async #publishCamera(room: Room): Promise<void> {
    let openedCamera: LocalVideoTrack | null = null
    let openedEffects: TalkShowCameraEffects | null = null
    try {
      const deviceId = await cameraDeviceIdFor(this.#cameraName)
      if (!deviceId) throw new Error('The selected camera is unavailable.')
      if (!this.#owns(room)) throw new Error('The room changed.')
      const camera = await createLocalVideoTrack({
        deviceId: { exact: deviceId },
        resolution: VideoPresets.h720.resolution
      })
      if (!this.#owns(room)) {
        camera.stop()
        return
      }
      openedCamera = camera
      this.#camera = camera
      this.#cameraEffectError = false
      const effects = new TalkShowCameraEffects(
        camera,
        (settings) =>
          new TalkShowKeyProcessor(settings, (error) => this.#cameraEffectFailed(camera, error))
      )
      openedEffects = effects
      this.#cameraEffects = effects
      await effects.update(this.#deps.cameraSettings?.())
      if (!this.#owns(room)) {
        camera.stop()
        return
      }
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
    } catch (error) {
      openedEffects?.close()
      openedCamera?.stop()
      if (this.#camera === openedCamera) {
        this.#cameraEffects = null
        this.#camera = null
      }
      this.#cameraOff = true
      this.#publish()
      throw error
    }
  }

  async #publishLocal(): Promise<void> {
    const room = this.#room
    if (!room) return
    if (!this.#owns(room)) return
    const problems: string[] = []
    if (this.#cameraName && !this.#cameraOff) {
      try {
        await this.#publishCamera(room)
      } catch (error) {
        problems.push(`The camera didn't open: ${messageOf(error)}`)
      }
    }
    if (!this.#owns(room)) return
    try {
      await this.#publishMicrophone(room)
    } catch (error) {
      problems.push(`The microphone didn't open: ${messageOf(error)}`)
    }
    if (!this.#owns(room)) return
    this.#problem = problems.length
      ? problems.join(' ')
      : this.#cameraEffectError
        ? this.#problem
        : null
    if (this.#problem) this.#deps.report('connected', this.#problem)
  }

  #publishMicrophone(room: Room): Promise<void> {
    const opening = this.#microphoneOpening.then(() =>
      this.#owns(room) ? this.#openMicrophone(room) : undefined
    )
    this.#microphoneOpening = opening.catch(() => {})
    return opening
  }

  async #openMicrophone(room: Room): Promise<void> {
    if (this.#microphoneCleanupFailed)
      throw new Error(
        'Microphone cleanup is unconfirmed. Close the room before opening another owner.'
      )
    if (!this.#deps.microphoneName && !this.#deps.pcmTestSource) return
    const generation = ++this.#microphoneGeneration
    const current = (): boolean => this.#owns(room) && this.#microphoneGeneration === generation
    try {
      let microphone: LocalAudioTrack
      if (this.#deps.pcmTestSource) {
        if (!import.meta.env.DEV || !room.localParticipant.identity.startsWith('host:'))
          throw new Error('PCM test source requires a development host room.')
        const controller = new AbortController()
        this.#pcmAbort = controller
        const source = await createRoomPcmTestSource(
          window.videorc.roomPcmTest,
          controller.signal,
          this.#deps.onPcmDiagnostic,
          (reason) => {
            if (!current()) return
            this.#retirePcm(room)
            this.#micMuted = true
            this.#problem = reason
            this.#publish()
            this.#deps.report('connected', reason)
          }
        )
        if (!current() || controller.signal.aborted) {
          source.close()
          return
        }
        this.#pcmSource = source
        microphone = new LocalAudioTrack(source.track)
      } else if (this.#microphoneChoice) {
        if (!this.#microphoneChoice.deviceId || !this.#microphoneChoice.name) return
        const controller = new AbortController()
        this.#pcmAbort = controller
        const source = await createRoomMicrophoneSource(
          this.#microphoneChoice,
          room.localParticipant.identity.replace(/^host:/, ''),
          controller.signal,
          microphoneDeviceIdFor,
          (reason) => {
            if (!current()) return
            this.#retirePcm(room)
            this.#micMuted = true
            this.#problem = reason
            this.#publish()
            this.#deps.report('connected', reason)
          },
          this.#deps.onPcmDiagnostic
        )
        if (!current()) {
          await source.close()
          return
        }
        this.#processedMicrophone = source
        microphone = new LocalAudioTrack(source.track)
      } else {
        const deviceId = await microphoneDeviceIdFor(this.#deps.microphoneName!)
        if (!current()) return
        if (!deviceId) throw new Error('The selected microphone is unavailable.')
        microphone = await createLocalAudioTrack({
          deviceId: { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false
        })
      }
      if (!current()) {
        microphone.stop()
        return
      }
      this.#microphone = microphone
      if (this.#micMuted) await microphone.mute()
      if (!current()) {
        microphone.stop()
        return
      }
      await room.localParticipant.publishTrack(microphone, {
        source: Track.Source.Microphone
      })
      if (current()) this.#processedMicrophone?.published()
      if (!current()) {
        microphone.stop()
        await room.localParticipant.unpublishTrack(microphone, true).catch(() => {})
        return
      }
    } catch (error) {
      if (!current()) return
      this.#pcmAbort?.abort()
      this.#pcmSource?.close()
      this.#pcmSource = null
      await this.#processedMicrophone?.close()
      this.#processedMicrophone = null
      this.#microphone?.stop()
      this.#microphone = null
      this.#micMuted = true
      throw error
    }
  }

  #retirePcm(room: Room): void {
    ++this.#microphoneGeneration
    this.#pcmAbort?.abort()
    this.#pcmAbort = null
    const processed = this.#processedMicrophone?.close()
    this.#processedMicrophone = null
    const closing = this.#pcmSource?.close()
    this.#pcmSource = null
    const track = this.#microphone
    this.#microphone = null
    track?.stop()
    this.#pcmRetiring = Promise.allSettled([this.#pcmRetiring, closing, processed])
      .then(async (settled) => {
        if (processed && settled.some((result) => result.status === 'rejected'))
          this.#microphoneCleanupFailed = true
        if (track) await room.localParticipant.unpublishTrack(track, true)
      })
      .catch(() => {
        if (processed) this.#microphoneCleanupFailed = true
      })
  }

  async #stopLocal(): Promise<void> {
    ++this.#microphoneGeneration
    this.#pcmAbort?.abort()
    this.#pcmAbort = null
    const closingProcessed = this.#processedMicrophone?.close()
    this.#processedMicrophone = null
    const closingPcm = this.#pcmSource?.close()
    this.#pcmSource = null
    const room = this.#room
    ++this.#screenGeneration
    ++this.#privacyGeneration
    this.#screenRaw?.stop()
    this.#screenRaw = null
    this.#privateScreen?.close()
    this.#privateScreen = null
    this.#privacy = undefined
    const tracks = [this.#camera, this.#microphone, this.#screen].filter(
      (track): track is LocalVideoTrack | LocalAudioTrack => track !== null
    )
    this.#cameraEffects?.close()
    this.#cameraEffects = null
    this.#camera = null
    this.#microphone = null
    this.#screen = null
    // Stop capture synchronously, before waiting for any network unpublish.
    for (const track of tracks) track.stop()
    const settled = await Promise.allSettled([closingPcm, closingProcessed, this.#pcmRetiring])
    if (settled.some((result) => result.status === 'rejected')) this.#microphoneCleanupFailed = true
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
    if (reason === DisconnectReason.DUPLICATE_IDENTITY) {
      void this.#duplicateHost()
      return
    }
    const terminal =
      reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.PARTICIPANT_REMOVED
    if (terminal || attempt >= RECONNECT_BACKOFF_MS.length) {
      this.#setState('disconnected', ROOM_LOST_DETAIL)
      return
    }
    this.#reconnectAttempt = attempt + 1
    this.#setState('reconnecting', 'Reconnecting to the room.')
    this.#reconnectTimer = window.setTimeout(() => {
      void this.#reconnect()
    }, RECONNECT_BACKOFF_MS[attempt])
  }

  /**
   * Plan 243 C5: LiveKit drops this connection when another one joins as
   * `host:<showId>`, which is how a phone or another computer takes the host
   * seat. Another device on air now, or within `TAKEN_OVER_GRACE_MS`, is a
   * take-over (the backend stops this computer; the toast names the device).
   * Otherwise the room is lost, as before. Never a rejoin: that would take
   * the seat back.
   */
  async #duplicateHost(): Promise<void> {
    for (
      let waited = 0;
      waited < TAKEN_OVER_GRACE_MS && !onAirElsewhere(this.#deps.onAir?.());
      waited += TAKEN_OVER_POLL_MS
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, TAKEN_OVER_POLL_MS))
      if (this.#closed) return
    }
    const takenOver = onAirElsewhere(this.#deps.onAir?.())
    this.#setState('disconnected', takenOver ? TAKEN_OVER_DETAIL : ROOM_LOST_DETAIL)
  }

  async #reconnect(): Promise<void> {
    if (this.#closed) return
    const stale = this.#room
    this.#avatar?.close()
    this.#avatar = null
    this.#stopMotion()
    this.#room = null
    if (stale) await stale.disconnect().catch(() => {})
    await this.#stopLocal()
    if (this.#closed) return
    try {
      // A fresh token: the old one may be past its 10 minutes.
      const token = await this.#deps.requestToken()
      if (this.#closed) return
      const room = new Room(talkShowRoomOptions())
      this.#room = room
      this.#bind(room)
      const auxiliaryEnabled = this.#aux?.enabled ?? false
      this.#aux?.close()
      this.#aux = new RoomAuxPublisher(room, auxiliaryEnabled)
      await room.connect(token.url, token.hostToken, { autoSubscribe: false })
      if (!this.#owns(room)) {
        await room.disconnect()
        return
      }
      this.#reconnectAttempt = 0
      await this.#publishLocal()
      if (!this.#owns(room)) return
      this.#setState('connected', null, token.identity)
      if (!this.#owns(room)) return
      this.#applySubscriptions()
      await this.sendStage(this.#lastStage, this.#lastScreen)
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
    if (this.#microphone) this.#micMuted = this.#microphone.isMuted ?? this.#micMuted
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
      screenPrivacy: this.#privacy
        ? { ...this.#privacy, observations: { ...this.#privacy.observations } }
        : undefined,
      local: {
        camera: this.#camera?.mediaStreamTrack ?? null,
        microphone: this.#microphone?.mediaStreamTrack ?? null,
        screen: this.#screen?.mediaStreamTrack ?? null,
        micMuted: this.#microphone?.isMuted ?? this.#micMuted,
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
