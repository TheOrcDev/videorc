import { useEffect, useMemo, useState } from 'react'

import {
  NO_TALK_SHOW,
  useTalkShowRoomController,
  type TalkShowContextValue,
  type TalkShowRoomControllerDeps
} from '@/hooks/use-talk-show-room'
import { roomProgramCamera } from '@/hooks/use-room-program-camera'
import type { CloudStatus } from '@/lib/backend'
import type { TalkShowRoomSnapshot } from '@/lib/talk-show-room'

// Plan 224 C-G4: the talk show's room controller, mounted lazily under the
// Studio provider so the eager bundle carries only the idle value. It draws
// nothing; it runs the controller and hands its value to the cloud context.
// Its state lives here, below the provider, so a room snapshot never
// re-renders the whole Studio.

/**
 * DEV only (C-G2, C-G3 screenshots and probes): a scripted room with no
 * LiveKit and no backend behind it. The Guests tab and the Show stage read
 * the scripted status and snapshot; the controller itself never joins.
 */
type TalkShowScript = {
  cloudStatus: CloudStatus
  room?: Partial<TalkShowRoomSnapshot>
  hostIdentity?: string
}

export default function TalkShowRoomHost({
  deps,
  onValue
}: {
  deps: TalkShowRoomControllerDeps
  onValue: (value: TalkShowContextValue) => void
}): null {
  const value = useTalkShowRoomController(deps)
  const [script, setScript] = useState<TalkShowScript | null>(null)

  // Plan 234: a cloud recording that stops is reported to the Library's
  // Cloud recordings section, which then waits for its row (both lazy).
  const recordingActive = deps.cloudStatus?.recording?.active ?? false
  const recordingSince = deps.cloudStatus?.recording?.since
  useEffect(() => {
    const nowMs = Date.now()
    void import('@/lib/cloud-recordings-watch').then((watch) =>
      watch.noteCloudRecording({ active: recordingActive, since: recordingSince }, nowMs)
    )
  }, [recordingActive, recordingSince])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const smokeWindow = window as Window & {
      __videorcSmokeScriptTalkShow?: (next: TalkShowScript | null) => boolean
    }
    smokeWindow.__videorcSmokeScriptTalkShow = (next) => {
      setScript(next)
      return next !== null
    }
    return () => {
      delete smokeWindow.__videorcSmokeScriptTalkShow
    }
  }, [])

  const shown = useMemo<TalkShowContextValue>(() => {
    if (!script) return value
    const showId = script.cloudStatus.show?.id ?? 'scripted'
    // Every action is a no-op: no backend or room stands behind the script.
    return {
      ...NO_TALK_SHOW,
      room: { ...value.room, ...script.room },
      hostIdentity: script.hostIdentity ?? `host:${showId}`,
      previewReplaced: true,
      scriptedCloudStatus: script.cloudStatus
    }
  }, [script, value])

  useEffect(() => {
    onValue(shown)
  }, [onValue, shown])
  useEffect(() => () => onValue(NO_TALK_SHOW), [onValue])

  // Plan 249 S23 (D10): the room program on Videorc Camera belongs to one
  // room; it ends with that room (Videorc Camera returns to its Studio source).
  const hostIdentity = shown.hostIdentity
  useEffect(() => {
    void roomProgramCamera.retire(hostIdentity).catch(() => {})
  }, [hostIdentity])
  useEffect(() => () => void roomProgramCamera.setOn(false, null).catch(() => {}), [])
  return null
}
