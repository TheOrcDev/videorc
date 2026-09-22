import { nextEligibleLayout } from '../../../shared/global-shortcuts'
import { describe, expect, it, vi } from 'vitest'
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))
import { executeGlobalShortcut } from './global-shortcuts'
import {
  GLOBAL_SHORTCUT_ACTIONS,
  globalShortcutEntries,
  isGlobalShortcutAction
} from '../../../shared/global-shortcuts'
import type { GlobalShortcutAction } from '../../../shared/global-shortcuts'

describe('global layout shortcuts', () => {
  it('dispatches every layout action exactly once without microphone fallback', () => {
    const context = {
      sessionActive: false,
      streamEnabled: false,
      startSession: vi.fn(),
      stopSession: vi.fn(),
      toggleMicrophoneMute: vi.fn(),
      switchLayout: vi.fn()
    }
    for (const action of GLOBAL_SHORTCUT_ACTIONS.filter((action) => action.startsWith('layout')))
      executeGlobalShortcut(action, context)
    expect(context.switchLayout).toHaveBeenCalledTimes(12)
    expect(context.toggleMicrophoneMute).not.toHaveBeenCalled()
    executeGlobalShortcut('invalid' as GlobalShortcutAction, context)
    expect(context.toggleMicrophoneMute).not.toHaveBeenCalled()
    expect(context.switchLayout).toHaveBeenCalledTimes(12)
  })
  it('keeps stable IDs, unassigned defaults and validates unknown actions', () => {
    expect(globalShortcutEntries({})).toHaveLength(15)
    expect(
      globalShortcutEntries({ layouts: { 'camera-only': 'Control+Alt+C' } }).find(
        ([id]) => id === 'layout:camera-only'
      )?.[1]
    ).toBe('Control+Alt+C')
    expect(isGlobalShortcutAction('layout:made-up')).toBe(false)
    expect(isGlobalShortcutAction('layout-next')).toBe(true)
  })
})

describe('layout cycle order', () => {
  it('wraps and finds the correct predecessor when the current layout is unavailable', () => {
    expect(
      nextEligibleLayout('camera-only', -1, ['screen-camera', 'screen-only', 'side-by-side'])
    ).toBe('screen-only')
    expect(nextEligibleLayout('screen-camera', -1, ['screen-camera', 'side-by-side'])).toBe(
      'side-by-side'
    )
    expect(
      nextEligibleLayout('vertical-camera-top', -1, ['vertical-camera-top', 'vertical-camera-only'])
    ).toBe('vertical-camera-only')
    expect(nextEligibleLayout('screen-only', 1, ['screen-only'])).toBeNull()
  })
})
