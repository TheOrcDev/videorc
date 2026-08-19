import { describe, expect, it, vi } from 'vitest'

import {
  applyVideorcWindowCaptureProtection,
  videorcWindowRequiresCaptureProtection,
  type VideorcWindowRole,
  WINDOW_CAPTURE_PROTECTION_SMOKE_MARKERS
} from './window-capture-protection'

describe('window capture protection policy', () => {
  const everyRole: VideorcWindowRole[] = [
    'main',
    'preview',
    'comments',
    'notes',
    'captions',
    'proof-surface'
  ]

  it('protects ONLY the notes teleprompter, on every platform', () => {
    // Owner call, 2026-08-19: comments and captions are part of the show and
    // must stay visible in recordings; notes is the one private window.
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      for (const role of everyRole) {
        expect(videorcWindowRequiresCaptureProtection(role, platform)).toBe(role === 'notes')
      }
    }
  })

  it('is idempotent for one window instance', () => {
    const setContentProtection = vi.fn()
    const window = { setContentProtection }

    expect(applyVideorcWindowCaptureProtection(window, 'notes', { platform: 'win32' })).toEqual({
      state: 'protected',
      protected: true
    })
    expect(applyVideorcWindowCaptureProtection(window, 'notes', { platform: 'win32' })).toEqual({
      state: 'already-protected',
      protected: true
    })
    expect(setContentProtection).toHaveBeenCalledTimes(1)
    expect(setContentProtection).toHaveBeenCalledWith(true)
  })

  it('protects a re-created window independently', () => {
    const first = { setContentProtection: vi.fn() }
    const recreated = { setContentProtection: vi.fn() }

    applyVideorcWindowCaptureProtection(first, 'notes', { platform: 'win32' })
    applyVideorcWindowCaptureProtection(recreated, 'notes', { platform: 'win32' })

    expect(first.setContentProtection).toHaveBeenCalledTimes(1)
    expect(recreated.setContentProtection).toHaveBeenCalledTimes(1)
  })

  it('does not memoize failures and reports a bounded reason', () => {
    const onFailure = vi.fn()
    const window = {
      setContentProtection: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('x'.repeat(600))
        })
        .mockImplementationOnce(() => undefined)
    }

    expect(
      applyVideorcWindowCaptureProtection(window, 'notes', {
        platform: 'win32',
        onFailure
      })
    ).toMatchObject({ state: 'failed', protected: false })
    expect(onFailure).toHaveBeenCalledWith('x'.repeat(512))
    expect(
      applyVideorcWindowCaptureProtection(window, 'notes', {
        platform: 'win32'
      })
    ).toEqual({ state: 'protected', protected: true })
    expect(window.setContentProtection).toHaveBeenCalledTimes(2)
  })

  it('assigns one unique physical-acceptance marker to every protected role', () => {
    const markers = everyRole.map((role) => WINDOW_CAPTURE_PROTECTION_SMOKE_MARKERS[role])
    expect(new Set(markers).size).toBe(everyRole.length)
    expect(markers.every((marker) => /^#[0-9a-f]{6}$/.test(marker))).toBe(true)
  })
})
