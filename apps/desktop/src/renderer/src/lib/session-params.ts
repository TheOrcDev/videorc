import type { Scene, StartSessionParams } from './backend'
import {
  captionsEnabledForSession,
  captionsSuppressedForSession,
  captionSessionOutputReadiness
} from './captions-preflight'
import { streamOutputVideosForTargets, type CaptureConfig, type SettingsState } from './capture'

export function buildStartSessionParams(input: {
  captureConfig: CaptureConfig
  scene: Scene | null
  sceneEditMode?: boolean
  settings: SettingsState
  suppressCaptionsForSession?: boolean
}): StartSessionParams {
  const {
    captureConfig,
    scene,
    sceneEditMode = false,
    settings,
    suppressCaptionsForSession = false
  } = input

  // Send the scene whenever edit mode is on OR it carries a background, so the
  // backend learns the selected background even outside transform editing (A5).
  const includeScene = sceneEditMode || scene?.background != null
  const captionOutputReadiness = captionSessionOutputReadiness({
    burnTarget: captureConfig.captions.burnTarget,
    recordEnabled: captureConfig.recordEnabled,
    streamEnabled: captureConfig.streamEnabled,
    recordingVideo: captureConfig.video,
    streamVideos: streamOutputVideosForTargets(
      captureConfig.video,
      captureConfig.streamEnabled ? captureConfig.streaming : undefined
    ).map(({ video }) => video)
  })
  const captionsSuppressed = captionsSuppressedForSession({
    persistedEnabled: captureConfig.captions.enabled,
    explicitSuppression: suppressCaptionsForSession,
    outputReadiness: captionOutputReadiness
  })

  return {
    sources: captureConfig.sources,
    layout: captureConfig.layout,
    scene: includeScene ? (scene ?? undefined) : undefined,
    output: {
      recordEnabled: captureConfig.recordEnabled,
      streamEnabled: captureConfig.streamEnabled,
      keepOriginalMkv: settings.keepOriginalRecording,
      video: captureConfig.video,
      rtmp: {
        preset: captureConfig.rtmpPreset,
        serverUrl: captureConfig.rtmpServerUrl.trim(),
        streamKey: captureConfig.streamKey.trim()
      }
    },
    audio: captureConfig.audio,
    streaming: captureConfig.streaming,
    captions: {
      enabled: captionsEnabledForSession({
        persistedEnabled: captureConfig.captions.enabled,
        suppressForSession: suppressCaptionsForSession
      }),
      suppressedForSession: captionsSuppressed,
      burnTarget: captureConfig.captions.burnTarget,
      styleId: captureConfig.captions.styleId,
      language: captureConfig.captions.language,
      styleRevision: captureConfig.captions.styleRevision,
      position: captureConfig.captions.position,
      textSize: captureConfig.captions.textSize
    }
  }
}
