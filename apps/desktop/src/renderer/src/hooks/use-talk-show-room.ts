import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { BackendClient } from '@/backendClient'
import type {
  CloudRoomOpenParams,
  CloudRoomTokenAnswer,
  CloudStage,
  CloudStatus,
  Device
} from '@/lib/backend'
import {
  IDLE_TALK_SHOW_SNAPSHOT,
  NO_TALK_SHOW,
  type TalkShowContextValue
} from '@/lib/talk-show-context'
import type { TalkShowRoomClient, TalkShowRoomSnapshot } from '@/lib/talk-show-room'

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

export type TalkShowRoomControllerDeps = {
  client: BackendClient | null
  cloudStatus: CloudStatus | null
  commitCloudStatus: (status: CloudStatus) => void
  /** The Sources page's camera and microphone ids and the device list, for
   * the names Chromium labels its devices with. */
  cameraId: string | null
  microphoneId: string | null
  devices: readonly Device[]
  /** The outputs a Go Live would create the show with (the stream settings). */
  outputs: () => CloudRoomOpenParams['outputs']
  /** The host's camera shape from Sources (D8). */
  hostShape: () => CloudStage['hostShape']
  /** Called once the room closed and the backend returned the camera (D6). */
  onCameraReturned: () => void
  /** A refusal or a failure, in the Studio's words. */
  onError: (error: unknown, action: string) => void
  /** The lifecycle probe's scripted room (DEV only): hides the Preview with
   * no LiveKit room behind it. */
  previewReplacedOverride: boolean
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
    previewReplacedOverride
  } = deps
  const [snapshot, setSnapshot] = useState<TalkShowRoomSnapshot>(IDLE_SNAPSHOT)
  const clientRef = useRef<TalkShowRoomClient | null>(null)
  const joiningRef = useRef<Promise<void> | null>(null)
  const audioHostRef = useRef<HTMLElement | null>(null)
  const roomPhase = cloudStatus?.room?.phase ?? 'closed'
  const roomOpen = roomPhase === 'open'
  const showId = cloudStatus?.show?.id ?? null
  const stage = cloudStatus?.room?.stage ?? null
  const stageKey = stage ? JSON.stringify(stage.onStage) : ''
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
  const cameraNameRef = useRef(cameraName)
  const microphoneNameRef = useRef(microphoneName)
  cameraNameRef.current = cameraName
  microphoneNameRef.current = microphoneName
  const stageRef = useRef<string[]>([])
  stageRef.current = stage?.onStage ?? []
  const onCameraReturnedRef = useRef(onCameraReturned)
  onCameraReturnedRef.current = onCameraReturned

  const requestToken = useCallback(async (): Promise<CloudRoomTokenAnswer> => {
    if (!client) throw new Error('Videorc is offline.')
    return client.requestTyped('cloud.room.token.refresh')
  }, [client])

  const report = useCallback(
    (state: TalkShowRoomSnapshot['state'], detail?: string) => {
      if (!client) return
      void client
        .requestTyped('cloud.room.client.report', { state, ...(detail ? { detail } : {}) })
        .then(commitCloudStatus)
        .catch(() => {})
    },
    [client, commitCloudStatus]
  )

  // Join when the room opens, leave when it closes (D6: the backend lent the
  // camera before the status said `open`; it takes it back after the leave).
  useEffect(() => {
    if (!roomOpen || !client) {
      const current = clientRef.current
      if (current) {
        clientRef.current = null
        void current.disconnect().finally(() => {
          void window.videorc?.setTalkShowMediaGrant?.({ video: false, screenSourceId: null })
          onCameraReturnedRef.current()
        })
      }
      return
    }
    if (clientRef.current || joiningRef.current) return
    joiningRef.current = (async () => {
      try {
        // Camera video and the screen share need main's grant while the room
        // is open (the renderer's web permissions allow audio only).
        await window.videorc?.setTalkShowMediaGrant?.({ video: true, screenSourceId: null })
        const { TalkShowRoomClient } = await loadRoomClient()
        if (!audioHostRef.current) {
          const host = document.createElement('div')
          host.setAttribute('data-talk-show-audio-host', '')
          host.style.display = 'none'
          document.body.appendChild(host)
          audioHostRef.current = host
        }
        const roomClient = new TalkShowRoomClient({
          requestToken,
          report,
          onSnapshot: setSnapshot,
          cameraName: cameraNameRef.current,
          microphoneName: microphoneNameRef.current,
          audioHost: () => audioHostRef.current
        })
        clientRef.current = roomClient
        await roomClient.sendStage(stageRef.current)
        await roomClient.connect()
      } catch (error) {
        onError(error, 'join the room')
        report('disconnected', error instanceof Error ? error.message : String(error))
      } finally {
        joiningRef.current = null
      }
    })()
  }, [client, onError, report, requestToken, roomOpen])

  // The guest page reads the stage from the host's data topic (D11).
  useEffect(() => {
    if (!roomOpen) return
    void clientRef.current?.sendStage(stageRef.current)
  }, [roomOpen, stageKey])

  useEffect(
    () => () => {
      const current = clientRef.current
      clientRef.current = null
      void current?.disconnect()
      audioHostRef.current?.remove()
      audioHostRef.current = null
    },
    []
  )

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
      if (!client) return
      try {
        const status = (await client.requestTyped(method, params as never)) as CloudStatus
        commitCloudStatus(status)
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

  const previewReplaced = roomOpen || previewReplacedOverride
  const value = useMemo<TalkShowContextValue>(
    () => ({
      room: snapshot,
      previewReplaced,
      hostIdentity,
      openRoom: async (params) =>
        call(
          'cloud.room.open',
          { ...params, outputs: params.outputs ?? outputs() },
          'open the room'
        ),
      closeRoom: async () => call('cloud.room.close', undefined, 'close the room'),
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
        call('cloud.guest.act', { guestId, action, ...(name ? { name } : {}) }, action),
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
      },
      setSpotlight: async (identity) => {
        if (!stage) return
        await setStage({
          ...stage,
          layout: identity ? 'spotlight' : stage.layout,
          spotlight: identity ?? undefined
        })
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
      setMonitor: async (enabled) => {
        clientRef.current?.setMonitor(enabled)
        await call('cloud.return.set', { open: enabled }, 'show the Program monitor for').catch(
          () => {}
        )
      },
      setMicrophoneMuted: async (muted) => clientRef.current?.setMicrophoneMuted(muted),
      setCameraOff: async (off) => clientRef.current?.setCameraOff(off),
      startCloudRecording: async () =>
        call('cloud.recording.start', undefined, 'start the recording'),
      stopCloudRecording: async () => call('cloud.recording.stop', undefined, 'stop the recording'),
      endTalkShowLivestream: async () =>
        call('cloud.show.legs.end', undefined, 'end the livestream')
    }),
    [call, hostIdentity, onError, outputs, previewReplaced, setStage, snapshot, stage]
  )

  return value
}
