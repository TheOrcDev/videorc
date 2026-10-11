import { SpeakerOffIcon, SpeakerOnIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { DevicePicker } from '@/components/device-picker'
import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { MicLevelMeter } from '@/components/studio/mic-level-meter'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { MuteToggle } from '@/components/ui/channel-toggle'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { useStudioCore } from '@/hooks/use-studio'
import { useMicrophoneMeter } from '@/hooks/use-studio-mic-sources'
import type { Device } from '@/lib/backend'
import { buildMicrophoneSources, microphonePickerDevices } from '@/lib/capture'
import type { MeterInput } from '@/lib/mic-meter-input'
import type { AudioMixerMonitorLabel } from '@/lib/mic-visual-gate'
import { cn } from '@/lib/utils'

/**
 * The Studio's Microphone section (plan 092, owner call 2026-10-02): the
 * microphone picker and its live level, between Session and Sources, and
 * since plan 174 D16 the mute in its header (S3.3). The level runs whenever
 * Studio is open, so anyone can check that their microphone works before they
 * record: the backend sends the warm microphone's level between sessions and
 * the bus's during one, and the renderer analyser fills in where the backend
 * has no standby source.
 */
export function MicrophoneSection(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    deviceList,
    selectedMicrophone,
    switchSourceDeviceLive,
    sourceSwitchReason,
    settings,
    runtimeInfo,
    wsStatus
  } = useStudioCore()
  const { meter, monitorLabel } = useMicrophoneMeter()
  const microphones = microphonePickerDevices(deviceList.devices)

  return (
    <MicrophoneSectionView
      devices={microphones}
      disabled={Boolean(sourceSwitchReason('microphone'))}
      discoveryPending={wsStatus !== 'connected'}
      meter={meter}
      monitorLabel={monitorLabel}
      muteShortcut={settings.globalShortcuts?.micToggle}
      muted={captureConfig.audio.microphoneMuted}
      platform={runtimeInfo?.platform}
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
      // The same mute the Sources mixer and the mute hotkey set: the session
      // applies it live (use-studio's live audio processing sync).
      onMutedChange={(microphoneMuted) =>
        setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, microphoneMuted }
        }))
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
  monitorLabel,
  muted,
  muteShortcut,
  platform,
  onChange,
  onMutedChange
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
  monitorLabel: AudioMixerMonitorLabel
  muted: boolean
  /** The bound global mute shortcut (an accelerator); absent when none is bound. */
  muteShortcut?: string
  platform?: string
  onChange: (microphoneId: string | undefined) => void
  onMutedChange: (muted: boolean) => void
}): ReactElement {
  return (
    <PanelSection
      action={
        // D16: the mute lives here, with its hotkey when one is bound, and a
        // muted microphone says so in words: flat bars alone read as a dead
        // microphone (plan 174 S3.3).
        <>
          {muted ? <StatusBadge icon={SpeakerOffIcon} value="Muted" /> : null}
          {muteShortcut ? <ShortcutKeys accelerator={muteShortcut} platform={platform} /> : null}
          <ShortcutTooltip
            accelerator={muteShortcut}
            label={muted ? 'Unmute microphone' : 'Mute microphone'}
            platform={platform}
          >
            <MuteToggle
              aria-label="Mute microphone"
              className="rounded-chip"
              data-videorc-studio-mic-mute=""
              pressed={muted}
              size="icon"
              onPressedChange={onMutedChange}
            >
              {muted ? (
                <SpeakerOffIcon className="size-4" weight="duotone" />
              ) : (
                <SpeakerOnIcon className="size-4" weight="duotone" />
              )}
            </MuteToggle>
          </ShortcutTooltip>
        </>
      }
      title="Microphone"
    >
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
      <div
        className={cn('flex items-center', muted && 'opacity-50')}
        data-muted={muted ? '' : undefined}
        data-videorc-mic-level=""
      >
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
