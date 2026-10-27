import type { LayoutSettings, RecordingState, SourceSelection, VideoSettings } from './backend'

export const WINDOWS_D3D11_PREVIEW_SMOKE_COMMAND = 'windows-d3d11-preview-harness'

export type WindowsD3d11PreviewSmokeRequest =
  | { action: 'configure'; screenId: string }
  | { action: 'state' }

export interface WindowsD3d11PreviewSmokeState {
  recording: {
    state: RecordingState
    sessionId?: string
  }
  lastError: string | null
  sources: Pick<
    SourceSelection,
    'screenId' | 'cameraId' | 'cameraOff' | 'microphoneId' | 'microphoneOff' | 'testPattern'
  >
  video: VideoSettings
  layout: Pick<LayoutSettings, 'layoutPreset'>
  output: {
    recordEnabled: boolean
    streamEnabled: boolean
  }
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
 * Strict validator for the packaged Windows D3D11 preview bridge. It selects
 * one available screen as the renderer's only source; it has no path, URL,
 * backend method, JavaScript, or recording-control parameters. The harness
 * already holds a backend connection that can start that screen, so the
 * bridge grants nothing the harness could not already do.
 */
export function validateWindowsD3d11PreviewSmokeRequest(
  value: Record<string, unknown>
): WindowsD3d11PreviewSmokeRequest | null {
  switch (value.action) {
    case 'configure':
      return exactKeys(value, ['action', 'screenId']) && exactDeviceId(value.screenId)
        ? { action: 'configure', screenId: value.screenId }
        : null
    case 'state':
      return exactKeys(value, ['action']) ? { action: 'state' } : null
    default:
      return null
  }
}
