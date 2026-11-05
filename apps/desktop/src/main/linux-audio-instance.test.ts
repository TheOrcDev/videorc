import { describe, expect, it } from 'vitest'

import { linuxPulseProp } from './linux-audio-instance'

describe('linuxPulseProp', () => {
  it('marks Linux playback with the main process pid only', () => {
    expect(linuxPulseProp('linux', undefined, 4242)).toBe('videorc.app-instance=4242')
    expect(linuxPulseProp('darwin', undefined, 4242)).toBeUndefined()
    expect(linuxPulseProp('win32', 'media.role=music', 4242)).toBeUndefined()
  })

  it('keeps properties a user or harness already set', () => {
    expect(linuxPulseProp('linux', 'media.role=music', 7)).toBe(
      'media.role=music videorc.app-instance=7'
    )
  })

  it('replaces a marker inherited from another Videorc process', () => {
    expect(linuxPulseProp('linux', 'videorc.app-instance=1 media.role=music', 9)).toBe(
      'media.role=music videorc.app-instance=9'
    )
    expect(linuxPulseProp('linux', `a=1 videorc.app-instance="3 4"  b=2`, 9)).toBe(
      'a=1 b=2 videorc.app-instance=9'
    )
  })
})
