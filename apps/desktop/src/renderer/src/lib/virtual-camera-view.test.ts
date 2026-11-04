import { describe, expect, it } from 'vitest'

import fixtures from '../../../../../../protocol-fixtures/virtual-camera.json'
import type { VirtualCameraState, VirtualCameraStatus } from '@/lib/backend'
import { OFFLINE_LOCK_REASON } from '@/lib/lock-reason'
import {
  VIDEORC_CAMERA_APPROVAL_PATH_MACOS_13,
  VIDEORC_CAMERA_APPROVAL_PATH_MACOS_15,
  virtualCameraBundleLine,
  virtualCameraHidden,
  virtualCameraSettingRefusal,
  virtualCameraStateLabel,
  virtualCameraToastStep,
  virtualCameraView,
  videorcCameraApprovalPath,
  type VirtualCameraView
} from './virtual-camera-view'

// Plan 214 E: every state's line and its one action, on each platform, and
// the hide rule. A4's own fixtures stand in for the backend.

const SONOMA = '23.6.0'
const TAHOE = '25.5.0'

function view(
  status: VirtualCameraStatus | null,
  platform = 'darwin',
  osRelease = TAHOE,
  connected = true
): VirtualCameraView {
  return virtualCameraView({ status, connected, platform, osRelease })
}

/** What the row shows: the switch, the line and the action. */
function shown(result: VirtualCameraView) {
  return {
    checked: result.checked,
    disabled: result.disabled,
    line: result.line?.text ?? null,
    tone: result.line?.tone ?? null,
    busy: result.line?.busy ?? false,
    action: result.action ? `${result.action.kind}: ${result.action.label}` : null,
    command: result.command
  }
}

const NONE = { action: null, command: null }

describe('Videorc Camera: the approval path by macOS version (plan 214 E1, E4)', () => {
  it('names Privacy & Security on 13 and 14, Login Items & Extensions from 15', () => {
    expect(videorcCameraApprovalPath('22.1.0')).toBe('Privacy & Security')
    expect(videorcCameraApprovalPath(SONOMA)).toBe(VIDEORC_CAMERA_APPROVAL_PATH_MACOS_13)
    expect(videorcCameraApprovalPath('24.0.0')).toBe(
      'General → Login Items & Extensions → Camera Extensions'
    )
    expect(videorcCameraApprovalPath(TAHOE)).toBe(VIDEORC_CAMERA_APPROVAL_PATH_MACOS_15)
    expect(videorcCameraApprovalPath(undefined)).toBe(VIDEORC_CAMERA_APPROVAL_PATH_MACOS_15)
  })
})

describe('Videorc Camera: every state on macOS (plan 214 E1)', () => {
  it('off: the switch alone, no line', () => {
    expect(shown(view(fixtures.off as VirtualCameraStatus))).toEqual({
      checked: false,
      disabled: false,
      line: null,
      tone: null,
      busy: false,
      ...NONE
    })
  })

  it('installing and starting: a busy line, the switch stays on', () => {
    expect(
      shown(view({ on: true, available: true, state: 'installing', platformStep: 'installing' }))
    ).toEqual({
      checked: true,
      disabled: false,
      line: 'Installing Videorc Camera…',
      tone: 'neutral',
      busy: true,
      ...NONE
    })
    expect(
      shown(
        view({
          on: true,
          available: true,
          state: 'installing',
          message: 'Starting Videorc Camera…'
        })
      )
    ).toEqual({
      checked: true,
      disabled: false,
      line: 'Starting Videorc Camera…',
      tone: 'neutral',
      busy: true,
      ...NONE
    })
  })

  it('needs approval: the path for this macOS and Open System Settings', () => {
    const needsApproval = fixtures.needsApproval as VirtualCameraStatus
    expect(shown(view(needsApproval))).toEqual({
      checked: true,
      disabled: false,
      line: 'Allow Videorc Camera in System Settings → General → Login Items & Extensions → Camera Extensions.',
      tone: 'warn',
      busy: false,
      action: 'open-approval-settings: Open System Settings',
      command: null
    })
    expect(shown(view(needsApproval, 'darwin', SONOMA)).line).toBe(
      'Allow Videorc Camera in System Settings → Privacy & Security.'
    )
    // The approval words are the page's, not the platform's message.
    expect(
      view({ ...needsApproval, message: 'Something else entirely.' }).line?.text
    ).not.toContain('Something else')
  })

  it('needs a restart: the words, no action', () => {
    expect(
      shown(
        view({ on: true, available: true, state: 'needs-approval', platformStep: 'needs-reboot' })
      )
    ).toEqual({
      checked: true,
      disabled: false,
      line: 'Restart your Mac to finish installing Videorc Camera.',
      tone: 'warn',
      busy: false,
      ...NONE
    })
  })

  it('ready, in use, and in use with an unknown count', () => {
    expect(shown(view(fixtures.ready as VirtualCameraStatus))).toEqual({
      checked: true,
      disabled: false,
      line: 'Ready · choose Videorc Camera in the other app',
      tone: 'good',
      busy: false,
      ...NONE
    })
    expect(view({ ...(fixtures.streaming as VirtualCameraStatus), viewers: 1 }).line?.text).toBe(
      'In use by 1 app'
    )
    expect(view(fixtures.streaming as VirtualCameraStatus).line).toEqual({
      text: 'In use by 2 apps',
      tone: 'good',
      busy: false
    })
    expect(view(fixtures.streamingUnknownViewers as VirtualCameraStatus).line?.text).toBe(
      'Ready · choose Videorc Camera in the other app'
    )
  })

  it('stopped while on: the reason, and the switch still turns it off', () => {
    expect(
      shown(
        view({
          on: true,
          available: true,
          state: 'unavailable',
          message: 'No Videorc Camera device.'
        })
      )
    ).toEqual({
      checked: true,
      disabled: false,
      line: 'Stopped. No Videorc Camera device.',
      tone: 'warn',
      busy: false,
      ...NONE
    })
    expect(view({ on: true, available: true, state: 'unavailable' }).line?.text).toBe(
      'Stopped. Videorc tries again on its own.'
    )
  })

  it("can't run: locked off with one reason, never the backend's internals", () => {
    expect(shown(view(fixtures.unavailableNoSink as VirtualCameraStatus))).toEqual({
      checked: false,
      disabled: true,
      line: "Videorc Camera can't run on this Mac.",
      tone: 'warn',
      busy: false,
      ...NONE
    })
    expect(
      shown(
        view({
          on: true,
          available: false,
          state: 'unavailable',
          platformStep: 'failed',
          message: 'Move Videorc to the Applications folder.'
        })
      )
    ).toEqual({
      checked: false,
      disabled: true,
      line: 'Move Videorc to the Applications folder.',
      tone: 'warn',
      busy: false,
      ...NONE
    })
  })

  it('offline: every control waits, and the line says why', () => {
    expect(
      shown(view(fixtures.needsApproval as VirtualCameraStatus, 'darwin', TAHOE, false))
    ).toEqual({
      checked: true,
      disabled: true,
      line: OFFLINE_LOCK_REASON,
      tone: 'neutral',
      busy: false,
      action: 'open-approval-settings: Open System Settings',
      command: null
    })
  })
})

describe('Videorc Camera on Windows and Linux (plan 214 E1)', () => {
  it('Windows: the one-time setup, then setting up', () => {
    expect(shown(view(fixtures.needsSetup as VirtualCameraStatus, 'win32'))).toEqual({
      checked: false,
      disabled: false,
      line: 'Needs a one-time setup. Windows asks for your permission once.',
      tone: 'warn',
      busy: false,
      action: 'set-up: Set up Videorc Camera',
      command: null
    })
    expect(
      shown(
        view(
          { on: true, available: true, state: 'needs-setup', platformStep: 'setting-up' },
          'win32'
        )
      )
    ).toEqual({
      checked: true,
      disabled: false,
      line: 'Setting up Videorc Camera…',
      tone: 'neutral',
      busy: true,
      ...NONE
    })
    expect(
      view(
        {
          on: false,
          available: false,
          state: 'unavailable',
          platformStep: 'failed',
          message: 'Videorc Camera needs Windows 11.'
        },
        'win32'
      ).line?.text
    ).toBe('Videorc Camera needs Windows 11.')
    expect(view({ on: false, available: false, state: 'unavailable' }, 'win32').line?.text).toBe(
      "Videorc Camera can't run on this PC."
    )
  })

  it('Linux: the install command to copy, then Load module, then the password', () => {
    const command = 'sudo apt install v4l2loopback-dkms'
    expect(
      shown(
        view(
          {
            on: true,
            available: true,
            state: 'needs-setup',
            platformStep: 'needs-setup',
            message: command
          },
          'linux'
        )
      )
    ).toEqual({
      checked: true,
      disabled: false,
      line: 'Install v4l2loopback, then load it.',
      tone: 'warn',
      busy: false,
      action: 'load-module: Load module',
      command
    })
    expect(shown(view({ on: true, available: true, state: 'needs-setup' }, 'linux')).line).toBe(
      'Install v4l2loopback with your package manager, then load it.'
    )
    expect(
      shown(
        view(
          { on: true, available: true, state: 'needs-approval', platformStep: 'needs-approval' },
          'linux'
        )
      )
    ).toEqual({
      checked: true,
      disabled: false,
      line: 'Waiting for your password…',
      tone: 'neutral',
      busy: true,
      ...NONE
    })
    // D13: Linux can't count apps; on and writing reads as ready.
    expect(view({ on: true, available: true, state: 'streaming' }, 'linux').line?.text).toBe(
      'Ready · choose Videorc Camera in the other app'
    )
  })
})

describe('the hide rule (owner, 2026-11-03)', () => {
  const unsupported: VirtualCameraStatus = {
    on: true,
    available: false,
    state: 'unavailable',
    platformStep: 'unsupported',
    message:
      "Videorc Camera isn't available on Windows yet (the Media Foundation camera, plan 214 C3, hasn't shipped)."
  }

  it('hides the camera exactly where the backend says this computer is unsupported', () => {
    for (const platform of ['win32', 'linux', 'darwin']) {
      const result = view(unsupported, platform)
      expect(result.hidden, platform).toBe(true)
      expect(result.line, platform).toBeNull()
      expect(result.action, platform).toBeNull()
    }
    expect(virtualCameraHidden(unsupported)).toBe(true)
    // Nothing is known yet: nothing shows.
    expect(virtualCameraHidden(null)).toBe(true)
    expect(view(null).hidden).toBe(true)
    // Every other step shows, even a camera that can't run.
    for (const platformStep of [
      undefined,
      'installing',
      'needs-approval',
      'needs-reboot',
      'ready',
      'failed',
      'needs-setup',
      'setting-up'
    ] as const) {
      const status: VirtualCameraStatus = {
        on: false,
        available: platformStep !== 'failed',
        state: 'off',
        ...(platformStep ? { platformStep } : {})
      }
      expect(virtualCameraHidden(status), String(platformStep)).toBe(false)
    }
  })

  it('refuses the agents in the hide rule’s words, and every other state in the row’s', () => {
    const input = (status: VirtualCameraStatus | null, connected = true) => ({
      status,
      connected,
      platform: 'darwin',
      osRelease: TAHOE
    })
    expect(virtualCameraSettingRefusal(input(unsupported), true)).toBe(
      "Videorc Camera isn't available on this computer."
    )
    expect(virtualCameraSettingRefusal(input(unsupported), false)).toBe(
      "Videorc Camera isn't available on this computer."
    )
    expect(virtualCameraSettingRefusal(input(null), true)).toBe(
      "Videorc Camera isn't available in this Studio."
    )
    expect(
      virtualCameraSettingRefusal(input(fixtures.off as VirtualCameraStatus, false), true)
    ).toBe(OFFLINE_LOCK_REASON)
    expect(
      virtualCameraSettingRefusal(input(fixtures.unavailableNoSink as VirtualCameraStatus), true)
    ).toBe("Videorc Camera can't run on this Mac.")
    // Off always works where the camera exists.
    expect(
      virtualCameraSettingRefusal(input(fixtures.unavailableNoSink as VirtualCameraStatus), false)
    ).toBeNull()
    expect(
      virtualCameraSettingRefusal(input(fixtures.needsApproval as VirtualCameraStatus), true)
    ).toBeNull()
  })
})

describe('the one stop toast (plan 214 E1)', () => {
  const ready = fixtures.ready as VirtualCameraStatus
  const streaming = fixtures.streaming as VirtualCameraStatus
  const options = { platform: 'darwin', osRelease: TAHOE }

  it('shows when a running camera stops on its own, with the reason', () => {
    expect(
      virtualCameraToastStep(
        streaming,
        {
          on: true,
          available: true,
          state: 'unavailable',
          message: 'The camera device went away.'
        },
        options
      )
    ).toEqual({
      kind: 'show',
      title: 'Videorc Camera stopped',
      description: 'The camera device went away.'
    })
    expect(
      virtualCameraToastStep(ready, { on: true, available: true, state: 'unavailable' }, options)
    ).toEqual({
      kind: 'show',
      title: 'Videorc Camera stopped',
      description: 'Videorc tries again on its own.'
    })
    // Approval taken back in System Settings: the line's own words.
    expect(
      virtualCameraToastStep(ready, fixtures.needsApproval as VirtualCameraStatus, options)
    ).toEqual({
      kind: 'show',
      title: 'Videorc Camera stopped',
      description:
        'Allow Videorc Camera in System Settings → General → Login Items & Extensions → Camera Extensions.'
    })
  })

  it('never shows for the switch, a start or a camera that was not running', () => {
    expect(virtualCameraToastStep(streaming, fixtures.off as VirtualCameraStatus, options)).toEqual(
      {
        kind: 'dismiss'
      }
    )
    expect(
      virtualCameraToastStep(
        ready,
        { on: true, available: true, state: 'installing', message: 'Starting Videorc Camera…' },
        options
      )
    ).toEqual({ kind: 'none' })
    expect(
      virtualCameraToastStep(
        fixtures.needsApproval as VirtualCameraStatus,
        { on: true, available: true, state: 'unavailable' },
        options
      )
    ).toEqual({ kind: 'none' })
    expect(
      virtualCameraToastStep(null, { on: true, available: true, state: 'unavailable' }, options)
    ).toEqual({ kind: 'none' })
  })

  it('goes away when the camera is back, turned off or hidden', () => {
    const stopped: VirtualCameraStatus = { on: true, available: true, state: 'unavailable' }
    expect(virtualCameraToastStep(stopped, ready, options)).toEqual({ kind: 'dismiss' })
    expect(virtualCameraToastStep(stopped, { ...stopped, on: false }, options)).toEqual({
      kind: 'dismiss'
    })
    expect(
      virtualCameraToastStep(
        stopped,
        { on: true, available: false, state: 'unavailable', platformStep: 'unsupported' },
        options
      )
    ).toEqual({ kind: 'dismiss' })
  })
})

describe('Health and the support bundle (plan 214 E3)', () => {
  it('names every state in a word, never the value', () => {
    const states: VirtualCameraState[] = [
      'off',
      'installing',
      'needs-approval',
      'needs-setup',
      'ready',
      'streaming',
      'unavailable'
    ]
    expect(states.map(virtualCameraStateLabel)).toEqual([
      'Off',
      'Installing',
      'Needs approval',
      'Needs setup',
      'Ready',
      'In use',
      'Unavailable'
    ])
  })

  it('bundles the state, the step and the count, and never the message', () => {
    expect(
      virtualCameraBundleLine({
        on: true,
        available: false,
        state: 'unavailable',
        platformStep: 'failed',
        message: 'Move /Users/someone/Downloads/Videorc.app to the Applications folder.'
      })
    ).toEqual({ on: true, available: false, state: 'unavailable', platformStep: 'failed' })
    const line = virtualCameraBundleLine(fixtures.streaming as VirtualCameraStatus)
    expect(line).toEqual({
      on: true,
      available: true,
      state: 'streaming',
      viewers: 2,
      platformStep: 'ready'
    })
    expect(Object.keys(line ?? {}).sort()).toEqual([
      'available',
      'on',
      'platformStep',
      'state',
      'viewers'
    ])
    expect(virtualCameraBundleLine(fixtures.off as VirtualCameraStatus)).toEqual({
      on: false,
      available: true,
      state: 'off'
    })
    expect(virtualCameraBundleLine(null)).toBeUndefined()
  })
})
