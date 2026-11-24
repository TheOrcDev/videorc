import { describe, expect, it } from 'vitest'

import {
  chromiumMapsPasswordStore,
  linuxKeyringStatus,
  linuxPasswordStoreSwitch
} from './linux-password-store'

describe('linuxPasswordStoreSwitch', () => {
  it.each(['Hyprland', 'sway', 'i3', 'niri', 'LXQt', ''])(
    'asks for libsecret on %j, which Chromium maps to basic_text',
    (desktop) => {
      expect(linuxPasswordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: desktop }, false)).toBe(
        'gnome-libsecret'
      )
    }
  )

  it('asks for libsecret with no desktop variables at all', () => {
    expect(linuxPasswordStoreSwitch('linux', {}, false)).toBe('gnome-libsecret')
  })

  it.each([
    'GNOME',
    'KDE',
    'ubuntu:GNOME',
    'XFCE',
    'X-Cinnamon',
    'Unity',
    'COSMIC',
    'Hyprland:KDE'
  ])("leaves Chromium's own store alone on %j", (desktop) => {
    expect(linuxPasswordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: desktop }, false)).toBeNull()
  })

  it('stops at the first desktop Chromium knows, as Chromium does', () => {
    expect(chromiumMapsPasswordStore({ XDG_CURRENT_DESKTOP: 'LXQt:GNOME' })).toBe(false)
    expect(chromiumMapsPasswordStore({ XDG_CURRENT_DESKTOP: ' :KDE' })).toBe(true)
  })

  it('falls back to the older session variables like Chromium', () => {
    expect(chromiumMapsPasswordStore({ XDG_CURRENT_DESKTOP: '', DESKTOP_SESSION: 'gnome' })).toBe(
      true
    )
    expect(chromiumMapsPasswordStore({ DESKTOP_SESSION: 'kde-plasma' })).toBe(true)
    expect(chromiumMapsPasswordStore({ DESKTOP_SESSION: 'xfce4' })).toBe(true)
    expect(chromiumMapsPasswordStore({ DESKTOP_SESSION: 'kde', KDE_SESSION_VERSION: '5' })).toBe(
      true
    )
    expect(chromiumMapsPasswordStore({ DESKTOP_SESSION: 'kde' })).toBe(false)
    expect(chromiumMapsPasswordStore({ GNOME_DESKTOP_SESSION_ID: 'this-is-deprecated' })).toBe(true)
    expect(chromiumMapsPasswordStore({ DESKTOP_SESSION: 'hyprland' })).toBe(false)
  })

  it('never overrides a password-store the user passed', () => {
    expect(linuxPasswordStoreSwitch('linux', { XDG_CURRENT_DESKTOP: 'Hyprland' }, true)).toBeNull()
  })

  it.each(['darwin', 'win32'] as const)('does nothing on %s', (platform) => {
    expect(
      linuxPasswordStoreSwitch(platform, { XDG_CURRENT_DESKTOP: 'Hyprland' }, false)
    ).toBeNull()
  })
})

describe('linuxKeyringStatus (plan 257 S18)', () => {
  const store = (available: boolean, backend: string) => ({
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend
  })

  it('says nothing off Linux, so macOS and Windows never ask safeStorage', () => {
    const probe = {
      isEncryptionAvailable: () => {
        throw new Error('must not be asked')
      }
    }
    expect(linuxKeyringStatus('darwin', probe, null)).toBeNull()
    expect(linuxKeyringStatus('win32', probe, null)).toBeNull()
  })

  it('is available with a real store', () => {
    expect(linuxKeyringStatus('linux', store(true, 'gnome_libsecret'), null)).toEqual({
      backend: 'gnome_libsecret',
      available: true,
      userPasswordStore: null
    })
    expect(linuxKeyringStatus('linux', store(true, 'kwallet6'), null)?.available).toBe(true)
  })

  it('is unavailable on basic_text even when Chromium calls it available', () => {
    expect(linuxKeyringStatus('linux', store(true, 'basic_text'), null)?.available).toBe(false)
    expect(linuxKeyringStatus('linux', store(false, 'basic_text'), 'basic')).toEqual({
      backend: 'basic_text',
      available: false,
      userPasswordStore: 'basic'
    })
  })

  it('reads a throwing safeStorage as unavailable, never as a crash', () => {
    const probe = {
      isEncryptionAvailable: () => {
        throw new Error('not ready')
      },
      getSelectedStorageBackend: () => {
        throw new Error('not ready')
      }
    }
    expect(linuxKeyringStatus('linux', probe, null)).toEqual({
      backend: 'unknown',
      available: false,
      userPasswordStore: null
    })
  })
})
