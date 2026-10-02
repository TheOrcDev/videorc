import { describe, expect, it } from 'vitest'

import type { AudioLevelsEvent } from './backend'
import {
  BACKEND_AUDIO_LEVELS_STALE_MS,
  createBackendAudioLevelsStore
} from './backend-audio-levels'

/** A clock the test moves by hand, with timers it fires itself. */
function manualClock() {
  let now = 0
  const timers: Array<{ at: number; callback: () => void }> = []
  return {
    now: () => now,
    setTimer: (callback: () => void, delayMs: number) => {
      timers.push({ at: now + delayMs, callback })
    },
    advance(ms: number) {
      now += ms
      for (const timer of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (timer.at <= now) timer.callback()
        else timers.push(timer)
      }
    },
    pending: () => timers.length
  }
}

const event: AudioLevelsEvent = {
  sessionId: 'session-1',
  microphone: { peakDb: -12, rmsDb: -20 },
  masterClippedSamples: 0
}

describe('backend audio levels store (plan 092 Phase C)', () => {
  it('delivers every event and goes live on the first one', () => {
    const clock = manualClock()
    const store = createBackendAudioLevelsStore(clock)
    const seen: AudioLevelsEvent[] = []
    store.subscribe((next) => seen.push(next))
    expect(store.isLive()).toBe(false)
    store.publish(event)
    store.publish(event)
    expect(seen).toHaveLength(2)
    expect(store.isLive()).toBe(true)
  })

  it('notifies liveness only on transitions, never per event', () => {
    const clock = manualClock()
    const store = createBackendAudioLevelsStore(clock)
    let changes = 0
    store.subscribeLive(() => {
      changes += 1
    })
    for (let index = 0; index < 20; index += 1) {
      store.publish(event)
      clock.advance(50)
    }
    expect(changes).toBe(1)
    expect(clock.pending()).toBe(1)
  })

  it('goes stale once events stop for the stale window, and live again after', () => {
    const clock = manualClock()
    const store = createBackendAudioLevelsStore(clock)
    store.publish(event)
    clock.advance(BACKEND_AUDIO_LEVELS_STALE_MS - 100)
    store.publish(event)
    clock.advance(500)
    expect(store.isLive()).toBe(true)
    clock.advance(BACKEND_AUDIO_LEVELS_STALE_MS)
    expect(store.isLive()).toBe(false)
    store.publish(event)
    expect(store.isLive()).toBe(true)
  })
})
