import { describe, expect, it } from 'vitest'

import {
  backgroundThrottlingFor,
  electronBackgroundPolicyFromEnv,
  shouldDisableOcclusionThrottling
} from './electron-background-policy'

describe('Electron background policy', () => {
  it('keeps capture ownership and detached preview presentation live', () => {
    expect(backgroundThrottlingFor('main')).toBe(false)
    expect(backgroundThrottlingFor('preview')).toBe(false)
  })

  it('restores Chromium defaults for event-driven auxiliary windows', () => {
    expect(backgroundThrottlingFor('notes')).toBe(true)
    expect(backgroundThrottlingFor('comments')).toBe(true)
    expect(backgroundThrottlingFor('captions')).toBe(true)
    expect(backgroundThrottlingFor('proof-surface')).toBe(true)
  })

  it('scopes global anti-occlusion switches to the macOS native preview path', () => {
    expect(shouldDisableOcclusionThrottling('darwin')).toBe(true)
    expect(shouldDisableOcclusionThrottling('win32')).toBe(false)
    expect(shouldDisableOcclusionThrottling('linux')).toBe(false)
  })

  it('supports an explicit legacy characterization policy without changing the default', () => {
    expect(electronBackgroundPolicyFromEnv({})).toBe('scoped')
    expect(
      electronBackgroundPolicyFromEnv({
        VIDEORC_ELECTRON_BACKGROUND_POLICY: 'legacy-unthrottled'
      })
    ).toBe('legacy-unthrottled')
    expect(
      electronBackgroundPolicyFromEnv({
        VIDEORC_ELECTRON_BACKGROUND_POLICY: 'unsupported'
      })
    ).toBe('scoped')

    for (const role of ['main', 'preview', 'notes', 'comments', 'captions'] as const) {
      expect(backgroundThrottlingFor(role, 'legacy-unthrottled')).toBe(false)
    }
    expect(shouldDisableOcclusionThrottling('win32', 'legacy-unthrottled')).toBe(true)
  })
})
