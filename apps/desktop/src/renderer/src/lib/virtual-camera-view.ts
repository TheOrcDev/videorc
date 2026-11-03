// Videorc Camera (plan 214 E): the camera other apps see, in words. One pure
// view for every surface that shows it: the Output page's row, ⌘K, the
// agents' settings tool, Health and the support bundle. Every state's line
// and its one action are decided here, so a surface never words a state on
// its own (and a test pins each one).
//
// The hide rule (owner, 2026-11-03): Windows and Linux code lands but stays
// hidden until each machine passes its spike. The backend says so with
// `platformStep: 'unsupported'`; then every surface hides the camera (the
// section, the ⌘K item, the Health group) and the agents' tool refuses it.

import type {
  VirtualCameraAction,
  VirtualCameraBundleLine,
  VirtualCameraState,
  VirtualCameraStatus
} from '@/lib/backend'
import { plural } from '@/lib/format'
import { OFFLINE_LOCK_REASON } from '@/lib/lock-reason'
import { appPlatform, osSettingsName } from '@/lib/platform'
import { platformCopy } from '@/lib/platform-copy'
import type { StatusTone } from '@/lib/status-word'

/** The camera's one name (D2), in every app and in Videorc's own copy. */
export const VIDEORC_CAMERA = 'Videorc Camera'

/** The row's description under its label (E1). */
export const VIDEORC_CAMERA_DESCRIPTION =
  'Shows your program as a camera in Meet, Zoom, Teams and Discord. No sound. Meet shows you a mirror image; everyone else sees it right.'

/** The Output section's title and description (D14). */
export const VIDEORC_CAMERA_SECTION_TITLE = 'Camera for other apps'
export const VIDEORC_CAMERA_SECTION_DESCRIPTION =
  'Your program as a camera other apps can choose, the way the Preview shows it.'

/**
 * Where macOS asks for approval, as System Settings reads it (docs/ui-copy.md
 * quotes both). macOS 13 and 14 allow a camera extension in Privacy &
 * Security; from macOS 15 it is a switch under Login Items & Extensions.
 */
export const VIDEORC_CAMERA_APPROVAL_PATH_MACOS_13 = 'Privacy & Security'
export const VIDEORC_CAMERA_APPROVAL_PATH_MACOS_15 =
  'General → Login Items & Extensions → Camera Extensions'

/** Darwin 24 is macOS 15. An unknown release reads as the current path. */
export function videorcCameraApprovalPath(osRelease?: string): string {
  const darwin = Number.parseInt(osRelease ?? '', 10)
  return Number.isFinite(darwin) && darwin < 24
    ? VIDEORC_CAMERA_APPROVAL_PATH_MACOS_13
    : VIDEORC_CAMERA_APPROVAL_PATH_MACOS_15
}

/** The macOS approval line: "Allow Videorc Camera in System Settings → …". */
export function videorcCameraApprovalLine(osRelease?: string): string {
  return `Allow ${VIDEORC_CAMERA} in ${osSettingsName('darwin')} → ${videorcCameraApprovalPath(osRelease)}.`
}

export const VIDEORC_CAMERA_COPY = {
  installing: 'Installing Videorc Camera…',
  starting: 'Starting Videorc Camera…',
  ready: 'Ready · choose Videorc Camera in the other app',
  inUse: (apps: number) => `In use by ${plural(apps, 'app')}`,
  needsRestart: (deviceNoun: string) =>
    `Restart your ${deviceNoun} to finish installing Videorc Camera.`,
  waitingForPassword: 'Waiting for your password…',
  settingUp: 'Setting up Videorc Camera…',
  windowsSetup: 'Needs a one-time setup. Windows asks for your permission once.',
  linuxSetup: 'Install v4l2loopback, then load it.',
  linuxSetupNoCommand: 'Install v4l2loopback with your package manager, then load it.',
  needsSetup: 'Needs a one-time setup.',
  cantRun: (deviceNoun: string) => `Videorc Camera can't run on this ${deviceNoun}.`,
  stopped: 'Stopped.',
  retrying: 'Videorc tries again on its own.',
  unsupported: "Videorc Camera isn't available on this computer.",
  notInThisStudio: "Videorc Camera isn't available in this Studio.",
  /** ⌘K's two items (E2). */
  turnOn: 'Turn Videorc Camera on',
  turnOff: 'Turn Videorc Camera off',
  /** The one warning toast (E1): its title, id and the line it falls back on. */
  stoppedToastTitle: 'Videorc Camera stopped',
  setUp: 'Set up Videorc Camera',
  loadModule: 'Load module',
  remove: 'Remove Videorc Camera',
  removeTitle: 'Remove Videorc Camera?',
  removeDescription:
    'Videorc Camera turns off and other apps stop listing it. macOS may ask for your password. Turn it on in Output to install it again.',
  removing: 'Removing…',
  removed: 'Videorc Camera removed'
} as const

/** One id for the one toast, so it never stacks. */
export const VIDEORC_CAMERA_TOAST_ID = 'virtual-camera'

/** What the Output page shows for the camera, and what ⌘K and agents mirror. */
export interface VirtualCameraView {
  /** The hide rule: nothing about the camera shows on this computer. */
  hidden: boolean
  /** The switch: checked, and whether it takes a click. */
  checked: boolean
  disabled: boolean
  /** The status line under the row, or null when there is nothing to say. */
  line: { text: string; tone: StatusTone; busy: boolean } | null
  /** The state's one action, or null. */
  action: { kind: Exclude<VirtualCameraAction, 'remove'>; label: string } | null
  /** Linux: the install command to copy, shown in its own line. */
  command: string | null
  /** The camera is showing the program to apps (ready or in use). */
  running: boolean
}

export interface VirtualCameraViewInput {
  status: VirtualCameraStatus | null
  /** The Studio's link to Videorc; offline, every control waits. */
  connected: boolean
  platform: string | undefined
  osRelease?: string
}

const HIDDEN_VIEW: VirtualCameraView = Object.freeze({
  hidden: true,
  checked: false,
  disabled: true,
  line: null,
  action: null,
  command: null,
  running: false
})

/** The hide rule, exactly: the backend says this computer can't have it. */
export function virtualCameraHidden(status: VirtualCameraStatus | null): boolean {
  return status === null || status.platformStep === 'unsupported'
}

/** Whether the camera is showing the program to apps right now. */
export function virtualCameraRunning(status: VirtualCameraStatus | null): boolean {
  return Boolean(status?.on && (status.state === 'ready' || status.state === 'streaming'))
}

/** The status line for one state, and its one action. Pure. */
export function virtualCameraView({
  status,
  connected,
  platform,
  osRelease
}: VirtualCameraViewInput): VirtualCameraView {
  if (!status || virtualCameraHidden(status)) return HIDDEN_VIEW
  const os = appPlatform(platform)
  const deviceNoun = platformCopy(platform).deviceNoun
  const view: VirtualCameraView = {
    hidden: false,
    // Locked means disabled: a camera that can't run never looks on.
    checked: status.on && status.available,
    disabled: !connected || !status.available,
    line: null,
    action: null,
    command: null,
    running: virtualCameraRunning(status)
  }
  const say = (text: string, tone: StatusTone = 'neutral', busy = false): void => {
    view.line = { text, tone, busy }
  }

  if (!status.available) {
    say(
      status.platformStep === 'failed' && status.message
        ? status.message
        : VIDEORC_CAMERA_COPY.cantRun(deviceNoun),
      'warn'
    )
  } else {
    switch (status.state) {
      case 'off':
        break
      case 'installing':
        say(
          status.platformStep === 'installing'
            ? VIDEORC_CAMERA_COPY.installing
            : VIDEORC_CAMERA_COPY.starting,
          'neutral',
          true
        )
        break
      case 'needs-approval':
        if (status.platformStep === 'needs-reboot') {
          say(VIDEORC_CAMERA_COPY.needsRestart(deviceNoun), 'warn')
        } else if (os === 'darwin') {
          say(videorcCameraApprovalLine(osRelease), 'warn')
          view.action = {
            kind: 'open-approval-settings',
            label: `Open ${osSettingsName(platform)}`
          }
        } else {
          say(VIDEORC_CAMERA_COPY.waitingForPassword, 'neutral', true)
        }
        break
      case 'needs-setup':
        if (status.platformStep === 'setting-up') {
          say(VIDEORC_CAMERA_COPY.settingUp, 'neutral', true)
        } else if (os === 'win32') {
          say(VIDEORC_CAMERA_COPY.windowsSetup, 'warn')
          view.action = { kind: 'set-up', label: VIDEORC_CAMERA_COPY.setUp }
        } else if (platform === 'linux') {
          // D1: the distro's install command arrives as the message.
          view.command = status.message ?? null
          say(
            view.command ? VIDEORC_CAMERA_COPY.linuxSetup : VIDEORC_CAMERA_COPY.linuxSetupNoCommand,
            'warn'
          )
          view.action = { kind: 'load-module', label: VIDEORC_CAMERA_COPY.loadModule }
        } else {
          say(VIDEORC_CAMERA_COPY.needsSetup, 'warn')
        }
        break
      case 'ready':
        say(VIDEORC_CAMERA_COPY.ready, 'good')
        break
      case 'streaming':
        // D13: a platform that can't count apps (Linux) reads as ready.
        say(
          status.viewers && status.viewers > 0
            ? VIDEORC_CAMERA_COPY.inUse(status.viewers)
            : VIDEORC_CAMERA_COPY.ready,
          'good'
        )
        break
      case 'unavailable':
        say(
          `${VIDEORC_CAMERA_COPY.stopped} ${status.message ?? VIDEORC_CAMERA_COPY.retrying}`,
          'warn'
        )
        break
    }
  }

  if (!connected) {
    // Offline, the line says why everything waits; the state comes back with Videorc.
    view.line = { text: OFFLINE_LOCK_REASON, tone: 'neutral', busy: false }
  }
  return view
}

/** Health's state word, one per state (plan 174 S1.3: a word, never the value). */
const STATE_LABELS: Readonly<Record<VirtualCameraState, string>> = {
  off: 'Off',
  installing: 'Installing',
  'needs-approval': 'Needs approval',
  'needs-setup': 'Needs setup',
  ready: 'Ready',
  streaming: 'In use',
  unavailable: 'Unavailable'
}

export function virtualCameraStateLabel(state: VirtualCameraState): string {
  return STATE_LABELS[state]
}

export function virtualCameraStateTone(status: VirtualCameraStatus): StatusTone {
  if (!status.available || status.state === 'unavailable') return 'warn'
  if (status.state === 'ready' || status.state === 'streaming') return 'good'
  if (status.state === 'needs-approval' || status.state === 'needs-setup') return 'warn'
  return 'neutral'
}

/**
 * The one warning toast (E1): it shows when a running camera stops on its
 * own, stays until the camera is back or the streamer turns it off, and
 * never shows for the streamer's own switch. Pure: what to do with the
 * toast, given the status before and after.
 */
export type VirtualCameraToastStep =
  | { kind: 'show'; title: string; description: string }
  | { kind: 'dismiss' }
  | { kind: 'none' }

export function virtualCameraToastStep(
  previous: VirtualCameraStatus | null,
  next: VirtualCameraStatus | null,
  options: { platform: string | undefined; osRelease?: string }
): VirtualCameraToastStep {
  if (!next || virtualCameraHidden(next) || !next.on || virtualCameraRunning(next)) {
    return { kind: 'dismiss' }
  }
  // Only a camera that was showing the program can stop. Starting up
  // (installing) is not a stop: the line already says it is starting.
  if (!virtualCameraRunning(previous) || next.state === 'installing') return { kind: 'none' }
  const line = virtualCameraView({ status: next, connected: true, ...options }).line
  const reason =
    next.state === 'unavailable'
      ? (next.message ?? VIDEORC_CAMERA_COPY.retrying)
      : (line?.text ?? VIDEORC_CAMERA_COPY.retrying)
  return { kind: 'show', title: VIDEORC_CAMERA_COPY.stoppedToastTitle, description: reason }
}

/**
 * The support bundle's line (E3): the state and the platform's step, the
 * switch and the count of apps. No message: a platform's words can carry a
 * path, and the counters already ride in the backend's own diagnostics.
 */
export function virtualCameraBundleLine(
  status: VirtualCameraStatus | null
): VirtualCameraBundleLine | undefined {
  if (!status) return undefined
  return {
    on: status.on,
    available: status.available,
    state: status.state,
    ...(status.platformStep ? { platformStep: status.platformStep } : {}),
    ...(status.viewers !== undefined ? { viewers: status.viewers } : {})
  }
}

/**
 * The agents' settings tool (E2): why `videorcCamera` can't change now, in
 * the same words the Output page shows, or null when it can.
 */
export function virtualCameraSettingRefusal(
  input: VirtualCameraViewInput,
  on: boolean
): string | null {
  const { status } = input
  if (!status) return VIDEORC_CAMERA_COPY.notInThisStudio
  if (virtualCameraHidden(status)) return VIDEORC_CAMERA_COPY.unsupported
  if (!input.connected) return OFFLINE_LOCK_REASON
  // Off always works on a computer that has the camera.
  if (!on) return null
  const view = virtualCameraView(input)
  return view.disabled ? (view.line?.text ?? VIDEORC_CAMERA_COPY.unsupported) : null
}
