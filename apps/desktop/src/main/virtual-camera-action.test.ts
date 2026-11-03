import { describe, expect, it, vi } from 'vitest'

import type { CameraExtensionPhase, CameraExtensionState } from './camera-extension'
import {
  CAMERA_EXTENSION_APPROVAL_URLS,
  VIRTUAL_CAMERA_NOT_AVAILABLE,
  cameraExtensionApprovalUrl,
  removalResult,
  runVirtualCameraAction,
  type VirtualCameraActionHost
} from './virtual-camera-action'

// Plan 214 E: the action channel's one dispatch point in main.

function state(phase: CameraExtensionPhase): CameraExtensionState {
  return {
    phase,
    action: 'deactivate',
    reason: null,
    code: null,
    codeName: null,
    detail: null,
    existingVersion: null,
    newVersion: null,
    updatedAt: 0
  }
}

function host(overrides: Partial<VirtualCameraActionHost> = {}): VirtualCameraActionHost {
  return {
    platform: 'darwin',
    osRelease: '25.5.0',
    openExternal: vi.fn(async () => {}),
    deactivateCameraExtension: vi.fn(async () => state('removed')),
    ...overrides
  }
}

describe('Videorc Camera actions in main (plan 214 E)', () => {
  it('opens Privacy & Security on macOS 13 and 14, Login Items & Extensions from 15', () => {
    expect(cameraExtensionApprovalUrl('22.6.0')).toBe(
      'x-apple.systempreferences:com.apple.preference.security'
    )
    expect(cameraExtensionApprovalUrl('23.4.0')).toBe(
      'x-apple.systempreferences:com.apple.preference.security'
    )
    for (const release of ['24.0.0', '25.5.0']) {
      expect(cameraExtensionApprovalUrl(release)).toBe(
        'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'
      )
    }
    expect(cameraExtensionApprovalUrl('')).toBe(CAMERA_EXTENSION_APPROVAL_URLS.loginItemsExtensions)
  })

  it('opens the approval pane, and System Settings itself when the pane fails', async () => {
    const opened: string[] = []
    const first = host({
      osRelease: '23.1.0',
      openExternal: async (url) => {
        opened.push(url)
      }
    })
    await expect(runVirtualCameraAction('open-approval-settings', first)).resolves.toEqual({
      ok: true
    })
    expect(opened).toEqual([CAMERA_EXTENSION_APPROVAL_URLS.privacySecurity])

    opened.length = 0
    const fallback = host({
      openExternal: async (url) => {
        opened.push(url)
        if (url !== CAMERA_EXTENSION_APPROVAL_URLS.systemSettings) throw new Error('no pane')
      }
    })
    await expect(runVirtualCameraAction('open-approval-settings', fallback)).resolves.toEqual({
      ok: true
    })
    expect(opened).toEqual([
      CAMERA_EXTENSION_APPROVAL_URLS.loginItemsExtensions,
      CAMERA_EXTENSION_APPROVAL_URLS.systemSettings
    ])

    const neither = host({
      openExternal: async () => {
        throw new Error('no settings')
      }
    })
    const refused = await runVirtualCameraAction('open-approval-settings', neither)
    expect(refused.ok).toBe(false)
    expect(refused.message).toBe("Couldn't open System Settings. Open it from the Apple menu.")
  })

  it('removes through the extension controller and words each result', async () => {
    const remove = host()
    await expect(runVirtualCameraAction('remove', remove)).resolves.toEqual({ ok: true })
    expect(remove.deactivateCameraExtension).toHaveBeenCalledTimes(1)

    expect(removalResult(state('reboot-required'))).toEqual({
      ok: true,
      message: 'Videorc Camera is gone after your Mac restarts.'
    })
    expect(removalResult(state('needs-approval'))).toEqual({
      ok: true,
      message: 'Approve the removal in System Settings.'
    })
    expect(removalResult(state('unavailable'))).toEqual({
      ok: false,
      message: VIRTUAL_CAMERA_NOT_AVAILABLE
    })
    for (const phase of ['failed', 'active', 'idle'] as const) {
      expect(removalResult(state(phase))).toEqual({
        ok: false,
        message: "macOS didn't remove Videorc Camera. Try again in a moment."
      })
    }
  })

  it('says "Not available on this computer." until Windows and Linux plug in', async () => {
    const refusal = { ok: false, message: 'Not available on this computer.' }
    const windows = host({ platform: 'win32' })
    const linux = host({ platform: 'linux' })
    await expect(runVirtualCameraAction('set-up', windows)).resolves.toEqual(refusal)
    await expect(runVirtualCameraAction('load-module', linux)).resolves.toEqual(refusal)
    // macOS actions stay macOS's.
    await expect(runVirtualCameraAction('open-approval-settings', windows)).resolves.toEqual(
      refusal
    )
    await expect(runVirtualCameraAction('remove', linux)).resolves.toEqual(refusal)
    expect(windows.openExternal).not.toHaveBeenCalled()
    expect(linux.deactivateCameraExtension).not.toHaveBeenCalled()
    // And no action from the wrong platform.
    await expect(runVirtualCameraAction('set-up', host())).resolves.toEqual(refusal)
    await expect(runVirtualCameraAction('load-module', windows)).resolves.toEqual(refusal)
  })

  it('hands set-up and load-module to the platform functions once they exist', async () => {
    const setUp = vi.fn(async () => ({ ok: true }))
    const loadModule = vi.fn(async () => ({ ok: false, message: 'Secure Boot blocked it.' }))
    await expect(
      runVirtualCameraAction('set-up', host({ platform: 'win32', setUp }))
    ).resolves.toEqual({ ok: true })
    await expect(
      runVirtualCameraAction('load-module', host({ platform: 'linux', loadModule }))
    ).resolves.toEqual({ ok: false, message: 'Secure Boot blocked it.' })
    expect(setUp).toHaveBeenCalledTimes(1)
    expect(loadModule).toHaveBeenCalledTimes(1)
  })

  it('refuses an unknown action before any platform sees it', async () => {
    const mac = host()
    for (const action of ['install', '', null, 7, { action: 'remove' }]) {
      await expect(runVirtualCameraAction(action, mac)).resolves.toEqual({
        ok: false,
        message: VIRTUAL_CAMERA_NOT_AVAILABLE
      })
    }
    expect(mac.openExternal).not.toHaveBeenCalled()
    expect(mac.deactivateCameraExtension).not.toHaveBeenCalled()
  })
})
