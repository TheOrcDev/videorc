import { describe, expect, it } from 'vitest'

import { defaultSettings } from './capture'
import { sceneHudProtectedOverlayWindow } from './protected-overlay-windows'
import {
  sceneHudCaptureConfirmed,
  sceneHudEnabled,
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

  const LIVE = { state: 'live' } as const
  const IDLE = { state: 'source-missing' } as const
  const APPLIED = {
    state: 'live',
    message:
      'Native screen preview source reused; the capture exclusion set was applied to the running capture.'
  } as const
  const DEFERRED = {
    state: 'live',
    message:
      'Native screen preview source reused; the capture exclusion set updates at the next capture start.'
  } as const

  it('confirms the macOS filter only once the running capture took the window id', () => {
    // A capture started before the window appeared: unconfirmed until the resend.
    expect(sceneHudCaptureConfirmed({ window: MAC, lastStart: [[7], LIVE], status: LIVE })).toBe(
      false
    )
    expect(sceneHudCaptureConfirmed({ window: MAC, lastStart: null, status: LIVE })).toBe(false)
    // The resend carried the id and the capture took it in place.
    expect(
      sceneHudCaptureConfirmed({ window: MAC, lastStart: [[7, 42], APPLIED], status: LIVE })
    ).toBe(true)
    // A fresh start with the id is built with it.
    expect(sceneHudCaptureConfirmed({ window: MAC, lastStart: [[42], LIVE], status: LIVE })).toBe(
      true
    )
    // A deferred set leaves it unconfirmed while that capture runs.
    expect(
      sceneHudCaptureConfirmed({ window: MAC, lastStart: [[42], DEFERRED], status: LIVE })
    ).toBe(false)
    // No capture running: every later start carries the id.
    expect(
      sceneHudCaptureConfirmed({ window: MAC, lastStart: [[42], DEFERRED], status: IDLE })
    ).toBe(true)
    expect(sceneHudCaptureConfirmed({ window: MAC, lastStart: null, status: IDLE })).toBe(true)
  })

  it('never confirms a window that is not ready, an id it never handed over, or Linux', () => {
    const held = [[42], LIVE] as const
    expect(
      sceneHudCaptureConfirmed({ window: { ...MAC, ready: false }, lastStart: held, status: IDLE })
    ).toBe(false)
    // A new window (a new id) while the capture runs with the old one.
    expect(
      sceneHudCaptureConfirmed({ window: { ...MAC, windowId: 43 }, lastStart: held, status: LIVE })
    ).toBe(false)
    expect(
      sceneHudCaptureConfirmed({
        window: { enabled: false, method: 'unsupported', ready: false },
        lastStart: null,
        status: IDLE
      })
    ).toBe(false)
    expect(sceneHudCaptureConfirmed({ window: null, lastStart: held, status: IDLE })).toBe(false)
  })

  it('trusts Windows content protection only as main confirmed it', () => {
    expect(sceneHudCaptureConfirmed({ window: WINDOWS, lastStart: null, status: LIVE })).toBe(true)
    expect(
      sceneHudCaptureConfirmed({
        window: { ...WINDOWS, ready: false },
        lastStart: null,
        status: LIVE
      })
    ).toBe(false)
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
