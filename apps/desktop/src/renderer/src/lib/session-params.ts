import type { Scene, StartSessionParams } from './backend'
import type { CaptureConfig, SettingsState } from './capture'

export function buildStartSessionParams(input: {
  captureConfig: CaptureConfig
  scene: Scene | null
  sceneEditMode?: boolean
  settings: SettingsState
}): StartSessionParams {
  const { captureConfig, scene, sceneEditMode = false, settings } = input

  // Send the scene whenever edit mode is on OR it carries a background, so the
  // backend learns the selected background even outside transform editing (A5).
  const includeScene = sceneEditMode || scene?.background != null

  return {
    sources: captureConfig.sources,
    layout: captureConfig.layout,
    scene: includeScene ? (scene ?? undefined) : undefined,
    output: {
      recordEnabled: captureConfig.recordEnabled,
      streamEnabled: captureConfig.streamEnabled,
      outputDirectory: settings.outputDirectory.trim() || undefined,
      ffmpegPath: settings.ffmpegPath.trim() || undefined,
      video: captureConfig.video,
      rtmp: {
        preset: captureConfig.rtmpPreset,
        serverUrl: captureConfig.rtmpServerUrl.trim(),
        streamKey: captureConfig.streamKey.trim()
      }
    },
    audio: captureConfig.audio,
    streaming: captureConfig.streaming,
    captions: { burnInEnabled: captureConfig.captions.burnInEnabled }
  }
}
