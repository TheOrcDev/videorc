import type { ReactElement, ReactNode } from 'react'

import { DevicePicker } from '@/components/device-picker'
import { PanelSection } from '@/components/panel-section'
import { MicLevelMeter } from '@/components/studio/mic-level-meter'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { useStudioCore } from '@/hooks/use-studio'
import { useMicrophoneMeter } from '@/hooks/use-studio-mic-sources'
import type { Device } from '@/lib/backend'
import { buildMicrophoneSources, microphonePickerDevices } from '@/lib/capture'
import type { MeterInput } from '@/lib/mic-meter-input'
import { micSignalLabel, type MicMonitorState } from '@/lib/state-labels'

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
    wsStatus
  } = useStudioCore()
  const { meter, monitorState } = useMicrophoneMeter()
  const microphones = microphonePickerDevices(deviceList.devices)

  return (
    <MicrophoneSectionView
      devices={microphones}
      disabled={Boolean(sourceSwitchReason('microphone'))}
      discoveryPending={wsStatus !== 'connected'}
      meter={meter}
      monitorState={monitorState}
      selectedDevice={selectedMicrophone}
      selectedName={captureConfig.sources.microphoneName}
      switchStatus={<SourceSwitchStatus kind="microphone" />}
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
  selectedDevice,
  switchStatus,
  disabled,
  discoveryPending,
  meter,
  monitorState,
  onChange
}: {
  devices: Device[]
  value: string | undefined
  selectedName: string | undefined
  /** The selected microphone from the whole device list. */
  selectedDevice?: Device
  /** The live switch status (as Screen and Camera show it), under the picker. */
  switchStatus?: ReactNode
  disabled: boolean
  discoveryPending: boolean
  meter: MeterInput
  monitorState: MicMonitorState
  onChange: (microphoneId: string | undefined) => void
}): ReactElement {
  return (
    <PanelSection title="Microphone">
      {/* The section title names the picker; its label stays for screen readers. */}
      <DevicePicker
        description={switchStatus}
        devices={devices}
        disabled={disabled}
        discoveryPending={discoveryPending}
        kind="microphone"
        label="Microphone"
        labelHidden
        noneLabel="Off"
        selectedDevice={selectedDevice}
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
        {/* Receiving / Muted / No signal for screen readers, and its state for the perf probe, off screen. */}
        <span className="sr-only" data-videorc-mic-monitor-state={monitorState}>
          {micSignalLabel(monitorState)}
        </span>
      </div>
    </PanelSection>
  )
}
