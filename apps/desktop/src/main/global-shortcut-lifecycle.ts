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

/**
 * Why this session cannot hold a global shortcut, or null when it can. On
 * Linux under Wayland, Electron's register() answers true for every key, yet
 * Wayland gives no app a key grab, and Chromium's GlobalShortcuts portal route
 * is refused ("An app id is required") because Chromium never registers an app
 * id with xdg-desktop-portal. Those keys could never fire, so say so instead
 * of showing them as set. `ozonePlatform` is the platform Electron resolved
 * (its `ozone-platform` switch); X11 sessions keep their real key grabs.
 */
export function globalShortcutsUnavailableReason(input: {
  platform: NodeJS.Platform
  ozonePlatform: string
}): string | null {
  if (input.platform !== 'linux' || input.ozonePlatform.trim().toLowerCase() !== 'wayland') {
    return null
  }
  return "Global shortcuts can't work in this Wayland session: Wayland doesn't let an app hear keys while it is in the background. App shortcuts still work while Videorc is in front, and Phone remote works while it is in the background."
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

/**
 * Owns Videorc's global registrations and the Settings shortcut recorder's
 * suspend (plan 062). While armed, every app-owned key is released so the
 * recorder can hear the combination instead of the OS firing it (recording
 * over a bound ⌘⇧R must not start a recording). Config changes that arrive
 * while armed are kept and applied on disarm, so global shortcuts can never
 * stay dead after a capture ends — however it ends.
 */
export class GlobalShortcutGate {
  private armed = false
  private requested: readonly [string, string | undefined][] = []
  private readonly owned = new Set<string>()

  /** `unavailable` (see `globalShortcutsUnavailableReason`) keeps every key
   * off the registry and is returned in place of a registration result. */
  constructor(
    private readonly registry: GlobalShortcutRegistrationRegistry,
    private readonly dispatch: (action: string) => void,
    private readonly unavailable: string | null = null
  ) {}

  get isArmed(): boolean {
    return this.armed
  }

  apply(requested: readonly [string, string | undefined][]): {
    registered: Record<string, boolean>
    deferred?: true
    unavailable?: string
  } {
    this.requested = requested
    if (this.armed) {
      return { registered: {}, deferred: true }
    }
    return this.replace(requested)
  }

  /** Release every app-owned key. Idempotent. */
  arm(): void {
    if (this.armed) return
    this.armed = true
    this.replace([])
  }

  /** Re-register the latest requested config. Idempotent; null when already disarmed. */
  disarm(): { registered: Record<string, boolean>; unavailable?: string } | null {
    if (!this.armed) return null
    this.armed = false
    return this.replace(this.requested)
  }

  private replace(requested: readonly [string, string | undefined][]): {
    registered: Record<string, boolean>
    unavailable?: string
  } {
    if (this.unavailable !== null) {
      return { registered: {}, unavailable: this.unavailable }
    }
    return replaceGlobalShortcutBindings(this.registry, this.owned, requested, this.dispatch)
  }
}
