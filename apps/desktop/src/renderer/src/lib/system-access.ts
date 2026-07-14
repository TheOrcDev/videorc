import type {
  AudioMeterResult,
  Device,
  DeviceList,
  MediaAccessSnapshot,
  MediaAccessStatus,
  SystemPermissionPane
} from '@/lib/backend'
import { appPlatform, osSettingsName, type AppPlatform } from '@/lib/platform'

// ST3 (Settings rework): live permission states for the System access rows.
// Derived from the SAME signals the rest of the app already trusts (device
// enumeration statuses + the audio meter probe) — never from guesses. When
// the OS genuinely won't tell us until first use, we say so instead of faking
// a green chip.
//
// Platform matters here: the macOS backend collapses never-asked, denied, and
// restricted into permission-required, so Electron's exact TCC snapshot owns
// permission truth there. Backend enumeration/meter results refine device
// health after a grant. Windows has no per-app screen permission, so its row
// set and recovery path differ.

export type SystemAccessState = 'granted' | 'not-granted' | 'first-use' | 'device-issue'

export interface SystemAccessRow {
  id: 'screen-recording' | 'camera' | 'microphone'
  label: string
  /** One line of why this permission matters. */
  purpose: string
  state: SystemAccessState
  detail: string
}

export type SystemAccessAction = 'request-media-access' | 'open-settings' | null

export function isMediaAccessSnapshotReady(
  mediaAccess: MediaAccessSnapshot | null | undefined
): mediaAccess is MediaAccessSnapshot {
  return (
    mediaAccess !== null &&
    mediaAccess !== undefined &&
    mediaAccess.camera !== 'unknown' &&
    mediaAccess.microphone !== 'unknown'
  )
}

function screenDevices(devices: Device[]): Device[] {
  return devices.filter((device) => device.kind === 'screen' || device.kind === 'window')
}

export function screenAccessState(deviceList: DeviceList): SystemAccessState {
  const devices = screenDevices(deviceList.devices)
  if (devices.some((device) => device.status === 'permission-required')) {
    return 'not-granted'
  }
  if (
    devices.some(
      (device) => device.status === 'available' && device.id.includes('screencapturekit')
    )
  ) {
    return 'granted'
  }
  return 'first-use'
}

export function cameraAccessState(deviceList: DeviceList): SystemAccessState {
  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  if (cameras.some((device) => device.status === 'permission-required')) {
    return 'not-granted'
  }
  if (cameras.some((device) => device.status === 'available')) {
    // Enumeration succeeding proves listing works; capture itself is only
    // proven once frames flow, but macOS reports denied cameras as
    // permission-required — available means the grant exists.
    return 'granted'
  }
  return 'first-use'
}

export function microphoneAccessState(audioMeter: AudioMeterResult | null): SystemAccessState {
  if (!audioMeter) {
    return 'first-use'
  }
  if (audioMeter.status === 'permission-required') {
    return 'not-granted'
  }
  if (audioMeter.status === 'no-frames') {
    return 'device-issue'
  }
  if (audioMeter.status === 'ready' || audioMeter.status === 'silent') {
    return 'granted'
  }
  // 'unavailable' (no capture backend on this OS yet) and anything unknown
  // fall through to first-use rather than a scary red chip.
  return 'first-use'
}

// Maps the OS's real getMediaAccessStatus to a chip state. This is the truthful
// source on Windows, where the audio meter has no capture backend and the
// camera enumerates regardless of the privacy toggle, so the meter/enumeration
// derivations above would leave both stuck on "first-use" (the tester's stuck
// mic chip). 'denied'/'restricted' → the desktop-apps toggle is off.
export function mediaAccessToState(status: MediaAccessStatus | undefined): SystemAccessState {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'denied':
    case 'restricted':
      return 'not-granted'
    default:
      // 'not-determined' | 'unknown' | undefined
      return 'first-use'
  }
}

function windowsMediaAccessState(
  status: MediaAccessStatus | undefined,
  backendState: SystemAccessState
): SystemAccessState {
  return status === undefined || status === 'unknown' ? backendState : mediaAccessToState(status)
}

// macOS exposes the permission decision separately from capture health. The
// exact TCC value must decide never-asked vs denied; after a grant, backend
// evidence still has to prove that the device can actually be used.
export function macosMediaAccessState(
  status: MediaAccessStatus | undefined,
  backendState: SystemAccessState
): SystemAccessState {
  switch (status) {
    case 'not-determined':
      return 'first-use'
    case 'denied':
    case 'restricted':
      return 'not-granted'
    case 'granted':
      return backendState === 'granted' ? 'granted' : 'device-issue'
    case 'unknown':
    default:
      return backendState
  }
}

export function systemAccessAction({
  pane,
  state,
  platform,
  mediaAccessStatus
}: {
  pane: SystemPermissionPane
  state?: SystemAccessState
  platform?: string
  mediaAccessStatus?: MediaAccessStatus
}): SystemAccessAction {
  if (pane === 'privacy') {
    return 'open-settings'
  }
  if ((pane === 'camera' || pane === 'microphone') && mediaAccessStatus === 'granted') {
    return null
  }
  if (state === 'granted' || state === 'device-issue') {
    return null
  }
  if (
    appPlatform(platform) === 'darwin' &&
    (pane === 'camera' || pane === 'microphone') &&
    state === 'first-use' &&
    mediaAccessStatus === 'not-determined'
  ) {
    return 'request-media-access'
  }
  return 'open-settings'
}

export function systemAccessRows({
  deviceList,
  audioMeter,
  platform,
  mediaAccess
}: {
  deviceList: DeviceList
  audioMeter: AudioMeterResult | null
  platform?: string
  mediaAccess?: { camera: MediaAccessStatus; microphone: MediaAccessStatus } | null
}): SystemAccessRow[] {
  const os = appPlatform(platform)
  const backendCamera = cameraAccessState(deviceList)
  const backendMicrophone = microphoneAccessState(audioMeter)
  const macosMicrophoneHealth =
    audioMeter === null &&
    backendMicrophone === 'first-use' &&
    deviceList.devices.some(
      (device) => device.kind === 'microphone' && device.status === 'available'
    )
      ? 'granted'
      : backendMicrophone
  const camera =
    os === 'win32'
      ? windowsMediaAccessState(mediaAccess?.camera, backendCamera)
      : os === 'darwin'
        ? macosMediaAccessState(mediaAccess?.camera, backendCamera)
        : backendCamera
  const microphone =
    os === 'win32'
      ? windowsMediaAccessState(mediaAccess?.microphone, backendMicrophone)
      : os === 'darwin'
        ? macosMediaAccessState(mediaAccess?.microphone, macosMicrophoneHealth)
        : backendMicrophone

  const rows: SystemAccessRow[] = []

  // Windows has no per-app screen-capture permission — the desktop is always
  // capturable — so the Screen Recording row only exists on macOS.
  if (os !== 'win32') {
    const screen = screenAccessState(deviceList)
    rows.push({
      id: 'screen-recording',
      label: 'Screen Recording',
      purpose: 'Capture displays and app windows.',
      state: screen,
      detail: accessDetail(screen, 'screen capture', os)
    })
  }

  rows.push({
    id: 'camera',
    label: 'Camera',
    purpose: 'Camera overlay in your scenes.',
    state: camera,
    detail:
      os === 'darwin' && mediaAccess?.camera === 'restricted'
        ? 'Camera access is restricted by macOS policy and may not be changeable here.'
        : camera === 'device-issue'
          ? 'Camera permission is granted, but no usable camera is currently available.'
          : accessDetail(camera, 'the camera', os)
  })

  rows.push({
    id: 'microphone',
    label: 'Microphone',
    purpose: 'Voice audio and live captions.',
    state: microphone,
    detail:
      os === 'darwin' && mediaAccess?.microphone === 'restricted'
        ? 'Microphone access is restricted by macOS policy and may not be changeable here.'
        : microphone === 'device-issue'
          ? ((audioMeter?.status === 'permission-required' ? undefined : audioMeter?.message) ??
            'Microphone permission is granted, but no usable input is currently available.')
          : microphone === 'first-use'
            ? 'Checked when you run a mic check or start a session.'
            : accessDetail(microphone, 'the microphone', os)
  })

  return rows
}

// Permissions onboarding gate: the dialog exists ONLY to collect grants, so it
// shows iff a grant is missing — never for users whose Mac already has them
// (TCC grants persist per bundle id, so reinstalls skip it too). `dismissed`
// is a snooze, not the trigger: once the user continues or skips, gaps go back
// to the Sources alerts and Settings chips. `backendReady` guards the boot
// window where device enumeration hasn't arrived and every state would read
// first-use — unknown backend or exact media state must never flash the dialog.
export function shouldShowPermissionsOnboarding({
  rows,
  dismissed,
  backendReady,
  mediaAccessReady = true
}: {
  rows: SystemAccessRow[]
  dismissed: boolean
  backendReady: boolean
  mediaAccessReady?: boolean
}): boolean {
  if (dismissed || !backendReady || !mediaAccessReady) {
    return false
  }
  return rows.some((row) => row.state !== 'granted' && row.state !== 'device-issue')
}

function accessDetail(state: SystemAccessState, subject: string, os: AppPlatform): string {
  const settings = osSettingsName(os === 'other' ? undefined : os)
  if (os === 'win32' && (state === 'not-granted' || state === 'first-use')) {
    // Windows gates desktop (non-Store) apps behind a single umbrella toggle
    // and does NOT list them by name — the tester was hunting for "Videorc" in
    // a list where it can never appear. Point at the two real levers instead.
    return `In ${settings} → Privacy & security → ${windowsPrivacyPageName(subject)}, turn on access and “Let desktop apps access your ${windowsDeviceNoun(subject)}”. Videorc is a desktop app, so it isn’t listed by name.`
  }
  switch (state) {
    case 'granted':
      return 'Permission granted.'
    case 'not-granted':
      // The packaged-app nuance from the 0.9.1 incident: a missing grant is
      // fixed in the OS Settings; a missing ENTITLEMENT can't be — but 0.9.2+
      // ships the entitlements, so Settings is the right pointer.
      return `Your ${settings} is blocking ${subject} — grant access there.`
    case 'first-use':
      return `${settings} reports this on first use.`
    case 'device-issue':
      return 'The device opened but did not send audio frames.'
  }
}

function windowsPrivacyPageName(subject: string): string {
  return subject.includes('camera') ? 'Camera' : 'Microphone'
}

function windowsDeviceNoun(subject: string): string {
  return subject.includes('camera') ? 'camera' : 'microphone'
}
