// Plan 214 E: the one main-process door for Videorc Camera's actions. The
// Output page asks to open System Settings at the approval pane, Health asks
// to remove the extension (after its own confirm), and the Windows setup and
// the Linux module load land here when C2 and D1 wire them. One dispatch
// table, so each platform's function has exactly one place to plug in.

import { release } from 'node:os'

import type { CameraExtensionState } from './camera-extension'
import type { VirtualCameraAction, VirtualCameraActionResult } from '../shared/backend'

export const VIRTUAL_CAMERA_ACTIONS: readonly VirtualCameraAction[] = [
  'open-approval-settings',
  'remove',
  'set-up',
  'load-module'
]

/** The plain refusal for an action this computer has no function for yet. */
export const VIRTUAL_CAMERA_NOT_AVAILABLE = 'Not available on this computer.'

/**
 * macOS 13 and 14 allow a camera extension in Privacy & Security; from
 * macOS 15 (Darwin 24) it is a switch under General → Login Items &
 * Extensions → Camera Extensions, a pane that takes the URL scheme on 15 and
 * 26 (`allowsXAppleSystemPreferencesURLScheme`). An unreadable release reads
 * as the current pane.
 */
export const CAMERA_EXTENSION_APPROVAL_URLS = {
  privacySecurity: 'x-apple.systempreferences:com.apple.preference.security',
  loginItemsExtensions: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
  /** System Settings itself, when the pane can't be opened. */
  systemSettings: 'x-apple.systempreferences:'
} as const

export function cameraExtensionApprovalUrl(osRelease: string): string {
  const darwin = Number.parseInt(osRelease, 10)
  return Number.isFinite(darwin) && darwin < 24
    ? CAMERA_EXTENSION_APPROVAL_URLS.privacySecurity
    : CAMERA_EXTENSION_APPROVAL_URLS.loginItemsExtensions
}

/** Pure. A removal's answer in words, from the extension's state after it. */
export function removalResult(state: CameraExtensionState): VirtualCameraActionResult {
  switch (state.phase) {
    case 'removed':
      return { ok: true }
    case 'reboot-required':
      return { ok: true, message: 'Videorc Camera is gone after your Mac restarts.' }
    case 'needs-approval':
      return { ok: true, message: 'Approve the removal in System Settings.' }
    case 'unavailable':
      return { ok: false, message: VIRTUAL_CAMERA_NOT_AVAILABLE }
    default:
      // The system's own words stay in main's log (the controller logs each step).
      return { ok: false, message: "macOS didn't remove Videorc Camera. Try again in a moment." }
  }
}

export interface VirtualCameraActionHost {
  platform: NodeJS.Platform
  /** `os.release()`: the Darwin version on macOS. */
  osRelease?: string
  openExternal: (url: string) => Promise<void>
  /** B3's `cameraExtension().deactivate()`. */
  deactivateCameraExtension: () => Promise<CameraExtensionState>
  /** Windows' one elevated setup (plan 214 C2), once it exists. */
  setUp?: () => Promise<VirtualCameraActionResult>
  /** Linux's `pkexec modprobe` load (plan 214 D1), once it exists. */
  loadModule?: () => Promise<VirtualCameraActionResult>
  /**
   * Whether the backend hides the camera on this computer
   * (`platformStep: unsupported`, the owner's hide rule). Asked before
   * set-up or load-module runs anything elevated, so a hidden platform stays
   * inert even if a renderer asks. An unanswered question counts as hidden.
   */
  platformHidden?: () => Promise<boolean>
}

const notAvailable = async (): Promise<VirtualCameraActionResult> => ({
  ok: false,
  message: VIRTUAL_CAMERA_NOT_AVAILABLE
})

/** The dispatch table: one function per action, per platform. */
const ACTIONS: Record<
  VirtualCameraAction,
  (host: VirtualCameraActionHost) => Promise<VirtualCameraActionResult>
> = {
  'open-approval-settings': async (host) => {
    if (host.platform !== 'darwin') return notAvailable()
    try {
      await host.openExternal(cameraExtensionApprovalUrl(host.osRelease ?? release()))
      return { ok: true }
    } catch {
      // A pane this macOS doesn't know: System Settings itself; the line
      // under the switch still names the path.
    }
    try {
      await host.openExternal(CAMERA_EXTENSION_APPROVAL_URLS.systemSettings)
      return { ok: true }
    } catch {
      return { ok: false, message: "Couldn't open System Settings. Open it from the Apple menu." }
    }
  },
  remove: async (host) =>
    host.platform === 'darwin'
      ? removalResult(await host.deactivateCameraExtension())
      : notAvailable(),
  'set-up': async (host) =>
    host.platform === 'win32' && host.setUp && !(await hiddenHere(host))
      ? host.setUp()
      : notAvailable(),
  'load-module': async (host) =>
    host.platform === 'linux' && host.loadModule && !(await hiddenHere(host))
      ? host.loadModule()
      : notAvailable()
}

/** The hide rule for the elevated actions; no answer reads as hidden. */
async function hiddenHere(host: VirtualCameraActionHost): Promise<boolean> {
  if (!host.platformHidden) return true
  try {
    return await host.platformHidden()
  } catch {
    return true
  }
}

/** Runs one action; anything unknown is refused before it reaches a platform. */
export async function runVirtualCameraAction(
  action: unknown,
  host: VirtualCameraActionHost
): Promise<VirtualCameraActionResult> {
  if (!VIRTUAL_CAMERA_ACTIONS.includes(action as VirtualCameraAction)) return notAvailable()
  return ACTIONS[action as VirtualCameraAction](host)
}
