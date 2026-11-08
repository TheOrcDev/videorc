// Plan 189: a pad's progress while its sound plays, from the voice's start
// and length, as an audiocn frame source: the bar moves every frame with no
// React render, and the source leaves the frame loop when the sound reaches
// its end (or the pad stops listening).

import { clamp } from '@/lib/audio/decibels'
import { subscribeFrame } from '@/lib/audio/frame-loop'
import type { FrameSource } from '@/lib/audio/types'

/** 0..1 through the sound at `nowMs` (wall clock, like `startedAtMs`). */
export function voiceProgress(
  voice: { startedAtMs: number; durationMs: number },
  nowMs: number
): number {
  return voice.durationMs > 0 ? clamp((nowMs - voice.startedAtMs) / voice.durationMs, 0, 1) : 1
}

export function createVoiceProgressSource(
  voice: { startedAtMs: number; durationMs: number },
  now: () => number = Date.now
): FrameSource<number> {
  return {
    subscribe: (listener) => {
      let stopped = false
      let off: (() => void) | null = null
      const tick = (): void => {
        const progress = voiceProgress(voice, now())
        listener(progress)
        if (progress >= 1) {
          stopped = true
          off?.()
        }
      }
      tick()
      if (!stopped) off = subscribeFrame(tick)
      return () => {
        stopped = true
        off?.()
      }
    }
  }
}
