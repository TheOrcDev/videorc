import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { SourceSelect } from '@/components/source-select'
import { MicLevelMeter } from '@/components/studio/mic-level-meter'
import { useStudioCore } from '@/hooks/use-studio'
import { useMicrophoneMeter } from '@/hooks/use-studio-mic-sources'
import type { Device } from '@/lib/backend'
import { buildMicrophoneSources, microphonePickerDevices } from '@/lib/capture'
import type { MeterInput } from '@/lib/mic-meter-input'
import type { AudioMixerMonitorLabel } from '@/lib/mic-visual-gate'

/**
 * The Studio's Microphone section (plan 092, owner call 2026-10-02): the
 * microphone picker and its live level, nothing else, between Session and
 * Inputs. The level runs whenever Studio is open, so anyone can check that
 * their microphone works before they record: the backend sends the warm
 * microphone's level between sessions and the bus's during one, and the
 * renderer analyser fills in where the backend has no standby source.
 */
export function MicrophoneSection(): ReactElement {
  const { captureConfig, deviceList, switchSourceDeviceLive, sourceSwitchReason, wsStatus } =
    useStudioCore()
  const { meter, monitorLabel } = useMicrophoneMeter()
  const microphones = microphonePickerDevices(deviceList.devices)

  return (
    <MicrophoneSectionView
      devices={microphones}
      disabled={Boolean(sourceSwitchReason('microphone'))}
      discoveryPending={wsStatus !== 'connected'}
      meter={meter}
      monitorLabel={monitorLabel}
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
        <MicLevelMeter
          aria-label="Microphone level"
          className="min-w-0 flex-1"
          data-videorc-mic-visualizer=""
          meter={meter}
          orientation="horizontal"
          variant="segmented"
        />
        {/* Live / Muted / Idle for screen readers (and the perf probe), not on screen. */}
        <span className="sr-only" data-videorc-mic-monitor-state={monitorLabel.toLowerCase()}>
          {monitorLabel}
        </span>
      </div>
    </PanelSection>
  )
}
