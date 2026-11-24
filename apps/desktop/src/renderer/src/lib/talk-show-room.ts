import type { BackendClient } from '@/backendClient'
import type { HostSpeechTap } from './room-speech-source'
import type { GuestSpeechTap } from './room-guest-speech'
// Guest captions ride the lazily loaded room chunk, never the eager bundle.
export { attachGuestSpeech } from './room-guest-speech'
import {
  createRoomMicrophoneSource,
  microphoneRequiresReplacement,
  type RoomMicrophoneChoice,
  type RoomMicrophoneSource
} from './room-microphone-source'
import {
  RoomGraphicsPublisher,
  roomGraphicsContent,
  type AcceptedGraphicsView,
  type GraphicsContent,
  type RoomGraphicsStatus
} from './room-graphics-publisher'
import {
  RoomHtmlLayerPublisher,
  type RoomHtmlLayerDeps,
  type RoomHtmlLayerStatus
} from './room-html-layer-publisher'
import { RoomAuxPublisher } from './room-aux-publisher'
import { createRoomPcmTestSource, type RoomPcmSource } from './room-pcm-source'
import { createRoomFrameTestSource, type RoomFrameSource } from './room-frame-source'
import type { EncodeObserver } from './room-frame-encode-observer'
import { roomFrameEncodeObserverEnabled } from './room-frame-test-state'
import {
  CAMERA_FRAME_CONTRACT,
  ROOM_FRAME,
  bindCameraFramePublication,
  cameraFrameTrackName,
  publishSourceNames,
  type CameraFrameAuthority,
  type CameraRoleFrameDescriptor,
  type RoomFrameSize
} from '../../../shared/room-frame'
import {
  RoomAvatarPublisher,
  type AcceptedAvatarView,
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
import { pickRoomCameraDevice } from '../../../shared/room-program-camera'
import { matchStrictAudioInput } from './mic-device-label'
import type { AnimatorSettings } from '../../../shared/buddy-animator'
import type { CohostPetAnimatorEvent } from '../../../shared/buddy-animator-public'
import {
  RoomScenePublisher,
  type RoomSceneCommit,
  type PreparedBackgroundAsset,
  type RoomSceneStatus,
  type SceneContent
} from './room-scene-publisher'
import { createPrivateScreen } from './room-private-screen'
import {
  roomScreenPrivacy,
  privacyTrackName,
  privacyObservationMatches,
  PRIVACY_ACK_TOPIC,
  PRIVACY_TOPIC,
  type ScreenPrivacyPublication
} from './room-screen-privacy'
import { hiddenStillUrl } from './hidden-still'
import { RoomLatencyHost } from './room-latency-host'
import { roomLatencyReport } from './room-latency-report'
import {
  LATENCY_TOPIC,
  type ConversationDelay,
  type NetStatsTrack,
  type NetTrack,
  type ProgramDelay,
  type RoomLatency
} from '../../../shared/room-latency'
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
  cameraBackgroundIsEffect,
  ROOM_CAMERA_OFF_FOR_BACKGROUND
} from '@/lib/camera-background-view'
import type { CameraBackground } from '@/lib/backend'

/** A switched-to camera's own background (null: none); undefined: read the settings. */
type OpeningBackground = Pick<CameraBackground, 'mode'> | null | undefined
import {
  RemoteAudioAttachments,
  guestCaptionTracks,
  isRecorderIdentity,
  isRunnerIdentity,
  type GuestMicrophone
} from '@/lib/talk-show-room-audio'

export { isRunnerIdentity } from '@/lib/talk-show-room-audio'

/** The data topic the guest page listens on (`guest-wire.ts`, `STAGE_TOPIC`). */
export const STAGE_TOPIC = 'videorc.stage'
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]
/** The Show stage's hidden still is drawn at most this tall; the stage scales it. */
const STAGE_STILL_ROWS = 720
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
  /**
   * Plan 253 S4: this guest's conversation delay on a managed show, from
   * both ends' reports. Absent with no report yet, and once one is 25 s old.
   */
  latency?: ConversationDelay
}

export type TalkShowLocalMedia = {
  camera: MediaStreamTrack | null
  microphone: MediaStreamTrack | null
  screen: MediaStreamTrack | null
  micMuted: boolean
  cameraOff: boolean
  /**
   * Plan 258 S5: the camera is off only because a background effect holds it
   * out of the room (before S8). Not the streamer's Off: never stored as it.
   */
  cameraHeld?: boolean
  /** Why the camera or the mic did not open, one sentence; null when both did. */
  problem: string | null
  /** Plan 253 S4: LiveKit's own quality of the host's connection. */
  quality?: CloudRoomQuality
  /** Plan 253 S4: the host's round trip to the room, while it is measured. */
  rttMs?: number
  /**
   * Plan 249 S13a: the camera-frame test publication, bound to the SFU's own
   * participant/track SIDs from the publish result. Absent otherwise.
   */
  cameraFrame?: { authority: CameraFrameAuthority; descriptor: CameraRoleFrameDescriptor }
  /**
   * Plan 249 S14: the capturer source the room shares (`screen:<id>:0` or
   * `window:<id>:0`), null when none or unknown. A scene or Follow switch
   * compares against it.
   */
  screenSourceId?: string | null
  /**
   * Hide screen in a room: while the screen is hidden, the designed hidden
   * still at the screen's size (a PNG data URL, hidden-still.ts), drawn over
   * the host's screen as guests and the program draw it. Absent while visible.
   */
  screenStill?: string
}

export type TalkShowMonitor = {
  enabled: boolean
  video: MediaStreamTrack | null
  audio: MediaStreamTrack | null
  /** Plan 260 S1.8d d5: the backend's room plays the return itself (no
   * track here); Listen goes through `setMonitorListening`. */
  backendAudio?: boolean
}

export type TalkShowRoomSnapshot = {
  state: CloudRoomClientState
  detail: string | null
  /** `host:<showId>` once connected. */
  identity: string | null
  people: TalkShowPerson[]
  local: TalkShowLocalMedia
  monitor: TalkShowMonitor
  graphics?: RoomGraphicsStatus
  avatar?: RoomAvatarStatus
  /** Plan 249 S12: the scene the program draws, and each output's rendered revision. */
  scene?: RoomSceneStatus
  /**
   * Plan 253 S4: the program delay on a managed show (the host's camera to
   * the program page having drawn it). Absent without the page's report.
   */
  program?: ProgramDelay
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
  attachHostSpeech?: (
    track: MediaStreamTrack,
    showId: string,
    muted: boolean,
    current: () => boolean
  ) => HostSpeechTap
  /**
   * Guest captions: the mix of the on-stage guests' microphones for the
   * backend's captions-only guest stream. Host rooms only.
   */
  attachGuestSpeech?: (
    showId: string,
    current: () => boolean,
    onCaptioning: (captioning: boolean) => void
  ) => GuestSpeechTap
  /** S7a explicit dev fixture; not inferred from media-v2 or exposed as production mode. */
  pcmTestSource?: boolean
  onPcmDiagnostic?: (value: unknown) => void
  /** S13a explicit dev fixture: the native camera-role frame bridge is the ONLY
   * camera producer; no browser camera, no browser key/effects (no double key). */
  frameTestSource?: boolean
  /**
   * Plan 249 S13b: the native camera owner publishes its processed frames
   * (key, despill, look applied once natively). Set only when main reports
   * the processed camera enabled; the backend then keeps the camera, so the
   * browser never opens it. Unqualified and development-only.
   */
  processedCamera?: boolean
  onFrameDiagnostic?: (value: unknown) => void
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
   * Plan 253 S4 (D10): true on a managed show. Only then is latency
   * measured; a node show's room samples nothing and shows no number.
   */
  measureLatency?: () => boolean
  /**
   * Plan 253 S7: the backend, which keeps the show's latency record
   * (`cloud.room.latency.report` after each 10 s sample). Without it
   * nothing is reported and the numbers stay in this window.
   */
  backend?: Pick<BackendClient, 'requestTyped'> | null
  /**
   * Plan 243 C5: the device on air, from the latest `cloud.state`, so a
   * second host connection that drops this one reads as taken over.
   */
  onAir?: () => CloudOnAir | undefined
  /** Plan 249 S24: an avatar output view a program page applied, to be kept. */
  onAvatarAccepted?: (view: AcceptedAvatarView) => void
  /** Plan 249 S24: a static output view a program page applied, to be kept. */
  onGraphicsAccepted?: (view: AcceptedGraphicsView) => void
  /**
   * Plan 249 S24: true after this computer took the show over, until the
   * streamer turns the camera and microphone on. A Sources pick never opens
   * capture meanwhile; turning things off stays allowed.
   */
  sourcesHeld?: () => boolean
  /**
   * Plan 249 S11: HTML banners as packed sheets for the egress pages the web
   * lets draw them (default-off: in production none ever asks).
   */
  htmlLayers?: Pick<RoomHtmlLayerDeps, 'frameUrl' | 'want' | 'controllerEpoch'> & {
    changed?: (status: RoomHtmlLayerStatus) => void
  }
}

const SOURCES_HELD =
  'This computer took the show over. Turn the camera and microphone on in the notice first.'

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
/** Plan 251: with two screens up, `screens` names both and `screen` stays the
 * first, which is all an older guest page reads. */
export function stageMessage(
  onStage: readonly string[],
  screen: string | null | readonly string[] = null,
  /** Guest captions: the on-stage guests are being captioned right now. */
  captions = false
): Uint8Array<ArrayBuffer> {
  const named = [...new Set(typeof screen === 'string' ? [screen] : (screen ?? []))]
    .filter((identity) => onStage.includes(identity))
    .slice(0, 2)
  return new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      onStage: [...onStage],
      screen: named[0] ?? null,
      ...(named.length === 2 ? { screens: named } : {}),
      // The guest page's "Live captions are on" line (web guest-wire.ts).
      ...(captions ? { captions: true } : {})
    })
  )
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

/**
 * A Chromium device id for the Sources camera, by its plain name. Never
 * Videorc Camera (plan 249 S23): with the room program on it, the room would
 * film itself.
 */
export async function cameraDeviceIdFor(cameraName: string | null): Promise<string | undefined> {
  if (!cameraName) return undefined
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const inputs = devices
    .filter((device) => device.kind === 'videoinput')
    .map((device) => ({ deviceId: device.deviceId, label: device.label }))
  return pickRoomCameraDevice(inputs, cameraName)
}

export async function microphoneDeviceIdFor(
  microphoneName: string | null
): Promise<string | undefined> {
  if (!microphoneName) return undefined
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const inputs = devices
    .filter((device) => device.kind === 'audioinput')
    .map((device) => ({ deviceId: device.deviceId, label: device.label }))
  // Chromium decorates the label ("Shure MV7+ (14ed:1019)", "… (Built-in)");
  // the plan 080 matcher strips that and never picks the OS default entry.
  const match = matchStrictAudioInput(microphoneName, inputs)
  return 'deviceId' in match ? match.deviceId : undefined
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
  #lastScreen: string | null | readonly string[] = null
  #monitorEnabled = false
  #micMuted = false
  #cameraOff = false
  #cameraName: string | null
  #controls: Promise<void> = Promise.resolve()
  #camera: LocalVideoTrack | null = null
  #cameraEffects: TalkShowCameraEffects | null = null
  #cameraEffectError = false
  /**
   * Plan 258 S5, before S8: the camera's background is an effect the room
   * can't apply yet, so the room publishes no camera (fail closed) and says
   * why on the Show stage. Off, or a screen key, lets it publish again.
   */
  #backgroundBlocked = false
  /** Whether the streamer wants the camera on in the room (it comes back on unblock). */
  #cameraWanted = false
  /** The effect went off while the room was still connecting: open the camera once it is. */
  #cameraRestorePending = false
  /** Bumps on every camera settings update: a queued switch sees what arrived after it. */
  #settingsEpoch = 0
  #cameraSettingsRevision = 0
  #microphone: LocalAudioTrack | null = null
  #pcmSource: RoomPcmSource | null = null
  #pcmAbort: AbortController | null = null
  #pcmRetiring: Promise<unknown> = Promise.resolve()
  #frameSource: RoomFrameSource | null = null
  /** S13a harness only: the one encoded-output observer of the bridge camera. */
  #encodeObserver: EncodeObserver | null = null
  #frameAbort: AbortController | null = null
  #frameGeneration = 0
  #frameRetiring: Promise<unknown> = Promise.resolve()
  #cameraFrame: { authority: CameraFrameAuthority; descriptor: CameraRoleFrameDescriptor } | null =
    null
  /** One camera-frame epoch per room connection: a new room is a new epoch. */
  #cameraFrameEpochs = new WeakMap<Room, string>()
  #processedMicrophone: RoomMicrophoneSource | null = null
  #microphoneChoice: RoomMicrophoneChoice | undefined
  #microphoneOpening: Promise<void> = Promise.resolve()
  #microphoneCleanupFailed = false
  #speech: HostSpeechTap | null = null
  #guestSpeech: GuestSpeechTap | null = null
  #guestCaptioning = false
  #microphoneGeneration = 0
  #screen: LocalVideoTrack | null = null
  #screenGeneration = 0
  #screenRaw: MediaStreamTrack | null = null
  /** Plan 249 S14: which capturer source `#screenRaw` captures. */
  #screenSourceId: string | null = null
  #privateScreen: ReturnType<typeof createPrivateScreen> | null = null
  #privacyOff: (() => void) | null = null
  #privacyTimer: ReturnType<typeof setTimeout> | null = null
  #privacy: TalkShowRoomSnapshot['screenPrivacy']
  #privacyEpoch = crypto.randomUUID().replaceAll('-', '')
  #privacyGeneration = 0
  /** The hidden screen's still (`TalkShowLocalMedia.screenStill`). */
  #screenStill: string | null = null
  /** Bumped when a still is started or dropped: a late still is ignored. */
  #stillToken = 0
  #screenWork: Promise<void> = Promise.resolve()
  #speaking = new Set<string>()
  /** Remote voices playing through the audio host; never the runner's return (H1). */
  readonly #audio: RemoteAudioAttachments<HTMLMediaElement>
  #snapshot: TalkShowRoomSnapshot = IDLE_TALK_SHOW_ROOM
  #problem: string | null = null
  #graphics: RoomGraphicsPublisher | null = null
  /** Plan 249 S11: the HTML layer sheet publisher, with the graphics one. */
  #htmlLayers: RoomHtmlLayerPublisher | null = null
  #graphicsContent: GraphicsContent | null = null
  #graphicsEnabled = false
  #avatar: RoomAvatarPublisher | null = null
  #avatarContent: AvatarContent | null = null
  /**
   * On in every new room: the avatar's own switches ("on stream", Show in
   * recording) already chose its outputs, and `AvatarContent` carries them.
   * Off was the default until 0.35.0, so on a managed show those switches did
   * nothing until a second one in Guests → Room was found (the owner,
   * 2026-11-20). The Guests → Room switch still hides it for this room.
   */
  #avatarEnabled = true
  /** Plan 249 S5: the avatar's motion stream, per bound room. */
  #motion: RoomAvatarMotion | null = null
  #motionTimer: ReturnType<typeof setInterval> | null = null
  /** Plan 253 S4: this room's latency, joined from three reports. */
  readonly #latency: RoomLatencyHost
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
  #scene: RoomScenePublisher | null = null
  /** The scene the program should draw; re-sent after a reconnect. */
  #sceneContent: SceneContent | null = null
  /** Plan 249 S14: the background pictures the scene names, re-sent after a reconnect. */
  #sceneAssets: readonly PreparedBackgroundAsset[] = []
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
    this.#cameraOff =
      deps.initiallyCameraOff === true ||
      (!deps.cameraName && !deps.frameTestSource && !deps.processedCamera)
    this.#cameraWanted = !this.#cameraOff
    this.#audio = new RemoteAudioAttachments<HTMLMediaElement>(() => deps.audioHost())
    this.#latency = new RoomLatencyHost({
      changed: () => this.#publish(),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      enabled: () => deps.measureLatency?.() === true,
      now: () => performance.now(),
      sampled: (latency) => this.#reportLatency(latency),
      setInterval: (run, everyMs) => window.setInterval(run, everyMs),
      setTimeout: (run, afterMs) => window.setTimeout(run, afterMs)
    })
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
    this.#latency.stop()
    this.#aux?.close()
    this.#aux = null
    this.#graphics?.close()
    this.#graphics = null
    void this.#htmlLayers?.close()
    this.#htmlLayers = null
    this.#avatar?.close()
    this.#avatar = null
    this.#graphicsContent = null
    this.#avatarContent = null
    this.#stopMotion()
    this.#motionSeed = null
    this.#motionRefused = null
    this.#cards = { h: null, v: null }
    this.#scene?.close()
    this.#scene = null
    this.#sceneContent = null
    this.#sceneAssets = []
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
  async sendStage(
    onStage: readonly string[],
    screen: string | null | readonly string[] = null
  ): Promise<void> {
    this.#lastStage = [...onStage]
    this.#lastScreen = screen
    const room = this.#room
    // Who is on stage decides whose voice is captioned.
    this.#feedGuestSpeech(room)
    if (!room || room.state !== ConnectionState.Connected) return
    try {
      await room.localParticipant.publishData(
        stageMessage(onStage, screen, this.#guestCaptioning),
        {
          reliable: true,
          topic: STAGE_TOPIC
        }
      )
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
    if (deviceId && name && this.#deps.sourcesHeld?.())
      return Promise.reject(new Error(SOURCES_HELD))
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
        if (choice.muted) await this.#speech?.setMuted(true)
        this.#processedMicrophone?.update(choice)
        if (choice.muted) await this.#microphone?.mute()
        else {
          await this.#microphone?.unmute()
          await this.#speech?.setMuted(false)
        }
      }
    })
  }

  setMicrophoneMuted(muted: boolean): Promise<void> {
    return this.setMicrophoneMode(muted ? 'mute' : 'unmute')
  }

  setMicrophoneMode(mode: 'mute' | 'unmute' | 'toggle'): Promise<void> {
    return this.#control(async (room) => {
      const muted = mode === 'toggle' ? !this.#micMuted : mode === 'mute'
      if (muted) await this.#speech?.setMuted(true)
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
      if (!muted) await this.#speech?.setMuted(false)
    })
  }

  setCameraOff(off: boolean): Promise<void> {
    return this.setCameraSelection(this.#cameraName, off)
  }

  setCameraSelection(
    name: string | null,
    off: boolean,
    background?: Pick<CameraBackground, 'mode'> | null
  ): Promise<void> {
    if (!off && name && this.#deps.sourcesHeld?.()) return Promise.reject(new Error(SOURCES_HELD))
    this.#cameraWanted = !off
    const since = this.#settingsEpoch
    return this.#control(async (room) => {
      // Each queued switch opens its camera with its own camera's background;
      // a camera with none is not held for the previous camera's effect,
      // unless an effect arrived after the switch was queued.
      if (background !== undefined) {
        if (!this.#openingBackgroundIsEffect(background, since) && this.#backgroundBlocked) {
          this.#backgroundBlocked = false
          if (this.#problem === ROOM_CAMERA_OFF_FOR_BACKGROUND) this.#problem = null
        }
      }
      // Release capture, not just its publication, for None/off.
      this.#cameraEffects?.close()
      this.#cameraEffects = null
      ++this.#frameGeneration
      this.#cameraFrame = null
      this.#frameAbort?.abort()
      this.#frameAbort = null
      const closingObserver = this.#detachEncodeObserver()
      const closingFrame = this.#frameSource?.close()
      this.#frameSource = null
      const old = this.#camera
      this.#camera = null
      this.#cameraOff = true
      if (old) {
        old.stop()
        await room.localParticipant.unpublishTrack(old, true)
      }
      await Promise.all([closingObserver, closingFrame, this.#frameRetiring])
      this.#cameraName = name
      this.#publish()
      if (!off && (name || this.#nativeCamera())) {
        await this.#publishCamera(room, background, since)
        // A camera the background effect keeps out of the room stays off.
        this.#cameraOff = this.#backgroundBlocked
        this.#publish()
      } else if (!off) {
        this.#publish()
        throw new Error('Choose a camera before turning it on.')
      }
    })
  }

  /** The screen picked through main (`setTalkShowMediaGrant` named the
   * source); `getDisplayMedia` answers with it once. Published at 1080p30
   * with `detail` so shared text stays crisp (S0b). */
  async startScreenShare(sourceId?: string): Promise<void> {
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
    this.#screenSourceId = sourceId ?? null
    this.#privacyEpoch = crypto.randomUUID().replaceAll('-', '')
    mediaTrack.addEventListener('ended', () => {
      if (this.#screenRaw === mediaTrack) void this.stopScreenShare()
    })
    await this.#refreshPrivateScreen()
  }

  /**
   * Plan 249 S14: share another screen or window (a scene or Follow switch),
   * transactionally. The new capture opens BEFORE the old one stops, so a
   * refused or vanished source leaves the current share as it was and the
   * caller refuses the switch. The new capture goes through the same S2
   * privacy gate as any share: a hidden screen stays hidden (a new epoch and
   * publication, frosted), and nothing raw is published in between. The
   * caller has named `sourceId` to main (`setTalkShowMediaGrant`) first.
   */
  async replaceScreenSource(sourceId: string): Promise<void> {
    const room = this.#room
    if (!room || !this.#owns(room)) throw new Error('The room is not open.')
    if (this.#screenRaw && this.#screenSourceId === sourceId) return
    const generation = ++this.#screenGeneration
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false
    })
    const [mediaTrack] = stream.getVideoTracks()
    if (!this.#owns(room) || generation !== this.#screenGeneration || !mediaTrack) {
      stream.getTracks().forEach((track) => track.stop())
      if (!mediaTrack) throw new Error('No screen was shared.')
      return
    }
    const old = this.#screenRaw
    this.#screenRaw = mediaTrack
    this.#screenSourceId = sourceId
    this.#privacyEpoch = crypto.randomUUID().replaceAll('-', '')
    old?.stop()
    mediaTrack.addEventListener('ended', () => {
      if (this.#screenRaw === mediaTrack) void this.stopScreenShare()
    })
    await this.#refreshPrivateScreen()
  }

  get screenSourceId(): string | null {
    return this.#screenRaw ? this.#screenSourceId : null
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
    // Shown again: the live picture replaces the still. Hidden: the still,
    // drawn once per hide, kept for a new screen while hidden, as guests and
    // the program keep theirs.
    if (!expected.hidden) this.#dropScreenStill()
    else if (!this.#screenStill) this.#keepScreenStill(raw)
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

  /**
   * Hide screen in a room: the host's own look of the hidden screen, the
   * designed still guests and the program draw, at the screen's size. It
   * never reads the screen. Drawn after the hide, never inside it; nothing
   * here is published: the wire keeps its neutral grey.
   */
  #keepScreenStill(raw: MediaStreamTrack | null): void {
    const token = ++this.#stillToken
    const settings = raw?.getSettings?.() ?? {}
    setTimeout(() => {
      if (token !== this.#stillToken || this.#closed) return
      this.#screenStill = hiddenStillUrl(
        document,
        settings.width ?? 0,
        settings.height ?? 0,
        STAGE_STILL_ROWS
      )
      this.#publish()
    }, 0)
  }

  #dropScreenStill(): void {
    ++this.#stillToken
    this.#screenStill = null
  }

  #privacyFailed(): void {
    this.#dropScreenStill()
    this.#screenRaw?.stop()
    this.#screenRaw = null
    this.#screenSourceId = null
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
    this.#dropScreenStill()
    this.#screenRaw?.stop()
    this.#screenRaw = null
    this.#screenSourceId = null
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

  // Captions and the comment card go out with the switch off too
  // (`roomGraphicsContent`); banners, timers and the chat box wait for it.
  setGraphics(content: GraphicsContent | null): void {
    this.#graphicsContent = content
    this.#graphics?.set(roomGraphicsContent(content, this.#graphicsEnabled))
    this.#htmlLayers?.setPlacements(this.#graphicsEnabled ? (content?.html ?? null) : null)
  }
  failGraphics(): void {
    this.#graphicsContent = null
    if (this.#graphicsEnabled) this.#graphics?.fail()
    else this.#graphics?.set(null)
    this.#htmlLayers?.setPlacements(null)
  }
  setGraphicsEnabled(enabled: boolean): void {
    this.#graphicsEnabled = enabled
    this.#graphics?.set(roomGraphicsContent(this.#graphicsContent, enabled))
    this.#htmlLayers?.setPlacements(enabled ? (this.#graphicsContent?.html ?? null) : null)
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

  /**
   * Plan 249 S12: what the program draws, committed atomically per lane.
   * Answers with each egress lane's rendered revision, `preview` before any
   * egress runs, or why it is not confirmed.
   */
  commitScene(
    content: SceneContent | null,
    assets: readonly PreparedBackgroundAsset[] = []
  ): Promise<RoomSceneCommit> {
    this.#sceneContent = content
    this.#sceneAssets = content ? assets : []
    this.#scene?.setAssets(this.#sceneAssets)
    if (!this.#scene || this.#closed)
      return Promise.resolve({
        state: 'failed',
        reason: 'The room is not connected.',
        observed: {}
      })
    return this.#scene.commit(content)
  }

  get sceneContent(): SceneContent | null {
    return this.#sceneContent
  }

  #bindScene(room: Room): void {
    this.#scene?.close()
    this.#scene = new RoomScenePublisher(room, (scene) => {
      if (!this.#owns(room)) return
      this.#snapshot = { ...this.#snapshot, scene }
      this.#publish()
    })
    // A new connection is a new publisher SID: the program drops the old
    // owner's scene and takes this one, as a cut (no replayed motion).
    this.#scene.setAssets(this.#sceneAssets)
    if (this.#sceneContent)
      void this.#scene.commit({
        ...this.#sceneContent,
        transition: { kind: 'cut', durationMs: 0 }
      })
  }

  #bind(room: Room): void {
    this.#graphics?.close()
    this.#graphics = new RoomGraphicsPublisher(
      room,
      (graphics) => {
        if (!this.#owns(room)) return
        this.#snapshot = {
          ...this.#snapshot,
          graphics: { ...graphics, enabled: this.#graphicsEnabled }
        }
        this.#publish()
      },
      // Plan 249 S24: a static view a program page applied, for the cloud.
      (view) => {
        if (this.#owns(room)) this.#deps.onGraphicsAccepted?.(view)
      }
    )
    this.#graphics.set(roomGraphicsContent(this.#graphicsContent, this.#graphicsEnabled))
    // Plan 249 S11: bound to this room; any ownership loss closes it.
    void this.#htmlLayers?.close()
    this.#htmlLayers = null
    const html = this.#deps.htmlLayers
    if (html) {
      this.#htmlLayers = new RoomHtmlLayerPublisher(room, {
        frameUrl: html.frameUrl,
        want: html.want,
        controllerEpoch: () => (this.#owns(room) ? html.controllerEpoch() : null),
        changed: (status) => {
          if (this.#owns(room)) html.changed?.(status)
        }
      })
      this.#htmlLayers.setPlacements(
        this.#graphicsEnabled ? (this.#graphicsContent?.html ?? null) : null
      )
    }
    this.#avatar?.close()
    this.#avatarStatus = null
    this.#avatar = new RoomAvatarPublisher(
      room,
      (avatar) => {
        if (!this.#owns(room)) return
        this.#avatarStatus = avatar
        this.#publishAvatar()
      },
      // Plan 249 S24: a view a program page applied, for the cloud to keep.
      (view) => {
        if (this.#owns(room)) this.#deps.onAvatarAccepted?.(view)
      }
    )
    this.#avatar.set(this.#avatarEnabled ? this.#avatarContent : null)
    // No timer without an animated avatar (an idle room keeps no intervals).
    if (this.#motionSeed) this.#startMotion(room)
    else this.#stopMotion()
    this.#avatar.guests(this.#avatarGuests)
    this.#bindScene(room)
    this.#latency.start({
      hostIdentity: () => (this.#owns(room) ? this.#snapshot.identity : null),
      present: (identity) => this.#owns(room) && room.remoteParticipants.has(identity),
      tracks: () => this.#latencyTracks(room)
    })
    room
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        // Plan 253 S4: latency reports, relayed by the server only. A
        // participant cannot send one, whatever topic it names.
        if (participant || topic !== LATENCY_TOPIC || !this.#owns(room)) return
        this.#latency.received(payload)
      })
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
        this.#latency.left(participant.identity)
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
        // LiveKit fires this on every speaker update, level-only ones too
        // (re-sorted by level), and the host is one of the speakers. Only
        // which guests talk reaches the snapshot, so anything else publishes
        // nothing: each publish re-renders every room reader (PH-12).
        const local = room.localParticipant.identity
        const next = new Set(
          speakers.map((speaker) => speaker.identity).filter((identity) => identity !== local)
        )
        if (sameMembers(next, this.#speaking)) return
        this.#speaking = next
        this.#publish()
      })
      .on(RoomEvent.Reconnecting, () => {
        if (!this.#owns(room)) return
        if ((this.#deps.pcmTestSource || this.#microphoneChoice) && this.#owns(room))
          this.#retirePcm(room)
        // A reconnect retires the frame producer; Reconnected opens a new generation.
        if (this.#nativeCamera() && this.#frameSource) this.#retireFrame(room)
        if (this.#privacy) {
          this.#privacy.observations = {}
          this.#privacy.status = 'unconfirmed'
        }
        this.#setState('reconnecting', 'Reconnecting to the room.')
      })
      .on(RoomEvent.Reconnected, () => {
        if (!this.#owns(room)) return
        this.#latency.reconnected()
        if (this.#nativeCamera() && !this.#cameraOff && !this.#camera) {
          const generation = this.#frameGeneration
          void this.#frameRetiring.then(async () => {
            if (!this.#owns(room) || generation !== this.#frameGeneration || this.#camera) return
            try {
              await this.#publishFrameCamera(room)
            } catch (error) {
              this.#problem = `The camera bridge test source didn't reopen: ${messageOf(error)}`
            }
            if (this.#owns(room)) this.#publish()
          })
        }
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
        // The background effect went off while the room was reconnecting.
        if (this.#cameraRestorePending) {
          this.#cameraRestorePending = false
          if (!this.#backgroundBlocked && this.#cameraWanted && !this.#camera && this.#cameraName)
            void this.setCameraSelection(this.#cameraName, false).catch(() => {})
        }
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!this.#owns(room) || reason === DisconnectReason.CLIENT_INITIATED) return
        // Out of the room: no sample, and no number from a room that is gone.
        this.#latency.stop()
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
    this.#settingsEpoch++
    const effect = cameraBackgroundIsEffect(settings?.layout.cameraBackground)
    if (effect && !this.#nativeCamera()) {
      // Plan 258 S5, before S8: an effect turned on while the room shows the
      // browser's own camera takes the camera out of the room at once. The
      // controls refuse it while a room is open; this holds for any other way in.
      if (camera || !this.#backgroundBlocked) this.#blockCameraForBackground()
      if (camera) await this.#releaseCameraForBackground()
      return
    }
    if (this.#backgroundBlocked && !effect) {
      // The effect is off: the camera may come back, as the streamer had it.
      this.#backgroundBlocked = false
      this.#cameraOff = !this.#cameraWanted
      if (this.#problem === ROOM_CAMERA_OFF_FOR_BACKGROUND) this.#problem = null
      this.#publish()
      if (!this.#cameraName || !this.#cameraWanted) return
      if (this.#room && this.#snapshot.state === 'connected')
        await this.setCameraSelection(this.#cameraName, false).catch(() => {})
      // Still connecting: the camera opens when the connection's own
      // publishing finishes (#publishLocal), never dropped.
      else this.#cameraRestorePending = true
      return
    }
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

  /** The room keeps the camera off for the background effect (plan 258 S5), and says so. */
  #blockCameraForBackground(): void {
    this.#backgroundBlocked = true
    this.#cameraOff = true
    if (!this.#cameraEffectError) {
      this.#problem = ROOM_CAMERA_OFF_FOR_BACKGROUND
      if (this.#room) this.#deps.report('connected', this.#problem)
    }
    this.#publish()
  }

  /**
   * Stops the browser camera an effect was turned on over at once (it sends
   * nothing from here), then unpublishes it in turn with the other controls.
   */
  async #releaseCameraForBackground(): Promise<void> {
    const old = this.#camera
    this.#camera = null
    this.#cameraEffects?.close()
    this.#cameraEffects = null
    old?.stop()
    this.#publish()
    if (!old) return
    await this.#control(async (room) => {
      await room.localParticipant.unpublishTrack(old, true)
    }).catch(() => {})
  }

  /**
   * Whether the camera being opened has an effect: the switched-to camera's
   * own background when a switch passed one (the Studio's settings may still
   * name the previous camera), else the settings'.
   */
  #openingBackgroundIsEffect(target: OpeningBackground, since?: number): boolean {
    const settings = this.#deps.cameraSettings?.()?.layout.cameraBackground
    if (target === undefined) return cameraBackgroundIsEffect(settings)
    // Fail closed: the switch's own camera has an effect, or settings that
    // arrived after the switch was queued (now naming that camera) do.
    return (
      cameraBackgroundIsEffect(target) ||
      (since !== this.#settingsEpoch && cameraBackgroundIsEffect(settings))
    )
  }

  async #publishCamera(room: Room, target?: OpeningBackground, since?: number): Promise<void> {
    if (this.#nativeCamera()) return this.#publishFrameCamera(room)
    // Plan 258 S5, before S8: the browser camera can't carry the background
    // effect yet, so with one on the room opens no camera at all: nothing of
    // the room behind the streamer is captured, let alone published.
    if (this.#openingBackgroundIsEffect(target, since)) {
      this.#blockCameraForBackground()
      return
    }
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
      // An effect turned on while the camera was opening: it never goes out.
      if (this.#backgroundBlocked || this.#openingBackgroundIsEffect(target, since)) {
        effects.close()
        camera.stop()
        if (this.#camera === camera) {
          this.#cameraEffects = null
          this.#camera = null
        }
        this.#blockCameraForBackground()
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

  /** The camera comes from the native side: the S13a fixture or the S13b processed camera. */
  #nativeCamera(): boolean {
    return !!this.#deps.frameTestSource || !!this.#deps.processedCamera
  }

  async #publishFrameCamera(room: Room): Promise<void> {
    if (!import.meta.env.DEV || !room.localParticipant.identity.startsWith('host:'))
      throw new Error('Camera frame test source requires a development host room.')
    // S13b: open at the native camera's current logical size; no size, no camera.
    let processed: RoomFrameSize | undefined
    if (this.#deps.processedCamera) {
      const resources = await window.videorc.getRoomProcessedCameraResources().catch(() => null)
      if (!resources || resources.logicalWidth === null || resources.logicalHeight === null) {
        // Truthful state: no native frame means the camera is off, not "on".
        this.#cameraOff = true
        this.#publish()
        throw new Error('The camera is not giving frames natively.')
      }
      processed = {
        width: resources.logicalWidth,
        height: resources.logicalHeight,
        fps: ROOM_FRAME.fps
      }
    }
    const generation = ++this.#frameGeneration
    const current = (): boolean => this.#owns(room) && generation === this.#frameGeneration
    const controller = new AbortController()
    this.#frameAbort = controller
    let source: RoomFrameSource | null = null
    let camera: LocalVideoTrack | null = null
    try {
      source = await createRoomFrameTestSource(
        processed ? window.videorc.roomProcessedCamera : window.videorc.roomFrameTest,
        controller.signal,
        this.#deps.onFrameDiagnostic,
        (reason) => {
          // Pause safely: retire the publication; never fall back to a raw camera.
          if (!current()) return
          this.#retireFrame(room)
          this.#cameraOff = true
          this.#problem = reason
          this.#publish()
          this.#deps.report('connected', reason)
        },
        {},
        processed
      )
      if (!current() || controller.signal.aborted) {
        await source.close()
        return
      }
      this.#frameSource = source
      camera = new LocalVideoTrack(source.track, undefined, true)
      this.#camera = camera
      this.#cameraEffectError = false
      const published = await room.localParticipant.publishTrack(camera, {
        // The native fixture always packs; a layout never changes in band.
        name: cameraFrameTrackName('rgb-left-alpha-right:g8', source.generation),
        source: Track.Source.Camera,
        videoCodec: 'vp8',
        simulcast: false,
        videoEncoding: { maxBitrate: 4_000_000, maxFramerate: ROOM_FRAME.fps }
      })
      if (!current()) {
        camera.stop()
        await room.localParticipant.unpublishTrack(camera, true).catch(() => {})
        return
      }
      this.#bindCameraFrame(
        room,
        source.generation,
        published?.trackSid,
        processed ? { width: processed.width, height: processed.height } : undefined
      )
      this.#attachEncodeObserver(camera, source.generation, current)
    } catch (error) {
      if (current()) {
        controller.abort()
        void this.#detachEncodeObserver()
        const closing = source?.close()
        if (this.#frameSource === source) this.#frameSource = null
        camera?.stop()
        if (this.#camera === camera) this.#camera = null
        this.#cameraFrame = null
        await closing
        this.#cameraOff = true
        this.#publish()
      } else await source?.close()
      throw error
    }
  }

  /**
   * S13a harness only: the published camera sender's outbound-rtp counters,
   * for the bridge and for the matched browser-camera baseline alike.
   * Aggregate counters: they never identify which frame was encoded when.
   */
  async cameraSenderStats(): Promise<Record<string, unknown>[] | null> {
    const camera = this.#camera
    if (!camera?.getRTCStatsReport) return null
    const report = await camera.getRTCStatsReport().catch(() => undefined)
    if (!report) return null
    const keys = [
      'timestamp',
      'framesEncoded',
      'framesSent',
      'keyFramesEncoded',
      'totalEncodeTime',
      'frameWidth',
      'frameHeight',
      'framesPerSecond',
      'qualityLimitationReason',
      'bytesSent'
    ]
    const out: Record<string, unknown>[] = []
    report.forEach((entry: Record<string, unknown>) => {
      if (entry.type === 'outbound-rtp' && entry.kind === 'video')
        out.push(Object.fromEntries(keys.map((key) => [key, entry[key] ?? null])))
    })
    return out
  }

  /** Authority from the SFU's answer to this publish, never from a track name. */
  #bindCameraFrame(
    room: Room,
    generation: number,
    trackSid: string | undefined,
    logical?: { width: number; height: number }
  ): void {
    let epoch = this.#cameraFrameEpochs.get(room)
    if (!epoch) {
      epoch = crypto.randomUUID()
      this.#cameraFrameEpochs.set(room, epoch)
    }
    const permissions = room.localParticipant.permissions
    const sources = publishSourceNames(permissions?.canPublishSources)
    const authority: CameraFrameAuthority = {
      contract: CAMERA_FRAME_CONTRACT,
      show: room.name,
      hostIdentity: room.localParticipant.identity,
      publisherSid: room.localParticipant.sid,
      trackSid: trackSid ?? '',
      epoch,
      generation,
      source: 'camera',
      // An empty list with publish permission means every source (LiveKit).
      canPublishSources: sources.length === 0 && permissions?.canPublish ? ['camera'] : sources
    }
    const bound = bindCameraFramePublication(authority, generation, 'packed', {
      experiment: true,
      ...(logical ? { logical } : {})
    })
    this.#cameraFrame = bound ? { authority, descriptor: bound.descriptor } : null
    if (!bound) this.#problem = 'The camera bridge publication could not be bound to the room.'
    this.#publish()
  }

  /** S13a harness only: DEV flag plus a diagnostic sink, after a successful publish. */
  #attachEncodeObserver(camera: LocalVideoTrack, generation: number, current: () => boolean): void {
    const observe = this.#deps.onFrameDiagnostic
    if (!observe || !roomFrameEncodeObserverEnabled()) return
    // Loaded on demand so the observer and its worker stay out of the eager bundle.
    void import('./room-frame-encode-observer')
      .then(({ attachEncodeObserver }) => {
        if (!current() || this.#camera !== camera || this.#encodeObserver) return
        this.#encodeObserver = attachEncodeObserver(camera.sender, generation, observe)
      })
      .catch((error) =>
        observe({
          phase: 'encode-observer',
          generation,
          status: 'unavailable',
          reason: messageOf(error)
        })
      )
  }

  #detachEncodeObserver(): Promise<void> | undefined {
    const observer = this.#encodeObserver
    this.#encodeObserver = null
    return observer?.detach()
  }

  #retireFrame(room: Room): void {
    this.#cameraFrame = null
    ++this.#frameGeneration
    this.#frameAbort?.abort()
    this.#frameAbort = null
    const closingObserver = this.#detachEncodeObserver()
    const closing = this.#frameSource?.close()
    this.#frameSource = null
    const track = this.#camera
    this.#camera = null
    track?.stop()
    this.#frameRetiring = Promise.all([this.#frameRetiring, closing, closingObserver])
      .then(async () => {
        if (track) await room.localParticipant.unpublishTrack(track, true)
      })
      .catch(() => {})
  }

  async #publishLocal(): Promise<void> {
    const room = this.#room
    if (!room) return
    if (!this.#owns(room)) return
    const problems: string[] = []
    if ((this.#cameraName || this.#nativeCamera()) && !this.#cameraOff) {
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
    if (this.#cameraRestorePending) {
      // The background effect went off while the room was connecting.
      this.#cameraRestorePending = false
      if (!this.#backgroundBlocked && this.#cameraWanted && !this.#camera && this.#cameraName) {
        try {
          await this.#publishCamera(room)
          this.#cameraOff = this.#backgroundBlocked
        } catch (error) {
          problems.push(`The camera didn't open: ${messageOf(error)}`)
        }
      }
    }
    if (!this.#owns(room)) return
    this.#problem = problems.length
      ? problems.join(' ')
      : this.#cameraEffectError
        ? this.#problem
        : this.#backgroundBlocked
          ? ROOM_CAMERA_OFF_FOR_BACKGROUND
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
      if (current()) {
        this.#processedMicrophone?.published()
        if (
          room.localParticipant.identity.startsWith('host:') &&
          (this.#processedMicrophone || this.#pcmSource)
        )
          this.#speech =
            this.#deps.attachHostSpeech?.(
              microphone.mediaStreamTrack,
              room.localParticipant.identity.replace(/^host:/, ''),
              this.#micMuted,
              current
            ) ?? null
      }
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
    const speechClosing = this.#speech?.close()
    this.#speech = null
    this.#pcmAbort?.abort()
    this.#pcmAbort = null
    const processed = this.#processedMicrophone?.close()
    this.#processedMicrophone = null
    const closing = this.#pcmSource?.close()
    this.#pcmSource = null
    const track = this.#microphone
    this.#microphone = null
    track?.stop()
    this.#pcmRetiring = Promise.allSettled([this.#pcmRetiring, closing, processed, speechClosing])
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
    const speechClosing = this.#speech?.close()
    this.#speech = null
    const guestSpeechClosing = this.#guestSpeech?.close()
    this.#guestSpeech = null
    this.#guestCaptioning = false
    await guestSpeechClosing
    this.#pcmAbort?.abort()
    this.#pcmAbort = null
    await speechClosing
    const closingProcessed = this.#processedMicrophone?.close()
    this.#processedMicrophone = null
    const closingPcm = this.#pcmSource?.close()
    this.#pcmSource = null
    ++this.#frameGeneration
    this.#cameraFrame = null
    this.#frameAbort?.abort()
    this.#frameAbort = null
    const closingObserver = this.#detachEncodeObserver()
    const closingFrame = this.#frameSource?.close()
    this.#frameSource = null
    const room = this.#room
    ++this.#screenGeneration
    ++this.#privacyGeneration
    this.#dropScreenStill()
    this.#screenRaw?.stop()
    this.#screenRaw = null
    this.#screenSourceId = null
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
    // Frame close failures stay visible in the source's resource registry.
    await Promise.allSettled([closingObserver, closingFrame, this.#frameRetiring])
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
    this.#graphics?.close()
    this.#graphics = null
    void this.#htmlLayers?.close()
    this.#htmlLayers = null
    this.#avatar?.close()
    this.#avatar = null
    this.#stopMotion()
    this.#scene?.close()
    this.#scene = null
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

  /**
   * Plan 253 S7: one report per 10 s sample, for the show's record. The
   * host's identity is `host:<showId>`. A report that is not kept (the
   * backend is busy or gone) is not sent again: the next sample is.
   */
  #reportLatency(latency: RoomLatency): void {
    const room = this.#room
    const identity = this.#snapshot.identity
    if (!room || !identity?.startsWith('host:')) return
    const report = roomLatencyReport(
      identity.slice(5),
      latency,
      (guest) => room.remoteParticipants.get(guest)?.name
    )
    if (report)
      void this.#deps.backend?.requestTyped('cloud.room.latency.report', report).catch(() => {})
  }

  /**
   * Plan 253 S4: the tracks the latency sampler reads. Each person's camera
   * and microphone as this client receives them, and the host's own. A
   * shared screen, the runner and LiveKit's recorder are not conversation.
   */
  #latencyTracks(room: Room): NetTrack[] {
    const tracks: NetTrack[] = []
    const kindOf = (source: Track.Source): 'audio' | 'video' | null =>
      source === Track.Source.Microphone ? 'audio' : source === Track.Source.Camera ? 'video' : null
    for (const participant of room.remoteParticipants.values()) {
      if (isRecorderIdentity(participant.identity) || isRunnerIdentity(participant.identity))
        continue
      for (const publication of participant.trackPublications.values()) {
        const kind = kindOf(publication.source)
        if (!kind || !publication.track || !publication.isSubscribed) continue
        tracks.push({
          direction: 'in',
          identity: participant.identity,
          kind,
          track: publication.track as NetStatsTrack
        })
      }
    }
    if (this.#camera)
      tracks.push({ direction: 'out', kind: 'video', track: this.#camera as NetStatsTrack })
    if (this.#microphone)
      tracks.push({ direction: 'out', kind: 'audio', track: this.#microphone as NetStatsTrack })
    return tracks
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

  /**
   * Guest captions: the host room's guest mix follows the stage and each
   * guest's microphone on every change. The tap opens lazily and only asks
   * the backend for its captions-only stream; it never reaches Sidekick.
   */
  #feedGuestSpeech(room: Room | null): void {
    if (!room || this.#snapshot.state !== 'connected' || !this.#owns(room)) return
    const identity = room.localParticipant.identity
    if (!identity.startsWith('host:') || !this.#deps.attachGuestSpeech) return
    this.#guestSpeech ??= this.#deps.attachGuestSpeech(
      identity.replace(/^host:/, ''),
      () => this.#owns(room) && !this.#closed,
      (captioning) => {
        if (!this.#owns(room) || captioning === this.#guestCaptioning) return
        this.#guestCaptioning = captioning
        // Tell the guest page (data messages are not replayed).
        void this.sendStage(this.#lastStage, this.#lastScreen)
      }
    )
    const people: GuestMicrophone<MediaStreamTrack>[] = []
    for (const participant of room.remoteParticipants.values()) {
      let microphone: GuestMicrophone<MediaStreamTrack>['microphone'] = null
      for (const publication of participant.trackPublications.values()) {
        if (publication.source !== Track.Source.Microphone) continue
        microphone = {
          track: publication.track?.mediaStreamTrack ?? null,
          subscribed: publication.isSubscribed,
          muted: publication.isMuted
        }
      }
      people.push({ identity: participant.identity, microphone })
    }
    this.#guestSpeech.setSources(guestCaptionTracks(people, this.#lastStage))
  }

  #publish(): void {
    if (this.#microphone) this.#micMuted = this.#microphone.isMuted ?? this.#micMuted
    if (this.#closed) return
    const room = this.#room
    const people: TalkShowPerson[] = []
    const latency = this.#latency.current
    let monitorVideo: MediaStreamTrack | null = null
    let monitorAudio: MediaStreamTrack | null = null
    this.#feedGuestSpeech(room)
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
          speaking: this.#speaking.has(participant.identity),
          ...(latency.people[participant.identity]
            ? { latency: latency.people[participant.identity] }
            : {})
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
        // Off only because the background effect holds it (plan 258 S5),
        // never the streamer's own camera Off.
        ...(this.#backgroundBlocked ? { cameraHeld: true } : {}),
        problem: this.#problem,
        ...(room && this.#snapshot.state === 'connected'
          ? { quality: qualityOf(room.localParticipant.connectionQuality) }
          : {}),
        ...(latency.hostRttMs === undefined ? {} : { rttMs: latency.hostRttMs }),
        ...(this.#cameraFrame && this.#frameSource ? { cameraFrame: this.#cameraFrame } : {}),
        ...(this.#screenRaw && this.#screenSourceId
          ? { screenSourceId: this.#screenSourceId }
          : {}),
        ...(this.#screenRaw && this.#screenStill ? { screenStill: this.#screenStill } : {})
      },
      monitor: { enabled: this.#monitorEnabled, video: monitorVideo, audio: monitorAudio },
      program: latency.program
    }
    this.#deps.onSnapshot(this.#snapshot)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const member of a) if (!b.has(member)) return false
  return true
}

/** For the tests: the publication shapes the snapshot reads. */
export type { LocalTrackPublication }
