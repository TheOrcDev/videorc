import { toast } from 'sonner'

import type { GlobalShortcutsConfig, GlobalShortcutsResult } from '@/lib/backend'

type RegisterFn = (shortcuts: GlobalShortcutsConfig) => Promise<GlobalShortcutsResult>

/**
 * Keeps the OS-level shortcut registration in step with Settings.
 *
 * Deliberately NOT a React effect: the studio render body hands it the
 * current config (`sync`, latest-value pattern) and it dedupes by value, so
 * only an actual settings change — or the first hydrated render — crosses
 * the IPC boundary.
 */
export class GlobalShortcutsRegistrar {
  private lastRegisteredBody: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: GlobalShortcutsConfig | null = null

  /** Safe to call from a render body: mutates only this object and defers
   * the IPC call past the commit; identical configs are no-ops. */
  sync(shortcuts: GlobalShortcutsConfig): void {
    const body = JSON.stringify(shortcuts)
    if (body === this.lastRegisteredBody) {
      return
    }
    this.pending = shortcuts
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.register()
    }, 0)
  }

  private register(): void {
    const shortcuts = this.pending
    if (!shortcuts) {
      return
    }
    this.pending = null
    const register: RegisterFn | undefined = window.videorc?.setGlobalShortcuts
    if (!register) {
      return
    }
    const body = JSON.stringify(shortcuts)
    register(shortcuts)
      .then((result) => {
        this.lastRegisteredBody = body
        const failed = Object.entries(result?.registered ?? {})
          .filter(([, ok]) => !ok)
          .map(([action]) => action)
        if (failed.length > 0) {
          toast.error('Some global shortcuts could not be registered', {
            id: 'global-shortcuts-conflict',
            description:
              'Another app may already use that key combination. Pick a different one in Settings.'
          })
        }
      })
      .catch((error: unknown) => {
        // The IPC itself failed — the user's shortcuts silently not working
        // is the one thing this must never do quietly.
        console.error('[global-shortcuts] registration failed', error)
        toast.error('Global shortcuts could not be registered', {
          id: 'global-shortcuts-conflict',
          description: 'Videorc could not reach the system shortcut registry. Try again.'
        })
      })
  }
}
