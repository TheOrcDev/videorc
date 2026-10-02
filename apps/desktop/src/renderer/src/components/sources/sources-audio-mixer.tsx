import {
  CheckIcon,
  ChevronRightIcon,
  DesktopIcon,
  MicrophoneIcon,
  SpeakerOffIcon,
  SpeakerOnIcon,
  UploadIcon,
  WaveformIcon
} from '@/components/icons'
import { useRef, useState, type ReactElement, type ReactNode } from 'react'

import { acceleratorDisplayKeys } from '../../../../shared/accelerator'
import { PanelSection } from '@/components/panel-section'
import { PowerSlider } from '@/components/power-slider'
import { SourceSelect } from '@/components/source-select'
import { MicLevelMeter } from '@/components/studio/mic-level-meter'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  ChannelStrip,
  ChannelStripControls,
  ChannelStripDescription,
  ChannelStripFader,
  ChannelStripHeader,
  ChannelStripMeter,
  ChannelStripText,
  ChannelStripTitle,
  ChannelStripValue
} from '@/components/ui/channel-strip'
import { MuteToggle } from '@/components/ui/channel-toggle'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Fader, FaderRange, FaderThumb, FaderTrack } from '@/components/ui/fader'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Mixer, MixerChannels, MixerTitle } from '@/components/ui/mixer'
import {
  ParameterSlider,
  ParameterSliderControl,
  ParameterSliderDescription,
  ParameterSliderHeader,
  ParameterSliderInput,
  ParameterSliderLabel,
  ParameterSliderReset,
  type ParameterChangeReason
} from '@/components/ui/parameter-slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioCore } from '@/hooks/use-studio'
import { useMicrophoneMeter } from '@/hooks/use-studio-mic-sources'
import { formatDb } from '@/lib/audio/decibels'
import {
  SYSTEM_AUDIO_GAIN_DB_DEFAULT,
  SYSTEM_AUDIO_GAIN_DB_MAX,
  SYSTEM_AUDIO_GAIN_DB_MIN,
  type AudioSettings
} from '@/lib/backend'
import {
  MICROPHONE_SYNC_OFFSET_MAX_MS,
  MICROPHONE_SYNC_OFFSET_MIN_MS,
  applyAudioSyncRecommendation,
  audioSyncCalibrationState,
  buildMicrophoneSources,
  microphonePickerDevices,
  normalizeMicrophoneSyncOffsetMs,
  parseAudioSyncRecommendationJson,
  resetAudioSyncCalibration,
  type AudioSyncRecommendationReport
} from '@/lib/capture'
import { micLevelUnavailableCopy, type MeterInput } from '@/lib/mic-meter-input'
import type { MicStreamFailureReason } from '@/lib/mic-stream'
import type { AudioMixerMonitorLabel } from '@/lib/mic-visual-gate'
import {
  systemAudioDevice,
  requestSystemAudioResume,
  systemAudioIssueCopy,
  systemAudioSwitchView,
  type SystemAudioSwitchView
} from '@/lib/system-audio'

// Plan 093: the Sources Audio mixer, one audiocn channel strip per source. The
// strips are flush rows split by hairlines (design v2: lists, not card
// stacks); Videorc styles the vendored parts from outside, never by editing
// them (docs/audiocn.md).

/** Videorc's slider knob on audiocn's thumbs (they paint the translucent coat). */
const FADER_THUMB = 'bg-knob ring-knob-ring'
const PARAMETER_THUMB =
  '[&_[data-slot=parameter-slider-thumb]]:bg-knob [&_[data-slot=parameter-slider-thumb]]:ring-knob-ring'

/** The renderer stores whole numbers (`clampNumber`), so faders step whole dB. */
const MICROPHONE_GAIN_DETENTS = [0]

/**
 * A Sync change from the parameter slider. A reset restores the structural
 * default and clears the user-set flag, exactly as the old Reset button did;
 * anything else is a manual trim.
 */
export function applySyncChange(
  audio: AudioSettings,
  offsetMs: number,
  reason: ParameterChangeReason
): AudioSettings {
  return reason === 'reset'
    ? resetAudioSyncCalibration(audio)
    : {
        ...audio,
        microphoneSyncOffsetMs: normalizeMicrophoneSyncOffsetMs(offsetMs),
        microphoneSyncOffsetUserSet: true
      }
}

/** A control's tooltip with its global shortcut, when one is bound (keyboard-first, quietly). */
function ShortcutTooltip({
  label,
  keys,
  children
}: {
  label: string
  keys: readonly string[]
  children: ReactElement
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>
        {label}
        {keys.length > 0 ? (
          <KbdGroup>
            {keys.map((glyph, index) => (
              <Kbd key={`${glyph}-${index}`}>{glyph}</Kbd>
            ))}
          </KbdGroup>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}

/** The Sources "Audio mixer" panel: the microphone picker, then one strip per source. */
export function SourcesAudioMixer(): ReactElement {
  const {
    deviceList,
    captureConfig,
    setCaptureConfig,
    selectedMicrophone,
    isSessionActive,
    sourceSwitchReason,
    switchSourceDeviceLive,
    settings,
    runtimeInfo,
    wsStatus,
    systemAudioConfirmed,
    systemAudioIssue
  } = useStudioCore()
  const { openSettings } = useWorkspaceNav()
  const microphone = useMicrophoneMeter()
  const microphones = microphonePickerDevices(deviceList.devices)
  const audio = captureConfig.audio
  const platform = runtimeInfo?.platform
  const setAudio = (update: (current: AudioSettings) => AudioSettings): void =>
    setCaptureConfig((current) => ({ ...current, audio: update(current.audio) }))
  const systemAudio = systemAudioSwitchView({
    device: systemAudioDevice(deviceList),
    requested: audio.systemAudioEnabled,
    sessionActive: isSessionActive,
    confirmed: systemAudioConfirmed,
    issue: systemAudioIssue
  })

  return (
    <PanelSection
      description="What your recording and stream hear, after gain. Nothing is processed automatically."
      icon={WaveformIcon}
      title="Audio mixer"
    >
      <SourceSelect
        allowNone
        devices={microphones}
        disabled={Boolean(sourceSwitchReason('microphone'))}
        description={<SourceSwitchStatus kind="microphone" />}
        selectedName={captureConfig.sources.microphoneName}
        discoveryPending={wsStatus !== 'connected'}
        label="Microphone"
        value={captureConfig.sources.microphoneId}
        onChange={(microphoneId) =>
          void switchSourceDeviceLive(
            'microphone',
            buildMicrophoneSources(captureConfig.sources, microphones, microphoneId)
          )
        }
      />
      <Mixer maxDb={0} minDb={-60}>
        <MixerTitle className="sr-only">Audio mixer</MixerTitle>
        <MixerChannels className="gap-0 divide-y divide-border" scrollable={false}>
          <MicrophoneChannel
            calibration={<SyncCalibration audio={audio} setAudio={setAudio} />}
            gainDb={audio.microphoneGainDb}
            meter={microphone.meter}
            microphoneSelected={Boolean(selectedMicrophone)}
            monitorLabel={microphone.monitorLabel}
            muteShortcut={acceleratorDisplayKeys(settings.globalShortcuts?.micToggle, platform)}
            muted={audio.microphoneMuted}
            sessionActive={isSessionActive}
            syncOffsetMs={audio.microphoneSyncOffsetMs}
            unavailableReason={microphone.unavailableReason}
            onGainChange={(microphoneGainDb) =>
              setAudio((current) => ({ ...current, microphoneGainDb }))
            }
            onMutedChange={(microphoneMuted) =>
              setAudio((current) => ({ ...current, microphoneMuted }))
            }
            onSyncChange={(offsetMs, reason) =>
              setAudio((current) => applySyncChange(current, offsetMs, reason))
            }
          />
        </MixerChannels>
      </Mixer>
      {systemAudio.visible ? (
        <SystemAudioSettings
          gainDb={audio.systemAudioGainDb}
          macOS={platform === 'darwin'}
          view={systemAudio}
          onEnabledChange={(systemAudioEnabled) =>
            setAudio((current) => ({ ...current, systemAudioEnabled }))
          }
          onGainChange={(systemAudioGainDb) =>
            setAudio((current) => ({ ...current, systemAudioGainDb }))
          }
          echoGuard={audio.systemAudioEchoGuard !== false}
          onEchoGuardChange={(systemAudioEchoGuard) =>
            setAudio((current) => ({ ...current, systemAudioEchoGuard }))
          }
          onOpenPermissions={() => openSettings('permissions')}
          onResume={requestSystemAudioResume}
        />
      ) : null}
    </PanelSection>
  )
}

/**
 * The microphone's group: its channel strip (state, level, Gain, Mute), then
 * Sync and its calibration tools. Markup from props, so the tests render it.
 */
export function MicrophoneChannel({
  microphoneSelected,
  meter,
  monitorLabel,
  unavailableReason,
  gainDb,
  muted,
  muteShortcut,
  syncOffsetMs,
  sessionActive,
  calibration,
  onGainChange,
  onMutedChange,
  onSyncChange
}: {
  microphoneSelected: boolean
  meter: MeterInput
  monitorLabel: AudioMixerMonitorLabel
  unavailableReason: MicStreamFailureReason | undefined
  gainDb: number
  muted: boolean
  /** Key chips of the bound global mute shortcut; empty when none is bound. */
  muteShortcut: readonly string[]
  syncOffsetMs: number
  sessionActive: boolean
  calibration: ReactNode
  onGainChange: (gainDb: number) => void
  onMutedChange: (muted: boolean) => void
  onSyncChange: (offsetMs: number, reason: ParameterChangeReason) => void
}): ReactElement {
  return (
    <div className="flex flex-col gap-3 py-3" data-videorc-mic-channel="">
      <ChannelStrip className="p-0" dimmed={!microphoneSelected} muted={muted} variant="ghost">
        <ChannelStripHeader>
          <MicrophoneIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
          <ChannelStripText>
            <ChannelStripTitle>Microphone</ChannelStripTitle>
            <ChannelStripDescription
              data-videorc-mic-monitor-state={
                microphoneSelected ? monitorLabel.toLowerCase() : 'none'
              }
            >
              {microphoneSelected ? monitorLabel : 'No microphone'}
            </ChannelStripDescription>
          </ChannelStripText>
        </ChannelStripHeader>
        {/* data-videorc-mic-preview: perf-idle-probe opens Sources on it. */}
        <ChannelStripMeter data-videorc-mic-preview="">
          <MicLevelMeter
            aria-label="Microphone level"
            className="min-w-0 flex-1"
            meter={meter}
            orientation="horizontal"
            variant="segmented"
          />
        </ChannelStripMeter>
        <ChannelStripFader>
          <Fader
            aria-label="Microphone gain"
            detents={MICROPHONE_GAIN_DETENTS}
            fineStep={1}
            largeStep={6}
            max={24}
            min={-24}
            origin={0}
            resetValue={0}
            step={1}
            value={gainDb}
            onValueChange={onGainChange}
          >
            <FaderTrack>
              <FaderRange />
              <FaderThumb className={FADER_THUMB} />
            </FaderTrack>
          </Fader>
        </ChannelStripFader>
        <ChannelStripValue>{formatDb(gainDb)}</ChannelStripValue>
        <ChannelStripControls>
          <ShortcutTooltip keys={muteShortcut} label="Mute microphone">
            <MuteToggle
              aria-label="Mute microphone"
              className="rounded-chip"
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
        </ChannelStripControls>
      </ChannelStrip>
      {unavailableReason ? (
        <p
          className="text-xs text-muted-foreground"
          data-videorc-mic-level-reason={unavailableReason}
        >
          {micLevelUnavailableCopy(unavailableReason)}
        </p>
      ) : null}
      <ParameterSlider
        className={PARAMETER_THUMB}
        largeStep={5}
        max={MICROPHONE_SYNC_OFFSET_MAX_MS}
        min={MICROPHONE_SYNC_OFFSET_MIN_MS}
        origin={0}
        resetValue={0}
        step={1}
        unit="ms"
        value={syncOffsetMs}
        onValueChange={(offsetMs, details) => onSyncChange(offsetMs, details.reason)}
      >
        <ParameterSliderHeader>
          <ParameterSliderLabel>Sync</ParameterSliderLabel>
          <ParameterSliderReset />
          <ParameterSliderInput />
        </ParameterSliderHeader>
        <ParameterSliderControl />
        {/* The offset is split once at session start (recording.rs). */}
        {sessionActive ? (
          <ParameterSliderDescription>
            Applies from the next recording or stream.
          </ParameterSliderDescription>
        ) : null}
      </ParameterSlider>
      {calibration}
    </div>
  )
}

/** The flash/click measurement tools for Sync, folded away (plan 093, D3). */
function SyncCalibration({
  audio,
  setAudio
}: {
  audio: AudioSettings
  setAudio: (update: (current: AudioSettings) => AudioSettings) => void
}): ReactElement {
  const [recommendation, setRecommendation] = useState<AudioSyncRecommendationReport | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const state = audioSyncCalibrationState(recommendation, audio)

  return (
    <SyncCalibrationView
      developer={import.meta.env.DEV}
      detail={message ?? state.detail}
      canApply={state.canApply}
      measuredLagLabel={state.measuredLagLabel}
      status={state.status}
      onApply={() => {
        if (!recommendation) return
        setAudio((current) => applyAudioSyncRecommendation(current, recommendation))
        if (state.recommendedOffsetMs != null) {
          setMessage(`Applied ${state.recommendedOffsetMs} ms sync offset.`)
        }
      }}
      onImport={async (file) => {
        const parsed = parseAudioSyncRecommendationJson(await file.text())
        if (!parsed.ok) {
          setRecommendation(null)
          setMessage(parsed.error)
          return
        }
        const next = audioSyncCalibrationState(parsed.recommendation, audio)
        setRecommendation(parsed.recommendation)
        setMessage(`${next.measuredLagLabel}. ${next.detail}`)
      }}
    />
  )
}

/** Calibrate's markup from props (the tests render it open and closed). */
export function SyncCalibrationView({
  developer,
  defaultOpen = false,
  status,
  measuredLagLabel,
  detail,
  canApply,
  onImport,
  onApply
}: {
  /** Development builds also show the stimulus commands (a packaged app has no pnpm). */
  developer: boolean
  defaultOpen?: boolean
  status: ReturnType<typeof audioSyncCalibrationState>['status']
  measuredLagLabel: string
  detail: string
  canApply: boolean
  onImport: (file: File) => Promise<void>
  onApply: () => void
}): ReactElement {
  const [showStimulus, setShowStimulus] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  return (
    <Collapsible className="group/calibrate" defaultOpen={defaultOpen}>
      <CollapsibleTrigger asChild>
        <Button className="-ml-2 self-start" size="xs" type="button" variant="ghost">
          <ChevronRightIcon
            className="transition-transform duration-150 group-data-[state=open]/calibrate:rotate-90"
            data-icon="inline-start"
          />
          Calibrate
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2 pt-2" data-videorc-sync-calibration="">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge
            variant={
              status === 'recommended'
                ? 'warning'
                : status === 'unavailable'
                  ? 'outline'
                  : 'secondary'
            }
          >
            {measuredLagLabel}
          </Badge>
          <div className="flex flex-wrap items-center gap-2">
            {developer ? (
              <Button
                size="xs"
                type="button"
                variant="outline"
                onClick={() => setShowStimulus((open) => !open)}
              >
                <WaveformIcon data-icon="inline-start" />
                Stimulus
              </Button>
            ) : null}
            <Button
              size="xs"
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon data-icon="inline-start" />
              Import JSON
            </Button>
            <Button
              disabled={!canApply}
              size="xs"
              type="button"
              variant="secondary"
              onClick={onApply}
            >
              <CheckIcon data-icon="inline-start" />
              Apply
            </Button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          accept="application/json,.json"
          className="hidden"
          type="file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) void onImport(file)
          }}
        />
        <p className="text-xs text-muted-foreground">{detail}</p>
        {developer && showStimulus ? (
          <div className="grid gap-1 rounded-chip border border-border/70 p-2 font-mono text-[11px] leading-5 text-muted-foreground">
            <span>pnpm measure:av-sync --make-fixture /tmp/videorc-sync.mp4 --seconds 120</span>
            <span>pnpm measure:av-sync &lt;recording-or-evidence.json&gt; --json</span>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** System audio (plan 069): the switch, its level, and the one fact people need. */
export function SystemAudioSettings({
  view,
  gainDb,
  macOS,
  echoGuard,
  onEnabledChange,
  onGainChange,
  onEchoGuardChange,
  onOpenPermissions,
  onResume
}: {
  view: SystemAudioSwitchView
  gainDb: number
  macOS: boolean
  /** Plan 076: pause System audio when it carries the stream back. */
  echoGuard: boolean
  onEnabledChange: (enabled: boolean) => void
  onGainChange: (gainDb: number) => void
  onEchoGuardChange: (enabled: boolean) => void
  onOpenPermissions: () => void
  onResume: () => void
}): ReactElement {
  return (
    <div
      className="grid gap-2 rounded-row border border-border bg-foreground/[0.03] px-3 py-2"
      data-videorc-system-audio-settings
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <DesktopIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
          <span className="truncate">System audio</span>
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          {view.permissionRequired ? null : (
            <span className="text-xs text-muted-foreground">{view.stateLabel}</span>
          )}
          <Switch
            aria-label="System audio"
            checked={view.checked}
            disabled={view.disabled}
            size="sm"
            onCheckedChange={onEnabledChange}
          />
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Everything your computer plays, except Videorc, including your own stream if it is open in a
        browser tab: mute that tab, because headphones don't stop it. Use headphones so your mic
        doesn't pick up your speakers.
        {macOS ? " Your Mac's volume and mute don't change what's recorded." : null}
      </p>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-xs text-muted-foreground">
          Pause System audio if your stream echoes back
        </span>
        <Switch
          aria-label="Pause System audio if your stream echoes back"
          checked={echoGuard}
          disabled={view.permissionRequired}
          size="sm"
          onCheckedChange={onEchoGuardChange}
        />
      </div>
      <PowerSlider
        bipolar
        defaultValue={SYSTEM_AUDIO_GAIN_DB_DEFAULT}
        disabled={view.permissionRequired}
        label="Level"
        max={SYSTEM_AUDIO_GAIN_DB_MAX}
        min={SYSTEM_AUDIO_GAIN_DB_MIN}
        numericInput
        suffix=" dB"
        value={gainDb}
        onChange={onGainChange}
      />
      {view.permissionRequired || (view.issue === 'unavailable' && macOS) ? (
        <div className="flex items-center justify-between gap-2 text-xs text-warning">
          <span className="min-w-0">
            {view.permissionRequired
              ? 'Needs Screen Recording permission'
              : systemAudioIssueCopy('unavailable')}
          </span>
          <Button className="shrink-0" size="xs" variant="ghost" onClick={onOpenPermissions}>
            Open Settings
          </Button>
        </div>
      ) : view.issue === 'echo' ? (
        <div className="flex items-center justify-between gap-2 text-xs text-warning">
          <span className="min-w-0">{systemAudioIssueCopy('echo')}</span>
          <Button className="shrink-0" size="xs" variant="ghost" onClick={onResume}>
            Resume
          </Button>
        </div>
      ) : view.issue ? (
        <span className="text-xs text-warning">{systemAudioIssueCopy(view.issue)}</span>
      ) : null}
    </div>
  )
}
