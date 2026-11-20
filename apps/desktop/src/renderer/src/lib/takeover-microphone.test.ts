import { describe, expect, it } from 'vitest'

import { takeoverMicrophoneHold, takeoverMicrophoneStatus } from './takeover-microphone'

describe('takeoverMicrophoneHold', () => {
  const live = { priorMicrophoneMuted: false }
  it('says nothing without a takeover', () => {
    expect(
      takeoverMicrophoneHold({
        active: false,
        roomOpen: true,
        microphoneMuted: true,
        ownership: live
      })
    ).toBeNull()
  })

  it('holds the stream while a room is open, whatever the microphone setting', () => {
    expect(
      takeoverMicrophoneHold({
        active: true,
        roomOpen: true,
        microphoneMuted: false,
        ownership: null
      })
    ).toBe('stream')
  })

  it('holds the microphone only when the takeover muted a live one', () => {
    expect(
      takeoverMicrophoneHold({
        active: true,
        roomOpen: false,
        microphoneMuted: true,
        ownership: live
      })
    ).toBe('microphone')
    // Already muted before the takeover: the mute is the streamer's.
    expect(
      takeoverMicrophoneHold({
        active: true,
        roomOpen: false,
        microphoneMuted: true,
        ownership: { priorMicrophoneMuted: true }
      })
    ).toBeNull()
    // Unmuted by hand during the takeover: the microphone is live.
    expect(
      takeoverMicrophoneHold({
        active: true,
        roomOpen: false,
        microphoneMuted: false,
        ownership: live
      })
    ).toBeNull()
  })
})

describe('takeoverMicrophoneStatus', () => {
  it('is one word for both holds, with when it ends as its line', () => {
    expect(takeoverMicrophoneStatus(null)).toBeNull()
    expect(takeoverMicrophoneStatus('stream')).toEqual({
      label: 'Muted for takeover',
      tone: 'neutral',
      hint: "Your audience can't hear you until the takeover ends. Guests in the room still can."
    })
    expect(takeoverMicrophoneStatus('microphone')?.label).toBe('Muted for takeover')
  })
})
