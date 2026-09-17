import { describe, expect, it } from 'vitest'

import { BackendRequestError } from '../backendClient'
import { isRetryableBackgroundSurfaceSyncError } from './surface-sync-retry'

describe('isRetryableBackgroundSurfaceSyncError', () => {
  it('treats the 2026-08-27 incident outcomes as silent retries', () => {
    for (const code of [
      'surface-busy',
      'command-lane-full',
      'command-expired-before-dispatch',
      'request-outcome-unknown'
    ]) {
      expect(isRetryableBackgroundSurfaceSyncError(new BackendRequestError(code, 'not now'))).toBe(
        true
      )
    }
  })

  it('keeps real failures loud', () => {
    expect(
      isRetryableBackgroundSurfaceSyncError(
        new BackendRequestError('invalid-params', 'bounds were malformed')
      )
    ).toBe(false)
    expect(isRetryableBackgroundSurfaceSyncError(new Error('surface-busy'))).toBe(false)
    expect(isRetryableBackgroundSurfaceSyncError(undefined)).toBe(false)
  })
})
