import type { Device, RecordingStatus } from '@/lib/backend'
import type { CaptureConfig } from '@/lib/capture'
import type {
  WindowsD3d11PreviewSmokeRequest,
  WindowsD3d11PreviewSmokeState
} from '../../../shared/windows-d3d11-preview-smoke'

/**
 * The renderer's own sources become the real screen, ScreenOnly, and nothing
 * else. Camera and microphone are explicitly off so device reconcile does not
 * select the first camera again: an unstarted camera refuses every session,
 * and the D3D11 scene map refuses the test pattern, so without this the
 * buffer-only session never runs and the preview has no source pixels.
 */
export function configureWindowsD3d11PreviewSmokeCapture(
  current: CaptureConfig,
  devices: Device[],
  request: Extract<WindowsD3d11PreviewSmokeRequest, { action: 'configure' }>
): CaptureConfig {
  const screen = devices.find(
    (candidate) =>
      candidate.id === request.screenId &&
      candidate.kind === 'screen' &&
      candidate.status === 'available'
  )
  if (!screen) {
    throw new Error(
      `Windows D3D11 preview smoke could not select available screen ${request.screenId}.`
    )
  }
  return {
    ...current,
    sources: {
      screenId: screen.id,
      screenName: screen.name,
      cameraOff: true,
      microphoneOff: true,
      testPattern: false
    },
    layout: {
      ...current.layout,
      layoutPreset: 'screen-only',
      cameraTransformMode: 'preset',
      cameraTransform: null
    },
    // The scenario's 1080p30 profile, so a Record arms the running session
    // in place instead of restarting it with a different shape.
    video: {
      preset: 'custom',
      width: 1920,
      height: 1080,
      fps: 30,
      bitrateKbps: 6_000
    },
    verticalRestoreVideo: null,
    lastHorizontalPreset: 'screen-only',
    recordEnabled: true,
    streamEnabled: false,
    captions: { ...current.captions, enabled: false }
  }
}

export function windowsD3d11PreviewSmokeState(input: {
  recording: RecordingStatus
  lastError: string | null
  captureConfig: CaptureConfig
}): WindowsD3d11PreviewSmokeState {
  const { sources } = input.captureConfig
  return {
    recording: {
      state: input.recording.state,
      ...(input.recording.sessionId ? { sessionId: input.recording.sessionId } : {})
    },
    lastError: input.lastError,
    sources: {
      screenId: sources.screenId,
      cameraId: sources.cameraId,
      cameraOff: sources.cameraOff,
      microphoneId: sources.microphoneId,
      microphoneOff: sources.microphoneOff,
      testPattern: sources.testPattern
    },
    video: { ...input.captureConfig.video },
    layout: { layoutPreset: input.captureConfig.layout.layoutPreset },
    output: {
      recordEnabled: input.captureConfig.recordEnabled,
      streamEnabled: input.captureConfig.streamEnabled
    }
  }
}
