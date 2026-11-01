import type {
  AudioMeterResult,
  Device,
  DeviceList,
  MediaAccessSnapshot,
  MediaAccessStatus,
  SystemPermissionPane
} from '@/lib/backend'
import { appPlatform, osSettingsName } from '@/lib/platform'

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

export type SystemAccessState =
  | 'granted'
  | 'not-granted'
  | 'first-use'
  | 'device-issue'
  | 'waiting'
  | 'needs-relaunch'
  | 'not-required'
  | 'unavailable'

export type SystemAccessContext = {
  pendingPane?: SystemPermissionPane | null
  captureRestarting?: boolean
  screenGrantStale?: boolean
  lastKnownStates?: Partial<Record<SystemAccessRow['id'], SystemAccessState>>
}

export interface SystemAccessRow {
  id: 'screen-recording' | 'system-audio' | 'camera' | 'microphone'
  label: string
  /** One line of why this permission matters. */
  purpose: string
  state: SystemAccessState
  detail: string
  required: boolean
  checking?: boolean
}

export type SystemAccessAction = 'request-media-access' | 'open-settings' | 'relaunch' | null

/** The exact OS status behind a row (plan 203 S2): the screen row reads the
 * Screen & System Audio Recording grant, the others their own. Privacy has
 * none. Snapshots from before S2 carry no `screen`, so it stays optional. */
export function mediaAccessStatusForPane(
  mediaAccess: Partial<MediaAccessSnapshot> | null | undefined,
  pane: SystemPermissionPane | 'system-audio'
): MediaAccessStatus | undefined {
  if (!mediaAccess) return undefined
  if (pane === 'camera' || pane === 'microphone') return mediaAccess[pane]
  if (pane === 'screen-recording') return mediaAccess.screen
  return undefined
}

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
      // 'not-determined' | 'unknown' | 'not-applicable' | undefined
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
  mediaAccessStatus,
  checking = false
}: {
  pane: SystemPermissionPane | 'system-audio'
  checking?: boolean
  state?: SystemAccessState
  platform?: string
  mediaAccessStatus?: MediaAccessStatus
}): SystemAccessAction {
  if (pane === 'system-audio' || checking || mediaAccessStatus === 'restricted') return null
  if (pane === 'screen-recording' && state === 'needs-relaunch') return 'relaunch'
  if (state === 'not-required' || state === 'unavailable') return null
  if (state === 'waiting') return 'open-settings'
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
  // Plan 203 S2: a never-asked screen is asked in place too. Until the
  // request, Videorc isn't in the Screen & System Audio Recording list, so
  // sending someone to System Settings strands them on a list without it.
  // The backend lists a never-asked screen as permission-required (the row
  // reads not-granted), so the exact TCC value decides here, not the state.
  if (
    appPlatform(platform) === 'darwin' &&
    pane === 'screen-recording' &&
    mediaAccessStatus === 'not-determined'
  ) {
    return 'request-media-access'
  }
  return 'open-settings'
}

/** Darwin 24 is macOS 15, when Apple renamed the screen permission pane. */
export function screenRecordingPaneName(osRelease?: string): string {
  return Number.parseInt(osRelease ?? '', 10) >= 24
    ? 'Screen & System Audio Recording'
    : 'Screen Recording'
}

/** A restart must keep a useful chip, never a stale refusal from capture. */
export function checkingAccessState(previous?: SystemAccessState): SystemAccessState {
  return previous === 'not-granted' ? 'waiting' : (previous ?? 'first-use')
}

export function systemAccessRows({
  deviceList,
  audioMeter,
  platform,
  mediaAccess,
  osRelease,
  permissionTargetName = 'Videorc',
  pendingPane,
  captureRestarting = false,
  screenGrantStale = false,
  lastKnownStates
}: {
  deviceList: DeviceList
  audioMeter: AudioMeterResult | null
  platform?: string
  osRelease?: string
  permissionTargetName?: string
  mediaAccess?: Partial<MediaAccessSnapshot> | null
} & SystemAccessContext): SystemAccessRow[] {
  if (platform === 'linux') return []
  const os = appPlatform(platform)
  const backendScreen = screenAccessState(deviceList)
  const backendCamera = cameraAccessState(deviceList)
  const backendMicrophone =
    audioMeter === null &&
    deviceList.devices.some(
      (device) => device.kind === 'microphone' && device.status === 'available'
    )
      ? 'granted'
      : microphoneAccessState(audioMeter)
  const screen =
    os === 'win32'
      ? 'not-required'
      : mediaAccess?.screen === 'granted' && backendScreen === 'not-granted'
        ? 'needs-relaunch'
        : macosMediaAccessState(mediaAccess?.screen, backendScreen)
  const microphone =
    os === 'win32'
      ? windowsMediaAccessState(mediaAccess?.microphone, backendMicrophone)
      : macosMediaAccessState(mediaAccess?.microphone, backendMicrophone)
  const camera =
    os === 'win32'
      ? windowsMediaAccessState(mediaAccess?.camera, backendCamera)
      : macosMediaAccessState(mediaAccess?.camera, backendCamera)
  const rows: SystemAccessRow[] = [
    {
      id: 'screen-recording',
      label: 'Screen Recording',
      purpose: 'Record your displays and app windows.',
      state: screen,
      required: os !== 'win32',
      detail: ''
    },
    {
      id: 'system-audio',
      label: 'System audio',
      purpose:
        os === 'win32'
          ? 'The sound your PC plays: games, music and calls.'
          : 'The sound your Mac plays: games, music and calls.',
      state: screen,
      required: false,
      detail: ''
    },
    {
      id: 'microphone',
      label: 'Microphone',
      purpose: 'Your voice in recordings, livestreams and captions.',
      state: microphone,
      required: true,
      detail: ''
    },
    {
      id: 'camera',
      label: 'Camera',
      purpose: 'Put yourself in your scenes.',
      state: camera,
      required: false,
      detail: ''
    }
  ]
  for (const row of rows) {
    const pane = row.id === 'system-audio' ? 'screen-recording' : row.id
    const status = mediaAccessStatusForPane(mediaAccess, pane)
    row.checking =
      os !== 'win32' &&
      status === 'granted' &&
      (captureRestarting || (pane === 'screen-recording' && screenGrantStale))
    if (row.checking) {
      row.state = checkingAccessState(lastKnownStates?.[row.id])
      continue
    }
    if (os !== 'win32' && pendingPane === pane && status !== 'granted' && status !== 'restricted') {
      row.state = 'waiting'
    }
    const paneName = pane === 'screen-recording' ? screenRecordingPaneName(osRelease) : row.label
    if (row.state === 'waiting') {
      row.detail = `Turn on ${permissionTargetName} in System Settings → Privacy & Security → ${paneName}, then come back here.`
    } else if (row.state === 'needs-relaunch') {
      row.detail = 'macOS turns this on after Videorc reopens.'
    } else if (os === 'darwin' && status === 'restricted') {
      row.detail = 'Restricted by macOS policy and may not be changeable here.'
    } else if (os === 'win32' && row.state === 'not-required') {
      row.detail = "Windows doesn't ask for this."
    } else if (row.state === 'not-granted' && os !== 'win32') {
      row.detail = `System Settings is blocking ${paneName}. Turn on ${permissionTargetName} in System Settings → Privacy & Security → ${paneName}.`
    } else if (row.state === 'device-issue') {
      row.detail =
        row.id === 'camera'
          ? 'Granted, but no camera is connected.'
          : row.id === 'microphone'
            ? 'Microphone permission is granted, but no usable input is currently available.'
            : 'Granted, but no display or app window is available.'
    } else if (row.state === 'granted' && row.id === 'camera') {
      row.detail =
        deviceList.devices.find(
          (device) => device.kind === 'camera' && device.status === 'available'
        )?.name ?? ''
    } else if (os === 'win32' && (row.state === 'not-granted' || row.state === 'first-use')) {
      const noun = row.id === 'camera' ? 'camera' : 'microphone'
      row.detail = `In ${osSettingsName(platform)} → Privacy & security → ${row.label}, turn on access and “Let desktop apps access your ${noun}”. Videorc is a desktop app, so it isn’t listed by name.`
    }
  }
  const systemAudio = rows[1]
  const audioDevice = deviceList.devices.find((device) => device.kind === 'system-audio')
  if (
    !systemAudio.checking &&
    (os === 'win32' || mediaAccess?.screen === 'granted' || screen === 'granted') &&
    audioDevice?.status === 'unavailable'
  ) {
    systemAudio.state = 'unavailable'
    systemAudio.detail = audioDevice.detail ?? 'System audio is not available on this computer.'
  } else if (!systemAudio.checking && os !== 'win32' && systemAudio.state !== 'granted') {
    systemAudio.detail = 'Comes with Screen Recording.'
  }
  return rows
}
