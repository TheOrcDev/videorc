import { cameraLookLayout } from './camera-look'
import type { Scene, StartSessionParams } from './backend'
import {
  captionsEnabledForSession,
  captionsSuppressedForSession,
  captionSessionOutputReadiness
} from './captions-preflight'
import {
  REPLAY_RING_SECONDS,
  buildSimulcastParams,
  providerStreamOutputPlanOptions,
  separateSourceRecordingsForSession,
  streamOutputVideosForTargets,
  type CaptureConfig,
  type SettingsState,
  type SimulcastScene
} from './capture'

/**
 * The main scene `session.start` sends: whenever edit mode is on OR it carries
 * a background, so the backend learns the selected background even outside
 * transform editing (A5). The SRT Camera's ask reads the same (plan 255 D15).
 */
export function sessionScene(
  scene: Scene | null | undefined,
  sceneEditMode: boolean
): Scene | undefined {
  return sceneEditMode || scene?.background != null ? (scene ?? undefined) : undefined
}

export function buildStartSessionParams(input: {
  captureConfig: CaptureConfig
  scene: Scene | null
  /**
   * The scene on stream: its 9:16 layout is the vertical stream's (plan 231
   * D4). Without it no vertical stream is built (the Clips ring's own session,
   * which never streams).
   */
  sceneOnStream?: SimulcastScene
  sceneEditMode?: boolean
  settings: SettingsState
  suppressCaptionsForSession?: boolean
  /** The replay buffer's switch is on (plan 181): the session carries the ring. */
  replayArmed?: boolean
  /** `process.platform` from runtime info: Separate source recordings are macOS-only. */
  platform?: string
}): StartSessionParams {
  const {
    captureConfig,
    scene,
    sceneEditMode = false,
    settings,
    suppressCaptionsForSession = false,
    replayArmed = false
  } = input

  const captionOutputReadiness = captionSessionOutputReadiness({
    burnTarget: captureConfig.captions.burnTarget,
    recordEnabled: captureConfig.recordEnabled,
    streamEnabled: captureConfig.streamEnabled,
    recordingVideo: captureConfig.video,
    streamVideos: streamOutputVideosForTargets(
      captureConfig.video,
      captureConfig.streamEnabled ? captureConfig.streaming : undefined,
      providerStreamOutputPlanOptions(captureConfig)
    ).map(({ video }) => video)
  })
  const captionsSuppressed = captionsSuppressedForSession({
    persistedEnabled: captureConfig.captions.enabled,
    explicitSuppression: suppressCaptionsForSession,
    outputReadiness: captionOutputReadiness
  })

  return {
    sources: captureConfig.sources,
    layout: cameraLookLayout(
      captureConfig.layout,
      captureConfig.sources.cameraId,
      settings.cameraLooks
    ),
    scene: sessionScene(scene, sceneEditMode),
    output: {
      recordEnabled: captureConfig.recordEnabled,
      streamEnabled: captureConfig.streamEnabled,
      keepOriginalMkv: settings.keepOriginalRecording,
      // Only sent when armed, so an ISO-off session's params stay byte-identical
      // to pre-157 renderers.
      separateSourceRecordings: separateSourceRecordingsForSession(captureConfig, input.platform),
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
    },
    // Present only when a vertical destination is armed on a horizontal
    // session — the backend refuses vertical targets without this leg.
    simulcast: buildSimulcastParams(
      {
        ...captureConfig,
        layout: cameraLookLayout(
          captureConfig.layout,
          captureConfig.sources.cameraId,
          settings.cameraLooks
        )
      },
      input.sceneOnStream
    ),
    // `auto` (redesign R2): a ring the user never asked for, which the
    // backend keeps off a software encoder path; a chosen one runs anywhere.
    // Plan 199: the ring always keeps the minute; only a smoke shortens it.
    ...(replayArmed
      ? {
          replay: {
            seconds: captureConfig.replayBuffer.smokeRingSeconds ?? REPLAY_RING_SECONDS,
            ...(captureConfig.replayBuffer.explicit ? {} : { auto: true })
          }
        }
      : {})
  }
}
