import { useMemo, useRef, useSyncExternalStore } from 'react'

import { useStudioMicVisualPipeline } from '@/hooks/use-studio-mic-visual'
import type { FrameSource, MeterFrame, VisualFrame } from '@/lib/audio/types'
import { backendAudioLevels } from '@/lib/backend-audio-levels'
import { createBackendLevelSource } from '@/lib/backend-level-sources'
import {
  createMicMeterSource,
  createMicVisualSource,
  type MicMeterSettings
} from '@/lib/mic-frame-sources'

// Plan 092: audiocn frame sources over the workspace's visual mic pipeline.
// Only lazy chunks (the Studio dashboard, the Studio tab, Sources) import this
// module, so the adapters and audiocn's core stay out of the eager bundle.

/**
 * The Studio microphone as a meter source: what the recording will hear (the
 * configured gain added, silence while muted). One stable source per
 * pipeline; gain and mute are read on every frame, so a Gain drag never
 * re-subscribes or reopens the device.
 */
export function useStudioMicMeterSource(settings: MicMeterSettings): FrameSource<MeterFrame> {
  const pipeline = useStudioMicVisualPipeline()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  return useMemo(() => createMicMeterSource(pipeline, () => settingsRef.current), [pipeline])
}

/** The Studio microphone's bands and level history, raw, for bars and waveforms. */
export function useStudioMicVisualSource(): FrameSource<VisualFrame> {
  const pipeline = useStudioMicVisualPipeline()
  return useMemo(() => createMicVisualSource(pipeline), [pipeline])
}

/**
 * Plan 092 Phase C: the backend's post-gain levels during a session, one
 * stable source per bus tap: the processed microphone, the gained system
 * audio, and the mix as written.
 */
export const backendLevelSources = Object.freeze({
  microphone: createBackendLevelSource(backendAudioLevels, 'microphone'),
  systemAudio: createBackendLevelSource(backendAudioLevels, 'systemAudio'),
  master: createBackendLevelSource(backendAudioLevels, 'master')
})

/** True while the backend's `audio.levels` keep arriving (a session's bus is running). */
export function useBackendAudioLevelsLive(): boolean {
  return useSyncExternalStore(
    backendAudioLevels.subscribeLive,
    backendAudioLevels.isLive,
    backendAudioLevels.isLive
  )
}
