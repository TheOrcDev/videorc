import { useMemo, useRef, useSyncExternalStore } from 'react'

import { useStudioCore, useStudioDiagnostics } from '@/hooks/use-studio'
import {
  useStudioMicVisualDemand,
  useStudioMicVisualLifecycle,
  useStudioMicVisualPipeline
} from '@/hooks/use-studio-mic-visual'
import type { FrameSource, MeterFrame, VisualFrame } from '@/lib/audio/types'
import { backendAudioLevels } from '@/lib/backend-audio-levels'
import { createBackendLevelSource } from '@/lib/backend-level-sources'
import {
  createMicMeterSource,
  createMicVisualSource,
  type MicMeterSettings
} from '@/lib/mic-frame-sources'
import {
  meterHasNoReading,
  micMeterInput,
  micSessionLevelUnavailable,
  type MeterInput
} from '@/lib/mic-meter-input'
import type { MicStreamFailureReason } from '@/lib/mic-stream'
import { audioMixerMonitorState } from '@/lib/mic-visual-gate'
import type { MicMonitorState } from '@/lib/state-labels'

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
 * audio, the soundboard's sounds as mixed (plan 189), and the mix as written.
 */
export const backendLevelSources = Object.freeze({
  microphone: createBackendLevelSource(backendAudioLevels, 'microphone'),
  systemAudio: createBackendLevelSource(backendAudioLevels, 'systemAudio'),
  sounds: createBackendLevelSource(backendAudioLevels, 'sounds'),
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

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Issue 1064: true while the bus's silence watchdog reports the captured microphone silent. */
export function useBackendMicrophoneSilent(): boolean {
  return useSyncExternalStore(
    backendAudioLevels.subscribeMicrophoneSilent,
    backendAudioLevels.isMicrophoneSilent,
    backendAudioLevels.isMicrophoneSilent
  )
}

export type MicrophoneMeter = Readonly<{
  meter: MeterInput
  monitorState: MicMonitorState
  /**
   * Why no live level reads (plan 080 S3): set only when nothing else drives
   * the meter and the renderer analyser, the last live input, failed.
   */
  unavailableReason: MicStreamFailureReason | undefined
  /**
   * Issue 1064: a session's bus runs but sends no level, so the meter shows
   * none (never the analyser); the row says so in words.
   */
  sessionLevelUnavailable: boolean
}>

/**
 * The selected microphone's meter input and state (plans 092 and 093), one
 * build for the Studio Microphone section and the Sources Audio mixer. The
 * level runs whenever either is open: the backend's levels (the warm
 * microphone between sessions, the bus during one), then, outside a session,
 * the renderer analyser, then the session's 1 Hz level. Issue 1064: while a
 * recording, livestream or Clips ring runs its bus, the analyser never paints
 * (it hears Chromium's microphone, not the recording's) and the backend's
 * silence watchdog owns the status word.
 */
export function useMicrophoneMeter(): MicrophoneMeter {
  const { captureConfig, selectedMicrophone, isSessionActive, audioBusActive } = useStudioCore()
  const { diagnosticStats } = useStudioDiagnostics()
  const muted = captureConfig.audio.microphoneMuted
  const micVisual = useStudioMicVisualLifecycle()
  const backendLevelsLive = useBackendAudioLevelsLive()
  const backendMicrophoneSilent = useBackendMicrophoneSilent()
  // The visible meter owns fallback demand even before the analyser is active.
  // Backend levels own painting while live, so this retain ends when they
  // return; a running bus never paints from the analyser, so it asks for none.
  useStudioMicVisualDemand(!backendLevelsLive && !audioBusActive)
  const analyserSource = useStudioMicMeterSource({
    gainDb: captureConfig.audio.microphoneGainDb,
    muted
  })
  const microphoneSelected = Boolean(selectedMicrophone)
  const liveLevel =
    typeof diagnosticStats?.micLiveLevel === 'number' ? diagnosticStats.micLiveLevel : null
  const meter = micMeterInput({
    microphoneSelected,
    muted,
    backendSource: backendLevelsLive ? backendLevelSources.microphone : null,
    analyserDriven: micVisual.active && !muted,
    source: analyserSource,
    backendPeakDb: liveLevel === null ? null : finiteOrNull(diagnosticStats?.micLivePeakDb),
    sessionActive: audioBusActive
  })
  const signalLive =
    !muted && (backendLevelsLive || (micVisual.active && !audioBusActive) || liveLevel !== null)
  return {
    meter,
    monitorState: audioMixerMonitorState({
      sessionActive: isSessionActive,
      signalLive,
      muted: muted && microphoneSelected,
      silent: microphoneSelected && backendLevelsLive && backendMicrophoneSilent
    }),
    unavailableReason:
      microphoneSelected &&
      !audioBusActive &&
      meterHasNoReading(meter) &&
      micVisual.status === 'unavailable'
        ? (micVisual.reason ?? 'unknown')
        : undefined,
    sessionLevelUnavailable: micSessionLevelUnavailable({
      microphoneSelected,
      muted,
      sessionActive: audioBusActive,
      meter
    })
  }
}
