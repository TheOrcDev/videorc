import { describe, expect, it } from 'vitest'

import {
  X_LOGO_WHITE_DATA_URL,
  X_VERIFIED_DATA_URL,
  YOUTUBE_ICON_DATA_URL
} from './brand-mark-data'
import { X_LOCKUP_URL, X_LOGO_WHITE_URL, X_VERIFIED_URL } from './x-mark'
import { YOUTUBE_ICON_URL } from './youtube-mark'

// Plan 189: the highlight card reads its canvas back, and the packaged
// renderer is a file:// page, so a file image would taint it. Its marks stay
// data URIs; the React marks are files, out of the eager bundle.
describe('brand mark copies', () => {
  it('gives the canvas card data URIs only', () => {
    for (const url of [
      YOUTUBE_ICON_DATA_URL,
      X_LOGO_WHITE_DATA_URL,
      ...Object.values(X_VERIFIED_DATA_URL)
    ]) {
      expect(url.startsWith('data:image/svg+xml')).toBe(true)
    }
  })

  it('gives the React marks files, never data URIs', () => {
    for (const url of [
      YOUTUBE_ICON_URL,
      X_LOGO_WHITE_URL,
      X_LOCKUP_URL.dark,
      X_LOCKUP_URL.light,
      ...Object.values(X_VERIFIED_URL)
    ]) {
      expect(url.startsWith('data:')).toBe(false)
      // The built app names the hashed file; the test server keeps the query.
      expect(url).toMatch(/\.svg(\?no-inline)?$/)
    }
  })
})
