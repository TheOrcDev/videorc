import { replaceGlobalShortcutBindings } from './global-shortcut-lifecycle'
import { describe, expect, it, vi } from 'vitest'

import { unregisterGlobalShortcutsWhenReady } from './global-shortcut-lifecycle'

describe('global shortcut lifecycle', () => {
  it('does not touch the registry before Electron is ready', () => {
    const registry = { unregisterAll: vi.fn() }

    unregisterGlobalShortcutsWhenReady(registry, () => false)

    expect(registry.unregisterAll).not.toHaveBeenCalled()
  })

  it('clears the registry when Electron is ready', () => {
    const registry = { unregisterAll: vi.fn() }

    unregisterGlobalShortcutsWhenReady(registry, () => true)

    expect(registry.unregisterAll).toHaveBeenCalledOnce()
  })
})

describe('global shortcut registration replacement', () => {
  it('unregisters owned keys, skips blank fields and reports each conflict independently', () => {
    const owned = new Set(['Control+Old'])
    const callbacks = new Map<string, () => void>()
    const registry = {
      unregister: vi.fn(),
      register: vi.fn((key: string, callback: () => void) => {
        if (key === 'Invalid') throw new Error('invalid')
        if (key === 'Conflict') return false
        callbacks.set(key, callback)
        return true
      })
    }
    const dispatch = vi.fn()
    const result = replaceGlobalShortcutBindings(
      registry,
      owned,
      [
        ['layout-next', 'Control+Next'],
        ['layout-previous', 'Control+Next'],
        ['layout:camera-only', 'Conflict'],
        ['mic-toggle', 'Invalid'],
        ['stream-toggle', ''],
        ['record-toggle', 'Control+Record']
      ],
      dispatch
    )
    expect(registry.unregister).toHaveBeenCalledExactlyOnceWith('Control+Old')
    expect(result.registered).toEqual({
      'layout-next': true,
      'layout-previous': false,
      'layout:camera-only': false,
      'mic-toggle': false,
      'record-toggle': true
    })
    callbacks.get('Control+Next')!()
    expect(dispatch).toHaveBeenCalledExactlyOnceWith('layout-next')
    replaceGlobalShortcutBindings(registry, owned, [], dispatch)
    expect(owned.size).toBe(0)
    expect(registry.unregister).toHaveBeenCalledWith('Control+Record')
  })
})
