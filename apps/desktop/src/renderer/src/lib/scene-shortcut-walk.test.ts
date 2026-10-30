import { describe, expect, it } from 'vitest'
import { nextEligibleScene } from './scene-shortcut-walk'
import { withGlobalShortcut } from '../../../shared/global-shortcut-bindings'
import {
  globalShortcutEntries,
  isGlobalShortcutAction,
  withoutSceneShortcut
} from '../../../shared/global-shortcuts'
import type { SavedScene } from './scene-presets'

const scenes = [
  { id: 'a', name: 'Figma', visual: { layout: { layoutPreset: 'screen-only' } } },
  { id: 'b', name: 'Portrait', visual: { layout: { layoutPreset: 'vertical-screen-only' } } }
] as SavedScene[]
const base = {
  current: 'scene:a',
  direction: 1 as const,
  scenes,
  orientation: 'horizontal' as const,
  sessionActive: false,
  appStates: {},
  layouts: ['screen-only', 'camera-only'] as const
}
describe('scene keys and library walk', () => {
  it('adds keys by id, survives a rename, releases a deleted key', () => {
    const config = withGlobalShortcut(undefined, 'scene:a', 'Control+F13')
    expect(isGlobalShortcutAction('scene:a')).toBe(true)
    expect(globalShortcutEntries(config)).toContainEqual(['scene:a', 'Control+F13'])
    const renamed = { ...scenes[0], name: 'Renamed' }
    expect(config.scenes?.[renamed.id]).toBe('Control+F13')
    expect(withoutSceneShortcut(config, renamed.id).scenes).toEqual({})
  })
  it('walks library order before layouts and wraps both ways', () => {
    expect(nextEligibleScene(base)).toBe('scene:b')
    expect(nextEligibleScene({ ...base, current: 'scene:b' })).toBe('layout:screen-only')
    expect(nextEligibleScene({ ...base, current: 'layout:screen-only', direction: -1 })).toBe(
      'scene:b'
    )
    expect(nextEligibleScene({ ...base, direction: -1 })).toBe('layout:camera-only')
    expect(nextEligibleScene({ ...base, current: 'layout:camera-only' })).toBe('scene:a')
  })
  it('skips known unavailable apps and the other orientation mid-session', () => {
    expect(nextEligibleScene({ ...base, sessionActive: true })).toBe('layout:screen-only')
    expect(nextEligibleScene({ ...base, appStates: { b: 'not-running' } })).toBe(
      'layout:screen-only'
    )
    expect(nextEligibleScene({ ...base, current: 'scene:deleted' })).toBe('scene:a')
    expect(nextEligibleScene({ ...base, unavailableSceneIds: ['b'] })).toBe('layout:screen-only')
    expect(nextEligibleScene({ ...base, scenes: [], layouts: [] })).toBeNull()
  })
})
