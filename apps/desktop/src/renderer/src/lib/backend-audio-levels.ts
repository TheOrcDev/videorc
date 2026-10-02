// Plan 092 Phase C: the backend's `audio.levels` events, about 20 a second
// while a session's audio bus runs, kept outside React. use-studio publishes
// each event here; the Studio mixer's level sources (a lazy chunk) subscribe.
// Liveness notifies only when levels start or stop arriving, never per event,
// so React re-renders twice a session at most. No dependencies: this module is
// in the eager bundle.

import type { AudioLevelsEvent } from './backend'

/** Levels older than this mean the bus stopped sending (session over or stalled). */
export const BACKEND_AUDIO_LEVELS_STALE_MS = 1000

type LevelsListener = (event: AudioLevelsEvent) => void

export type BackendAudioLevelsStore = {
  publish: (event: AudioLevelsEvent) => void
  subscribe: (listener: LevelsListener) => () => void
  /** True while events keep arriving (each within the stale window). */
  isLive: () => boolean
  subscribeLive: (listener: () => void) => () => void
}

type StoreClock = {
  now: () => number
  setTimer: (callback: () => void, delayMs: number) => unknown
}

const browserClock: StoreClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs)
}

export function createBackendAudioLevelsStore(
  clock: StoreClock = browserClock
): BackendAudioLevelsStore {
  const listeners = new Set<LevelsListener>()
  const liveListeners = new Set<() => void>()
  let live = false
  let lastAt = Number.NEGATIVE_INFINITY
  let timerPending = false

  const setLive = (next: boolean): void => {
    if (live === next) return
    live = next
    for (const listener of liveListeners) listener()
  }

  // One timer a second at most: it re-arms for the time left instead of
  // being reset by every event.
  const watchStaleness = (delayMs: number): void => {
    timerPending = true
    clock.setTimer(() => {
      timerPending = false
      const idleMs = clock.now() - lastAt
      if (idleMs >= BACKEND_AUDIO_LEVELS_STALE_MS) {
        setLive(false)
      } else {
        watchStaleness(BACKEND_AUDIO_LEVELS_STALE_MS - idleMs)
      }
    }, delayMs)
  }

  return {
    publish(event) {
      lastAt = clock.now()
      if (!timerPending) watchStaleness(BACKEND_AUDIO_LEVELS_STALE_MS)
      setLive(true)
      for (const listener of listeners) listener(event)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    isLive: () => live,
    subscribeLive(listener) {
      liveListeners.add(listener)
      return () => {
        liveListeners.delete(listener)
      }
    }
  }
}

/** The app's one store: use-studio publishes, the mixer reads. */
export const backendAudioLevels = createBackendAudioLevelsStore()
