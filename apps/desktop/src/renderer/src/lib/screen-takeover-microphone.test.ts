import { describe, expect, it } from 'vitest'

import {
  loadScreenTakeoverMuteOwnership,
  persistScreenTakeoverMuteOwnership,
  screenTakeoverMicrophoneTransition,
  SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY
} from './screen-takeover-microphone'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    }
  }
}

describe('screen takeover microphone ownership', () => {
  it('mutes a newly observed takeover and restores an originally-live microphone', () => {
    const active = screenTakeoverMicrophoneTransition({
      active: true,
      microphoneMuted: false,
      ownership: null
    })
    expect(active).toEqual({
      microphoneMuted: true,
      ownership: { priorMicrophoneMuted: false }
    })

    expect(
      screenTakeoverMicrophoneTransition({
        active: false,
        microphoneMuted: active.microphoneMuted,
        ownership: active.ownership
      })
    ).toEqual({ microphoneMuted: false, ownership: null })
  })

  it('round-trips ownership across reload without reasserting over a manual unmute', () => {
    const storage = memoryStorage()
    const first = screenTakeoverMicrophoneTransition({
      active: true,
      microphoneMuted: false,
      ownership: null
    })
    persistScreenTakeoverMuteOwnership(first.ownership, storage)

    const reloadedOwnership = loadScreenTakeoverMuteOwnership(storage)
    expect(reloadedOwnership).toEqual({ priorMicrophoneMuted: false })
    expect(
      screenTakeoverMicrophoneTransition({
        active: true,
        microphoneMuted: false,
        ownership: reloadedOwnership
      })
    ).toEqual({ microphoneMuted: false, ownership: reloadedOwnership })

    persistScreenTakeoverMuteOwnership(null, storage)
    expect(storage.getItem(SCREEN_TAKEOVER_MUTE_OWNERSHIP_STORAGE_KEY)).toBeNull()
  })

  it('never unmutes a microphone that was already muted before takeover', () => {
    const active = screenTakeoverMicrophoneTransition({
      active: true,
      microphoneMuted: true,
      ownership: null
    })
    expect(
      screenTakeoverMicrophoneTransition({
        active: false,
        microphoneMuted: true,
        ownership: active.ownership
      })
    ).toEqual({ microphoneMuted: true, ownership: null })
  })
})
