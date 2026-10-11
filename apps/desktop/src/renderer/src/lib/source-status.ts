import type { StatusTone } from '@/components/status-badge'
import type { Device, DeviceStatus, PreviewCameraState, PreviewScreenState } from '@/lib/backend'
import { SOURCE_RECEIVING_LABEL, systemAudioIssueLabel } from '@/lib/state-labels'
import type { SystemAudioSwitchView } from '@/lib/system-audio'

// Plan 173: one status vocabulary for the four Sources rows. Each row's header
// carries at most one chip, and the same condition reads the same way on
// every row. A row with nothing to add shows no chip: the picker already says
// None or Off, the System audio switch says Off, and a moving meter says the
// microphone works.

export interface SourceStatus {
  label: string
  tone: StatusTone
  /**
   * What to do about it, in words: a visible status line in the row's body
   * (plan 174 C-10), never only a tooltip.
   */
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
        ? 'That screen or window is gone. Choose another.'
        : "It isn't connected. Reconnect it, or choose another."
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
  const { state, frameAgeMs } = input.preview ?? {}
  if (state === 'live') {
    if (
      input.kind === 'camera' &&
      typeof frameAgeMs === 'number' &&
      frameAgeMs > CAMERA_STALE_WARN_MS
    ) {
      return {
        label: `Stale ${Math.round(frameAgeMs / 1000)}s`,
        tone: 'warn',
        hint: 'No fresh frames. Choose it again to restart it.'
      }
    }
    // Producing frames reads "Receiving" (plan 174 D4): "On air" is the livestream's alone.
    return { label: SOURCE_RECEIVING_LABEL, tone: 'good' }
  }
  // The page's permission alert carries the fix (plan 174 C-8), so the chip
  // adds no second line.
  if (state === 'permission-needed' || input.device === 'permission-required') {
    return { label: 'Needs permission', tone: 'warn' }
  }
  // Only the device list says a source is gone. The preview's own
  // `source-missing` / `device-missing` is also its IDLE state (the backend's
  // `idle_status` in preview_screen.rs, and the camera's twin): a selected,
  // connected display whose preview is not running reports it, so it must
  // never read "Not found" (the old chip ignored it for the same reason).
  if (input.device === 'missing' || input.device === 'unavailable') {
    return notFound(input.kind)
  }
  if (state === 'starting') return { label: 'Starting', tone: 'warn' }
  // The preview's own message is raw text: it goes to Health, not the line.
  if (state === 'failed') {
    return { label: 'Failed', tone: 'error', hint: "Couldn't start it. Choose it again to retry." }
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
  if (input.sessionActive) return { label: SOURCE_RECEIVING_LABEL, tone: 'good' }
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
  // System audio rides on the Screen Recording grant, whose alert leads the
  // page with the fix. An issue has its own alert in the row, so no hint.
  if (view.permissionRequired) {
    return {
      label: 'Needs permission',
      tone: 'warn',
      hint: 'Uses the Screen Recording permission. Turn it on above.'
    }
  }
  if (view.issue) return { label: systemAudioIssueLabel(view.issue), tone: 'warn' }
  if (view.pending === 'on') return { label: 'Turning on…', tone: 'neutral' }
  if (view.pending === 'off') return { label: 'Turning off…', tone: 'neutral' }
  if (!view.checked) return null
  return sessionActive && view.meter
    ? { label: SOURCE_RECEIVING_LABEL, tone: 'good' }
    : { label: 'On', tone: 'neutral' }
}

/** A backend warning about a permission: the page's curated alerts own those. */
const PERMISSION_WARNING = /(camera|microphone|screen recording) permission/i

/**
 * The device list's warnings that are not about a permission (plan 174 C-8).
 * The curated permission alerts on Sources say those with their fix, and
 * only for a source someone chose ("Locked means disabled, with one reason").
 * What is left is raw backend text, so it lives in Health; Sources only says
 * that something is there.
 */
export function unknownDeviceWarnings(warnings: readonly string[] | undefined): string[] {
  return (warnings ?? []).filter((warning) => !PERMISSION_WARNING.test(warning))
}
