import { GlobalShortcutGate, replaceGlobalShortcutBindings } from './global-shortcut-lifecycle'
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

describe('global shortcut gate (shortcut recorder suspend)', () => {
  const makeRegistry = () => {
    const active = new Map<string, () => void>()
    return {
      active,
      register: vi.fn((key: string, callback: () => void) => {
        if (key === 'Taken') return false
        active.set(key, callback)
        return true
      }),
      unregister: vi.fn((key: string) => {
        active.delete(key)
      })
    }
  }

  it('releases only app-owned keys while armed and restores exactly the last config', () => {
    const registry = makeRegistry()
    registry.active.set('Other+App', () => undefined)
    const gate = new GlobalShortcutGate(registry, vi.fn())
    gate.apply([
      ['record-toggle', 'Cmd+Shift+R'],
      ['mic-toggle', 'Cmd+Shift+M']
    ])
    expect([...registry.active.keys()].sort()).toEqual(['Cmd+Shift+M', 'Cmd+Shift+R', 'Other+App'])

    gate.arm()
    expect(gate.isArmed).toBe(true)
    expect([...registry.active.keys()]).toEqual(['Other+App'])

    expect(gate.disarm()).toEqual({ registered: { 'record-toggle': true, 'mic-toggle': true } })
    expect([...registry.active.keys()].sort()).toEqual(['Cmd+Shift+M', 'Cmd+Shift+R', 'Other+App'])
  })

  it('defers a config change made while armed and applies it on disarm', () => {
    const registry = makeRegistry()
    const gate = new GlobalShortcutGate(registry, vi.fn())
    gate.apply([['record-toggle', 'Cmd+Shift+R']])
    gate.arm()

    expect(gate.apply([['record-toggle', 'Cmd+Shift+X']])).toEqual({
      registered: {},
      deferred: true
    })
    expect(registry.active.size).toBe(0)

    gate.disarm()
    expect([...registry.active.keys()]).toEqual(['Cmd+Shift+X'])
  })

  it('treats a double arm or double disarm as a no-op', () => {
    const registry = makeRegistry()
    const gate = new GlobalShortcutGate(registry, vi.fn())
    gate.apply([['record-toggle', 'Cmd+Shift+R']])
    gate.arm()
    gate.arm()
    expect(registry.active.size).toBe(0)
    expect(gate.disarm()).not.toBeNull()
    expect(gate.disarm()).toBeNull()
    expect(registry.register).toHaveBeenCalledTimes(2)
    expect([...registry.active.keys()]).toEqual(['Cmd+Shift+R'])
  })

  it('dispatches the action for a key registered through the gate', () => {
    const registry = makeRegistry()
    const dispatch = vi.fn()
    const gate = new GlobalShortcutGate(registry, dispatch)
    gate.apply([['mic-toggle', 'Cmd+Shift+M']])
    registry.active.get('Cmd+Shift+M')?.()
    expect(dispatch).toHaveBeenCalledWith('mic-toggle')
  })
})
