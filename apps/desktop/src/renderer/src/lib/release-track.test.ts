import { describe, expect, it } from 'vitest'

import { releaseTrackLabel } from './release-track'

describe('releaseTrackLabel', () => {
  it('names the track each platform ships on', () => {
    expect(releaseTrackLabel('darwin', true)).toBe('Beta')
    expect(releaseTrackLabel('win32', true)).toBe('Alpha')
  })

  it('calls an unpackaged build a development build', () => {
    expect(releaseTrackLabel('darwin', false)).toBe('Development')
    expect(releaseTrackLabel('win32', false)).toBe('Development')
  })
})
