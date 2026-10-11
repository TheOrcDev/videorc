import { describe, expect, it } from 'vitest'

import { skippedReleasesLine } from './whats-new-dialog'

// Plan 174 S3.21 (A-19): the dialog shows the newest release and names the
// ones the streamer skipped on the way.
describe('skippedReleasesLine', () => {
  it('says nothing when only the newest release is new', () => {
    expect(skippedReleasesLine([])).toBeNull()
  })

  it('names one, two or more skipped releases', () => {
    expect(skippedReleasesLine(['0.9.139'])).toBe('Also includes 0.9.139.')
    expect(skippedReleasesLine(['0.9.139', '0.9.138'])).toBe('Also includes 0.9.139 and 0.9.138.')
    expect(skippedReleasesLine(['0.9.139', '0.9.138-beta.2', '0.9.137'])).toBe(
      'Also includes 0.9.139, 0.9.138 Beta 2 and 0.9.137.'
    )
  })
})
