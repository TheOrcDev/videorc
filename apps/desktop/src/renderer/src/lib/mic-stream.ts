// Shared microphone MediaStream acquisition (plan: Studio Audio ElevenLabs UI
// rework, S2). The workspace visual-mic provider opens its sole stream through
// this controller, never raw getUserMedia: one acquisition path keeps the
// backend-name → WebAudio-label matching, shared-mode coexistence with backend
// capture, and the never-throw fallback
// ("a passive meter must never toast") in a single tested place. The backend
// stays the capture/health authority; this stream is visual-only.

import type { MediaAccessStatus } from './backend'
import { matchMicrophoneDeviceId } from './mic-meter'

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

export type MicStreamController<S extends MicMediaStreamLike> = {
  /**
   * Open a stream for the backend-named device (default input when the name
   * cannot be matched). Resolves null — never rejects — when media devices
   * are unavailable, permission is denied, or the controller closed while
   * acquiring (the racing stream's tracks are stopped).
   */
  open: (deviceName: string | undefined) => Promise<S | null>
  /** Stop every open track; the controller cannot be reused afterwards. */
  close: () => void
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

  const stopTracks = (stream: S | null): void => {
    stream?.getTracks().forEach((track) => track.stop())
  }

  return {
    async open(deviceName) {
      if (closed || !media?.getUserMedia) {
        return null
      }
      try {
        const inputs = ((await media.enumerateDevices?.().catch(() => [])) ?? [])
          .filter((device) => device.kind === 'audioinput')
          .map((device) => ({ deviceId: device.deviceId, label: device.label }))
        if (closed) {
          return null
        }
        const deviceId = matchMicrophoneDeviceId(deviceName, inputs)
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
      } catch {
        return null
      }
    },
    close() {
      closed = true
      stopTracks(current)
      current = null
    }
  }
}
