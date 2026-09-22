export interface GlobalShortcutRegistry {
  unregisterAll(): void
}

/**
 * Electron rejects globalShortcut calls before app readiness. A second
 * protocol-launch process can reach will-quit before its ready event, and it
 * has no shortcuts of its own to clean up in that case.
 */
export function unregisterGlobalShortcutsWhenReady(
  registry: GlobalShortcutRegistry,
  isReady: () => boolean
): void {
  if (!isReady()) {
    return
  }
  registry.unregisterAll()
}

export interface GlobalShortcutRegistrationRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

/** Replace only app-owned registrations; one bad key cannot remove valid siblings. */
export function replaceGlobalShortcutBindings(
  registry: GlobalShortcutRegistrationRegistry,
  owned: Set<string>,
  requested: readonly [string, string | undefined][],
  dispatch: (action: string) => void
): { registered: Record<string, boolean> } {
  for (const accelerator of owned) {
    try {
      registry.unregister(accelerator)
    } catch {
      /* Continue replacing the other app-owned keys. */
    }
  }
  owned.clear()
  const registered: Record<string, boolean> = {}
  const claimed = new Set<string>()
  for (const [action, value] of requested) {
    const accelerator = typeof value === 'string' ? value.trim() : ''
    if (!accelerator) continue
    const key = accelerator.toLowerCase()
    try {
      const ok = !claimed.has(key) && registry.register(accelerator, () => dispatch(action))
      registered[action] = ok
      if (ok) {
        owned.add(accelerator)
        claimed.add(key)
      }
    } catch {
      registered[action] = false
    }
  }
  return { registered }
}
