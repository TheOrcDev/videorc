import { roomMicrophoneState, roomMicrophoneMeter } from '@/lib/room-microphone-state'
import { useMemo, useRef, useSyncExternalStore } from 'react'

import { useStudioCore, useStudioDiagnostics, useStudioCloud } from '@/hooks/use-studio'
import {
  useStudioMicVisualDemand,
  useStudioMicVisualLifecycle,
  useStudioMicVisualPipeline
} from '@/hooks/use-studio-mic-visual'
import type { FrameSource, MeterFrame } from '@/lib/audio/types'
import { backendAudioLevels } from '@/lib/backend-audio-levels'
import { createBackendLevelSource } from '@/lib/backend-level-sources'
import { createMicMeterSource, type MicMeterSettings } from '@/lib/mic-frame-sources'
import {
  meterHasNoReading,
  micMeterInput,
  micSessionLevelUnavailable,
  type MeterInput
} from '@/lib/mic-meter-input'
import type { MicStreamFailureReason } from '@/lib/mic-stream'
import { audioMixerMonitorState } from '@/lib/mic-visual-gate'
import type { MicMonitorState } from '@/lib/state-labels'
import { isBackendMeteredMicrophoneId } from '@/lib/warm-microphone-gate'

// Plan 092: audiocn frame sources over the backend's `audio.levels` and, for a
// Windows or Linux microphone between sessions only, the workspace's visual
// mic pipeline (plan 260 S1.3a). Only lazy chunks (the Studio dashboard, the
// Studio tab, Sources) import this module, so the adapters and audiocn's core
// stay out of the eager bundle.

/**
 * The renderer analyser's microphone as a meter source: what the recording
 * will hear (the configured gain added, silence while muted). One stable
 * source per pipeline; gain and mute are read on every frame, so a Gain drag
 * never re-subscribes or reopens the device. plan 260 S1.3a: it only ever
 * runs for a Windows or Linux microphone between sessions (S1.3c removes it).
 */
export function useStudioMicMeterSource(settings: MicMeterSettings): FrameSource<MeterFrame> {
  const pipeline = useStudioMicVisualPipeline()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  return useMemo(() => createMicMeterSource(pipeline, () => settingsRef.current), [pipeline])
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
  processingDetail?: string
  meter: MeterInput
  monitorState: MicMonitorState
  /**
   * Why no live level reads (plan 080 S3): set only when nothing drives the
   * idle meter because its feed failed (the backend's standing-by microphone
   * for a CoreAudio input, the renderer analyser for a Windows or Linux one).
   */
  unavailableReason: MicStreamFailureReason | undefined
  /**
   * Issue 1064: a session's bus runs but sends no level, so the meter shows
   * none (never the analyser); the row says so in words.
   */
  sessionLevelUnavailable: boolean
}>

/**
 * Why an idle meter has no level (plan 080 S3). A CoreAudio microphone's only
 * idle feed is the backend's standing-by microphone (plan 260 S1.3a), so a
 * failed open is the reason there; elsewhere the analyser's failure is.
 */
export function idleLevelUnavailableReason(input: {
  backendMetered: boolean
  warmMicrophone: Readonly<{ armed: boolean; reason?: string }> | null | undefined
  analyser: Readonly<{ status: string; reason?: MicStreamFailureReason }>
}): MicStreamFailureReason | undefined {
  if (input.backendMetered) {
    return input.warmMicrophone?.armed === false && input.warmMicrophone.reason === 'open-failed'
      ? 'unknown'
      : undefined
  }
  return input.analyser.status === 'unavailable' ? (input.analyser.reason ?? 'unknown') : undefined
}

/**
 * The selected microphone's meter input and state (plans 092 and 093), one
 * build for the Studio Microphone section and the Sources Audio mixer. The
 * level runs whenever either is open: the backend's levels (the warm
 * microphone between sessions, the bus during one), then, outside a session
 * and only for a Windows or Linux microphone (plan 260 S1.3a), the renderer
 * analyser, then the session's 1 Hz level. Issue 1064: while a recording,
 * livestream or Clips ring runs its bus, the analyser never paints (it hears
 * Chromium's microphone, not the recording's) and the backend's silence
 * watchdog owns the status word.
 */
export function useMicrophoneMeter(): MicrophoneMeter {
  const { captureConfig, selectedMicrophone, isSessionActive, audioBusActive, warmMicrophone } =
    useStudioCore()
  const roomOpen = useStudioCloud().cloudStatus?.room?.phase === 'open'
  // The view, not the levels: a level re-rendering this hook's host 20 times
  // a second is what the meter's own frame source exists to avoid (PH-12).
  const roomMic = useSyncExternalStore(
    roomMicrophoneState.subscribe,
    roomMicrophoneState.getView,
    roomMicrophoneState.getView
  )
  const { diagnosticStats } = useStudioDiagnostics()
  const muted = captureConfig.audio.microphoneMuted
  const micVisual = useStudioMicVisualLifecycle()
  const backendLevelsLive = useBackendAudioLevelsLive()
  const backendMicrophoneSilent = useBackendMicrophoneSilent()
  // The visible meter owns fallback demand even before the analyser is active.
  // Backend levels own painting while live, so this retain ends when they
  // return; a running bus never paints from the analyser, so it asks for none.
  useStudioMicVisualDemand(!roomOpen && !backendLevelsLive && !audioBusActive)
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
  if (roomOpen) {
    // Levels stop with a null tick (unpublished, context not running) or
    // the close, either of which changes the view.
    const available = roomMic.state === 'published' && roomMic.levels
    return {
      meter: available
        ? { kind: 'source', source: roomMicrophoneMeter }
        : { kind: 'value', peakDb: NaN },
      monitorState: muted ? 'muted' : available ? 'live' : 'idle',
      unavailableReason: undefined,
      sessionLevelUnavailable: Boolean(selectedMicrophone) && !muted && !available,
      processingDetail:
        roomMic.reason ??
        (roomMic.mode === 'native-headphones'
          ? 'Native headphones test mode. Clock sync and speaker AEC are unqualified.'
          : 'Browser echo cancellation. Native RNNoise and sync offset are not applied in this mode.')
    }
  }
  return {
    meter,
    monitorState: audioMixerMonitorState({
      sessionActive: isSessionActive,
      signalLive,
      muted: muted && microphoneSelected,
      silent: microphoneSelected && backendLevelsLive && backendMicrophoneSilent
    }),
    unavailableReason:
      microphoneSelected && !audioBusActive && meterHasNoReading(meter)
        ? idleLevelUnavailableReason({
            backendMetered: isBackendMeteredMicrophoneId(selectedMicrophone?.id),
            warmMicrophone,
            analyser: micVisual
          })
        : undefined,
    sessionLevelUnavailable: micSessionLevelUnavailable({
      microphoneSelected,
      muted,
      sessionActive: audioBusActive,
      meter
    })
  }
}
