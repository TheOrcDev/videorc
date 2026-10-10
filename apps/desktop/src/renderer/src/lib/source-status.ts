import type { StatusTone } from '@/components/status-badge'
import type { Device, DeviceStatus, PreviewCameraState, PreviewScreenState } from '@/lib/backend'
import type { SystemAudioSwitchView } from '@/lib/system-audio'

// Plan 173: one status vocabulary for the four Sources rows. Each row's header
// carries at most one chip, and the same condition reads the same way on
// every row. A row with nothing to add shows no chip: the picker already says
// None or Off, the System audio switch says Off, and a moving meter says the
// microphone works.

export interface SourceStatus {
  label: string
  tone: StatusTone
  /** The chip's tooltip: what to do about it. */
  hint?: string
}

/** A camera whose newest frame is older than this is reported stale. */
export const CAMERA_STALE_WARN_MS = 3000

/**
 * How the selected device appears in the device list: its status, or
 * `missing` when the saved id is not listed at all (unplugged, window closed).
 * Undefined when nothing is selected.
 */
export type SelectedDeviceStatus = DeviceStatus | 'missing'

export function selectedDeviceStatus(
  devices: readonly Pick<Device, 'id' | 'status'>[],
  selectedId: string | undefined
): SelectedDeviceStatus | undefined {
  if (!selectedId) return undefined
  return devices.find((device) => device.id === selectedId)?.status ?? 'missing'
}

const SWITCHING: SourceStatus = { label: 'Switching', tone: 'warn' }

function notFound(kind: 'screen' | 'camera' | 'microphone'): SourceStatus {
  return {
    label: 'Not found',
    tone: 'warn',
    hint:
      kind === 'screen'
        ? 'That screen or window is gone. Pick another.'
        : 'It is not connected. Reconnect it, or pick another.'
  }
}

/**
 * Screen and Camera: what the preview pipeline says about the selected source
 * right now. A live camera whose newest frame is old is reported stale;
 * screens deliver only on change, so an old frame is normal there.
 */
export function videoSourceStatus(input: {
  kind: 'screen' | 'camera'
  /** A device is selected (screen/window id, camera id, or the test pattern). */
  selected: boolean
  /** A live switch for this source is in flight. */
  switching: boolean
  device?: SelectedDeviceStatus
  preview?: {
    state?: PreviewScreenState | PreviewCameraState
    frameAgeMs?: number
    message?: string
  }
}): SourceStatus | null {
  if (input.switching) return SWITCHING
  if (!input.selected) return null
  const { state, frameAgeMs, message } = input.preview ?? {}
  if (state === 'live') {
    if (
      input.kind === 'camera' &&
      typeof frameAgeMs === 'number' &&
      frameAgeMs > CAMERA_STALE_WARN_MS
    ) {
      return {
        label: `Stale ${Math.round(frameAgeMs / 1000)}s`,
        tone: 'warn',
        hint: 'No fresh frames. Re-select the source to restart it.'
      }
    }
    return { label: 'Live', tone: 'good' }
  }
  if (state === 'permission-needed' || input.device === 'permission-required') {
    return { label: 'Needs permission', tone: 'warn', hint: message }
  }
  if (
    state === 'source-missing' ||
    state === 'device-missing' ||
    input.device === 'missing' ||
    input.device === 'unavailable'
  ) {
    return notFound(input.kind)
  }
  if (state === 'starting') return { label: 'Starting', tone: 'warn' }
  if (state === 'failed') {
    return { label: 'Failed', tone: 'error', hint: message ?? 'Re-select the source to retry.' }
  }
  return null
}

/**
 * The microphone: muted and missing are news; a working microphone says
 * nothing until a session runs, because its meter already moves. A dead meter
 * explains itself on the line under the meter, not in a second chip.
 */
export function microphoneStatus(input: {
  selected: boolean
  switching: boolean
  device?: SelectedDeviceStatus
  muted: boolean
  sessionActive: boolean
}): SourceStatus | null {
  if (input.switching) return SWITCHING
  if (!input.selected) return null
  if (input.device === 'permission-required') {
    return { label: 'Needs permission', tone: 'warn' }
  }
  if (input.device === 'missing' || input.device === 'unavailable') {
    return notFound('microphone')
  }
  if (input.muted) return { label: 'Muted', tone: 'neutral' }
  if (input.sessionActive) return { label: 'Live', tone: 'good' }
  return null
}

/** System audio, from the switch's own view so every surface agrees (plan 069). */
export function systemAudioStatus(
  view: Pick<
    SystemAudioSwitchView,
    'permissionRequired' | 'checked' | 'pending' | 'issue' | 'meter'
  >,
  sessionActive: boolean
): SourceStatus | null {
  if (view.permissionRequired) return { label: 'Needs permission', tone: 'warn' }
  if (view.issue === 'echo') {
    return { label: 'Paused', tone: 'warn', hint: 'Your stream came back as an echo.' }
  }
  if (view.issue) return { label: 'Stopped', tone: 'warn' }
  if (view.pending === 'on') return { label: 'Turning on…', tone: 'neutral' }
  if (view.pending === 'off') return { label: 'Turning off…', tone: 'neutral' }
  if (!view.checked) return null
  return sessionActive && view.meter
    ? { label: 'Live', tone: 'good' }
    : { label: 'On', tone: 'neutral' }
}
