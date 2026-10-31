type FrameListener = (nowMs: number) => void
type FramePhase = 'update' | 'paint'

const listeners = {
  paint: new Set<FrameListener>(),
  update: new Set<FrameListener>()
}
let handle: number | null = null
let ticking = false

const hasListeners = () => listeners.update.size + listeners.paint.size > 0

const reportError = (error: unknown) => {
  queueMicrotask(() => {
    throw error
  })
}

const tick = (nowMs: number) => {
  handle = null
  ticking = true
  for (const phase of [listeners.update, listeners.paint]) {
    for (const listener of phase) {
      try {
        listener(nowMs)
      } catch (error) {
        reportError(error)
      }
    }
  }
  ticking = false
  if (hasListeners() && handle === null) {
    handle = requestAnimationFrame(tick)
  }
}

/**
 * Runs sources in the update phase, then renderers in the default paint phase.
 * One loop serves the whole page and stops when nothing is subscribed.
 * The browser pauses it while the tab is hidden.
 */
export const subscribeFrame = (
  listener: FrameListener,
  phase: FramePhase = 'paint'
): (() => void) => {
  listeners[phase].add(listener)
  if (handle === null && !ticking && typeof requestAnimationFrame === 'function') {
    handle = requestAnimationFrame(tick)
  }
  return () => {
    listeners[phase].delete(listener)
    if (!hasListeners() && handle !== null) {
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
