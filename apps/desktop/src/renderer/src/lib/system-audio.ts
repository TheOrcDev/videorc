import { toast } from '@/lib/toast'

import type { Device, DeviceList, DeviceStatus } from '@/lib/backend'
import type { SystemAudioIssue } from '@/lib/system-audio-session'

export {
  confirmedSystemAudioMix,
  SYSTEM_AUDIO_LOST_CODE,
  SYSTEM_AUDIO_UNAVAILABLE_CODE,
  systemAudioIssueFromHealthEvent,
  type SystemAudioIssue
} from '@/lib/system-audio-session'

// System audio (plan 069 S5): one switch, On or Off. Pure view logic shared by
// the Studio mixer, the Sources panel and the Studio inputs, so every surface
// says the same thing about the same state. Only lazy surfaces import this
// module; the provider's session facts live in lib/system-audio-session.

export const SYSTEM_AUDIO_DEVICE_ID = 'system-audio:default'

/** The backend's one system-audio device. Always listed; its status says whether it can run. */
export function systemAudioDevice(deviceList: DeviceList): Device | undefined {
  return (
    deviceList.devices.find((device) => device.id === SYSTEM_AUDIO_DEVICE_ID) ??
    deviceList.devices.find((device) => device.kind === 'system-audio')
  )
}

export interface SystemAudioSwitchInput {
  device: Pick<Device, 'status'> | undefined
  /** captureConfig.audio.systemAudioEnabled: what the user asked for. */
  requested: boolean
  sessionActive: boolean
  /** From `confirmedSystemAudioMix` for the active session. */
  confirmed: boolean | null
  /** The newest system-audio health issue for the active session. */
  issue: SystemAudioIssue | null
}

export interface SystemAudioSwitchView {
  /** Hidden where capture is not supported: never a permanent "Unavailable". */
  visible: boolean
  permissionRequired: boolean
  checked: boolean
  disabled: boolean
  /** The switch waits for the session to confirm the change. */
  pending: 'on' | 'off' | null
  /** Shown only while it still explains the state (requested On, not mixed). */
  issue: SystemAudioIssue | null
  /** The level meter: only while a session mixes system audio. */
  meter: boolean
  /** Short state text beside the switch. */
  stateLabel: string
}

/**
 * The switch shows what the session confirms, not the optimistic click. It
 * falls back to the requested state until the first confirming status, and
 * stays as the user set it when a health event explains why capture stopped.
 */
export function systemAudioSwitchView(input: SystemAudioSwitchInput): SystemAudioSwitchView {
  const hidden: SystemAudioSwitchView = {
    visible: false,
    permissionRequired: false,
    checked: false,
    disabled: true,
    pending: null,
    issue: null,
    meter: false,
    stateLabel: 'Off'
  }
  if (!input.device || input.device.status === 'unavailable') return hidden
  if (input.device.status === 'permission-required') {
    return { ...hidden, visible: true, permissionRequired: true }
  }

  if (!input.sessionActive) {
    return {
      ...hidden,
      visible: true,
      checked: input.requested,
      disabled: false,
      stateLabel: input.requested ? 'On' : 'Off'
    }
  }

  const issue = input.requested && input.confirmed !== true ? input.issue : null
  if (issue) {
    return {
      ...hidden,
      visible: true,
      checked: true,
      disabled: false,
      issue,
      stateLabel: issue === 'echo' ? 'Paused' : 'On'
    }
  }

  const mixed = input.confirmed ?? input.requested
  const pending =
    input.confirmed === null || input.confirmed === input.requested
      ? null
      : input.requested
        ? 'on'
        : 'off'
  return {
    ...hidden,
    visible: true,
    checked: mixed,
    disabled: false,
    pending,
    meter: mixed && pending === null,
    stateLabel:
      pending === 'on' ? 'Turning on…' : pending === 'off' ? 'Turning off…' : mixed ? 'On' : 'Off'
  }
}

/** One line of health copy per issue: what happened, and what still works. */
export function systemAudioIssueCopy(issue: SystemAudioIssue): string {
  return issue === 'lost'
    ? 'System audio stopped. The session keeps going.'
    : issue === 'bypassed'
      ? 'System audio is off for this session because the microphone is on a fallback input.'
      : issue === 'echo'
        ? 'Paused: your stream is playing on this Mac and coming back as an echo. Mute that tab, then resume.'
        : 'System audio could not start.'
}

/** The window event the Studio answers by turning System audio on again. */
export const SYSTEM_AUDIO_RESUME_EVENT = 'videorc:resume-system-audio'
/** The toast the echo guard's pause shows (plan 076). */
export const SYSTEM_AUDIO_ECHO_TOAST_ID = 'system-audio-echo-paused'

/**
 * Plan 076: resume System audio after the echo guard paused it. The Studio
 * owns the switch; a lazy surface asks through a window event.
 */
export function requestSystemAudioResume(): void {
  toast.dismiss(SYSTEM_AUDIO_ECHO_TOAST_ID)
  window.dispatchEvent(new Event(SYSTEM_AUDIO_RESUME_EVENT))
}

/**
 * What a shortcut or remote intent asks for (plan 069 S6), or null when the
 * device cannot run: missing, unsupported, or waiting on the Screen Recording
 * grant. A toggle flips the state the Studio and the remotes show (the
 * session's confirmed mix, else the request), the same as clicking the switch.
 */
export function systemAudioTarget(
  mode: 'on' | 'off' | 'toggle',
  status: DeviceStatus | undefined,
  shown: boolean
): boolean | null {
  if (status !== 'available') return null
  return mode === 'toggle' ? !shown : mode === 'on'
}
