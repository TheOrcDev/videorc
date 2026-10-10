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
import { GroupedList } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { SourceSelect } from '@/components/source-select'
import { SourceControlRow, SourceFacts, SourceItem } from '@/components/sources/source-item'
import { MicLevelMeter } from '@/components/studio/mic-level-meter'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MuteToggle } from '@/components/ui/channel-toggle'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Fader, FaderRange, FaderThumb, FaderTrack } from '@/components/ui/fader'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Mixer, MixerChannels } from '@/components/ui/mixer'
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
import { AudioConfigProvider } from '@/hooks/use-audio-config'
import { useStudioCore } from '@/hooks/use-studio'
import {
  backendLevelSources,
  useBackendAudioLevelsLive,
  useMicrophoneMeter
} from '@/hooks/use-studio-mic-sources'
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
import {
  meterHasNoReading,
  micLevelUnavailableCopy,
  systemAudioMeterInput,
  type MeterInput
} from '@/lib/mic-meter-input'
import type { MicStreamFailureReason } from '@/lib/mic-stream'
import type { AudioMixerMonitorLabel } from '@/lib/mic-visual-gate'
import {
  microphoneStatus,
  selectedDeviceStatus,
  systemAudioStatus,
  type SourceStatus
} from '@/lib/source-status'
import {
  systemAudioDevice,
  requestSystemAudioResume,
  systemAudioIssueCopy,
  systemAudioSwitchView,
  type SystemAudioSwitchView
} from '@/lib/system-audio'

// Plan 173: the Sources page's Audio column. Microphone and System audio are
// SourceItems (the shape every Sources row takes) inside one grouped list.
// The audiocn controls stay what plan 093 chose (Fader, MuteToggle,
// ParameterSlider, the level meter); Videorc styles the vendored parts from
// outside, never by editing them (docs/audiocn.md). The audiocn Mixer stays
// around the rows for its meter range and its Cmd+Up/Down move between rows.

/** Videorc's slider knob on audiocn's thumbs (they paint the translucent coat). */
const FADER_THUMB = 'bg-knob ring-knob-ring'
const PARAMETER_THUMB =
  '[&_[data-slot=parameter-slider-thumb]]:bg-knob [&_[data-slot=parameter-slider-thumb]]:ring-knob-ring'

/** The renderer stores whole numbers (`clampNumber`), so faders step whole dB. */
const MICROPHONE_GAIN_DETENTS = [0]
const SYSTEM_AUDIO_GAIN_DETENTS = [SYSTEM_AUDIO_GAIN_DB_DEFAULT, 0]

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

/**
 * The Microphone header's tag while Sync is not the default, so a setting
 * folded into More is never a surprise. Null at the default.
 */
export function syncOffsetTag(offsetMs: number, userSet: boolean): string | null {
  if (!userSet || offsetMs === 0) return null
  return `Sync ${offsetMs > 0 ? '+' : '−'}${Math.abs(offsetMs)} ms`
}

/**
 * A control's tooltip with its global shortcut, when one is bound
 * (keyboard-first, quietly). The trigger is a wrapper: Radix's TooltipTrigger
 * writes `data-state` onto its child, which would replace a Switch's
 * checked/unchecked, the hook its track styles use.
 */
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
      <TooltipTrigger asChild>
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
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

/**
 * One row of the audiocn Mixer's keyboard map: the Mixer moves focus between
 * `[data-slot=channel-strip]` elements on Cmd+Up/Down (plan 093's VoiceOver
 * checklist), so each SourceItem sits in one.
 */
function MixerRow({ children }: { children: ReactNode }): ReactElement {
  return <div data-slot="channel-strip">{children}</div>
}

/** The Sources "Audio" column: the Microphone, then System audio. */
export function SourcesAudioMixer(): ReactElement {
  const {
    deviceList,
    captureConfig,
    setCaptureConfig,
    selectedMicrophone,
    isSessionActive,
    sourceDeviceSwitchPending,
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
  const backendLevelsLive = useBackendAudioLevelsLive()
  // Calibrate's last message; a Sync reset replaces it, as the old Reset did.
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const microphones = microphonePickerDevices(deviceList.devices)
  const audio = captureConfig.audio
  const platform = runtimeInfo?.platform
  const microphoneId = captureConfig.sources.microphoneId
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
      title="Audio"
    >
      {/* No MixerTitle: the section's own heading names it, and a second one
          would announce it twice. */}
      <Mixer aria-labelledby={undefined} className="gap-0" maxDb={0} minDb={-60}>
        <MixerChannels className="gap-0" scrollable={false}>
          <GroupedList>
            <MixerRow>
              <MicrophoneChannel
                calibration={
                  import.meta.env.DEV ? (
                    <SyncCalibration
                      audio={audio}
                      message={syncMessage}
                      setAudio={setAudio}
                      setMessage={setSyncMessage}
                    />
                  ) : null
                }
                gainDb={audio.microphoneGainDb}
                meter={microphone.meter}
                microphoneSelected={Boolean(selectedMicrophone)}
                monitorLabel={microphone.monitorLabel}
                muteShortcut={acceleratorDisplayKeys(settings.globalShortcuts?.micToggle, platform)}
                muted={audio.microphoneMuted}
                picker={
                  <SourceSelect
                    allowNone
                    description={<SourceSwitchStatus kind="microphone" />}
                    devices={microphones}
                    disabled={Boolean(sourceSwitchReason('microphone'))}
                    discoveryPending={wsStatus !== 'connected'}
                    label="Microphone"
                    labelHidden
                    selectedName={captureConfig.sources.microphoneName}
                    value={microphoneId}
                    onChange={(nextId) =>
                      void switchSourceDeviceLive(
                        'microphone',
                        buildMicrophoneSources(captureConfig.sources, microphones, nextId)
                      )
                    }
                  />
                }
                sessionActive={isSessionActive}
                status={microphoneStatus({
                  selected: Boolean(microphoneId),
                  switching: sourceDeviceSwitchPending === 'microphone',
                  device: selectedDeviceStatus(deviceList.devices, microphoneId),
                  muted: audio.microphoneMuted,
                  sessionActive: isSessionActive
                })}
                syncOffsetMs={audio.microphoneSyncOffsetMs}
                syncUserSet={audio.microphoneSyncOffsetUserSet === true}
                unavailableReason={microphone.unavailableReason}
                onGainChange={(microphoneGainDb) =>
                  setAudio((current) => ({ ...current, microphoneGainDb }))
                }
                onMutedChange={(microphoneMuted) =>
                  setAudio((current) => ({ ...current, microphoneMuted }))
                }
                onSyncChange={(offsetMs, reason) => {
                  setAudio((current) => applySyncChange(current, offsetMs, reason))
                  if (reason === 'reset')
                    setSyncMessage('Reset microphone sync to structural default.')
                }}
              />
            </MixerRow>
            {systemAudio.visible ? (
              <MixerRow>
                <SystemAudioSettings
                  echoGuard={audio.systemAudioEchoGuard !== false}
                  gainDb={audio.systemAudioGainDb}
                  macOS={platform === 'darwin'}
                  meter={systemAudioMeterInput({
                    sessionActive: isSessionActive,
                    mixed: systemAudio.meter,
                    backendLevelsLive,
                    source: backendLevelSources.systemAudio
                  })}
                  sessionActive={isSessionActive}
                  toggleShortcut={acceleratorDisplayKeys(
                    settings.globalShortcuts?.systemAudioToggle,
                    platform
                  )}
                  view={systemAudio}
                  onEchoGuardChange={(systemAudioEchoGuard) =>
                    setAudio((current) => ({ ...current, systemAudioEchoGuard }))
                  }
                  onEnabledChange={(systemAudioEnabled) =>
                    setAudio((current) => ({ ...current, systemAudioEnabled }))
                  }
                  onGainChange={(systemAudioGainDb) =>
                    setAudio((current) => ({ ...current, systemAudioGainDb }))
                  }
                  onOpenPermissions={() => openSettings('permissions')}
                  onResume={requestSystemAudioResume}
                />
              </MixerRow>
            ) : null}
          </GroupedList>
        </MixerChannels>
      </Mixer>
    </PanelSection>
  )
}

/**
 * The Microphone row: Mute in the header; the picker, its level and Gain in
 * the body; Sync (and, in development builds, Calibrate) folded into More.
 * Markup from props, so the tests render it.
 */
export function MicrophoneChannel({
  picker,
  microphoneSelected,
  status,
  meter,
  monitorLabel,
  unavailableReason,
  gainDb,
  muted,
  muteShortcut,
  syncOffsetMs,
  syncUserSet,
  sessionActive,
  calibration,
  defaultMoreOpen,
  onGainChange,
  onMutedChange,
  onSyncChange
}: {
  /** The microphone picker (the page passes `SourceSelect`). */
  picker?: ReactNode
  microphoneSelected: boolean
  status: SourceStatus | null
  meter: MeterInput
  monitorLabel: AudioMixerMonitorLabel
  unavailableReason: MicStreamFailureReason | undefined
  gainDb: number
  muted: boolean
  /** Key chips of the bound global mute shortcut; empty when none is bound. */
  muteShortcut: readonly string[]
  syncOffsetMs: number
  syncUserSet: boolean
  sessionActive: boolean
  /** Calibrate, in development builds only (plan 173, D3); null otherwise. */
  calibration: ReactNode
  defaultMoreOpen?: boolean
  onGainChange: (gainDb: number) => void
  onMutedChange: (muted: boolean) => void
  onSyncChange: (offsetMs: number, reason: ParameterChangeReason) => void
}): ReactElement {
  const tag = syncOffsetTag(syncOffsetMs, syncUserSet)
  return (
    <AudioConfigProvider value={{ dimmed: muted || !microphoneSelected }}>
      <SourceItem
        control={
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
        }
        data-muted={muted ? '' : undefined}
        data-videorc-mic-channel=""
        data-videorc-mic-monitor-state={microphoneSelected ? monitorLabel.toLowerCase() : 'none'}
        defaultMoreOpen={defaultMoreOpen}
        icon={MicrophoneIcon}
        id="microphone"
        more={
          <>
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
              <ParameterSliderDescription>
                Delays your voice to line up with the video.
                {sessionActive ? ' Applies from the next recording or stream.' : null}
              </ParameterSliderDescription>
            </ParameterSlider>
            {calibration}
          </>
        }
        moreLabel="More microphone settings"
        status={status}
        tag={tag ? <Badge variant="outline">{tag}</Badge> : undefined}
        title="Microphone"
      >
        {picker}
        {microphoneSelected ? null : <SourceFacts>No microphone selected.</SourceFacts>}
        {/* data-videorc-mic-preview: perf-idle-probe opens Sources on it. */}
        <div className="flex min-w-0" data-videorc-mic-preview="">
          <MicLevelMeter
            aria-label="Microphone level"
            className="min-w-0 flex-1"
            meter={meter}
            orientation="horizontal"
            variant="segmented"
          />
        </div>
        <SourceControlRow label="Gain" value={formatDb(gainDb)}>
          <Fader
            aria-label="Microphone gain"
            className="w-full"
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
        </SourceControlRow>
        {unavailableReason ? (
          <p
            className="text-xs text-muted-foreground"
            data-videorc-mic-level-reason={unavailableReason}
          >
            {micLevelUnavailableCopy(unavailableReason)}
          </p>
        ) : null}
      </SourceItem>
    </AudioConfigProvider>
  )
}

/** The flash/click measurement tools for Sync, folded away (plan 093, D3). */
function SyncCalibration({
  audio,
  setAudio,
  message,
  setMessage
}: {
  audio: AudioSettings
  setAudio: (update: (current: AudioSettings) => AudioSettings) => void
  message: string | null
  setMessage: (message: string | null) => void
}): ReactElement {
  const [recommendation, setRecommendation] = useState<AudioSyncRecommendationReport | null>(null)
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

/**
 * The System audio row (plan 069): the On switch in the header; one line on
 * what it captures; while On, its level and the Level fader; then any issue.
 * The echo guard (plan 076) and the three facts people need sit in More.
 */
export function SystemAudioSettings({
  view,
  gainDb,
  macOS,
  echoGuard,
  meter,
  sessionActive,
  toggleShortcut,
  defaultMoreOpen,
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
  /** The bus level while a session mixes System audio; no reading otherwise. */
  meter: MeterInput
  sessionActive: boolean
  /** Key chips of the bound global System audio shortcut; empty when none is bound. */
  toggleShortcut: readonly string[]
  defaultMoreOpen?: boolean
  onEnabledChange: (enabled: boolean) => void
  onGainChange: (gainDb: number) => void
  onEchoGuardChange: (enabled: boolean) => void
  onOpenPermissions: () => void
  onResume: () => void
}): ReactElement {
  const issueCopy = view.permissionRequired
    ? 'Needs Screen Recording permission'
    : view.issue === 'unavailable' && macOS
      ? systemAudioIssueCopy('unavailable')
      : view.issue
        ? systemAudioIssueCopy(view.issue)
        : null
  const issueAction =
    view.permissionRequired || (view.issue === 'unavailable' && macOS) ? (
      <Button className="shrink-0" size="xs" variant="ghost" onClick={onOpenPermissions}>
        Open Settings
      </Button>
    ) : view.issue === 'echo' ? (
      <Button className="shrink-0" size="xs" variant="ghost" onClick={onResume}>
        Resume
      </Button>
    ) : null

  return (
    <AudioConfigProvider value={{ disabled: view.permissionRequired }}>
      <SourceItem
        control={
          <ShortcutTooltip keys={toggleShortcut} label="System audio">
            <Switch
              aria-label="System audio"
              checked={view.checked}
              disabled={view.disabled}
              size="sm"
              onCheckedChange={onEnabledChange}
            />
          </ShortcutTooltip>
        }
        data-videorc-system-audio-settings=""
        defaultMoreOpen={defaultMoreOpen}
        disabled={view.permissionRequired}
        icon={DesktopIcon}
        id="system-audio"
        more={
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 flex-col">
                <span className="text-xs font-medium text-foreground">
                  Pause if your stream echoes back
                </span>
                <span className="text-xs text-muted-foreground">
                  Stops System audio when your own stream plays on this computer.
                </span>
              </span>
              <Switch
                aria-label="Pause System audio if your stream echoes back"
                checked={echoGuard}
                disabled={view.permissionRequired}
                size="sm"
                onCheckedChange={onEchoGuardChange}
              />
            </div>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-muted-foreground">
              <li>
                Your own stream open in a browser tab is captured too. Mute that tab: headphones
                don&apos;t stop it.
              </li>
              <li>Use headphones so your mic doesn&apos;t pick up your speakers.</li>
              {macOS ? (
                <li>Your Mac&apos;s volume and mute don&apos;t change what&apos;s recorded.</li>
              ) : null}
            </ul>
          </>
        }
        moreLabel="More System audio settings"
        status={systemAudioStatus(view, sessionActive)}
        title="System audio"
      >
        <SourceFacts>
          {macOS
            ? 'Everything your Mac plays, except Videorc.'
            : 'Everything your computer plays, except Videorc.'}
        </SourceFacts>
        {view.checked ? (
          <>
            {meterHasNoReading(meter) ? (
              // Plan 173: no dead meter. The level only exists while a session
              // mixes System audio, so outside one the row says when it moves.
              <p className="text-xs text-subtle" data-videorc-system-audio-idle="">
                Level shows while recording or live.
              </p>
            ) : (
              <div className="flex min-w-0" data-videorc-system-audio-visualizer="">
                <MicLevelMeter
                  aria-label="System audio level"
                  className="min-w-0 flex-1"
                  meter={meter}
                  orientation="horizontal"
                  variant="segmented"
                />
              </div>
            )}
            <SourceControlRow label="Level" value={formatDb(gainDb)}>
              <Fader
                aria-label="System audio gain"
                className="w-full"
                detents={SYSTEM_AUDIO_GAIN_DETENTS}
                disabled={view.permissionRequired}
                fineStep={1}
                largeStep={6}
                max={SYSTEM_AUDIO_GAIN_DB_MAX}
                min={SYSTEM_AUDIO_GAIN_DB_MIN}
                resetValue={SYSTEM_AUDIO_GAIN_DB_DEFAULT}
                step={1}
                value={gainDb}
                onValueChange={onGainChange}
              >
                <FaderTrack>
                  <FaderRange />
                  <FaderThumb className={FADER_THUMB} />
                </FaderTrack>
              </Fader>
            </SourceControlRow>
          </>
        ) : null}
        {issueCopy ? (
          <div className="flex items-start justify-between gap-2">
            <SourceFacts tone="warning">{issueCopy}</SourceFacts>
            {issueAction}
          </div>
        ) : null}
      </SourceItem>
    </AudioConfigProvider>
  )
}
