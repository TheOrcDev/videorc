import type {
  LinuxBusServiceState,
  LinuxDesktopCheck,
  LinuxDeviceGroupCheck,
  LinuxKeyringStatus,
  LinuxPortalCheck
} from '@/lib/backend'
import type { HealthCheck } from '@/lib/health-checks'

// What a Linux desktop is missing, in words (plan 257 S18). Three Health rows
// (Keyring, Device groups, Screen portal) and, for each that needs the
// streamer, one alert that says what to install. Destinations shows the
// keyring alert too, before any sign-in starts. Pure, so every message is
// pinned by tests.

export type LinuxSetupIssueId = 'keyring' | 'device-groups' | 'screen-portal'

/** One thing to fix on this desktop: a title and what to install or run. */
export interface LinuxSetupIssue {
  id: LinuxSetupIssueId
  title: string
  description: string
}

export interface LinuxDesktopInput {
  /** From RuntimeInfo; absent off Linux or before it arrives. */
  keyring?: LinuxKeyringStatus | null
  /** From `diagnostics.linuxDesktop`; null until the backend answers. */
  desktop?: LinuxDesktopCheck | null
}

type CheckWords = Pick<HealthCheck, 'value' | 'tone'>

const KEYRING_NEEDS =
  'Signing in to Videorc and remembering your recordings folder need a keyring (Secret Service).'

function keyringBackendLabel(backend: string): string {
  if (backend.startsWith('kwallet')) return 'KWallet'
  if (backend === 'gnome_libsecret') return 'Secret Service'
  return 'Available'
}

type KeyringProblem = 'turned-off' | 'no-service' | 'cannot-open' | 'unavailable'

function keyringProblem(
  keyring: LinuxKeyringStatus,
  secretService: LinuxBusServiceState | undefined
): KeyringProblem | null {
  if (keyring.available) return null
  if (keyring.userPasswordStore && keyring.userPasswordStore !== 'gnome-libsecret') {
    return 'turned-off'
  }
  if (secretService === 'missing') return 'no-service'
  if (secretService === 'running' || secretService === 'activatable') return 'cannot-open'
  return 'unavailable'
}

export function keyringCheck(
  keyring: LinuxKeyringStatus,
  secretService?: LinuxBusServiceState
): CheckWords {
  switch (keyringProblem(keyring, secretService)) {
    case null:
      return { value: keyringBackendLabel(keyring.backend), tone: 'good' }
    case 'turned-off':
      return { value: 'Turned off', tone: 'error' }
    case 'no-service':
      return { value: 'Not found', tone: 'error' }
    case 'cannot-open':
      return { value: "Can't open", tone: 'error' }
    default:
      return { value: 'Not available', tone: 'error' }
  }
}

export function keyringIssue(
  keyring: LinuxKeyringStatus,
  secretService?: LinuxBusServiceState
): LinuxSetupIssue | null {
  const install =
    'Install GNOME Keyring (gnome-keyring) or KWallet, make sure it starts with your desktop, then restart Videorc.'
  switch (keyringProblem(keyring, secretService)) {
    case null:
      return null
    case 'turned-off':
      return {
        id: 'keyring',
        title: `Videorc was started with --password-store=${keyring.userPasswordStore}`,
        description: `${KEYRING_NEEDS} Start Videorc without --password-store, or with --password-store=gnome-libsecret.`
      }
    case 'no-service':
      return {
        id: 'keyring',
        title: 'No keyring on this desktop',
        description: `${KEYRING_NEEDS} ${install}`
      }
    case 'cannot-open':
      return {
        id: 'keyring',
        title: "Videorc can't open your keyring",
        description: `${KEYRING_NEEDS} One is running, but Videorc couldn't use it. Unlock it if your desktop asks; otherwise install libsecret (libsecret-1-0 on Ubuntu and Debian), then restart Videorc.`
      }
    default:
      return {
        id: 'keyring',
        title: 'No keyring Videorc can use',
        description: `${KEYRING_NEEDS} ${install}`
      }
  }
}

/** A group that exists, guards a device this run can't open, and isn't ours. */
function blockedGroups(groups: readonly LinuxDeviceGroupCheck[]): LinuxDeviceGroupCheck[] {
  return groups.filter((group) => group.exists && !group.member && group.accessible < group.devices)
}

function joinOr(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
}

export function deviceGroupsCheck(groups: readonly LinuxDeviceGroupCheck[]): CheckWords {
  const blocked = blockedGroups(groups)
  if (blocked.length) {
    return { value: `Not in ${joinOr(blocked.map((group) => group.name))}`, tone: 'warn' }
  }
  const existing = groups.filter((group) => group.exists)
  if (existing.length && existing.every((group) => group.member)) {
    return { value: `In ${existing.map((group) => group.name).join(' and ')}`, tone: 'good' }
  }
  // Not in a group, but the seat ACL (uaccess) or a 0666 node opens the device.
  return { value: 'Desktop grants access', tone: 'good' }
}

const GROUP_DEVICE: Record<string, string> = {
  video: 'your camera',
  render: 'the GPU encoder'
}

export function deviceGroupsIssue(
  groups: readonly LinuxDeviceGroupCheck[]
): LinuxSetupIssue | null {
  const blocked = blockedGroups(groups)
  if (!blocked.length) return null
  const names = blocked.map((group) => group.name)
  const devices = blocked.map((group) => GROUP_DEVICE[group.name] ?? `${group.name} devices`)
  const plural = names.length > 1
  return {
    id: 'device-groups',
    title: `Videorc can't open ${joinOr(devices)}`,
    description: `Your user isn't in the ${joinOr(names)} group${plural ? 's' : ''}. Run “sudo usermod -aG ${names.join(',')} $USER”, then log out and back in.`
  }
}

/** The portal backend package for this desktop, from XDG_CURRENT_DESKTOP. */
export function portalBackendPackage(currentDesktop: string | undefined): string | null {
  const desktops = (currentDesktop ?? '')
    .split(':')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  for (const desktop of desktops) {
    if (desktop === 'hyprland') return 'xdg-desktop-portal-hyprland'
    if (desktop === 'kde') return 'xdg-desktop-portal-kde'
    if (desktop === 'gnome' || desktop === 'niri') return 'xdg-desktop-portal-gnome'
    if (desktop === 'cosmic') return 'xdg-desktop-portal-cosmic'
    if (['sway', 'river', 'wayfire', 'labwc', 'wlroots'].includes(desktop)) {
      return 'xdg-desktop-portal-wlr'
    }
  }
  return null
}

function portalInstallLine(currentDesktop: string | undefined): string {
  const name = currentDesktop?.split(':')[0]?.trim()
  const pkg = portalBackendPackage(currentDesktop)
  return pkg && name
    ? `${pkg} (the one for ${name})`
    : 'the portal for your desktop (xdg-desktop-portal-gnome, -kde, -hyprland or -wlr)'
}

export function screenPortalCheck(portal: LinuxPortalCheck): CheckWords {
  if (portal.frontend === 'unknown') return { value: "Couldn't check", tone: 'neutral' }
  if (portal.frontend === 'missing') return { value: 'Not installed', tone: 'error' }
  if (portal.screenCastVersion === undefined) {
    // A frontend that did not answer in time is not proof of a missing backend.
    if (portal.detail?.includes('in time')) return { value: "Couldn't check", tone: 'neutral' }
    return { value: 'No screen sharing', tone: 'error' }
  }
  return { value: 'Ready', tone: 'good' }
}

export function screenPortalIssue(
  portal: LinuxPortalCheck,
  currentDesktop?: string
): LinuxSetupIssue | null {
  if (screenPortalCheck(portal).tone !== 'error') return null
  if (portal.frontend === 'missing') {
    return {
      id: 'screen-portal',
      title: 'Screen capture needs xdg-desktop-portal',
      description: `Install xdg-desktop-portal and ${portalInstallLine(currentDesktop)}, then log out and back in.`
    }
  }
  const found = portal.backends.length
    ? ` The portals here (${portal.backends.join(', ')}) don't share screens.`
    : ''
  return {
    id: 'screen-portal',
    title: "Your desktop's portal can't share the screen",
    description: `xdg-desktop-portal is running, but no portal backend offers screen sharing.${found} Install ${portalInstallLine(currentDesktop)}, then log out and back in.`
  }
}

/** The Linux rows for Health, in order; none off Linux or before data arrives. */
export function linuxDesktopChecks({ keyring, desktop }: LinuxDesktopInput): HealthCheck[] {
  const rows: HealthCheck[] = []
  if (keyring) {
    rows.push({ id: 'keyring', label: 'Keyring', ...keyringCheck(keyring, desktop?.secretService) })
  }
  if (desktop) {
    rows.push({
      id: 'device-groups',
      label: 'Device groups',
      ...deviceGroupsCheck(desktop.groups)
    })
    rows.push({ id: 'screen-portal', label: 'Screen portal', ...screenPortalCheck(desktop.portal) })
  }
  return rows
}

/** What to fix, one alert per row that needs the streamer. */
export function linuxDesktopIssues({ keyring, desktop }: LinuxDesktopInput): LinuxSetupIssue[] {
  return [
    keyring ? keyringIssue(keyring, desktop?.secretService) : null,
    desktop ? deviceGroupsIssue(desktop.groups) : null,
    desktop ? screenPortalIssue(desktop.portal, desktop.currentDesktop) : null
  ].filter((issue): issue is LinuxSetupIssue => issue !== null)
}
