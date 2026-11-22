import { describe, expect, it } from 'vitest'

import type { LinuxDesktopCheck, LinuxKeyringStatus } from '@/lib/backend'

import {
  deviceGroupsCheck,
  deviceGroupsIssue,
  keyringCheck,
  keyringIssue,
  linuxDesktopCheckSettled,
  linuxDesktopChecks,
  linuxDesktopIssues,
  portalBackendPackage,
  screenPortalCheck,
  screenPortalIssue
} from './linux-desktop-check'

const keyring = (patch: Partial<LinuxKeyringStatus> = {}): LinuxKeyringStatus => ({
  backend: 'gnome_libsecret',
  available: true,
  userPasswordStore: null,
  ...patch
})
const noKeyring = keyring({ backend: 'basic_text', available: false })

const group = (name: string, patch: Partial<LinuxDesktopCheck['groups'][number]> = {}) => ({
  name,
  exists: true,
  member: true,
  devices: 1,
  accessible: 1,
  ...patch
})

const desktop = (patch: Partial<LinuxDesktopCheck> = {}): LinuxDesktopCheck => ({
  secretService: 'running',
  portal: { frontend: 'running', screenCastVersion: 5, backends: ['gtk', 'hyprland'] },
  groups: [group('video'), group('render', { devices: 2, accessible: 2 })],
  currentDesktop: 'Hyprland',
  ...patch
})

describe('keyring', () => {
  it('names the store that works', () => {
    expect(keyringCheck(keyring(), 'running')).toEqual({ value: 'Secret Service', tone: 'good' })
    expect(keyringCheck(keyring({ backend: 'kwallet6' }))).toEqual({
      value: 'KWallet',
      tone: 'good'
    })
    expect(keyringIssue(keyring(), 'missing')).toBeNull()
  })

  it('says what to install when no Secret Service is on the bus', () => {
    expect(keyringCheck(noKeyring, 'missing')).toEqual({ value: 'Not found', tone: 'error' })
    const issue = keyringIssue(noKeyring, 'missing')
    expect(issue?.title).toBe('No keyring on this desktop')
    expect(issue?.description).toContain('Install GNOME Keyring (gnome-keyring) or KWallet')
    expect(issue?.description).toContain('then restart Videorc')
  })

  it('points at libsecret when a keyring runs but Videorc could not use it', () => {
    for (const state of ['running', 'activatable'] as const) {
      expect(keyringCheck(noKeyring, state).value).toBe("Can't open")
      const issue = keyringIssue(noKeyring, state)
      expect(issue?.title).toBe("Videorc can't open your keyring")
      expect(issue?.description).toContain('libsecret-1-0')
    }
  })

  it('blames the --password-store the person passed before the bus', () => {
    const turnedOff = keyring({
      backend: 'basic_text',
      available: false,
      userPasswordStore: 'basic'
    })
    expect(keyringCheck(turnedOff, 'running').value).toBe('Turned off')
    expect(keyringIssue(turnedOff, 'running')?.title).toBe(
      'Videorc was started with --password-store=basic'
    )
    // Their own gnome-libsecret is Videorc's choice too: the bus decides.
    const asked = keyring({
      backend: 'basic_text',
      available: false,
      userPasswordStore: 'gnome-libsecret'
    })
    expect(keyringIssue(asked, 'missing')?.title).toBe('No keyring on this desktop')
  })

  it('still says what to install before the backend answers', () => {
    expect(keyringCheck(noKeyring).value).toBe('Not available')
    expect(keyringIssue(noKeyring)?.title).toBe('No keyring Videorc can use')
    expect(keyringIssue(noKeyring, 'unknown')?.description).toContain('KWallet')
  })
})

describe('device groups', () => {
  it('is quiet when in both groups', () => {
    expect(deviceGroupsCheck([group('video'), group('render')])).toEqual({
      value: 'In video and render',
      tone: 'good'
    })
    expect(deviceGroupsIssue([group('video'), group('render')])).toBeNull()
  })

  it('is quiet when the desktop grants access without the group (Fedora, 0666 render)', () => {
    const groups = [group('video', { member: false }), group('render', { member: false })]
    expect(deviceGroupsCheck(groups)).toEqual({ value: 'Desktop grants access', tone: 'good' })
    expect(deviceGroupsIssue(groups)).toBeNull()
  })

  it('is quiet with no device to open, and ignores a group the system lacks', () => {
    const groups = [
      group('video', { member: false, devices: 0, accessible: 0 }),
      group('render', { exists: false, member: false, devices: 1, accessible: 0 })
    ]
    expect(deviceGroupsIssue(groups)).toBeNull()
    expect(deviceGroupsCheck(groups).tone).toBe('good')
  })

  it('names the group and the command when a device is closed to us', () => {
    const video = [group('video', { member: false, accessible: 0 }), group('render')]
    expect(deviceGroupsCheck(video)).toEqual({ value: 'Not in video', tone: 'warn' })
    expect(deviceGroupsIssue(video)).toEqual({
      id: 'device-groups',
      title: "Videorc can't open your camera",
      description:
        "Your user isn't in the video group. Run “sudo usermod -aG video $USER”, then log out and back in."
    })

    const both = [
      group('video', { member: false, accessible: 0 }),
      group('render', { member: false, devices: 2, accessible: 1 })
    ]
    expect(deviceGroupsCheck(both).value).toBe('Not in video or render')
    expect(deviceGroupsIssue(both)).toEqual({
      id: 'device-groups',
      title: "Videorc can't open your camera or the GPU encoder",
      description:
        "Your user isn't in the video or render groups. Run “sudo usermod -aG video,render $USER”, then log out and back in."
    })
  })
})

describe('screen portal', () => {
  it('is ready when ScreenCast answers', () => {
    expect(screenPortalCheck(desktop().portal)).toEqual({ value: 'Ready', tone: 'good' })
    expect(screenPortalIssue(desktop().portal, 'Hyprland')).toBeNull()
  })

  it('asks for xdg-desktop-portal and this desktop’s backend when the frontend is missing', () => {
    const portal = { frontend: 'missing' as const, backends: [] }
    expect(screenPortalCheck(portal)).toEqual({ value: 'Not installed', tone: 'error' })
    expect(screenPortalIssue(portal, 'Hyprland')).toEqual({
      id: 'screen-portal',
      title: 'Screen capture needs xdg-desktop-portal',
      description:
        'Install xdg-desktop-portal and xdg-desktop-portal-hyprland (the one for Hyprland), then log out and back in.'
    })
  })

  it('names the portals found when none shares the screen', () => {
    const portal = {
      frontend: 'running' as const,
      backends: ['gtk'],
      detail: 'ScreenCast: org.freedesktop.DBus.Error.InvalidArgs'
    }
    expect(screenPortalCheck(portal)).toEqual({ value: 'No screen sharing', tone: 'error' })
    const issue = screenPortalIssue(portal, 'KDE')
    expect(issue?.title).toBe("Your desktop's portal can't share the screen")
    expect(issue?.description).toContain("The portals here (gtk) don't share screens.")
    expect(issue?.description).toContain('xdg-desktop-portal-kde (the one for KDE)')
  })

  it('falls back to the list of backends on a desktop it does not know', () => {
    const issue = screenPortalIssue({ frontend: 'activatable', backends: [] }, 'Weird')
    expect(issue?.description).toContain('xdg-desktop-portal-gnome, -kde, -hyprland or -wlr')
    expect(issue?.description).not.toContain('The portals here')
  })

  it('never blames the desktop for a bus or portal that did not answer', () => {
    expect(screenPortalCheck({ frontend: 'unknown', backends: [] }).tone).toBe('neutral')
    expect(
      screenPortalCheck({
        frontend: 'running',
        backends: ['hyprland'],
        detail: 'ScreenCast: the portal did not answer in time'
      }).tone
    ).toBe('neutral')
    expect(screenPortalIssue({ frontend: 'unknown', backends: [] })).toBeNull()
  })

  it.each([
    ['Hyprland', 'xdg-desktop-portal-hyprland'],
    ['KDE', 'xdg-desktop-portal-kde'],
    ['ubuntu:GNOME', 'xdg-desktop-portal-gnome'],
    ['sway', 'xdg-desktop-portal-wlr'],
    ['niri', 'xdg-desktop-portal-gnome'],
    ['COSMIC', 'xdg-desktop-portal-cosmic']
  ])('maps %j to %j', (current, pkg) => {
    expect(portalBackendPackage(current)).toBe(pkg)
  })

  it('has no package for an unknown or empty desktop', () => {
    expect(portalBackendPackage('Weird')).toBeNull()
    expect(portalBackendPackage(undefined)).toBeNull()
  })
})

describe('Health rows and alerts', () => {
  it('adds nothing until data arrives', () => {
    expect(linuxDesktopChecks({})).toEqual([])
    expect(linuxDesktopIssues({})).toEqual([])
  })

  it('shows the keyring row from RuntimeInfo before the backend answers', () => {
    expect(linuxDesktopChecks({ keyring: noKeyring, desktop: null })).toEqual([
      { id: 'keyring', label: 'Keyring', value: 'Not available', tone: 'error' }
    ])
  })

  it('lists three rows and one alert per problem, in order', () => {
    const broken = desktop({
      secretService: 'missing',
      portal: { frontend: 'missing', backends: [] },
      groups: [group('video', { member: false, accessible: 0 })]
    })
    expect(
      linuxDesktopChecks({ keyring: noKeyring, desktop: broken }).map((row) => row.id)
    ).toEqual(['keyring', 'device-groups', 'screen-portal'])
    expect(linuxDesktopIssues({ keyring: noKeyring, desktop: broken }).map((i) => i.id)).toEqual([
      'keyring',
      'device-groups',
      'screen-portal'
    ])
    expect(linuxDesktopIssues({ keyring: keyring(), desktop: desktop() })).toEqual([])
  })
})

describe('linuxDesktopCheckSettled', () => {
  it('keeps answers where the bus and the portal both answered', () => {
    expect(linuxDesktopCheckSettled(desktop())).toBe(true)
    expect(
      linuxDesktopCheckSettled(desktop({ portal: { frontend: 'missing', backends: [] } }))
    ).toBe(true)
    expect(
      linuxDesktopCheckSettled(
        desktop({
          portal: { frontend: 'running', backends: ['gtk'], detail: 'ScreenCast: InvalidArgs' }
        })
      )
    ).toBe(true)
  })

  it('asks again after a bus or portal that did not answer', () => {
    expect(
      linuxDesktopCheckSettled(desktop({ portal: { frontend: 'unknown', backends: [] } }))
    ).toBe(false)
    expect(
      linuxDesktopCheckSettled(
        desktop({
          portal: {
            frontend: 'running',
            backends: ['hyprland'],
            detail: 'ScreenCast: the portal did not answer in time'
          }
        })
      )
    ).toBe(false)
  })
})
