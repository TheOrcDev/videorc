import type {
  AudioProcessingUpdateResult,
  AudioSettings,
  LayoutSettings,
  RecordingState,
  SourceSelection,
  VideoSettings
} from './backend'

export const WINDOWS_LIVE_AUDIO_SMOKE_COMMAND = 'windows-live-audio-harness'

export type WindowsLiveAudioSmokeAudioValues = Pick<
  AudioSettings,
  'microphoneGainDb' | 'microphoneMuted'
>

export type WindowsLiveAudioSmokeRequest =
  | {
      action: 'configure'
      screenId: string
      cameraId: string
      microphoneId: string
    }
  | { action: 'start' }
  | ({ action: 'set-audio' } & WindowsLiveAudioSmokeAudioValues)
  | { action: 'rapid-burst' }
  | { action: 'stop' }
  | { action: 'state' }

export interface WindowsLiveAudioSmokeSettledUpdate {
  requested: WindowsLiveAudioSmokeAudioValues & { sessionId: string }
  applied: boolean
  reasonCode?: AudioProcessingUpdateResult['reasonCode']
  settings?: WindowsLiveAudioSmokeAudioValues
  error?: string
}

export interface WindowsLiveAudioSmokeTelemetry {
  requestedCount: number
  settledCount: number
  lastSettled: WindowsLiveAudioSmokeSettledUpdate | null
}

export interface WindowsLiveAudioSmokeState {
  recording: {
    state: RecordingState
    sessionId?: string
  }
  lastError: string | null
  audio: WindowsLiveAudioSmokeAudioValues
  sources: Pick<SourceSelection, 'screenId' | 'cameraId' | 'microphoneId' | 'testPattern'>
  video: VideoSettings
  layout: LayoutSettings
  output: {
    recordEnabled: boolean
    streamEnabled: boolean
  }
  telemetry: WindowsLiveAudioSmokeTelemetry
}

const EXACT_ID_MAX_LENGTH = 2_048

function exactDeviceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= EXACT_ID_MAX_LENGTH &&
    value.trim() === value &&
    !value.includes('\0')
  )
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

/**
 * Strict validator for the packaged Windows renderer bridge. The command has
 * no path, URL, backend method, or JavaScript parameters; each accepted action
 * maps to one fixed StudioProvider operation.
 */
export function validateWindowsLiveAudioSmokeRequest(
  value: Record<string, unknown>
): WindowsLiveAudioSmokeRequest | null {
  switch (value.action) {
    case 'configure':
      return exactKeys(value, ['action', 'screenId', 'cameraId', 'microphoneId']) &&
        exactDeviceId(value.screenId) &&
        exactDeviceId(value.cameraId) &&
        exactDeviceId(value.microphoneId)
        ? {
            action: 'configure',
            screenId: value.screenId,
            cameraId: value.cameraId,
            microphoneId: value.microphoneId
          }
        : null
    case 'set-audio':
      return exactKeys(value, ['action', 'microphoneGainDb', 'microphoneMuted']) &&
        typeof value.microphoneGainDb === 'number' &&
        Number.isFinite(value.microphoneGainDb) &&
        value.microphoneGainDb >= -24 &&
        value.microphoneGainDb <= 24 &&
        typeof value.microphoneMuted === 'boolean'
        ? {
            action: 'set-audio',
            microphoneGainDb: value.microphoneGainDb,
            microphoneMuted: value.microphoneMuted
          }
        : null
    case 'start':
    case 'rapid-burst':
    case 'stop':
    case 'state':
      return exactKeys(value, ['action']) ? { action: value.action } : null
    default:
      return null
  }
}
