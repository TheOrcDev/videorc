import { DesktopIcon, MicrophoneIcon, SpeakerOffIcon, SpeakerOnIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { MicrophoneGainFader, SystemAudioGainFader } from '@/components/audio/gain-faders'
import { DevicePicker } from '@/components/device-picker'
import { GroupedList } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { SourceItem } from '@/components/sources/source-item'
import { StatusBadge } from '@/components/status-badge'
import { MicLevelMeter } from '@/components/studio/mic-level-meter'
import { RetroMicrophoneSectionView } from '@/components/studio/retro-lcd-studio'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { MuteToggle } from '@/components/ui/channel-toggle'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Mixer, MixerChannels } from '@/components/ui/mixer'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { Switch } from '@/components/ui/switch'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioCore, useStudioReplay } from '@/hooks/use-studio'
import {
  backendLevelSources,
  useBackendAudioLevelsLive,
  useMicrophoneMeter
} from '@/hooks/use-studio-mic-sources'
import type { AudioSettings, Device } from '@/lib/backend'
import { buildMicrophoneSources, microphonePickerDevices } from '@/lib/capture'
import { systemAudioMeterInput, type MeterInput } from '@/lib/mic-meter-input'
import { systemAudioStatus } from '@/lib/source-status'
import { micSignalLabel, type MicMonitorState } from '@/lib/state-labels'
import {
  SYSTEM_AUDIO_IDLE_LINE,
  requestSystemAudioResume,
  systemAudioDevice,
  systemAudioIdleReason,
  systemAudioIssueCopy,
  systemAudioSwitchView,
  type SystemAudioSwitchView
} from '@/lib/system-audio'
import { cn } from '@/lib/utils'

/** Why the System audio switch and Gain are off on macOS without the grant. */
const SYSTEM_AUDIO_PERMISSION_REASON = 'System audio needs Screen Recording permission.'

/**
 * The Studio's Audio section (plan 201, D1): the Microphone and System audio
 * side by side on one scale, each with its Gain fader under its meter, so a
 * streamer can set their voice over game or music audio without opening
 * Sources. It was the Microphone section (plan 092, owner call 2026-10-02):
 * the picker, its live level and since plan 174 D16 the mute and its hotkey.
 * Both rows edit the same captureConfig as Sources, through the same faders.
 *
 * The microphone level runs whenever Studio is open: the backend sends the
 * warm microphone's level between sessions and the bus's during one, and the
 * renderer analyser fills in where the backend has no standby source. System
 * audio has no standby capture (D3): its level reads while a recording, a
 * livestream or Clips runs the bus.
 */
export function AudioSection(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    deviceList,
    selectedMicrophone,
    switchSourceDeviceLive,
    sourceSwitchReason,
    settings,
    runtimeInfo,
    wsStatus,
    isSessionActive,
    audioBusActive,
    systemAudioConfirmed,
    systemAudioIssue
  } = useStudioCore()
  const { openSettings } = useWorkspaceNav()
  const { meter, monitorState } = useMicrophoneMeter()
  const backendLevelsLive = useBackendAudioLevelsLive()
  const microphones = microphonePickerDevices(deviceList.devices)
  const audio = captureConfig.audio
  const platform = runtimeInfo?.platform
  // Settings → General → Retro LCD (plan 197): the same section on a screen.
  const retro = settings.retroLcdStudio === true
  // The same writes the Sources mixer and the hotkeys make: the session
  // applies them live (use-studio's live audio processing sync).
  const setAudio = (update: (current: AudioSettings) => AudioSettings): void =>
    setCaptureConfig((current) => ({ ...current, audio: update(current.audio) }))
  const systemAudio = systemAudioSwitchView({
    device: systemAudioDevice(deviceList),
    requested: audio.systemAudioEnabled,
    sessionActive: isSessionActive,
    audioBusActive,
    confirmed: systemAudioConfirmed,
    issue: systemAudioIssue
  })

  const microphone: MicrophoneRowProps = {
    devices: microphones,
    disabled: Boolean(sourceSwitchReason('microphone')),
    discoveryPending: wsStatus !== 'connected',
    gainDb: audio.microphoneGainDb,
    meter,
    monitorState,
    muteShortcut: settings.globalShortcuts?.micToggle,
    muted: audio.microphoneMuted,
    platform,
    selectedDevice: selectedMicrophone,
    selectedName: captureConfig.sources.microphoneName,
    switchStatus: <SourceSwitchStatus kind="microphone" look={retro ? 'lcd' : 'default'} />,
    value: captureConfig.sources.microphoneId,
    onChange: (microphoneId) =>
      void switchSourceDeviceLive(
        'microphone',
        buildMicrophoneSources(captureConfig.sources, microphones, microphoneId)
      ),
    onGainChange: (microphoneGainDb) => setAudio((current) => ({ ...current, microphoneGainDb })),
    onMutedChange: (microphoneMuted) => setAudio((current) => ({ ...current, microphoneMuted }))
  }

  // Retro LCD keeps its Microphone screen, and System audio its row on the
  // Sources screen, until plan 201 S3 draws this section there.
  if (retro) return <RetroMicrophoneSectionView {...microphone} />

  return (
    <AudioSectionView
      microphone={microphone}
      systemAudio={
        systemAudio.visible
          ? {
              view: systemAudio,
              gainDb: audio.systemAudioGainDb,
              meter: systemAudioMeterInput({
                audioBusActive,
                mixed: systemAudio.meter,
                backendLevelsLive,
                source: backendLevelSources.systemAudio
              }),
              idleLine: (
                <SystemAudioClipsLine
                  audioBusActive={audioBusActive}
                  checked={systemAudio.checked}
                />
              ),
              sessionActive: isSessionActive,
              platform,
              toggleShortcut: settings.globalShortcuts?.systemAudioToggle,
              onEnabledChange: (systemAudioEnabled) =>
                setAudio((current) => ({ ...current, systemAudioEnabled })),
              onGainChange: (systemAudioGainDb) =>
                setAudio((current) => ({ ...current, systemAudioGainDb })),
              onOpenPermissions: () => openSettings('permissions'),
              onResume: requestSystemAudioResume
            }
          : null
      }
    />
  )
}

/**
 * D6's line under a resting System audio meter, only while Clips is off or
 * gave up. A leaf on the Clips context: the ring ticks once a second, and
 * only this re-renders.
 */
function SystemAudioClipsLine({
  audioBusActive,
  checked
}: {
  audioBusActive: boolean
  checked: boolean
}): ReactElement | null {
  const clips = useStudioReplay()
  return (
    <SystemAudioIdleLine
      reason={systemAudioIdleReason({
        audioBusActive,
        checked,
        clipsArmed: clips.armed,
        clipsState: clips.state.state
      })}
    />
  )
}

/**
 * The line itself. Nothing while Clips starts or restarts: the meter rests
 * for a moment and comes back, so nothing jumps.
 */
export function SystemAudioIdleLine({
  reason
}: {
  reason: 'clips-off' | null
}): ReactElement | null {
  if (reason !== 'clips-off') return null
  return (
    <p className="text-xs text-muted-foreground" data-videorc-studio-system-audio-idle="">
      {SYSTEM_AUDIO_IDLE_LINE}
    </p>
  )
}

/**
 * One row of the audiocn Mixer's keyboard map: Cmd/Ctrl+Up/Down moves focus
 * between `[data-slot=channel-strip]` elements, as on Sources.
 */
function MixerRow({ children }: { children: ReactNode }): ReactElement {
  return <div data-slot="channel-strip">{children}</div>
}

/** The section's markup from props (the tests render it). */
export function AudioSectionView({
  microphone,
  systemAudio
}: {
  microphone: MicrophoneRowProps
  /** Null where System audio can't run (Linux, older Windows): Microphone only. */
  systemAudio: SystemAudioRowProps | null
}): ReactElement {
  return (
    <PanelSection title="Audio">
      {/* One Mixer with Sources' range, so equal heights mean equal loudness.
          No MixerTitle: the section's heading names it. */}
      <Mixer aria-labelledby={undefined} className="gap-0" maxDb={0} minDb={-60}>
        <MixerChannels className="gap-0" scrollable={false}>
          <GroupedList>
            <MixerRow>
              <MicrophoneRow {...microphone} />
            </MixerRow>
            {systemAudio ? (
              <MixerRow>
                <SystemAudioRow {...systemAudio} />
              </MixerRow>
            ) : null}
          </GroupedList>
        </MixerChannels>
      </Mixer>
    </PanelSection>
  )
}

export type MicrophoneRowProps = {
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
  muted: boolean
  /** The bound global mute shortcut (an accelerator); absent when none is bound. */
  muteShortcut?: string
  platform?: string
  gainDb: number
  onChange: (microphoneId: string | undefined) => void
  onMutedChange: (muted: boolean) => void
  onGainChange: (gainDb: number) => void
}

/** The Microphone row: the mute in its header, then the picker, the level and Gain. */
function MicrophoneRow({
  devices,
  value,
  selectedName,
  selectedDevice,
  switchStatus,
  disabled,
  discoveryPending,
  meter,
  monitorState,
  muted,
  muteShortcut,
  platform,
  gainDb,
  onChange,
  onMutedChange,
  onGainChange
}: MicrophoneRowProps): ReactElement {
  return (
    <SourceItem
      control={
        // D16: the mute, with its hotkey when one is bound, and a muted
        // microphone says so in words: flat bars alone read as a dead
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
      icon={MicrophoneIcon}
      id="studio-microphone"
      title="Microphone"
    >
      {/* The row title names the picker; its label stays for screen readers
          and the perf probe. */}
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
      {/* Exactly the picker's width: the meter alone. It still names its
          level in dB to screen readers (aria-valuetext). */}
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
        />
        {/* Receiving / Muted / No signal for screen readers, and its state for the perf probe, off screen. */}
        <span className="sr-only" data-videorc-mic-monitor-state={monitorState}>
          {micSignalLabel(monitorState)}
        </span>
      </div>
      <MicrophoneGainFader gainDb={gainDb} onGainChange={onGainChange} />
    </SourceItem>
  )
}

export type SystemAudioRowProps = {
  view: SystemAudioSwitchView
  gainDb: number
  /** The bus level while a recording, livestream or Clips mixes it; no reading otherwise. */
  meter: MeterInput
  /** Under the meter: D6's line while Clips is off (`SystemAudioIdleLine`). */
  idleLine?: ReactNode
  sessionActive: boolean
  /** The bound global System audio shortcut (an accelerator); absent when none is bound. */
  toggleShortcut?: string
  platform?: string
  onEnabledChange: (enabled: boolean) => void
  onGainChange: (gainDb: number) => void
  onOpenPermissions: () => void
  /** Plan 076: turn System audio on again after the echo guard paused it. */
  onResume: () => void
}

/**
 * The System audio row (plan 069): its state and the On switch in the
 * header; while On, the level and Gain; then any issue with its one action.
 * The echo guard and the facts stay on Sources.
 */
function SystemAudioRow({
  view,
  gainDb,
  meter,
  idleLine,
  sessionActive,
  toggleShortcut,
  platform,
  onEnabledChange,
  onGainChange,
  onOpenPermissions,
  onResume
}: SystemAudioRowProps): ReactElement {
  // Sources' state words. Its permission hint points at the Sources page's
  // alert; here the row's own line says it, with the way to the fix.
  const status = systemAudioStatus(view, sessionActive)
  const issueCopy = view.permissionRequired
    ? SYSTEM_AUDIO_PERMISSION_REASON
    : view.issue
      ? systemAudioIssueCopy(view.issue, platform)
      : null
  const issueAction =
    view.permissionRequired || (view.issue === 'unavailable' && platform === 'darwin') ? (
      <Button className="-ml-2" size="xs" variant="ghost" onClick={onOpenPermissions}>
        Open Permissions
      </Button>
    ) : view.issue === 'echo' ? (
      <Button className="-ml-2" size="xs" variant="ghost" onClick={onResume}>
        Resume
      </Button>
    ) : null
  const toggle = (
    <Switch
      aria-label="System audio"
      checked={view.checked}
      disabled={view.disabled}
      size="sm"
      onCheckedChange={onEnabledChange}
    />
  )

  return (
    <SourceItem
      control={
        view.permissionRequired ? (
          <DisabledReason reason={SYSTEM_AUDIO_PERMISSION_REASON}>{toggle}</DisabledReason>
        ) : (
          <ShortcutTooltip accelerator={toggleShortcut} label="System audio" platform={platform}>
            {toggle}
          </ShortcutTooltip>
        )
      }
      data-videorc-studio-system-audio=""
      disabled={view.permissionRequired}
      icon={DesktopIcon}
      id="studio-system-audio"
      status={status ? { label: status.label, tone: status.tone } : null}
      title="System audio"
    >
      {view.checked ? (
        <>
          {/* The meter rests with no reading and comes back with the bus. */}
          <div className="flex min-w-0" data-videorc-studio-system-audio-level="">
            <MicLevelMeter
              aria-label="System audio level"
              className="min-w-0 flex-1"
              meter={meter}
            />
          </div>
          {idleLine}
        </>
      ) : null}
      {view.checked || view.permissionRequired ? (
        <SystemAudioGainFader
          disabled={view.permissionRequired}
          gainDb={gainDb}
          onGainChange={onGainChange}
        />
      ) : null}
      {issueCopy ? (
        <Alert
          data-videorc-studio-system-audio-issue={
            view.permissionRequired ? 'permission' : (view.issue ?? undefined)
          }
          variant="warning"
        >
          <AlertTitle>{issueCopy}</AlertTitle>
          {issueAction ? <AlertDescription className="pt-1">{issueAction}</AlertDescription> : null}
        </Alert>
      ) : null}
    </SourceItem>
  )
}
