import { describe, expect, it } from 'vitest'

import { buddyOffOutputsNotice } from '@/lib/buddy-output-notice'

const LIVE_AND_OFF = {
  enabled: true,
  onAir: true,
  showOnStream: false,
  showInRecording: false,
  name: 'Golmar'
}

describe('buddyOffOutputsNotice', () => {
  it('says so when Buddy Live runs on air with both outputs off', () => {
    expect(buddyOffOutputsNotice(LIVE_AND_OFF)).toEqual({
      title: "Golmar isn't on stream.",
      detail: "Viewers can't see it, its bubbles or its reactions.",
      action: 'Show on stream'
    })
  })

  it('treats a seed without the recording switch as off (an older Studio)', () => {
    const { showInRecording: _dropped, ...withoutRecording } = LIVE_AND_OFF
    expect(buddyOffOutputsNotice(withoutRecording)?.title).toBe("Golmar isn't on stream.")
    expect(buddyOffOutputsNotice({ ...withoutRecording, showInRecording: null })).not.toBeNull()
  })

  it('falls back to Buddy for a nameless persona', () => {
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, name: null })?.title).toBe(
      "Buddy isn't on stream."
    )
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, name: '  ' })?.title).toBe(
      "Buddy isn't on stream."
    )
  })

  it('stays quiet while an output carries the Buddy', () => {
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, showOnStream: true })).toBeNull()
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, showInRecording: true })).toBeNull()
  })

  it('stays quiet while Buddy Live is off, nothing is on air, or the relay has no Buddy', () => {
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, enabled: false })).toBeNull()
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, onAir: false })).toBeNull()
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, showOnStream: null })).toBeNull()
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, showOnStream: undefined })).toBeNull()
  })
})
