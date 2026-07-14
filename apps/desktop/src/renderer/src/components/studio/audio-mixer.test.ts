import { describe, expect, it } from 'vitest'

import { audioMixerNotice } from './audio-mixer'

describe('audioMixerNotice', () => {
  it.each(['silent', 'no-frames'] as const)(
    'lets an exact permission action outrank stale %s meter evidence',
    (meterStatus) => {
      expect(audioMixerNotice('open-settings', meterStatus, true)).toBe('permission')
    }
  )

  it('retains meter and device recovery copy when no permission action exists', () => {
    expect(audioMixerNotice(null, 'no-frames', true)).toBe('no-frames')
    expect(audioMixerNotice(null, 'unavailable', true)).toBe('device-issue')
  })
})
