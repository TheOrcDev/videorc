import { describe, expect, it } from 'vitest'

import { releaseTrackLabel } from './release-track'

describe('releaseTrackLabel', () => {
  it('names the track each platform ships on', () => {
    expect(releaseTrackLabel('darwin', true)).toBe('Beta')
    expect(releaseTrackLabel('win32', true)).toBe('Alpha')
    // Release test 146, plan 0006: the Linux AppImage ships as an Alpha too.
    expect(releaseTrackLabel('linux', true)).toBe('Alpha')
  })

  it('calls an unpackaged build a development build', () => {
    expect(releaseTrackLabel('darwin', false)).toBe('Development')
    expect(releaseTrackLabel('win32', false)).toBe('Development')
    expect(releaseTrackLabel('linux', false)).toBe('Development')
  })
})
