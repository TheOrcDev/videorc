import type { Device, RecordingStatus } from '@/lib/backend'
import type { CaptureConfig } from '@/lib/capture'
import type {
  WindowsLiveAudioSmokeRequest,
  WindowsLiveAudioSmokeState,
  WindowsLiveAudioSmokeTelemetry
} from '../../../shared/windows-live-audio-smoke'

export const WINDOWS_LIVE_AUDIO_SMOKE_BURST = [
  { microphoneGainDb: -3, microphoneMuted: false },
  { microphoneGainDb: -6, microphoneMuted: true },
  { microphoneGainDb: -9, microphoneMuted: false },
  { microphoneGainDb: 0, microphoneMuted: false }
] as const

function requireAvailableDevice(devices: Device[], id: string, kind: Device['kind']): Device {
  const device = devices.find(
    (candidate) =>
      candidate.id === id && candidate.kind === kind && candidate.status === 'available'
  )
  if (!device) {
    throw new Error(`Windows live audio smoke could not select available ${kind} ${id}.`)
  }
  return device
}

export function configureWindowsLiveAudioSmokeCapture(
  current: CaptureConfig,
  devices: Device[],
  request: Extract<WindowsLiveAudioSmokeRequest, { action: 'configure' }>
): CaptureConfig {
  const screen = requireAvailableDevice(devices, request.screenId, 'screen')
  const camera = requireAvailableDevice(devices, request.cameraId, 'camera')
  const microphone = requireAvailableDevice(devices, request.microphoneId, 'microphone')
  return {
    ...current,
    sources: {
      screenId: screen.id,
      screenName: screen.name,
      cameraId: camera.id,
      cameraName: camera.name,
      microphoneId: microphone.id,
      microphoneName: microphone.name,
      testPattern: false
    },
    layout: {
      ...current.layout,
      layoutPreset: 'screen-camera',
      cameraTransformMode: 'preset',
      cameraTransform: null
    },
    video: {
      preset: 'custom',
      width: 1280,
      height: 720,
      fps: 30,
      bitrateKbps: 2_000
    },
    verticalRestoreVideo: null,
    lastHorizontalPreset: 'screen-camera',
    audio: {
      ...current.audio,
      microphoneGainDb: 0,
      microphoneMuted: false
    },
    recordEnabled: true,
    streamEnabled: false,
    captions: { ...current.captions, enabled: false }
  }
}

export function windowsLiveAudioSmokeState(input: {
  recording: RecordingStatus
  lastError: string | null
  captureConfig: CaptureConfig
  telemetry: WindowsLiveAudioSmokeTelemetry
}): WindowsLiveAudioSmokeState {
  return {
    recording: {
      state: input.recording.state,
      ...(input.recording.sessionId ? { sessionId: input.recording.sessionId } : {})
    },
    lastError: input.lastError,
    audio: {
      microphoneGainDb: input.captureConfig.audio.microphoneGainDb,
      microphoneMuted: input.captureConfig.audio.microphoneMuted
    },
    sources: {
      screenId: input.captureConfig.sources.screenId,
      cameraId: input.captureConfig.sources.cameraId,
      microphoneId: input.captureConfig.sources.microphoneId,
      testPattern: input.captureConfig.sources.testPattern
    },
    video: { ...input.captureConfig.video },
    layout: { ...input.captureConfig.layout },
    output: {
      recordEnabled: input.captureConfig.recordEnabled,
      streamEnabled: input.captureConfig.streamEnabled
    },
    telemetry: {
      requestedCount: input.telemetry.requestedCount,
      settledCount: input.telemetry.settledCount,
      lastSettled: input.telemetry.lastSettled
        ? {
            ...input.telemetry.lastSettled,
            requested: { ...input.telemetry.lastSettled.requested },
            ...(input.telemetry.lastSettled.settings
              ? { settings: { ...input.telemetry.lastSettled.settings } }
              : {})
          }
        : null
    }
  }
}
