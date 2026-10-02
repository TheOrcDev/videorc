'use client'

import { useEffect, useEffectEvent } from 'react'

import type { FrameSource } from '@/lib/audio/types'

export interface UseFrameSourceOptions {
  /** Pause the subscription without unmounting. Default true. */
  enabled?: boolean
}

/**
 * Subscribes `onFrame` to a frame source. The callback can change on every
 * render without resubscribing.
 */
export const useFrameSource = <T>(
  source: FrameSource<T> | null | undefined,
  onFrame: (frame: T) => void,
  { enabled = true }: UseFrameSourceOptions = {}
): void => {
  const handleFrame = useEffectEvent(onFrame)

  useEffect(() => {
    if (!(source && enabled)) {
      return
    }
    return source.subscribe((frame) => {
      handleFrame(frame)
    })
  }, [source, enabled])
}
