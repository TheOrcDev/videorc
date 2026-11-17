import { attachHostSpeech } from '@/lib/room-speech-source'
import { roomNativeMicrophoneEnabled } from '@/lib/room-microphone-state'
import { closeVisualMicrophoneStreams } from '@/lib/mic-visual-ownership'
import type { RoomMicrophoneChoice } from '@/lib/room-microphone-source'
import { roomPcmTestEnabled } from '../lib/room-pcm-test-state'
import type { CohostPersona, BuddyOverlaySnapshot, OverlayItemLayout } from '@/lib/backend'
import { toast } from '@/lib/toast'
import { withRestoredBanners } from '@/lib/cloud-restored-banners'
import type { GraphicsContent } from '../../../shared/cloud-graphics'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { BackendClient } from '@/backendClient'
import type {
  CloudGuestAction,
  CloudRoomOpenParams,
  CloudRoomOverlayEvent,
  CloudStage,
  CloudStatus,
  Device
} from '@/lib/backend'
import {
  IDLE_TALK_SHOW_SNAPSHOT,
  NO_TALK_SHOW,
  type TalkShowContextValue
} from '@/lib/talk-show-context'
import type { TalkShowCameraSettings } from '@/lib/talk-show-camera-effects'
import type { TalkShowRoomClient, TalkShowRoomSnapshot } from '@/lib/talk-show-room'
import { cloudAvatarAtlasReason } from '@/lib/cloud-avatar-refusal'
import type { AvatarMotionSource } from '../../../shared/cloud-avatar-view'

// The host's room, from the Studio's side (plan 224 C-G4). The backend owns
// the show and the room's facts (`cloud.state`); this hook owns the renderer's
// LiveKit connection: it joins when the status says the room is open, leaves
// when it closes, keeps the guest page's stage topic current, and hands the
// room's tracks to the Show stage (C-G3) as plain `MediaStreamTrack`s.
//
// This module is lazy: `components/studio/talk-show-room-host.tsx` runs the
// hook under the Studio provider, which holds only the idle value
// (`lib/talk-show-context.ts`). `lib/talk-show-room.ts` (and `livekit-client`
// with it) loads only when a room opens. The eager budget is an owner STOP.

export { PROGRAM_MONITOR_EMPTY } from '@/lib/talk-show-session'
export { NO_TALK_SHOW, type TalkShowContextValue }

const IDLE_SNAPSHOT = IDLE_TALK_SHOW_SNAPSHOT

const loadRoomClient = () => import('@/lib/talk-show-room')
const loadOverlays = () => import('@/lib/talk-show-overlays')

/** The Studio supplies the object, "the room", when it builds the toast. */
export const ROOM_JOIN_ERROR_ACTION = 'join'

export type TalkShowRoomControllerDeps = {
  client: BackendClient | null
  cloudStatus: CloudStatus | null
  commitCloudStatus: (status: CloudStatus) => void
  /** The Sources page's camera and microphone ids and the device list, for
   * the names Chromium labels its devices with. */
  stopOutput?: (output: 'recording' | 'live') => Promise<boolean>
  controlsRef?: { current: TalkShowRoomClient | null }
  onMediaSnapshot?: (snapshot: TalkShowRoomSnapshot) => void
  microphoneAudio?: {
    microphoneGainDb: number
    microphoneNoiseSuppression?: 'off' | 'rnnoise'
    microphoneSyncOffsetMs: number
  }
  microphoneMuted?: boolean
  cameraOff?: boolean
  avatar?: {
    persona: CohostPersona | null
    snapshot: BuddyOverlaySnapshot | null
    layout: OverlayItemLayout
  }
  cameraSettings?: TalkShowCameraSettings
  cameraId: string | null
  microphoneId: string | null
  devices: readonly Device[]
  /** The outputs a Go Live would create the show with (the stream settings). */
  outputs: () => CloudRoomOpenParams['outputs']
  /** The host's camera shape from Sources (D8). */
  hostShape: () => CloudStage['hostShape']
  /** Called once the room closed and the backend returned the camera (D6). */
  onCameraReturned: () => void
  /** A refusal or a failure, in the Studio's words. `action` is the whole
   * phrase after "Couldn't" ("join the room", "mute the guest"). */
  onError: (error: unknown, action: string) => void
  /** The lifecycle probe's scripted room (DEV only): hides the Preview with
   * no LiveKit room behind it. */
  previewReplacedOverride: boolean
  /** Runs `open` once the Clips ring's buffer-only session has stepped
   * aside: the backend refuses Open the room beside it (D6). */
  clipsStepAside?: (open: () => Promise<void>) => Promise<void>
}

/** A guest action in the Studio's error words: "Couldn't {words}". */
export function guestActionWords(action: CloudGuestAction): string {
  switch (action) {
    case 'mute':
      return 'mute the guest'
    case 'unmute':
      return 'unmute the guest'
    case 'remove':
      return 'remove the guest'
    case 'ban':
      return 'ban the guest'
    case 'rename':
      return 'rename the guest'
    case 'allow-screen-share':
      return 'let the guest share their screen'
    case 'disallow-screen-share':
      return "stop the guest's screen share"
  }
}

/**
 * The next stage after Bring on or Send backstage: pure, for the tests. The
 * host is always on stage and leads the list (D8): a stage without them
 * would take their camera and mic out of the program (the runner composes
 * only who the stage names), so a Bring on into an empty stage names the
 * host too, and the host can never be sent backstage.
 */
export function stageWith(
  stage: CloudStage,
  identity: string,
  onStage: boolean,
  hostIdentity: string | null
): CloudStage {
  const without = stage.onStage.filter((entry) => entry !== identity)
  const next = onStage ? [...without, identity] : without
  // The host leads the list so Solo and Spotlight default to them.
  const ordered = hostIdentity
    ? [hostIdentity, ...next.filter((entry) => entry !== hostIdentity)]
    : next
  return {
    ...stage,
    onStage: ordered,
    ...(stage.spotlight && !ordered.includes(stage.spotlight) ? { spotlight: undefined } : {}),
    ...(stage.screen && !ordered.includes(stage.screen) ? { screen: undefined } : {})
  }
}

export function useTalkShowRoomController(deps: TalkShowRoomControllerDeps): TalkShowContextValue {
  const {
    client,
    cloudStatus,
    commitCloudStatus,
    cameraId,
    microphoneId,
    devices,
    outputs,
    hostShape,
    onCameraReturned,
    onError,
    previewReplacedOverride,
    clipsStepAside
  } = deps
  const controlsRef = deps.controlsRef
  const [snapshot, setSnapshot] = useState<TalkShowRoomSnapshot>(IDLE_SNAPSHOT)
  const clientRef = useRef<TalkShowRoomClient | null>(null)
  /** Plan 249 S24: the kept avatar per output view, so it is sent on change only. */
  const keptAvatarRef = useRef(new Map<string, string>())
  /** Plan 249 S24: the kept banners per output view, likewise. */
  const keptGraphicsRef = useRef(new Map<string, string>())
  /**
   * Plan 249 S24: the banners the show kept, restored after a takeover. They
   * fill an orientation where this computer shows no banner of its own,
   * until its banner list changes.
   */
  const restoredGraphicsRef = useRef<GraphicsContent | null>(null)
  const graphicsInvalidateRef = useRef<(() => void) | null>(null)
  const leavingRef = useRef<Promise<void>>(Promise.resolve())
  const audioHostRef = useRef<HTMLElement | null>(null)
  // A completed leave only hands capture back while the Studio is mounted.
  const disposedRef = useRef(false)
  const roomPhase = cloudStatus?.room?.phase ?? 'closed'
  const roomOpen = roomPhase === 'open'
  const roomOpenRef = useRef(roomOpen)
  roomOpenRef.current = roomOpen
  const showId = cloudStatus?.show?.id ?? null
  const stage = cloudStatus?.room?.stage ?? null
  const stageKey = stage ? JSON.stringify([stage.onStage, stage.screen ?? null]) : ''
  const hostIdentity = roomOpen && showId ? `host:${showId}` : null

  const cameraName = useMemo(
    () =>
      devices.find((device) => device.kind === 'camera' && device.id === cameraId)?.name ?? null,
    [cameraId, devices]
  )
  const microphoneName = useMemo(
    () =>
      devices.find((device) => device.kind === 'microphone' && device.id === microphoneId)?.name ??
      null,
    [devices, microphoneId]
  )
  // Plan 249 S24 (D9): after this computer took the show over, nothing that
  // captures here starts by itself. A muted microphone still opens capture,
  // so the device names are withheld from the room client until the
  // streamer turns them on; then S7b's live selection opens them (no rejoin).
  const controller = cloudStatus?.controller
  const holdEpoch = controller?.takenOverFrom ? controller.controllerEpoch : 0
  const [enabledEpoch, setEnabledEpoch] = useState(0)
  const devicesHeld = holdEpoch > 0 && enabledEpoch !== holdEpoch
  const devicesHeldRef = useRef(devicesHeld)
  devicesHeldRef.current = devicesHeld
  useEffect(() => {
    if (!devicesHeld || !roomOpen) return
    const needs = controller?.needsEnable ?? []
    toast.info('You control this show here now', {
      id: 'cloud-controller-continuation',
      description:
        needs.length > 0
          ? `Camera and microphone stay off here until you turn them on. Also off: ${
              needs.filter((need) => need !== 'camera' && need !== 'microphone').join(', ') ||
              'nothing else'
            }.`
          : 'Camera and microphone stay off here until you turn them on.',
      duration: Infinity,
      action: { label: 'Turn on', onClick: () => setEnabledEpoch(holdEpoch) }
    })
    return () => {
      toast.dismiss('cloud-controller-continuation')
    }
  }, [devicesHeld, roomOpen, holdEpoch, controller?.needsEnable])
  const microphoneChoice = useMemo<RoomMicrophoneChoice>(
    () => ({
      mode:
        import.meta.env.DEV &&
        (roomNativeMicrophoneEnabled() ||
          new URLSearchParams(globalThis.location?.search ?? '').get('roomNativeMic') === '1')
          ? 'native-headphones'
          : 'browser-aec',
      // Plan 249 S24: withheld after a takeover until the streamer turns it on.
      deviceId: devicesHeld ? null : microphoneId,
      name: devicesHeld ? null : microphoneName,
      gainDb: deps.microphoneAudio?.microphoneGainDb ?? 0,
      muted: deps.microphoneMuted === true,
      noise: deps.microphoneAudio?.microphoneNoiseSuppression ?? 'off',
      offsetMs: deps.microphoneAudio?.microphoneSyncOffsetMs ?? 0
    }),
    [microphoneId, microphoneName, devicesHeld, deps.microphoneAudio, deps.microphoneMuted]
  )
  const microphoneChoiceRef = useRef(microphoneChoice)
  microphoneChoiceRef.current = microphoneChoice
  useEffect(() => {
    const owner = clientRef.current
    if (!owner || snapshot.state !== 'connected' || roomPcmTestEnabled()) return
    void owner
      .updateMicrophone(microphoneChoice)
      .catch((error) => onError(error, 'update the room microphone'))
  }, [microphoneChoice, snapshot.state, onError])
  const cameraNameRef = useRef(cameraName)
  const microphoneNameRef = useRef(microphoneName)
  cameraNameRef.current = cameraName
  microphoneNameRef.current = microphoneName
  const cameraSettingsRef = useRef(deps.cameraSettings)
  cameraSettingsRef.current = deps.cameraSettings
  useEffect(() => {
    void clientRef.current?.updateCameraSettings(deps.cameraSettings)
  }, [deps.cameraSettings])
  const stageRef = useRef<string[]>([])
  stageRef.current = stage?.onStage ?? []
  const stageScreenRef = useRef<string | null>(null)
  stageScreenRef.current = stage?.screen ?? null
  const onCameraReturnedRef = useRef(onCameraReturned)
  onCameraReturnedRef.current = onCameraReturned

  const mediaDepsRef = useRef(deps)
  mediaDepsRef.current = deps
  const callbacksRef = useRef({ commitCloudStatus, onError })
  callbacksRef.current = { commitCloudStatus, onError }
  // Plan 243 C5: the room client reads who is on air when its host seat drops.
  const onAirRef = useRef(cloudStatus?.onAir)
  onAirRef.current = cloudStatus?.onAir

  // Each open show owns one join. Closing, changing shows or losing the
  // backend cancels it, even while the media grant or lazy import is pending.
  // A replacement waits for teardown so the old leave cannot revoke its grant.
  useEffect(() => {
    setSnapshot(IDLE_SNAPSHOT)
    mediaDepsRef.current.onMediaSnapshot?.(IDLE_SNAPSHOT)
    if (!roomOpen || !client || !showId) {
      return
    }
    let cancelled = false
    let current: TalkShowRoomClient | null = null
    let grant: Promise<unknown> | null = null
    const report = (state: TalkShowRoomSnapshot['state'], detail?: string): void => {
      if (cancelled) return
      void client
        .requestTyped('cloud.room.client.report', { state, ...(detail ? { detail } : {}) })
        .then((status) => {
          if (!cancelled) callbacksRef.current.commitCloudStatus(status)
        })
        .catch(() => {})
    }
    void (async () => {
      try {
        await leavingRef.current
        if (cancelled) return
        grant = Promise.resolve(
          window.videorc?.setTalkShowMediaGrant?.({ video: true, screenSourceId: null })
        )
        await grant
        if (cancelled) return
        closeVisualMicrophoneStreams()
        await client.request('audio.mic.disarm')
        if (cancelled) return
        const { TalkShowRoomClient } = await loadRoomClient()
        if (cancelled) return
        const host = document.createElement('div')
        host.setAttribute('data-talk-show-audio-host', '')
        host.style.display = 'none'
        document.body.appendChild(host)
        audioHostRef.current = host
        // A new epoch keeps nothing yet: send every applied view again.
        keptAvatarRef.current.clear()
        keptGraphicsRef.current.clear()
        const roomClient = new TalkShowRoomClient({
          attachHostSpeech: (...args) => attachHostSpeech(client, ...args),
          // S7a harness opt-in; main also requires VIDEORC_ROOM_PCM_TEST=1 and
          // the native source requires a debug build with smoke RPC enabled.
          pcmTestSource:
            import.meta.env.DEV &&
            (roomPcmTestEnabled() ||
              new URLSearchParams(window.location.search).get('roomPcmTest') === '1'),
          onPcmDiagnostic: (detail) =>
            window.dispatchEvent(new CustomEvent('videorc:pcm-test-diagnostic', { detail })),
          requestToken: () => client.requestTyped('cloud.room.token.refresh'),
          report,
          onSnapshot: (next) => {
            if (!cancelled) {
              setSnapshot(next)
              mediaDepsRef.current.onMediaSnapshot?.(next)
            }
          },
          cameraName: devicesHeldRef.current ? null : cameraNameRef.current,
          initiallyMuted: mediaDepsRef.current.microphoneMuted,
          initiallyCameraOff: mediaDepsRef.current.cameraOff,
          cameraSettings: () => cameraSettingsRef.current,
          microphoneName: devicesHeldRef.current ? null : microphoneNameRef.current,
          microphoneChoice: microphoneChoiceRef.current,
          sourcesHeld: () => devicesHeldRef.current,
          audioHost: () => host,
          onAir: () => onAirRef.current,
          // Plan 249 S24: a view a program page applied is kept by the cloud
          // for the next controller; only its avatar layer survives (D9), so
          // a refresh or a bubble alone sends nothing.
          // Plan 249 S24 with S9: the same for the static view. Only banners
          // at rest survive; chat, captions and cards are cleared or dropped.
          onGraphicsAccepted: (view) => {
            if (!showId) return
            const kept = JSON.stringify([
              view.layers
                .filter((layer) => layer.kind === 'banner' && layer.expiresAt === null)
                .map((layer) => [
                  layer.id,
                  layer.asset.hash,
                  layer.rect,
                  layer.opacity * (layer.fade ? layer.fade.to : 1)
                ]),
              view.layers
                .filter((layer) => layer.kind === 'chat' || layer.kind === 'caption')
                .map((layer) => layer.kind)
            ])
            const key = `${view.output}/${view.orientation}`
            if (keptGraphicsRef.current.get(key) === kept) return
            keptGraphicsRef.current.set(key, kept)
            void client
              .requestTyped('cloud.presentation.accepted', { showId, topic: 'static', ...view })
              .catch(() => keptGraphicsRef.current.delete(key))
          },
          onAvatarAccepted: (view) => {
            if (!showId) return
            const kept = JSON.stringify(
              view.layers
                .filter((layer) => layer.kind === 'avatar' && layer.expiresAt === null)
                .map((layer) => [layer.asset.hash, layer.rect])
            )
            const key = `${view.output}/${view.orientation}`
            if (keptAvatarRef.current.get(key) === kept) return
            keptAvatarRef.current.set(key, kept)
            void client
              .requestTyped('cloud.presentation.accepted', { showId, topic: 'avatar', ...view })
              .catch(() => keptAvatarRef.current.delete(key))
          }
        })
        current = roomClient
        clientRef.current = roomClient
        if (controlsRef) controlsRef.current = roomClient
        await roomClient.sendStage(stageRef.current, stageScreenRef.current)
        if (cancelled) return
        await roomClient.connect()
      } catch (error) {
        if (cancelled) return
        callbacksRef.current.onError(error, ROOM_JOIN_ERROR_ACTION)
        report('disconnected', error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      cancelled = true
      if (controlsRef?.current === current) controlsRef.current = null
      if (clientRef.current === current) clientRef.current = null
      audioHostRef.current?.remove()
      audioHostRef.current = null
      if (!grant && !current) return
      // disconnect stops local tracks before its first await. Do not wait
      // for a pending connect to finish before releasing capture.
      leavingRef.current = Promise.allSettled([grant, current?.disconnect()])
        .then(async () => {
          await window.videorc?.setTalkShowMediaGrant?.({ video: false, screenSourceId: null })
        })
        .catch(() => {})
        .then(() => {
          if (!disposedRef.current && !roomOpenRef.current) onCameraReturnedRef.current()
        })
    }
    // An epoch change (a takeover) rejoins even for the same show; the
    // explicit enable does not.
  }, [client, roomOpen, showId, controlsRef, holdEpoch])

  useEffect(() => {
    const current = clientRef.current
    if (!client || !current || !roomOpen || !showId || snapshot.state !== 'connected') return
    let closed = false,
      generation = 0,
      active = 0,
      dirty = false
    let known: string | undefined
    const refresh = () => {
      if (closed) return
      if (active >= 1) {
        dirty = true
        return
      }
      const token = ++generation
      active++
      void client
        .requestTyped('cloud.graphics.snapshot', { showId, ...(known ? { known } : {}) })
        .then((result) => {
          if (closed || token !== generation) return
          known = result.signature
          if (result.content)
            current.setGraphics(withRestoredBanners(result.content, restoredGraphicsRef.current))
        })
        .catch(() => {
          if (!closed && token === generation) {
            known = undefined
            current.failGraphics()
          }
        })
        .finally(() => {
          active--
          if (dirty) {
            dirty = false
            refresh()
          }
        })
    }
    const invalidate = () => {
      generation++
      known = undefined
      refresh()
    }
    // This computer's own banner list changed: from now on it alone rules.
    const bannersChanged = () => {
      restoredGraphicsRef.current = null
      invalidate()
    }
    const off = [
      'banners.changed',
      'comments.highlight.status',
      'cloud.graphics.changed',
      'overlays.layout.changed'
    ].map((event) => client.on(event, event === 'banners.changed' ? bannersChanged : invalidate))
    graphicsInvalidateRef.current = invalidate
    refresh()
    const timer = setInterval(refresh, 500)
    return () => {
      closed = true
      generation++
      clearInterval(timer)
      off.forEach((fn) => fn())
      if (graphicsInvalidateRef.current === invalidate) graphicsInvalidateRef.current = null
      current.setGraphics(null)
    }
  }, [client, roomOpen, showId, snapshot.state])

  // Only the explicitly public avatar and bubble become raster assets. Private
  // Sidekick configuration remains in this process and is never serialized.
  useEffect(() => {
    const current = clientRef.current
    if (!current || !roomOpen || !deps.avatar) return
    let cancelled = false
    current.setAvatar(null) // invalidates any pending older raster/upload
    const avatar = deps.avatar
    if (!avatar?.persona) return
    void (async () => {
      const { renderCloudAvatar } = await import('@/lib/buddy-overlay')
      const content = {
        h: [],
        v: [],
        stream: avatar.layout.showOnStream,
        recording: avatar.layout.showInRecording
      } as import('@/lib/room-avatar-publisher').AvatarContent
      if (content.stream || content.recording) {
        for (const orientation of ['h', 'v'] as const) {
          if (cancelled) return
          content[orientation] = await renderCloudAvatar({
            persona: avatar.persona!,
            state: avatar.snapshot?.state ?? 'idle',
            bubble: avatar.snapshot?.bubble ?? null,
            canvas:
              orientation === 'h' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 },
            rect: avatar.layout[orientation === 'h' ? 'horizontal' : 'vertical']
          })
        }
      }
      // Plan 249 S5: an Alive pack also travels as an atlas for consumers that
      // animate it; a failure keeps the static content above, never blocks it.
      let seed: Parameters<typeof current.setAvatarMotion>[0] = null
      let refused: string | null = null
      const persona = avatar.persona!
      if ((content.stream || content.recording) && persona.avatar.kind === 'alive') {
        const packId = persona.avatar.packId
        try {
          const atlasModule = await import('@/lib/cloud-avatar-atlas')
          const atlas = await atlasModule.cachedCloudAvatarAtlas(
            { id: persona.id, packId },
            async () => {
              const { loadBuddyPreviewPack, disposeBuddyPreviewPack } =
                await import('@/lib/buddy-pet-preview-pack')
              const { avatarHash } = await import('../../../shared/cloud-avatar')
              const pack = await loadBuddyPreviewPack({
                personaId: persona.id,
                packId,
                pixelSize: atlasModule.ATLAS_MAX_CELL_PX
              })
              try {
                return await atlasModule.buildCloudAvatarAtlas(pack, {
                  canvas: atlasModule.browserAtlasCanvas,
                  hash: avatarHash
                })
              } finally {
                disposeBuddyPreviewPack(pack)
              }
            }
          )
          if (cancelled) return
          const built = atlasModule.animatedAvatarContent({
            atlas,
            staticLayers: { h: content.h, v: content.v },
            layout: { h: avatar.layout.horizontal, v: avatar.layout.vertical },
            settings: persona.motion,
            avatarState: avatar.snapshot?.state ?? 'idle'
          })
          content.animated = built.animated
          seed = built.seed
        } catch (error) {
          // The streamer reads why under the Program preview; the detail stays here.
          console.warn('[talk-show] avatar stays still on cloud outputs', error)
          refused = cloudAvatarAtlasReason(error)
        }
      }
      if (!cancelled) {
        current.setAvatar(content)
        current.setAvatarMotion(seed, refused)
      }
    })().catch((error: unknown) => {
      if (!cancelled) {
        current.failAvatar()
        callbacksRef.current.onError(error, 'render the room avatar')
      }
    })
    return () => {
      cancelled = true
    }
  }, [deps.avatar, roomOpen, showId, snapshot.state])

  useEffect(() => {
    if (!client || !roomOpen || !showId || !deps.avatar || snapshot.state !== 'connected') return
    const report = () => {
      const observed = Object.values(clientRef.current?.snapshot.avatar?.observed ?? {})
      void client
        .requestTyped('buddy.cloud.report', {
          showId,
          stream:
            observed.some((o) => o.output === 'stream') &&
            deps.avatar?.layout.showOnStream === true,
          recording:
            observed.some((o) => o.output === 'recording') &&
            deps.avatar?.layout.showInRecording === true
        })
        .catch(() => {})
    }
    report()
    const timer = setInterval(report, 5000)
    return () => {
      clearInterval(timer)
      void client
        .requestTyped('buddy.cloud.report', { showId, stream: false, recording: false })
        .catch(() => {})
    }
  }, [client, roomOpen, showId, snapshot.state, snapshot.avatar?.observed, deps.avatar])

  // Plan 249 S5: the backend's public animator inputs drive the room's
  // motion stream. No text or prompt is in them (`buddy_animator::public_event`).
  useEffect(() => {
    if (!client || !roomOpen) return
    return client.on('cohost.pet.animator', (payload) => {
      clientRef.current?.avatarMotionEvent(payload)
    })
  }, [client, roomOpen])

  // Plan 249 S24 (D9): after a takeover, the avatar the show kept is sent
  // again under this controller's own envelope (once per epoch). A local
  // avatar change replaces it as usual; a bubble is never part of it.
  const restoredEpochRef = useRef(0)
  const restoredViews = controller?.restoredViews ?? 0
  useEffect(() => {
    const current = clientRef.current
    if (
      !client ||
      !current ||
      !roomOpen ||
      !showId ||
      holdEpoch === 0 ||
      restoredViews === 0 ||
      snapshot.state !== 'connected' ||
      restoredEpochRef.current === holdEpoch
    )
      return
    restoredEpochRef.current = holdEpoch
    void (async () => {
      const restore = await client.requestTyped('cloud.presentation.restore', { showId })
      const { restoredAvatarContent, restoredGraphicsContent } =
        await import('@/lib/cloud-presentation-restore')
      // S9: kept banners return once the streamer turns graphics on (the
      // toggle starts off), where this computer shows none of its own.
      restoredGraphicsRef.current = restoredGraphicsContent(restore)
      graphicsInvalidateRef.current?.()
      const content = restoredAvatarContent(restore)
      if (!content || clientRef.current !== current) return
      current.setAvatar(content)
      current.setAvatarEnabled(true)
    })().catch(() => {
      restoredEpochRef.current = 0
    })
  }, [client, roomOpen, showId, holdEpoch, restoredViews, snapshot.state])

  // Plan 249 S24: the streamer's explicit "Turn on" after a takeover opens
  // the camera through S7b's live selection; the microphone follows from
  // `microphoneChoice` above. Once per epoch, only on a connected room.
  const enabledAppliedRef = useRef(0)
  useEffect(() => {
    const current = clientRef.current
    if (
      devicesHeld ||
      holdEpoch === 0 ||
      !current ||
      snapshot.state !== 'connected' ||
      enabledAppliedRef.current === holdEpoch
    )
      return
    enabledAppliedRef.current = holdEpoch
    const name = cameraNameRef.current
    void current
      .setCameraSelection(name, mediaDepsRef.current.cameraOff === true || !name)
      .catch((error) => onError(error, 'turn the room camera on'))
  }, [devicesHeld, holdEpoch, snapshot.state, onError])

  // Plan 249 S24: what this controller has on, and the avatar's output flags,
  // so a computer that takes the show over knows what to ask its streamer to
  // turn on. Sent on change; the backend drops it unless this is the controller.
  const cameraOn = roomOpen && !devicesHeld && cameraName !== null && deps.cameraOff !== true
  const microphoneOn =
    roomOpen && !devicesHeld && microphoneName !== null && deps.microphoneMuted !== true
  const avatarStream = deps.avatar?.layout.showOnStream === true
  const avatarRecording = deps.avatar?.layout.showInRecording === true
  const controllerEpoch = controller?.controllerEpoch ?? 0
  useEffect(() => {
    if (!client || !roomOpen || !showId || controllerEpoch === 0) return
    void client
      .requestTyped('cloud.controller.desired', {
        showId,
        enabled: { camera: cameraOn, microphone: microphoneOn },
        outputs: { avatar: { stream: avatarStream, recording: avatarRecording } }
      })
      .catch(() => {})
  }, [
    client,
    roomOpen,
    showId,
    controllerEpoch,
    cameraOn,
    microphoneOn,
    avatarStream,
    avatarRecording
  ])

  // The guest page reads the stage from the host's data topic (D11).
  useEffect(() => {
    if (!roomOpen) return
    void clientRef.current?.sendStage(stageRef.current, stageScreenRef.current)
  }, [roomOpen, stageKey])

  // Plan 234 T3 (wire contract 6.3): on a managed show the backend hands
  // each overlay to this renderer, which holds the host's room connection,
  // and the program page takes it as a byte stream. The event never fires
  // on a node show; the check below holds that here too.
  const cloudStatusRef = useRef(cloudStatus)
  cloudStatusRef.current = cloudStatus
  useEffect(() => {
    if (!client || !roomOpen) return
    return client.on('cloud.room.overlay', (event: CloudRoomOverlayEvent) => {
      void (async () => {
        const overlays = await loadOverlays()
        const status = cloudStatusRef.current
        if (!overlays.overlayIsForThisRoom(event, status, status?.room?.phase ?? 'closed')) return
        await clientRef.current?.sendOverlay(event, (imageId, signal) =>
          overlays.fetchOverlayImage(
            overlays.overlayImageUrl(client.connection, imageId),
            undefined,
            signal
          )
        )
      })().catch((error: unknown) => {
        console.warn(
          '[talk-show] an overlay could not be sent',
          error instanceof Error ? error.message : String(error)
        )
      })
    })
  }, [client, roomOpen])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
    }
  }, [])

  const setGraphicsEnabled = useCallback(async (enabled: boolean) => {
    clientRef.current?.setGraphicsEnabled(enabled)
  }, [])

  const setAvatarEnabled = useCallback(async (enabled: boolean) => {
    clientRef.current?.setAvatarEnabled(enabled)
  }, [])
  const avatarMotionProbe = useCallback(() => clientRef.current?.avatarMotionProbe() ?? null, [])
  // Plan 249 S5: one stable source for the Program preview, whichever client is current.
  const avatarMotionSource = useMemo<AvatarMotionSource>(
    () => ({
      advance: () => clientRef.current?.avatarMotionSource.advance(),
      draw: (orientation, atlasHash) =>
        clientRef.current?.avatarMotionSource.draw(orientation, atlasHash) ?? null,
      get sim() {
        return clientRef.current?.avatarMotionSource.sim ?? null
      }
    }),
    []
  )

  const setAvatarGuests = useCallback(async (enabled: boolean) => {
    clientRef.current?.setAvatarGuests(enabled)
  }, [])

  const call = useCallback(
    async <
      TMethod extends
        | 'cloud.room.open'
        | 'cloud.room.close'
        | 'cloud.room.resume'
        | 'cloud.room.invite.rotate'
        | 'cloud.room.door.set'
        | 'cloud.guest.decide'
        | 'cloud.guest.act'
        | 'cloud.stage.set'
        | 'cloud.recording.start'
        | 'cloud.recording.stop'
        | 'cloud.show.legs.end'
        | 'cloud.return.set'
    >(
      method: TMethod,
      params: Parameters<BackendClient['requestTyped']>[1],
      action: string
    ): Promise<void> => {
      if (!client) throw new Error('The room is not connected.')
      try {
        const status = (await client.requestTyped(method, params as never)) as CloudStatus
        commitCloudStatus(status)
        if (method === 'cloud.recording.start' && status.recording?.active !== true)
          throw new Error('The cloud recording did not start.')
      } catch (error) {
        onError(error, action)
        throw error
      }
    },
    [client, commitCloudStatus, onError]
  )

  const setStage = useCallback(
    async (next: CloudStage) => {
      await call(
        'cloud.stage.set',
        { ...next, ...(next.hostShape ? {} : { hostShape: hostShape() }) },
        'set the stage'
      )
    },
    [call, hostShape]
  )

  const clearRoomScene = useCallback(async () => {
    const roomClient = clientRef.current
    if (!roomClient?.sceneContent) return
    const commit = await roomClient.commitScene(null)
    if (commit.state === 'failed' || commit.state === 'waiting')
      onError(
        new Error(commit.reason ?? 'The program has not confirmed the room layout.'),
        'clear the scene'
      )
  }, [onError])

  const previewReplaced = roomOpen || previewReplacedOverride
  const value = useMemo<TalkShowContextValue>(
    () => ({
      room: snapshot,
      previewReplaced,
      hostIdentity,
      openRoom: async (params) => {
        const open = (): Promise<void> =>
          call(
            'cloud.room.open',
            { ...params, outputs: params.outputs ?? outputs() },
            'open the room'
          )
        await (clipsStepAside ? clipsStepAside(open) : open())
      },
      closeRoom: async () => {
        if (
          cloudStatusRef.current?.room?.live &&
          (!mediaDepsRef.current.stopOutput || !(await mediaDepsRef.current.stopOutput('live')))
        )
          throw new Error('The livestream must finish stopping before closing the room.')
        await call('cloud.room.close', undefined, 'close the room')
      },
      resumeRoom: async () => call('cloud.room.resume', undefined, 'resume the show'),
      rotateInvite: async () => call('cloud.room.invite.rotate', undefined, 'make a new link'),
      setDoor: async (open) => call('cloud.room.door.set', { open }, 'change the door'),
      decideGuest: async (requestId, decision) =>
        call(
          'cloud.guest.decide',
          { requestId, decision },
          decision === 'let-in' ? 'let the guest in' : 'decline the guest'
        ),
      actOnGuest: async (guestId, action, name) =>
        call(
          'cloud.guest.act',
          { guestId, action, ...(name ? { name } : {}) },
          guestActionWords(action)
        ),
      setStage,
      bringOn: async (identity) => {
        if (!stage) return
        await setStage(stageWith(stage, identity, true, hostIdentity))
      },
      sendBackstage: async (identity) => {
        if (!stage) return
        await setStage(stageWith(stage, identity, false, hostIdentity))
      },
      setLayout: async (layout) => {
        if (!stage) return
        await setStage({ ...stage, layout })
        // Plan 249 S12: choosing a room layout puts the room's own layouts
        // back on the program; a scene stays only until the host does this.
        await clearRoomScene()
      },
      setSpotlight: async (identity) => {
        if (!stage) return
        await setStage({
          ...stage,
          layout: identity ? 'spotlight' : stage.layout,
          spotlight: identity ?? undefined
        })
        if (identity) await clearRoomScene()
      },
      listDisplaySources: async () => (await window.videorc?.getTalkShowDisplaySources?.()) ?? [],
      startScreenShare: async (sourceId) => {
        const roomClient = clientRef.current
        if (!roomClient) throw new Error('The room is not open.')
        try {
          await window.videorc?.setTalkShowMediaGrant?.({ video: true, screenSourceId: sourceId })
          await roomClient.startScreenShare()
          if (stage && hostIdentity) {
            await setStage({ ...stage, layout: 'screen-people', screen: hostIdentity })
          }
        } catch (error) {
          onError(error, 'share the screen')
          throw error
        }
      },
      stopScreenShare: async () => {
        await clientRef.current?.stopScreenShare()
        if (stage && stage.screen === hostIdentity) {
          await setStage({
            ...stage,
            layout: stage.layout === 'screen-people' ? 'side-by-side' : stage.layout,
            screen: undefined
          })
        }
      },
      setGraphicsEnabled,
      setAvatarEnabled,
      avatarMotionProbe,
      avatarMotionSource,
      setAvatarGuests,
      setMonitor: async (enabled) => {
        // Plan 234 D6: a managed show has no return to subscribe to or to
        // ask for; its Program monitor draws the stage.
        const status = cloudStatusRef.current
        const roomClient = clientRef.current
        const { isManagedShow } = await import('@/lib/talk-show-managed')
        if (isManagedShow(status)) return
        roomClient?.setMonitor(enabled)
        await call(
          'cloud.return.set',
          { open: enabled },
          'show the Program monitor to the room'
        ).catch(() => {})
      },
      setMicrophoneMuted: async (muted) => {
        if (!clientRef.current) throw new Error('The room is not connected.')
        try {
          await clientRef.current.setMicrophoneMuted(muted)
        } catch (error) {
          onError(error, 'change the room microphone')
          throw error
        }
      },
      setCameraOff: async (off) => {
        if (!clientRef.current) throw new Error('The room is not connected.')
        try {
          await clientRef.current.setCameraOff(off)
        } catch (error) {
          onError(error, 'change the room camera')
          throw error
        }
      },
      startCloudRecording: async () =>
        call('cloud.recording.start', undefined, 'start the recording'),
      stopCloudRecording: async () => {
        if (
          !mediaDepsRef.current.stopOutput ||
          !(await mediaDepsRef.current.stopOutput('recording'))
        ) {
          const error = new Error('The cloud recording has not stopped.')
          onError(error, 'stop the cloud recording')
          throw error
        }
      },
      endTalkShowLivestream: async () => {
        if (!mediaDepsRef.current.stopOutput || !(await mediaDepsRef.current.stopOutput('live'))) {
          const error = new Error('The livestream has not stopped.')
          onError(error, 'end the livestream')
          throw error
        }
      }
    }),
    [
      call,
      clearRoomScene,
      clipsStepAside,
      setGraphicsEnabled,
      setAvatarEnabled,
      avatarMotionProbe,
      avatarMotionSource,
      setAvatarGuests,
      hostIdentity,
      onError,
      outputs,
      previewReplaced,
      setStage,
      snapshot,
      stage
    ]
  )

  return value
}
