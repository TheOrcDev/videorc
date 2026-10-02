type FrameListener = (nowMs: number) => void

const listeners = new Set<FrameListener>()
let handle: number | null = null

const reportError = (error: unknown) => {
  queueMicrotask(() => {
    throw error
  })
}

const tick = (nowMs: number) => {
  handle = null
  for (const listener of listeners) {
    try {
      listener(nowMs)
    } catch (error) {
      reportError(error)
    }
  }
  if (listeners.size > 0) {
    handle = requestAnimationFrame(tick)
  }
}

/**
 * Runs `listener` on every animation frame, on one loop shared by the whole
 * page. The loop stops when nothing is subscribed, and the browser pauses it
 * while the tab is hidden. Returns an unsubscribe function.
 */
export const subscribeFrame = (listener: FrameListener): (() => void) => {
  listeners.add(listener)
  if (handle === null && typeof requestAnimationFrame === 'function') {
    handle = requestAnimationFrame(tick)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && handle !== null) {
      cancelAnimationFrame(handle)
      handle = null
    }
  }
}

/** One frame of a task. Return true while the task needs another frame. */
export type FrameTaskStep = (nowMs: number) => boolean

export interface FrameTask {
  /** Runs the step again from the next frame, if the task is asleep. */
  wake: () => void
  /** Stops the task for good. A stopped task ignores `wake`. */
  stop: () => void
}

/**
 * Runs `step` on the shared loop for as long as it returns true. When it
 * returns false the task sleeps and requests no frames until `wake()`, so a
 * settled, silent or hidden painter costs nothing. The task starts awake.
 */
export const createFrameTask = (step: FrameTaskStep): FrameTask => {
  let stopped = false
  let unsubscribe: (() => void) | null = null

  const sleep = () => {
    unsubscribe?.()
    unsubscribe = null
  }

  const run = (nowMs: number) => {
    if (!step(nowMs)) {
      sleep()
    }
  }

  const wake = () => {
    if (!stopped && unsubscribe === null) {
      unsubscribe = subscribeFrame(run)
    }
  }

  wake()

  return {
    stop: () => {
      stopped = true
      sleep()
    },
    wake
  }
}

/** The longest step a painter clock takes, so waking never jumps. */
export const MAX_FRAME_GAP_MS = 100

/**
 * A clock that follows the frames but never advances more than
 * `MAX_FRAME_GAP_MS` at once. A painter that slept, or ran in a hidden tab,
 * resumes its ballistics where they were instead of jumping to the end.
 */
export const createPainterClock = (): ((nowMs: number) => number) => {
  let lastMs: number | null = null
  let clockMs = 0
  return (nowMs) => {
    if (lastMs !== null) {
      clockMs += Math.min(Math.max(0, nowMs - lastMs), MAX_FRAME_GAP_MS)
    }
    lastMs = nowMs
    return clockMs
  }
}
