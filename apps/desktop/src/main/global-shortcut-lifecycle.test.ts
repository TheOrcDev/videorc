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
