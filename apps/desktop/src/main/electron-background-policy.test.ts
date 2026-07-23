import { describe, expect, it } from 'vitest'

import {
  backgroundThrottlingFor,
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
})
