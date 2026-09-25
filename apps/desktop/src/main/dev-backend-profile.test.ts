import { describe, expect, it } from 'vitest'

import { devBackendCargoProfile } from './dev-backend-profile'

describe('devBackendCargoProfile', () => {
  it('runs the debug backend unless the release profile is requested explicitly', () => {
    expect(devBackendCargoProfile({})).toBe('debug')
    expect(devBackendCargoProfile({ VIDEORC_DEV_BACKEND_PROFILE: 'debug' })).toBe('debug')
    expect(devBackendCargoProfile({ VIDEORC_DEV_BACKEND_PROFILE: 'fast' })).toBe('debug')
    expect(devBackendCargoProfile({ VIDEORC_DEV_BACKEND_PROFILE: 'release' })).toBe('release')
  })
})
