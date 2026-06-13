import type { Scene, StartSessionParams } from './backend'
import type { CaptureConfig, SettingsState } from './capture'

export function buildStartSessionParams(input: {
  captureConfig: CaptureConfig
  scene: Scene | null
  settings: SettingsState
}): StartSessionParams {
  const { captureConfig, scene, settings } = input

  return {
    sources: captureConfig.sources,
    layout: captureConfig.layout,
    scene: scene ?? undefined,
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
    streaming: captureConfig.streaming
  }
}
