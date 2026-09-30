// Shared microphone MediaStream acquisition (plan: Studio Audio ElevenLabs UI
// rework, S2). The workspace visual-mic provider opens its sole stream through
// this controller, never raw getUserMedia: one acquisition path keeps the
// backend-name → WebAudio-label matching, shared-mode coexistence with backend
// capture, and the never-throw fallback
// ("a passive meter must never toast") in a single tested place. The backend
// stays the capture/health authority; this stream is visual-only.

import type { MediaAccessStatus } from './backend'
import { matchStrictAudioInput } from './mic-device-label'
import { matchMicrophoneDeviceId } from './mic-meter'

import { registerVisualMicrophoneOwner } from './mic-visual-ownership'
export {
  closeVisualMicrophoneStreams,
  registerVisualMicrophoneSuspension,
  subscribeVisualMicrophoneEpoch,
  visualMicrophoneEpoch
} from './mic-visual-ownership'

type MicTrackLike = { stop: () => void }

export type MicMediaStreamLike = { getTracks: () => MicTrackLike[] }

/**
 * Meter-stream processing is OFF: Chromium's defaults (echo cancellation,
 * noise suppression, and especially auto gain control) pump room tone up to
 * speech level in silence, so the bars would show a signal the recording
 * never contains. The RECORDING path is the backend's own capture and is
 * untouched by these constraints.
 */
export const MIC_METER_STREAM_PROCESSING = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false
})

export type MicStreamAudioConstraints = typeof MIC_METER_STREAM_PROCESSING & {
  deviceId?: { exact: string }
}

export type MicStreamConstraints = {
  audio: MicStreamAudioConstraints
  video: false
}

export type MicMediaDevicesLike<S extends MicMediaStreamLike> = {
  enumerateDevices?: () => Promise<Array<{ kind: string; deviceId: string; label: string }>>
  getUserMedia?: (constraints: MicStreamConstraints) => Promise<S>
}

/**
 * Why a visual stream could not open (plan 080 S3). Every reason used to
 * collapse into one null, and the UI blamed permission for all of them.
 */
export type MicStreamFailureReason =
  | 'no-media'
  | 'no-label-match'
  | 'ambiguous-label'
  | 'labels-hidden'
  | 'permission-denied'
  | 'device-busy'
  | 'device-missing'
  | 'overconstrained'
  | 'audio-context'
  | 'unknown'

export type MicStreamFailure = Readonly<{ reason: MicStreamFailureReason; detail?: string }>

export type MicStreamController<S extends MicMediaStreamLike> = {
  /**
   * Open a stream for the backend-named device (default input when the name
   * cannot be matched). Resolves null — never rejects — when media devices
   * are unavailable, permission is denied, or the controller closed while
   * acquiring (the racing stream's tracks are stopped).
   */
  open: (deviceName: string | undefined, strict?: boolean) => Promise<S | null>
  /**
   * Why the latest open() resolved null, or null when it opened a stream or
   * lost a race with close() (a superseded open is not a failure).
   */
  lastFailure: () => MicStreamFailure | null
  /** Stop every open track; the controller cannot be reused afterwards. */
  close: () => void
}

/** getUserMedia's DOMException names mapped onto a failure the UI can explain. */
export function micStreamFailureFromError(error: unknown): MicStreamFailure {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : ''
  const detail =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : undefined
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { reason: 'permission-denied', detail }
    case 'NotReadableError':
    case 'AbortError':
      return { reason: 'device-busy', detail }
    case 'NotFoundError':
      return { reason: 'device-missing', detail }
    case 'OverconstrainedError':
      return { reason: 'overconstrained', detail }
    default:
      return { reason: 'unknown', detail }
  }
}

/**
 * Renderer microphone visuals must never become an implicit OS permission
 * request. Only a user-resolved, exact `granted` status may reach
 * getUserMedia; loading, denied, restricted, and unknown states remain idle.
 */
export function microphoneStreamAcquisitionEnabled(
  requested: boolean,
  permissionStatus: MediaAccessStatus | undefined
): boolean {
  return requested && permissionStatus === 'granted'
}

export function createMicStreamController<S extends MicMediaStreamLike>(
  media: MicMediaDevicesLike<S> | undefined
): MicStreamController<S> {
  let current: S | null = null
  let closed = false
  let failure: MicStreamFailure | null = null
  let unregisterOwner: (() => void) | undefined

  const stopTracks = (stream: S | null): void => {
    stream?.getTracks().forEach((track) => track.stop())
  }

  const close = (): void => {
    closed = true
    stopTracks(current)
    current = null
    unregisterOwner?.()
    unregisterOwner = undefined
  }
  return {
    async open(deviceName, strict = false) {
      failure = null
      if (closed) {
        return null
      }
      if (!media?.getUserMedia) {
        failure = { reason: 'no-media' }
        return null
      }
      unregisterOwner ??= registerVisualMicrophoneOwner(close)
      try {
        const inputs = ((await media.enumerateDevices?.().catch(() => [])) ?? [])
          .filter((device) => device.kind === 'audioinput')
          .map((device) => ({ deviceId: device.deviceId, label: device.label }))
        if (closed) {
          return null
        }
        let deviceId: string | undefined
        if (strict) {
          // Plan 046 S5: a live-safe preview never meters a device other
          // than the selected one. Plan 080 S3: "the selected one" is found
          // by its plain name, since Chromium decorates every macOS label.
          const match = matchStrictAudioInput(deviceName, inputs)
          if ('failure' in match) {
            failure = { reason: match.failure }
            return null
          }
          deviceId = match.deviceId
        } else {
          deviceId = matchMicrophoneDeviceId(deviceName, inputs)
        }
        const stream = await media.getUserMedia({
          audio: deviceId
            ? { ...MIC_METER_STREAM_PROCESSING, deviceId: { exact: deviceId } }
            : { ...MIC_METER_STREAM_PROCESSING },
          video: false
        })
        if (closed) {
          stopTracks(stream)
          return null
        }
        current = stream
        return stream
      } catch (error) {
        if (!closed) {
          failure = micStreamFailureFromError(error)
        }
        return null
      }
    },
    lastFailure: () => failure,
    close
  }
}
