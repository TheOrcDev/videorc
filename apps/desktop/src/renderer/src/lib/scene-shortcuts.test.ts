import { describe, expect, it } from 'vitest'
import { sceneShortcutBindings, sceneShortcutRows } from './scene-shortcuts'
import { globalShortcutConflictReason, globalShortcutTakenReason } from './global-shortcut-owner'

const scenes = [
  { id: 'figma', name: 'Figma' },
  { id: 't3', name: 'T3 Code' }
]

describe('scene keys on cards and in Settings', () => {
  it('lists nine positions, including empty ones, then custom keys only', () => {
    const rows = sceneShortcutRows(scenes, { scenes: { figma: 'F13', t3: '' } }, 'darwin')
    expect(rows).toHaveLength(10)
    expect(rows[0]).toEqual({
      action: 'scene-slot-1',
      label: 'Scene 1 · Figma',
      accelerator: 'Control+Alt+1'
    })
    expect(rows[2]).toEqual({
      action: 'scene-slot-3',
      label: 'Scene 3 · no scene',
      accelerator: 'Control+Alt+3'
    })
    expect(rows[9]).toEqual({ action: 'scene:figma', label: 'Figma', accelerator: 'F13' })
    expect(sceneShortcutRows([...scenes].reverse(), {}, 'win32')[0]).toEqual({
      action: 'scene-slot-1',
      label: 'Scene 1 · T3 Code',
      accelerator: 'Control+Alt+Shift+1'
    })
    expect(sceneShortcutRows([], {}, 'linux')).toHaveLength(9)
  })

  it('keeps the custom key beside a position key, through reorder, change and clearing', () => {
    const config = { scenes: { figma: 'F13' }, sceneSlots: { 2: 'F14', 3: '' } }
    expect(sceneShortcutBindings('figma', 1, config, 'darwin')).toEqual([
      { action: 'scene-slot-1', accelerator: 'Control+Alt+1' },
      { action: 'scene:figma', accelerator: 'F13' }
    ])
    expect(sceneShortcutBindings('figma', 2, config, 'darwin')).toEqual([
      { action: 'scene-slot-2', accelerator: 'F14' },
      { action: 'scene:figma', accelerator: 'F13' }
    ])
    for (const position of [3, 10])
      expect(sceneShortcutBindings('figma', position, config, 'darwin')).toEqual([
        { action: 'scene:figma', accelerator: 'F13' }
      ])
    expect(sceneShortcutBindings('t3', 10, config, 'darwin')).toEqual([])
  })

  it('includes default positions in duplicate checks, with the same conflict words everywhere', () => {
    expect(
      globalShortcutTakenReason({
        config: {},
        accelerator: 'Ctrl+Alt+3',
        action: 'scene:figma',
        platform: 'darwin',
        scenes
      })
    ).toBe('Already used by Scene 3.')
    expect(
      globalShortcutTakenReason({
        config: { scenes: { figma: 'F13' } },
        accelerator: 'F13',
        action: 'scene-slot-1',
        platform: 'darwin',
        scenes
      })
    ).toBe('Already used by Figma.')
    expect(
      globalShortcutTakenReason({
        config: {},
        accelerator: 'Ctrl+Alt+3',
        action: 'scene:figma',
        platform: 'win32',
        scenes
      })
    ).toBeNull()
    expect(globalShortcutConflictReason('Control+Alt+3', 'darwin', true)).toBe(
      'Another app uses ⌃⌥3'
    )
    expect(globalShortcutConflictReason('Control+Alt+Shift+3', 'win32', true)).toBe(
      'Another app uses Ctrl+Alt+Shift+3'
    )
    expect(globalShortcutConflictReason('F13', 'darwin', false)).toBeNull()
    expect(globalShortcutConflictReason('', 'darwin', true)).toBeNull()
  })
})
