const CAPTION_AUDIO_PUMP_MS = 1_000

export function startCaptionAudioPump({ ws, request, captionFake, streamSessionId }) {
  // Both scripted-speech scenarios need provider progress between exact finals:
  // the healthy energy-positive bus otherwise trips the transcript watchdog.
  const previousPartialProgress = captionFake.state.realtimePartialProgress
  captionFake.state.realtimePartialProgress = true
  let stopped = false
  const tick = () => {
    if (stopped) return
    const method = streamSessionId ? 'audio.test.inject-pcm' : 'captions.test.inject-audio'
    const params = streamSessionId
      ? { sessionId: streamSessionId, durationMs: 200, rawPeak: 0.12 }
      : { durationMs: 200 }
    request(ws, 5_000, method, params).catch(() => {})
  }
  tick()
  const timer = setInterval(tick, CAPTION_AUDIO_PUMP_MS)
  return {
    stop() {
      if (stopped) return
      stopped = true
      captionFake.state.realtimePartialProgress = previousPartialProgress
      clearInterval(timer)
    }
  }
}

export function streamSessionParams(outputDirectoryCapability, RTMP_PORT) {
  const timestamp = '2026-01-01T00:00:00.000Z'
  const serverUrl = `rtmp://127.0.0.1:${RTMP_PORT}/live`
  const target = {
    id: 'cohost-smoke-rtmp',
    platform: 'custom',
    label: 'Local co-host smoke',
    enabled: true,
    serverUrl,
    urlMode: 'server-and-key',
    streamKey: 'cohost-smoke',
    streamKeyPresent: true,
    authMode: 'manual-rtmp',
    outputPreset: 'stream-safe-1080p30',
    outputBitrateKbps: 6000,
    createdAt: timestamp,
    updatedAt: timestamp
  }
  return {
    sources: { testPattern: true, microphoneId: 'microphone:coreaudio:4294967295' },
    layout: {
      layoutPreset: 'screen-only',
      cameraTransformMode: 'preset',
      cameraTransform: null,
      cameraCorner: 'bottom-right',
      cameraSize: 'medium',
      cameraShape: 'rectangle',
      cameraCornerRadiusPct: 12,
      cameraAspect: 'source',
      cameraMargin: 32,
      cameraFit: 'fill',
      cameraMirror: false,
      cameraZoom: 100,
      cameraOffsetX: 0,
      cameraOffsetY: 0,
      sideBySideSplit: '70-30',
      sideBySideCameraSide: 'right'
    },
    output: {
      recordEnabled: false,
      streamEnabled: true,
      outputDirectoryCapability,
      video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
      rtmp: { preset: 'custom', serverUrl, streamKey: target.streamKey }
    },
    streaming: {
      enabled: true,
      mode: 'single',
      targets: [target],
      selectedTargetId: target.id,
      defaultOutputPreset: target.outputPreset,
      defaultBitrateKbps: target.outputBitrateKbps,
      enabledTargetIds: [target.id]
    },
    audio: { microphoneGainDb: 0, microphoneMuted: false, microphoneSyncOffsetMs: 0 }
  }
}
