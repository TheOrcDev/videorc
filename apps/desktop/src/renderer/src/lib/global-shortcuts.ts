import {
  globalShortcutLayout,
  isGlobalShortcutAction,
  type GlobalShortcutAction
} from '../../../shared/global-shortcuts'
export type { GlobalShortcutAction } from '../../../shared/global-shortcuts'
import { toast } from '@/lib/toast'
import { GO_LIVE_SHORTCUT_LABEL, RECORD_SHORTCUT_LABEL } from '@/lib/go-live-copy'
import { layoutPresetLabel } from '@/lib/layout-labels'

import type { DeviceStatus, GlobalShortcutsConfig, GlobalShortcutsResult } from '@/lib/backend'
import { openSettingsTab } from '@/lib/settings-tabs'
import { systemAudioTarget } from '@/lib/system-audio'

type RegisterFn = (shortcuts: GlobalShortcutsConfig) => Promise<GlobalShortcutsResult>

export interface GlobalShortcutContext {
  sessionActive: boolean
  /**
   * The Studio's two explicit starts (plan 174 S3.1, B-3): the record key
   * records, the Go Live key goes live, whatever mode was saved last. Each
   * refuses with its own reason when it cannot start, so the hotkey never
   * needs a mode of its own.
   */
  startRecording: () => Promise<unknown>
  startLivestream: () => Promise<unknown>
  stopSession: () => Promise<unknown>
  toggleMicrophoneMute: () => void
  /** Plan 068 D6: mark a clip at the current moment. */
  markClip?: () => void
  /** Plan 069 S6: the system-audio device status and the state the Studio
   * shows (the session's confirmed mix, else the request). */
  systemAudio?: readonly [status: DeviceStatus | undefined, shown: boolean]
  /** Sets captureConfig.audio.systemAudioEnabled, exactly as the switch does. */
  setSystemAudioEnabled?: (enabled: boolean) => void
  switchLayout?: (action: GlobalShortcutAction) => void
}

export function executeGlobalShortcut(
  action: GlobalShortcutAction,
  context: GlobalShortcutContext
): void {
  if (!isGlobalShortcutAction(action)) return
  if (action.startsWith('layout')) {
    context.switchLayout?.(action)
    return
  }
  if (action === 'record-toggle') {
    void (context.sessionActive ? context.stopSession() : context.startRecording())
    return
  }
  if (action === 'stream-toggle') {
    // Always a Go Live (plan 174 S3.1): with no destination ready the
    // provider refuses with "Set up a destination to go live" and its fix.
    void (context.sessionActive ? context.stopSession() : context.startLivestream())
    return
  }
  if (action === 'mic-toggle') context.toggleMicrophoneMute()
  if (action === 'system-audio-toggle') toggleSystemAudio(context)
  if (action === 'clip-mark') context.markClip?.()
}

function toggleSystemAudio(context: GlobalShortcutContext): void {
  const [status, shown] = context.systemAudio ?? [undefined, false]
  const target = systemAudioTarget('toggle', status, shown)
  if (target !== null) {
    context.setSystemAudioEnabled?.(target)
    return
  }
  // The key press did nothing, possibly with Videorc in the background: say
  // why once (a fixed id), never flip a switch the device cannot honour.
  if (status === 'permission-required') {
    toast.warning('System audio needs Screen Recording access', {
      id: 'global-shortcut-system-audio',
      action: { label: 'Open Permissions', onClick: () => openSettingsTab('permissions') }
    })
  } else {
    toast.warning("System audio isn't available on this computer", {
      id: 'global-shortcut-system-audio'
    })
  }
}

// The one label table for global shortcuts: Settings → Shortcuts, its
// "Already used by" refusal and the registration toast all read it (plan 174
// S2.3a, after S2.4). The session pair is S2.2's verb pair.
const GLOBAL_SHORTCUT_LABELS: Partial<Record<GlobalShortcutAction, string>> = {
  'record-toggle': RECORD_SHORTCUT_LABEL,
  'stream-toggle': GO_LIVE_SHORTCUT_LABEL,
  'mic-toggle': 'Mute / unmute microphone',
  'system-audio-toggle': 'Turn system audio on or off',
  'clip-mark': 'Mark a clip',
  'layout-next': 'Next scene',
  'layout-previous': 'Previous scene'
}

/**
 * Pure. What a global shortcut does, in words, never its id (plan 174 A-22).
 * Read out of its list (a toast, "Already used by …"), so a vertical layout
 * says so ("Vertical screen + camera").
 */
export function globalShortcutLabel(action: string): string {
  if (!isGlobalShortcutAction(action)) return action
  const layout = globalShortcutLayout(action)
  if (layout) return layoutPresetLabel(layout, { bothOrientations: true })
  return GLOBAL_SHORTCUT_LABELS[action] ?? action
}

// Plan 062: the latest per-action registration outcome, so Settings can mark
// the one row another app owns instead of only toasting a list.
type RegistrationSnapshot = Readonly<Record<string, boolean>>
let registrationSnapshot: RegistrationSnapshot = {}
const registrationListeners = new Set<() => void>()

function publishRegistration(registered: RegistrationSnapshot): void {
  registrationSnapshot = registered
  for (const listener of registrationListeners) listener()
}

export const globalShortcutRegistration = {
  subscribe(listener: () => void): () => void {
    registrationListeners.add(listener)
    return () => registrationListeners.delete(listener)
  },
  getSnapshot(): RegistrationSnapshot {
    return registrationSnapshot
  }
}

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

  dispose(): void {
    this.pending = null
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
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
        // Held by main while the shortcut recorder is armed: leave the body
        // unmarked so the next render re-syncs and learns the real outcome.
        if (result?.deferred) {
          return
        }
        this.lastRegisteredBody = body
        publishRegistration({ ...result?.registered })
        const failed = Object.entries(result?.registered ?? {})
          .filter(([, ok]) => !ok)
          .map(([action]) => action)
        if (failed.length > 0) {
          toast.error(
            failed.length === 1
              ? "A global shortcut didn't register"
              : "Some global shortcuts didn't register",
            {
              id: 'global-shortcuts-conflict',
              description: `${failed.map(globalShortcutLabel).join(', ')}: another app uses ${failed.length === 1 ? 'it' : 'them'}, or the keys are taken twice. Choose different keys in Settings → Shortcuts.`,
              action: { label: 'Open Shortcuts', onClick: () => openSettingsTab('shortcuts') }
            }
          )
        }
      })
      .catch((error: unknown) => {
        // The IPC itself failed — the user's shortcuts silently not working
        // is the one thing this must never do quietly.
        console.error('[global-shortcuts] registration failed', error)
        toast.error("Global shortcuts didn't register", {
          id: 'global-shortcuts-conflict',
          description: "Restart Videorc if they still don't work.",
          action: { label: 'Open Shortcuts', onClick: () => openSettingsTab('shortcuts') }
        })
      })
  }
}
