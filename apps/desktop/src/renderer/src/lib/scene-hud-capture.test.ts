import { describe, expect, it } from 'vitest'

import { defaultSettings } from './capture'
import { sceneHudProtectedOverlayWindow } from './protected-overlay-windows'
import {
  sceneHudCaptureConfirmed,
  sceneHudEnabled,
  sceneHudExclusionAfterStart,
  sceneHudExclusionForWindow,
  sceneHudKeySet,
  screenStartHoldsExclusion
} from './scene-hud-capture'
import type { SceneHudWindowState } from '../../../shared/scene-hud'

const MAC: SceneHudWindowState = {
  enabled: true,
  method: 'capture-filter',
  windowId: 42,
  ready: true
}
const WINDOWS: SceneHudWindowState = { enabled: true, method: 'content-protection', ready: true }

describe("Show the scene's name when a key switches it (plan 231 D20)", () => {
  it('is on by default, and on for a profile saved before it existed', () => {
    expect(sceneHudEnabled(defaultSettings)).toBe(true)
    expect(sceneHudEnabled({})).toBe(true)
    expect(sceneHudEnabled({ sceneHud: true })).toBe(true)
    expect(sceneHudEnabled({ sceneHud: false })).toBe(false)
  })
})

describe('the capture leaves the key HUD out (fail closed)', () => {
  it('reads a screen start’s answer: built with the list, applied in place, or deferred', () => {
    expect(screenStartHoldsExclusion({ state: 'live' })).toBe(true)
    expect(screenStartHoldsExclusion({ state: 'starting' })).toBe(true)
    expect(
      screenStartHoldsExclusion({
        state: 'live',
        message:
          'Native screen preview source reused; the capture exclusion set was applied to the running capture.'
      })
    ).toBe(true)
    expect(
      screenStartHoldsExclusion({
        state: 'live',
        message:
          'Native screen preview source reused; the capture exclusion set updates at the next capture start.'
      })
    ).toBe(false)
    expect(screenStartHoldsExclusion({ state: 'failed' })).toBe(false)
  })

  it('confirms the macOS filter only once the running capture took the window id', () => {
    // A capture running when the window appeared: unconfirmed until the resend.
    const pending = sceneHudExclusionForWindow(MAC, null, true)
    expect(pending).toEqual({ windowId: 42, held: false })
    expect(
      sceneHudCaptureConfirmed({ window: MAC, exclusion: pending, captureRunning: true })
    ).toBe(false)
    // The resend carried the id and the capture took it in place.
    const held = sceneHudExclusionAfterStart(pending, [7, 42], {
      state: 'live',
      message:
        'Native screen preview source reused; the capture exclusion set was applied to the running capture.'
    })
    expect(sceneHudCaptureConfirmed({ window: MAC, exclusion: held, captureRunning: true })).toBe(
      true
    )
    // A deferred set leaves it unconfirmed while that capture runs.
    const deferred = sceneHudExclusionAfterStart(pending, [42], {
      state: 'live',
      message:
        'Native screen preview source reused; the capture exclusion set updates at the next capture start.'
    })
    expect(
      sceneHudCaptureConfirmed({ window: MAC, exclusion: deferred, captureRunning: true })
    ).toBe(false)
    // A start that never carried the id changes nothing.
    expect(sceneHudExclusionAfterStart(pending, [7], { state: 'live' })).toBe(pending)
    // No capture running: every later start carries the id.
    expect(sceneHudExclusionForWindow(MAC, null, false)).toEqual({ windowId: 42, held: true })
    expect(
      sceneHudCaptureConfirmed({ window: MAC, exclusion: deferred, captureRunning: false })
    ).toBe(true)
  })

  it('never confirms a window that is not ready, an id it never handed over, or Linux', () => {
    const held = { windowId: 42, held: true }
    expect(
      sceneHudCaptureConfirmed({
        window: { ...MAC, ready: false },
        exclusion: held,
        captureRunning: false
      })
    ).toBe(false)
    expect(
      sceneHudCaptureConfirmed({
        window: { ...MAC, windowId: 43 },
        exclusion: held,
        captureRunning: false
      })
    ).toBe(false)
    expect(sceneHudCaptureConfirmed({ window: MAC, exclusion: null, captureRunning: false })).toBe(
      false
    )
    expect(
      sceneHudCaptureConfirmed({
        window: { enabled: false, method: 'unsupported', ready: false },
        exclusion: null,
        captureRunning: false
      })
    ).toBe(false)
    expect(sceneHudCaptureConfirmed({ window: null, exclusion: held, captureRunning: false })).toBe(
      false
    )
  })

  it('trusts Windows content protection only as main confirmed it', () => {
    expect(
      sceneHudCaptureConfirmed({ window: WINDOWS, exclusion: null, captureRunning: true })
    ).toBe(true)
    expect(
      sceneHudCaptureConfirmed({
        window: { ...WINDOWS, ready: false },
        exclusion: null,
        captureRunning: true
      })
    ).toBe(false)
    expect(sceneHudExclusionForWindow(WINDOWS, null, true)).toBeNull()
  })

  it('puts the macOS window on every exclusion list, and nothing on Windows or Linux', () => {
    expect(sceneHudProtectedOverlayWindow(MAC)).toEqual({ open: true, windowId: 42 })
    expect(sceneHudProtectedOverlayWindow(WINDOWS)).toEqual({ open: false })
    expect(sceneHudProtectedOverlayWindow({ method: 'capture-filter' })).toEqual({ open: false })
    expect(sceneHudProtectedOverlayWindow(null)).toEqual({ open: false })
  })
})

describe('sceneHudKeySet', () => {
  const scenes = [{ id: 'a' }, { id: 'b' }]
  const allSlotsCleared = {
    sceneSlots: { 1: '', 2: '', 3: '', 4: '', 5: '', 6: '', 7: '', 8: '', 9: '' }
  }

  it('makes no window until a key can switch a scene', () => {
    // No scenes: nothing to switch to.
    expect(sceneHudKeySet({}, [], 'darwin')).toBe(false)
    // Default position keys switch the first scenes.
    expect(sceneHudKeySet(undefined, scenes, 'darwin')).toBe(true)
    expect(sceneHudKeySet({}, scenes, 'win32')).toBe(true)
    // Every position key released, no other key: no window.
    expect(sceneHudKeySet(allSlotsCleared, scenes, 'darwin')).toBe(false)
    // A position key left only for a place with no scene does not count.
    expect(
      sceneHudKeySet({ sceneSlots: { ...allSlotsCleared.sceneSlots, 5: 'F5' } }, scenes, 'darwin')
    ).toBe(false)
    expect(
      sceneHudKeySet({ sceneSlots: { ...allSlotsCleared.sceneSlots, 2: 'F2' } }, scenes, 'darwin')
    ).toBe(true)
    // A scene's own key, or Next / Previous.
    expect(sceneHudKeySet({ ...allSlotsCleared, scenes: { b: 'F9' } }, scenes, 'darwin')).toBe(true)
    expect(sceneHudKeySet({ ...allSlotsCleared, scenes: { gone: 'F9' } }, scenes, 'darwin')).toBe(
      false
    )
    expect(sceneHudKeySet({ ...allSlotsCleared, layoutNext: 'F8' }, scenes, 'darwin')).toBe(true)
  })
})
