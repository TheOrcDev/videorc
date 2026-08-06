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
