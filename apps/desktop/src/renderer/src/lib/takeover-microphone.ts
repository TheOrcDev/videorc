import { useMemo } from 'react'

import { useStudioCloud, useStudioCore } from '@/hooks/use-studio'
import {
  loadScreenTakeoverMuteOwnership,
  type ScreenTakeoverMuteOwnership
} from '@/lib/screen-takeover-microphone'
import type { SourceStatus } from '@/lib/source-status'

// Live show 2026-11-20: the takeover muted the owner and nothing in the Studio
// said so. Its own module, imported only by the lazy surfaces that show it
// (the mic rows and the Show stage), so none of it lands in the renderer's
// entry chunk, whose gzip budget is full.

/**
 * What a takeover is doing to the host's voice.
 * - `stream`: a room is open, so the program page silences speech (D3); the
 *   microphone setting is untouched and guests still hear the host.
 * - `microphone`: no room, and the takeover itself muted a live microphone,
 *   so it comes back when the takeover ends.
 */
export type TakeoverMicrophoneHold = 'stream' | 'microphone' | null

export function takeoverMicrophoneHold(input: {
  active: boolean
  roomOpen: boolean
  microphoneMuted: boolean
  ownership: ScreenTakeoverMuteOwnership | null
}): TakeoverMicrophoneHold {
  if (!input.active) return null
  if (input.roomOpen) return 'stream'
  return input.microphoneMuted && input.ownership?.priorMicrophoneMuted === false
    ? 'microphone'
    : null
}

/**
 * The hold from the Studio's state. The ownership record is read from storage:
 * `commitActiveScreen` writes it in the same step as the screen and the mute it
 * goes with, so it is current on every render those changes cause.
 */
export function useTakeoverMicrophoneHold(): TakeoverMicrophoneHold {
  const { activeScreen, captureConfig } = useStudioCore()
  const roomOpen = useStudioCloud().cloudStatus?.room?.phase === 'open'
  const active = activeScreen !== null
  const microphoneMuted = captureConfig.audio.microphoneMuted
  return useMemo(
    () =>
      takeoverMicrophoneHold({
        active,
        roomOpen,
        microphoneMuted,
        ownership: active && !roomOpen ? loadScreenTakeoverMuteOwnership() : null
      }),
    [active, roomOpen, microphoneMuted]
  )
}

/** The one status word for both holds, on every surface that mirrors the microphone. */
export const TAKEOVER_MUTED_LABEL = 'Muted for takeover'

export const TAKEOVER_MUTED_HINT: Record<Exclude<TakeoverMicrophoneHold, null>, string> = {
  stream: "Your audience can't hear you until the takeover ends. Guests in the room still can.",
  microphone: 'Your microphone comes back on when the takeover ends.'
}

/** The Sources row's chip for a hold, with its line; null without one. */
export function takeoverMicrophoneStatus(hold: TakeoverMicrophoneHold): SourceStatus | null {
  return hold
    ? { label: TAKEOVER_MUTED_LABEL, tone: 'neutral', hint: TAKEOVER_MUTED_HINT[hold] }
    : null
}
