'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { CLIP_HOLD_MS, CLIP_THRESHOLD_DB } from '@/lib/audio/zones'

export interface UseClipHoldOptions {
  /** Levels at or above this count as a clip. Default −1 dBFS. */
  thresholdDb?: number
  /** How long the clip state holds. `Infinity` latches until `reset()`. Default 1500 ms. */
  holdMs?: number
  onClippingChange?: (clipping: boolean) => void
}

export interface ClipHold {
  clipping: boolean
  /** Number of separate clips since mount or the last reset. */
  count: number
  /** Feed every level reading here. */
  report: (db: number) => void
  reset: () => void
}

export const useClipHold = ({
  thresholdDb = CLIP_THRESHOLD_DB,
  holdMs = CLIP_HOLD_MS,
  onClippingChange
}: UseClipHoldOptions = {}): ClipHold => {
  const [clipping, setClipping] = useState(false)
  const [count, setCount] = useState(0)
  const clippingRef = useRef(false)
  const aboveRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onChangeRef = useRef(onClippingChange)

  useEffect(() => {
    onChangeRef.current = onClippingChange
  })

  const update = useCallback((next: boolean) => {
    if (clippingRef.current === next) {
      return
    }
    clippingRef.current = next
    setClipping(next)
    onChangeRef.current?.(next)
  }, [])

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const scheduleRelease = useCallback(() => {
    clearTimer()
    if (Number.isFinite(holdMs)) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        update(false)
      }, holdMs)
    }
  }, [clearTimer, holdMs, update])

  const report = useCallback(
    (db: number) => {
      const above = db >= thresholdDb
      const wasAbove = aboveRef.current
      aboveRef.current = above
      if (!above) {
        return
      }
      if (!wasAbove) {
        setCount((previous) => previous + 1)
      }
      update(true)
      scheduleRelease()
    },
    [scheduleRelease, thresholdDb, update]
  )

  const reset = useCallback(() => {
    clearTimer()
    aboveRef.current = false
    setCount(0)
    update(false)
  }, [clearTimer, update])

  useEffect(() => {
    // An Activity hide cancels a pending release; re-arm it on show so the
    // light doesn't stay on.
    if (clippingRef.current && timerRef.current === null) {
      scheduleRelease()
    }
    return clearTimer
  }, [clearTimer, scheduleRelease])

  return { clipping, count, report, reset }
}
