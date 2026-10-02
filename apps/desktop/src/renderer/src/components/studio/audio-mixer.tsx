import {
  DesktopIcon,
  MicrophoneIcon,
  SpeakerOffIcon,
  SpeakerOnIcon,
  WaveformIcon
} from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { GroupedList } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { Button } from '@/components/ui/button'
import {
  ChannelStrip,
  ChannelStripActions,
  ChannelStripHeader,
  ChannelStripMeter,
  ChannelStripNotice,
  ChannelStripTitle,
  ChannelStripValue
} from '@/components/ui/channel-strip'
import { ClipIndicator } from '@/components/ui/clip-indicator'
import { DbReadout } from '@/components/ui/db-readout'
import { LevelMeter } from '@/components/ui/level-meter'
import { Mixer, MixerChannels } from '@/components/ui/mixer'
import { Switch } from '@/components/ui/switch'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioAudio, useStudioCore, useStudioDiagnostics } from '@/hooks/use-studio'
import {
  backendLevelSources,
  useBackendAudioLevelsLive,
  useStudioMicMeterSource
} from '@/hooks/use-studio-mic-sources'
import { useStudioMicVisualLifecycle } from '@/hooks/use-studio-mic-visual'
import { SILENCE_DB } from '@/lib/audio/decibels'
import type { FrameSource, MeterFrame } from '@/lib/audio/types'
import { CLIP_THRESHOLD_DB } from '@/lib/audio/zones'
import type { AudioMeterStatus, DiagnosticStats } from '@/lib/backend'
import { audioMixerMonitorLabel, type AudioMixerMonitorLabel } from '@/lib/mic-visual-gate'
import { systemAccessAction, systemAccessRows, type SystemAccessAction } from '@/lib/system-access'
import {
  systemAudioDevice,
  requestSystemAudioResume,
  systemAudioIssueCopy,
  systemAudioSwitchView,
  type SystemAudioSwitchView
} from '@/lib/system-audio'
import { cn } from '@/lib/utils'

/** A strip is one row of the mixer's grouped list, which draws the surface. */
const STRIP_CLASS = 'px-3 py-2'
/**
 * Every strip's value column is the same width (clip light, a clip count on
 * the Mix strip, and "−88.8 dB"), so the meters start and end at the same x.
 * The clip light sits at the meter's end and the readout at the right edge.
 */
const VALUE_CLASS = 'w-28 justify-between gap-1.5'
/** Stacked under its title (a narrow strip), the meter starts where the title does. */
const METER_CLASS = 'pl-6 @xl/channel-strip:pl-0'
/**
 * The footer line: text-only like Videorc's other notices (no tinted fill),
 * indented to the title past the 16 px icon and its 8 px gap.
 */
const NOTICE_CLASS =
  'justify-between gap-3 rounded-none bg-transparent p-0 pl-6 text-muted-foreground'

export type AudioMixerNotice = 'permission' | 'silent' | 'no-frames' | 'device-issue'

export function audioMixerNotice(
  permissionAction: SystemAccessAction,
  meterStatus: AudioMeterStatus | undefined,
  deviceIssue: boolean
): AudioMixerNotice | null {
  if (permissionAction) return 'permission'
  if (meterStatus === 'silent' || meterStatus === 'no-frames') return meterStatus
  return deviceIssue ? 'device-issue' : null
}

export function audioMixerSignalLive(
  muted: boolean,
  rendererActive: boolean,
  backendLiveLevel: number | null
): boolean {
  return !muted && (rendererActive || backendLiveLevel !== null)
}

/**
 * What drives a strip's meter, readout and clip light: a live source (the
 * backend's 20 Hz levels during a session, or the renderer analyser), or one
 * plain reading (the backend's 1 Hz level, a "Check level" sample, silence
 * while muted, or NaN when there is nothing to read yet).
 */
export type MeterInput =
  | Readonly<{ kind: 'source'; source: FrameSource<MeterFrame> }>
  | Readonly<{ kind: 'value'; peakDb: number }>

const NO_READING: MeterInput = Object.freeze({ kind: 'value', peakDb: Number.NaN })
const SILENCE: MeterInput = Object.freeze({ kind: 'value', peakDb: SILENCE_DB })

/**
 * The mic meter's input, in priority order. Every path reads the level the
 * recording gets: the backend measures it on the bus (plan 092 Phase C), the
 * analyser source adds the configured gain, and the 1 Hz backend values are
 * post-gain too.
 */
export function micMeterInput(input: {
  microphoneSelected: boolean
  muted: boolean
  /** The backend's 20 Hz bus level while a session runs. */
  backendSource: FrameSource<MeterFrame> | null
  analyserDriven: boolean
  source: FrameSource<MeterFrame>
  /** The running session's 1 Hz level. */
  backendPeakDb: number | null
  /** The last "Check level" sample. */
  sampledPeakDb: number | null
}): MeterInput {
  if (!input.microphoneSelected) return NO_READING
  if (input.muted) return SILENCE
  if (input.backendSource) return { kind: 'source', source: input.backendSource }
  if (input.analyserDriven) return { kind: 'source', source: input.source }
  if (input.backendPeakDb !== null) return { kind: 'value', peakDb: input.backendPeakDb }
  if (input.sampledPeakDb !== null) return { kind: 'value', peakDb: input.sampledPeakDb }
  return NO_READING
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Audio mixer (plan 092 on audiocn; history: SD4, post-0.9.4 F7, the
 * 2026-07-10 live meter, the ElevenLabs rework, live feedback B2, plan 069).
 * One audiocn channel strip per source, each with a level meter (peak, RMS,
 * peak hold, zones), a dB readout and a clip light. The renderer's visual mic
 * analyser drives the mic strip whenever the mixer is on screen, session or
 * not, because "is my microphone working?" is asked before recording; the
 * meter adds the configured gain, so it reads what the recording gets. The
 * backend stays the capture and health authority: its 1 Hz post-gain level,
 * or the on-demand "Check level" sample, drives the meter whenever the
 * analyser cannot open the device. During a session the backend's own bus
 * levels (plan 092 Phase C, about 20 a second) take over every strip, and a
 * Mix strip shows what the recording and the stream get. System audio has a
 * strip only where capture exists (a permanent "Unavailable" badge read as a
 * broken app, #375), with its level from the session while it is mixed.
 */
export function AudioMixer(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    selectedMicrophone,
    sampleAudioMeter,
    deviceList,
    handleSystemPermission,
    mediaAccess,
    runtimeInfo,
    isSessionActive,
    warmMicrophone
  } = useStudioCore()
  const { audioMeter, audioMeterLoading } = useStudioAudio()
  const { diagnosticStats } = useStudioDiagnostics()
  const { openStudioPanel, openSettings } = useWorkspaceNav()

  const muted = captureConfig.audio.microphoneMuted
  const micVisual = useStudioMicVisualLifecycle()
  // Levels from the bus itself: only while this session's bus is sending them.
  const backendLevelsLive = useBackendAudioLevelsLive() && isSessionActive
  const micMeterSource = useStudioMicMeterSource({
    gainDb: captureConfig.audio.microphoneGainDb,
    muted
  })

  const liveLevel =
    typeof diagnosticStats?.micLiveLevel === 'number' ? diagnosticStats.micLiveLevel : null
  const meterStatus = micVisual.active || liveLevel !== null ? 'ready' : audioMeter?.status
  const microphoneAccess = systemAccessRows({
    deviceList,
    audioMeter,
    platform: runtimeInfo?.platform,
    mediaAccess
  }).find((row) => row.id === 'microphone')
  const microphonePermissionAction = systemAccessAction({
    pane: 'microphone',
    state: microphoneAccess?.state,
    platform: runtimeInfo?.platform,
    mediaAccessStatus: mediaAccess?.microphone
  })
  const notice = audioMixerNotice(
    microphonePermissionAction,
    meterStatus,
    microphoneAccess?.state === 'device-issue'
  )
  const signalLive = audioMixerSignalLive(muted, micVisual.active || backendLevelsLive, liveLevel)
  const meter = micMeterInput({
    microphoneSelected: Boolean(selectedMicrophone),
    muted,
    backendSource: backendLevelsLive ? backendLevelSources.microphone : null,
    analyserDriven: micVisual.active && !muted,
    source: micMeterSource,
    backendPeakDb: liveLevel === null ? null : finiteOrNull(diagnosticStats?.micLivePeakDb),
    sampledPeakDb: finiteOrNull(audioMeter?.peakDb)
  })

  return (
    <PanelSection
      title="Audio mixer"
      action={
        <Button size="sm" variant="ghost" onClick={() => openStudioPanel('sources')}>
          Audio settings
        </Button>
      }
    >
      {/* PanelSection shows the visible title; the mixer only needs a name. */}
      <Mixer
        aria-label="Audio mixer"
        aria-labelledby={undefined}
        className="[--channel-strip-header-width:18rem]"
      >
        {/* One grouped list: the strips are like things, split by hairlines. */}
        <MixerChannels scrollable={false}>
          <GroupedList>
            <MicrophoneStripView
              checkLevel={
                !isSessionActive && !signalLive
                  ? {
                      disabled: !selectedMicrophone || audioMeterLoading,
                      loading: audioMeterLoading,
                      onCheck: () => void sampleAudioMeter()
                    }
                  : null
              }
              deviceDetail={microphoneAccess?.detail}
              deviceName={selectedMicrophone?.name}
              meter={meter}
              monitorLabel={audioMixerMonitorLabel({
                sessionActive: isSessionActive,
                signalLive,
                muted: muted && Boolean(selectedMicrophone)
              })}
              muted={muted}
              notice={notice}
              permissionLabel={
                microphonePermissionAction === 'request-media-access'
                  ? 'Enable microphone'
                  : 'Open settings'
              }
              signalLive={signalLive}
              warmReady={!isSessionActive && Boolean(warmMicrophone?.armed)}
              onPermission={() => void handleSystemPermission('microphone')}
              onToggleMute={
                selectedMicrophone
                  ? () =>
                      setCaptureConfig((current) => ({
                        ...current,
                        audio: { ...current.audio, microphoneMuted: !current.audio.microphoneMuted }
                      }))
                  : null
              }
            />
            <SystemAudioMixerRow
              backendSource={backendLevelsLive ? backendLevelSources.systemAudio : null}
              diagnosticStats={diagnosticStats}
              macOS={runtimeInfo?.platform === 'darwin'}
              onOpenPermissions={() => openSettings('permissions')}
            />
            {backendLevelsLive ? <MixStripView source={backendLevelSources.master} /> : null}
          </GroupedList>
        </MixerChannels>
      </Mixer>
    </PanelSection>
  )
}

/**
 * A strip's meter row: the meter, then the clip light and the readout, all
 * reading the same input so they can never disagree.
 */
function StripMeterRow({
  input,
  label,
  meterAttribute,
  clipAttribute,
  showClipCount = false
}: {
  input: MeterInput
  label: string
  meterAttribute: string
  clipAttribute?: string
  /** Count separate clips beside the light (the Mix strip). */
  showClipCount?: boolean
}): ReactElement {
  const live = input.kind === 'source'
  const meterData = { [meterAttribute]: '' }
  const clipData = clipAttribute ? { [clipAttribute]: '' } : {}
  return (
    <>
      <ChannelStripMeter className={METER_CLASS}>
        {live ? (
          <LevelMeter
            aria-label={label}
            ballistics="peak"
            source={input.source}
            variant="segmented"
            {...meterData}
          />
        ) : (
          // One reading a second at most: VU ballistics glide between them.
          <LevelMeter
            aria-label={label}
            ballistics="vu"
            peakDb={input.peakDb}
            variant="segmented"
            {...meterData}
          />
        )}
      </ChannelStripMeter>
      <ChannelStripValue className={VALUE_CLASS}>
        {live ? (
          <ClipIndicator showCount={showClipCount} source={input.source} {...clipData} />
        ) : (
          <ClipIndicator clipping={input.peakDb >= CLIP_THRESHOLD_DB} {...clipData} />
        )}
        {live ? <DbReadout source={input.source} /> : <DbReadout value={input.peakDb} />}
      </ChannelStripValue>
    </>
  )
}

/** A strip's footer line: what to know on the left, what to do on the right. */
function StripFooter({
  actions = null,
  children
}: {
  actions?: ReactNode
  children: ReactNode
}): ReactElement {
  return (
    <ChannelStripNotice className={NOTICE_CLASS}>
      <div className="flex min-w-0 flex-col gap-0.5">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </ChannelStripNotice>
  )
}

/** The microphone strip: props in, markup out (the mixer tests render it). */
export function MicrophoneStripView({
  deviceName,
  muted,
  monitorLabel,
  signalLive,
  meter,
  warmReady,
  checkLevel,
  notice,
  permissionLabel,
  deviceDetail,
  onPermission,
  onToggleMute
}: {
  deviceName: string | undefined
  muted: boolean
  monitorLabel: AudioMixerMonitorLabel
  signalLive: boolean
  meter: MeterInput
  /** The warm microphone is open, so Record starts instantly. */
  warmReady: boolean
  /** The backend's own reading, offered while nothing else reads the mic. */
  checkLevel: Readonly<{ disabled: boolean; loading: boolean; onCheck: () => void }> | null
  notice: AudioMixerNotice | null
  permissionLabel: string
  deviceDetail: string | undefined
  onPermission: () => void
  /** Null when no microphone is selected: there is nothing to mute. */
  onToggleMute: (() => void) | null
}): ReactElement {
  const footerText: ReactNode[] = []
  const footerActions: ReactNode[] = []
  if (warmReady) {
    footerText.push(
      <p
        key="warm"
        className="text-xs text-muted-foreground/70"
        data-videorc-mic-warm="ready"
        title="The microphone is open and ready, so Record starts instantly."
      >
        Mic ready for instant Record
      </p>
    )
  }
  if (notice === 'permission') {
    footerText.push(
      <span key="notice" className="text-xs text-warning">
        Microphone permission is required before levels can be read.
      </span>
    )
    footerActions.push(
      <Button key="permission" size="xs" variant="outline" onClick={onPermission}>
        {permissionLabel}
      </Button>
    )
  } else if (notice === 'silent' || notice === 'no-frames') {
    footerText.push(
      <span key="notice" className="text-xs text-warning">
        {notice === 'silent'
          ? 'The mic delivered only silence on the last check.'
          : 'The mic opened but did not send audio frames.'}
      </span>
    )
  } else if (notice === 'device-issue') {
    footerText.push(
      <span key="notice" className="text-xs text-warning">
        {deviceDetail}
      </span>
    )
  }
  if (checkLevel) {
    footerActions.push(
      <Button
        key="check"
        disabled={checkLevel.disabled}
        size="xs"
        variant="outline"
        onClick={checkLevel.onCheck}
      >
        {checkLevel.loading ? 'Checking…' : 'Check level'}
      </Button>
    )
  }

  return (
    <ChannelStrip
      className={STRIP_CLASS}
      data-videorc-mic-strip=""
      dimmed={!deviceName}
      muted={muted}
      variant="ghost"
    >
      <ChannelStripHeader>
        <MicrophoneIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        <ChannelStripTitle className="min-w-0 flex-1">
          {deviceName ?? 'No microphone'}
        </ChannelStripTitle>
        <ChannelStripActions className="gap-1.5">
          <span
            className={cn(
              'text-xs',
              signalLive ? 'text-muted-foreground' : 'text-muted-foreground/60'
            )}
            data-videorc-mic-monitor-state={monitorLabel.toLowerCase()}
          >
            {monitorLabel}
          </span>
          {onToggleMute ? (
            <Button
              aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
              aria-pressed={muted}
              className="size-7"
              size="icon"
              variant="ghost"
              onClick={onToggleMute}
            >
              {muted ? (
                <SpeakerOffIcon className="size-4 text-warning" weight="fill" />
              ) : (
                <SpeakerOnIcon className="size-4" weight="fill" />
              )}
            </Button>
          ) : null}
        </ChannelStripActions>
      </ChannelStripHeader>
      <StripMeterRow
        clipAttribute="data-videorc-mic-clip"
        input={meter}
        label="Microphone level"
        meterAttribute="data-videorc-mic-visualizer"
      />
      {footerText.length > 0 || footerActions.length > 0 ? (
        <StripFooter actions={footerActions.length > 0 ? footerActions : null}>
          {footerText}
        </StripFooter>
      ) : null}
    </ChannelStrip>
  )
}

/**
 * System audio (plan 069 S5): the switch shows what the session confirms, the
 * meter runs only while the session mixes it, and a health issue keeps the
 * switch where the user put it and says what happened, without a toast.
 */
function SystemAudioMixerRow({
  backendSource,
  diagnosticStats,
  macOS,
  onOpenPermissions
}: {
  /** The session's 20 Hz bus level (plan 092 Phase C), when it is sending. */
  backendSource: FrameSource<MeterFrame> | null
  diagnosticStats: DiagnosticStats | null | undefined
  macOS: boolean
  onOpenPermissions: () => void
}): ReactElement | null {
  const {
    captureConfig,
    setCaptureConfig,
    deviceList,
    isSessionActive,
    systemAudioConfirmed,
    systemAudioIssue
  } = useStudioCore()
  const view = systemAudioSwitchView({
    device: systemAudioDevice(deviceList),
    requested: captureConfig.audio.systemAudioEnabled,
    sessionActive: isSessionActive,
    confirmed: systemAudioConfirmed,
    issue: systemAudioIssue
  })
  if (!view.visible) return null

  return (
    <SystemAudioMixerRowView
      peakDb={view.meter ? finiteOrNull(diagnosticStats?.systemAudioLivePeakDb) : null}
      source={backendSource}
      macOS={macOS}
      view={view}
      onEnabledChange={(systemAudioEnabled) =>
        setCaptureConfig((current) => ({
          ...current,
          audio: { ...current.audio, systemAudioEnabled }
        }))
      }
      onOpenPermissions={onOpenPermissions}
      onResume={requestSystemAudioResume}
    />
  )
}

/** The System audio strip: props in, markup out (the state matrix test renders it). */
export function SystemAudioMixerRowView({
  view,
  peakDb,
  source = null,
  macOS,
  onEnabledChange,
  onOpenPermissions,
  onResume
}: {
  view: SystemAudioSwitchView
  /** The backend's post-gain System audio peak while the session mixes it (1 Hz). */
  peakDb: number | null
  /** The same level about 20 times a second, preferred while the bus sends it. */
  source?: FrameSource<MeterFrame> | null
  /** Settings > Permissions can only help on macOS (the Screen Recording grant). */
  macOS: boolean
  onEnabledChange: (enabled: boolean) => void
  onOpenPermissions: () => void
  /** Plan 076: turn System audio on again after the echo guard paused it. */
  onResume: () => void
}): ReactElement {
  const stateLabel = view.meter ? 'Live' : view.stateLabel
  const notice =
    view.permissionRequired || (view.issue === 'unavailable' && macOS) ? (
      <StripFooter
        actions={
          <Button size="xs" variant="ghost" onClick={onOpenPermissions}>
            Open Settings
          </Button>
        }
      >
        <span className="text-xs text-warning">
          {view.permissionRequired
            ? 'Needs Screen Recording permission'
            : systemAudioIssueCopy('unavailable')}
        </span>
      </StripFooter>
    ) : view.issue === 'echo' ? (
      <StripFooter
        actions={
          <Button size="xs" variant="ghost" onClick={onResume}>
            Resume
          </Button>
        }
      >
        <span className="text-xs text-warning">{systemAudioIssueCopy('echo')}</span>
      </StripFooter>
    ) : view.issue ? (
      <StripFooter>
        <span className="text-xs text-warning">{systemAudioIssueCopy(view.issue)}</span>
      </StripFooter>
    ) : null

  return (
    <ChannelStrip
      className={STRIP_CLASS}
      data-videorc-system-audio-row={
        view.permissionRequired
          ? 'permission-required'
          : view.issue
            ? `issue-${view.issue}`
            : view.pending
              ? `pending-${view.pending}`
              : view.meter
                ? 'live'
                : view.checked
                  ? 'on'
                  : 'off'
      }
      variant="ghost"
    >
      <ChannelStripHeader>
        <DesktopIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        <ChannelStripTitle className="min-w-0 flex-1">System audio</ChannelStripTitle>
        <ChannelStripActions className="gap-2.5">
          {view.permissionRequired ? null : (
            <span className="text-xs text-muted-foreground">{stateLabel}</span>
          )}
          <Switch
            aria-label="System audio"
            checked={view.checked}
            disabled={view.disabled}
            size="sm"
            onCheckedChange={onEnabledChange}
          />
        </ChannelStripActions>
      </ChannelStripHeader>
      {view.meter ? (
        <StripMeterRow
          input={
            source ? { kind: 'source', source } : { kind: 'value', peakDb: peakDb ?? Number.NaN }
          }
          label="System audio level"
          meterAttribute="data-videorc-system-audio-visualizer"
        />
      ) : null}
      {notice}
    </ChannelStrip>
  )
}

/**
 * The Mix strip (plan 092 Phase C): the chunk the bus writes, which is what
 * the recording and the stream get, with a count of clips. Shown only while a
 * session's bus sends levels.
 */
export function MixStripView({ source }: { source: FrameSource<MeterFrame> }): ReactElement {
  return (
    <ChannelStrip className={STRIP_CLASS} data-videorc-mix-strip="" variant="ghost">
      <ChannelStripHeader>
        <WaveformIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
        <ChannelStripTitle className="min-w-0 flex-1">Mix</ChannelStripTitle>
        <ChannelStripActions>
          <span className="text-xs text-muted-foreground">Recorded and streamed</span>
        </ChannelStripActions>
      </ChannelStripHeader>
      <StripMeterRow
        clipAttribute="data-videorc-mix-clip"
        input={{ kind: 'source', source }}
        label="Mix level"
        meterAttribute="data-videorc-mix-meter"
        showClipCount
      />
    </ChannelStrip>
  )
}
