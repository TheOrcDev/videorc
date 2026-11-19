import { describe, expect, it } from 'vitest'
import { nextEligibleScene } from './scene-shortcut-walk'
import { withGlobalShortcut } from '../../../shared/global-shortcut-bindings'
import {
  globalShortcutEntries,
  isGlobalShortcutAction,
  withoutSceneShortcut
} from '../../../shared/global-shortcuts'

const scenes = [
  { id: 'a', name: 'Figma' },
  { id: 'b', name: 'T3 Code' },
  { id: 'c', name: 'Chrome' }
]
const base = {
  current: 'scene:a',
  direction: 1 as const,
  scenes,
  appStates: {}
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
  it('walks library order only and wraps both ways', () => {
    expect(nextEligibleScene(base)).toBe('scene:b')
    expect(nextEligibleScene({ ...base, current: 'scene:b' })).toBe('scene:c')
    expect(nextEligibleScene({ ...base, current: 'scene:c', direction: -1 })).toBe('scene:b')
    expect(nextEligibleScene({ ...base, direction: -1 })).toBe('scene:c')
    expect(nextEligibleScene({ ...base, current: 'scene:c' })).toBe('scene:a')
  })
  it('skips unavailable apps and sources without changing their position', () => {
    expect(nextEligibleScene({ ...base, appStates: { b: 'not-running' } })).toBe('scene:c')
    expect(nextEligibleScene({ ...base, current: 'scene:deleted' })).toBe('scene:a')
    expect(nextEligibleScene({ ...base, current: 'scene:deleted', direction: -1 })).toBe('scene:c')
    expect(nextEligibleScene({ ...base, unavailableSceneIds: ['b'] })).toBe('scene:c')
    expect(nextEligibleScene({ ...base, unavailableSceneIds: ['b', 'c'] })).toBeNull()
    expect(nextEligibleScene({ ...base, scenes: [] })).toBeNull()
    expect(nextEligibleScene({ ...base, scenes: [scenes[0]] })).toBeNull()
    expect(nextEligibleScene({ ...base, scenes: [scenes[2], scenes[1], scenes[0]] })).toBe(
      'scene:c'
    )
  })
})
