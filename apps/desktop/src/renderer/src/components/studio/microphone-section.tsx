import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { SourceSelect } from '@/components/source-select'
import { LevelMeter } from '@/components/ui/level-meter'
import { useStudioCore, useStudioDiagnostics } from '@/hooks/use-studio'
import {
  backendLevelSources,
  useBackendAudioLevelsLive,
  useStudioMicMeterSource
} from '@/hooks/use-studio-mic-sources'
import { useStudioMicVisualLifecycle } from '@/hooks/use-studio-mic-visual'
import { SILENCE_DB } from '@/lib/audio/decibels'
import type { FrameSource, MeterFrame } from '@/lib/audio/types'
import type { Device } from '@/lib/backend'
import { buildMicrophoneSources, microphonePickerDevices } from '@/lib/capture'
import { audioMixerMonitorLabel, type AudioMixerMonitorLabel } from '@/lib/mic-visual-gate'

/**
 * What drives the meter: a live source (the backend's levels about 20 times a
 * second, or the renderer analyser), or one plain reading (the session's 1 Hz
 * level, silence while muted, NaN when nothing reads).
 */
export type MeterInput =
  | Readonly<{ kind: 'source'; source: FrameSource<MeterFrame> }>
  | Readonly<{ kind: 'value'; peakDb: number }>

const NO_READING: MeterInput = Object.freeze({ kind: 'value', peakDb: Number.NaN })
const SILENCE: MeterInput = Object.freeze({ kind: 'value', peakDb: SILENCE_DB })

/**
 * The meter's input, in priority order. Every path reads the level the
 * recording gets: the backend measures it with the gain applied, on the
 * session bus during a session and on the warm microphone between sessions
 * (plan 092), and the analyser source adds the configured gain itself.
 */
export function micMeterInput(input: {
  microphoneSelected: boolean
  muted: boolean
  /** The backend's levels while they arrive: the session bus or the standby microphone. */
  backendSource: FrameSource<MeterFrame> | null
  analyserDriven: boolean
  source: FrameSource<MeterFrame>
  /** The running session's 1 Hz level. */
  backendPeakDb: number | null
}): MeterInput {
  if (!input.microphoneSelected) return NO_READING
  if (input.muted) return SILENCE
  if (input.backendSource) return { kind: 'source', source: input.backendSource }
  if (input.analyserDriven) return { kind: 'source', source: input.source }
  if (input.backendPeakDb !== null) return { kind: 'value', peakDb: input.backendPeakDb }
  return NO_READING
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The Studio's Microphone section (plan 092, owner call 2026-10-02): the
 * microphone picker and its live level, nothing else, between Session and
 * Inputs. The level runs whenever Studio is open, so anyone can check that
 * their microphone works before they record: the backend sends the warm
 * microphone's level between sessions and the bus's during one, and the
 * renderer analyser fills in where the backend has no standby source.
 */
export function MicrophoneSection(): ReactElement {
  const {
    captureConfig,
    deviceList,
    selectedMicrophone,
    switchSourceDeviceLive,
    sourceSwitchReason,
    wsStatus,
    isSessionActive
  } = useStudioCore()
  const { diagnosticStats } = useStudioDiagnostics()
  const muted = captureConfig.audio.microphoneMuted
  const micVisual = useStudioMicVisualLifecycle()
  const backendLevelsLive = useBackendAudioLevelsLive()
  const analyserSource = useStudioMicMeterSource({
    gainDb: captureConfig.audio.microphoneGainDb,
    muted
  })
  const liveLevel =
    typeof diagnosticStats?.micLiveLevel === 'number' ? diagnosticStats.micLiveLevel : null
  const microphones = microphonePickerDevices(deviceList.devices)
  const meter = micMeterInput({
    microphoneSelected: Boolean(selectedMicrophone),
    muted,
    backendSource: backendLevelsLive ? backendLevelSources.microphone : null,
    analyserDriven: micVisual.active && !muted,
    source: analyserSource,
    backendPeakDb: liveLevel === null ? null : finiteOrNull(diagnosticStats?.micLivePeakDb)
  })
  const signalLive = !muted && (backendLevelsLive || micVisual.active || liveLevel !== null)

  return (
    <MicrophoneSectionView
      devices={microphones}
      disabled={Boolean(sourceSwitchReason('microphone'))}
      discoveryPending={wsStatus !== 'connected'}
      meter={meter}
      monitorLabel={audioMixerMonitorLabel({
        sessionActive: isSessionActive,
        signalLive,
        muted: muted && Boolean(selectedMicrophone)
      })}
      selectedName={captureConfig.sources.microphoneName}
      value={captureConfig.sources.microphoneId}
      onChange={(microphoneId) =>
        void switchSourceDeviceLive(
          'microphone',
          buildMicrophoneSources(captureConfig.sources, microphones, microphoneId)
        )
      }
    />
  )
}

/** The section's markup from props (the tests render it). */
export function MicrophoneSectionView({
  devices,
  value,
  selectedName,
  disabled,
  discoveryPending,
  meter,
  monitorLabel,
  onChange
}: {
  devices: Device[]
  value: string | undefined
  selectedName: string | undefined
  disabled: boolean
  discoveryPending: boolean
  meter: MeterInput
  monitorLabel: AudioMixerMonitorLabel
  onChange: (microphoneId: string | undefined) => void
}): ReactElement {
  const live = meter.kind === 'source'
  return (
    <PanelSection title="Microphone">
      {/* The section title names the picker; its label stays for screen readers. */}
      <SourceSelect
        allowNone
        devices={devices}
        disabled={disabled}
        discoveryPending={discoveryPending}
        label="Microphone"
        labelHidden
        selectedName={selectedName}
        value={value}
        onChange={onChange}
      />
      {/* Exactly the picker's width: the meter alone. It still names its level
          in dB to screen readers (aria-valuetext). */}
      <div className="flex items-center" data-videorc-mic-level="">
        {live ? (
          <LevelMeter
            aria-label="Microphone level"
            ballistics="peak"
            className="min-w-0 flex-1"
            data-videorc-mic-visualizer=""
            orientation="horizontal"
            source={meter.source}
            variant="segmented"
          />
        ) : (
          // One reading a second at most: VU ballistics glide between them.
          <LevelMeter
            aria-label="Microphone level"
            ballistics="vu"
            className="min-w-0 flex-1"
            data-videorc-mic-visualizer=""
            orientation="horizontal"
            peakDb={meter.peakDb}
            variant="segmented"
          />
        )}
        {/* Live / Muted / Idle for screen readers (and the perf probe), not on screen. */}
        <span className="sr-only" data-videorc-mic-monitor-state={monitorLabel.toLowerCase()}>
          {monitorLabel}
        </span>
      </div>
    </PanelSection>
  )
}
