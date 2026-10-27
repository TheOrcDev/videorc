import {
  LivestreamIcon,
  RecordIcon,
  SpeakerOffIcon,
  SpeakerOnIcon,
  StopIcon
} from '@/components/icons'
import { Fragment, useContext, type ReactElement, type ReactNode } from 'react'

import { MicrophoneGainFader, SystemAudioGainFader } from '@/components/audio/gain-faders'
import { DevicePicker } from '@/components/device-picker'
import {
  LCD_FADER,
  LCD_MESSAGE,
  LCD_VALUE_BUTTON,
  LcdPanel,
  LcdPanelAction,
  LcdPanelHeader,
  LcdPanelKey,
  LcdPanelNavRow,
  LcdPanelPressRow,
  LcdPanelSwitch
} from '@/components/lcd-panel'
import { PanelSection } from '@/components/panel-section'
import { STATUS_TONE_CLASS } from '@/components/status-badge'
import { MicLcdMeter } from '@/components/studio/mic-level-meter'
import type { MicrophoneRowProps, SystemAudioRowProps } from '@/components/studio/audio-section'
import { useStudioSources } from '@/components/studio/quick-settings'
import {
  CohostSessionRow,
  LiveDestinationRows,
  LiveStreamHealthRow,
  SESSION_STATUS_ICONS,
  SessionClock,
  SessionNotices,
  type BlockedJump,
  type SessionPanelProps,
  type SessionTransport,
  useSessionOutputSummary,
  useTakeovers
} from '@/components/studio/session-panel'
import { SourceSwitchStatus } from '@/components/studio/source-switch-status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { LcdDisplaySeparator } from '@/components/ui/lcd-display'
import { Mixer, MixerChannels } from '@/components/ui/mixer'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { useWorkspaceNav, WorkspaceNavContext } from '@/components/workspace-nav'
import { useStudioCore } from '@/hooks/use-studio'
import { buildCameraSources, buildCaptureSources } from '@/lib/capture'
import { GO_LIVE_CHECKING_LABEL, GO_LIVE_LABEL, RECORD_LABEL } from '@/lib/go-live-copy'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { captionsStatusLabel, micSignalLabel, systemAudioIssueLabel } from '@/lib/state-labels'
import {
  STOP_FINALIZE_OVERRUN_ALERT,
  sessionAlsoRecords,
  sessionStatusGlyph,
  sessionStatusLabel,
  sessionStatusTone,
  streamingSummary,
  type SessionStatusView
} from '@/lib/studio-session-view'
import { systemAudioIssueCopy, type SystemAudioSwitchView } from '@/lib/system-audio'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

// Plan 197: Retro LCD, an option in Settings → General (owner 2026-10-25:
// "let's put it only as some retro LCD option in settings"). The Studio
// inspector's sections, each on one audiocn LCD screen with its title, its
// rows and its sentences, and Record and Go Live as keys on the transport's
// screen. Each section shares its state with the inspector's own (the same
// hooks and rows), so only the drawing differs. Studio picks these when
// `settings.retroLcdStudio` is on.

/**
 * The transport on one screen: the session's state and, while it runs, the
 * clock; Record and Go Live (or Stop) as keys; and why a start is off. The
 * same props and handlers as `SessionTransport`.
 */
export function RetroSessionTransport({
  active,
  canStop,
  stopLabel,
  stopNote,
  stopOverrun = false,
  startRequestPending,
  goLivePending = false,
  recordBlockedReason,
  liveStreamBlockedReason,
  blockedReason = null,
  blockedJump = null,
  status,
  onRecord,
  onLiveStream,
  onStop
}: Parameters<typeof SessionTransport>[0]): ReactElement {
  const startsBusy = startRequestPending || goLivePending
  return (
    <section
      aria-label="Session controls"
      className="flex flex-col gap-3 border-b border-border p-gutter"
      data-slot="session-transport"
    >
      <LcdPanel>
        <div
          className="flex min-h-6 items-center justify-between gap-2 py-2"
          data-slot="session-readout"
        >
          {status}
          {active ? (
            <SessionClock className="text-[1em] font-normal text-(--lcd-display-lit)" />
          ) : null}
        </div>
        <LcdDisplaySeparator />
        <div className="flex flex-wrap gap-2 py-2">
          {active ? (
            <LcdPanelKey className="flex-1" disabled={!canStop} tone="record" onClick={onStop}>
              <StopIcon weight="fill" />
              {stopLabel}
            </LcdPanelKey>
          ) : (
            <>
              {/* Why a start is blocked shows on hover and on keyboard focus
                  (plan 174 S1.1, B-9): a disabled key never shows a title. */}
              <DisabledReason className="flex flex-1" reason={recordBlockedReason}>
                <LcdPanelKey
                  className="flex-1"
                  disabled={Boolean(recordBlockedReason) || startsBusy}
                  tone="record"
                  onClick={onRecord}
                >
                  <RecordIcon weight="fill" />
                  {RECORD_LABEL}
                  <ShortcutKeys
                    accelerator={shortcutAccelerator('record-toggle')}
                    className="font-normal opacity-70"
                    variant="text"
                  />
                </LcdPanelKey>
              </DisabledReason>
              <DisabledReason
                className="flex flex-1"
                reason={goLivePending ? null : liveStreamBlockedReason}
              >
                <LcdPanelKey
                  className="flex-1"
                  data-testid="go-live-button"
                  disabled={Boolean(liveStreamBlockedReason) || startsBusy}
                  onClick={onLiveStream}
                >
                  <LivestreamIcon weight="fill" />
                  {goLivePending ? GO_LIVE_CHECKING_LABEL : GO_LIVE_LABEL}
                </LcdPanelKey>
              </DisabledReason>
            </>
          )}
        </div>
        {/* D19: Go Live and Stop are one session, said where the control is. */}
        {active && stopNote ? (
          <p className={LCD_MESSAGE} data-slot="session-stop-note">
            {stopNote}
          </p>
        ) : null}
        {!active && blockedReason ? (
          <RetroBlockedReasonLine jump={blockedJump} reason={blockedReason} />
        ) : null}
      </LcdPanel>
      {/* B-16: a stop that drags on says what Force stop does. An alert, not
          a screen line: it has to interrupt. */}
      {active && stopOverrun ? (
        <Alert data-testid="session-stop-overrun" variant="warning">
          <AlertTitle>{STOP_FINALIZE_OVERRUN_ALERT.title}</AlertTitle>
          <AlertDescription>{STOP_FINALIZE_OVERRUN_ALERT.description}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}

/** Why a start cannot run, as a sentence on the screen, with the way to its fix. */
function RetroBlockedReasonLine({
  reason,
  jump
}: {
  reason: string
  jump: BlockedJump | null
}): ReactElement {
  const nav = useContext(WorkspaceNavContext)
  return (
    <div
      className={cn(LCD_MESSAGE, 'flex flex-col items-start gap-1')}
      data-slot="session-blocked-reason"
    >
      <span className="min-w-0">{reason}</span>
      {jump && nav ? (
        <LcdPanelAction
          onClick={() =>
            jump.to === 'settings' ? nav.openSettings(jump.settingsTab) : nav.setActive(jump.to)
          }
        >
          {jump.label}
        </LcdPanelAction>
      ) : null}
    </div>
  )
}

/**
 * The session's state on the transport's screen: the state's icon (or a dot
 * while idle) in its tone, the words lit, and a lit Rec when Go Live also
 * records. The same words and live region as `SessionStatusPill`, which the
 * smokes read.
 */
export function RetroSessionStatus({
  recording,
  wsStatus,
  startBlocked = false
}: {
  recording: SessionStatusView
  wsStatus: string
  startBlocked?: boolean
}): ReactElement {
  const glyph = sessionStatusGlyph(recording, wsStatus)
  const tone = sessionStatusTone(recording, wsStatus, { startBlocked })
  const LeadingIcon = glyph ? SESSION_STATUS_ICONS[glyph] : null
  return (
    <>
      <span
        className={cn('inline-flex min-w-0 items-center gap-2', STATUS_TONE_CLASS[tone])}
        data-slot="session-status"
        data-tone={tone}
      >
        {LeadingIcon ? (
          <LeadingIcon aria-hidden className="size-3.5 shrink-0 text-(--chip-tone)" weight="fill" />
        ) : (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-(--chip-tone)" />
        )}
        <span
          className="min-w-0 truncate text-(--lcd-display-lit)"
          data-videorc-session-status
          role="status"
        >
          {sessionStatusLabel(recording, wsStatus, { startBlocked })}
        </span>
      </span>
      {wsStatus === 'connected' && sessionAlsoRecords(recording) ? (
        <InfoTooltip content="Also recording a local file">
          <span className="text-(--lcd-display-lit)" data-testid="session-also-recording">
            Rec
          </span>
        </InfoTooltip>
      ) : null}
    </>
  )
}

/** The Session facts on a screen, each going to its page; notices under it. */
export function RetroSessionPanel({ live = false, ...notices }: SessionPanelProps): ReactElement {
  const { captureConfig } = useStudioCore()
  const { openStudioPanel } = useWorkspaceNav()
  const outputSummary = useSessionOutputSummary(live)
  return (
    <PanelSection>
      <LcdPanel>
        <LcdPanelHeader title="Session" />
        <LcdPanelNavRow
          label="Livestream"
          value={streamingSummary(captureConfig.streaming.targets)}
          onNavigate={() => openStudioPanel('live')}
        />
        <LcdPanelNavRow
          label="Output"
          value={outputSummary}
          onNavigate={() => openStudioPanel('recording')}
        />
        {live ? <LcdDisplaySeparator /> : null}
        {live ? <LiveDestinationRows look="lcd" /> : null}
        {live ? <LiveStreamHealthRow look="lcd" /> : null}
        {live ? <CohostSessionRow look="lcd" /> : null}
      </LcdPanel>
      <SessionNotices {...notices} />
    </PanelSection>
  )
}

/**
 * The Audio section on one screen (plan 201): the Microphone (its title and
 * mute, its dropdown, its level and Gain), a dotted rule, then System audio
 * (its switch, its level and Gain). The same props as `AudioSectionView`, and
 * the same Mixer: one scale for both meters, and Cmd/Ctrl+Up/Down between
 * the rows.
 */
export function RetroAudioSectionView({
  microphone,
  systemAudio
}: {
  microphone: MicrophoneRowProps
  /** Null where System audio can't run (Linux, older Windows): Microphone only. */
  systemAudio: SystemAudioRowProps | null
}): ReactElement {
  return (
    <PanelSection>
      <LcdPanel>
        <LcdPanelHeader title="Audio" />
        <Mixer aria-labelledby={undefined} className="gap-0" maxDb={0} minDb={-60}>
          <MixerChannels className="gap-0" scrollable={false}>
            <div data-slot="channel-strip">
              <RetroMicrophoneRows {...microphone} />
            </div>
            {systemAudio ? (
              <div data-slot="channel-strip">
                <LcdDisplaySeparator />
                <RetroSystemAudioRows {...systemAudio} />
              </div>
            ) : null}
          </MixerChannels>
        </Mixer>
      </LcdPanel>
    </PanelSection>
  )
}

/** A channel's title on the screen, lit, with its control on the right. */
function RetroChannelHeader({
  title,
  children
}: {
  title: string
  children: ReactNode
}): ReactElement {
  return (
    <div className="flex min-h-8 min-w-0 items-center justify-between gap-4 py-1.5">
      <h3 className="min-w-0 truncate font-normal text-(--lcd-display-lit)">{title}</h3>
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-3">{children}</div>
    </div>
  )
}

/** The Microphone's rows: the mute by its title, the dropdown, the level, then Gain. */
function RetroMicrophoneRows({
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
    <>
      <RetroChannelHeader title="Microphone">
        {/* D16: the mute, with its hotkey when one is bound, and a muted
            microphone says so in words (plan 174 S3.3). Muted inverts, like a
            lit key. */}
        {muteShortcut ? (
          <ShortcutKeys
            accelerator={muteShortcut}
            className="font-normal text-(--lcd-display-ink-dim)"
            platform={platform}
            variant="text"
          />
        ) : null}
        <ShortcutTooltip
          accelerator={muteShortcut}
          label={muted ? 'Unmute microphone' : 'Mute microphone'}
          platform={platform}
        >
          <button
            aria-label="Mute microphone"
            aria-pressed={muted}
            className={cn(
              LCD_VALUE_BUTTON,
              muted
                ? 'bg-(--lcd-display-lit) text-(--glass-solid) hover:bg-(--lcd-display-lit)'
                : 'text-(--lcd-display-ink-dim) hover:text-(--lcd-display-lit)'
            )}
            data-videorc-studio-mic-mute=""
            type="button"
            onClick={() => onMutedChange(!muted)}
          >
            {muted ? (
              <SpeakerOffIcon className="size-3.5 shrink-0" weight="fill" />
            ) : (
              <SpeakerOnIcon className="size-3.5 shrink-0" weight="fill" />
            )}
            <span>{muted ? 'Muted' : 'Mute'}</span>
          </button>
        </ShortcutTooltip>
      </RetroChannelHeader>
      <DevicePicker
        devices={devices}
        disabled={disabled}
        discoveryPending={discoveryPending}
        kind="microphone"
        label="Microphone"
        noneLabel="Off"
        rowLabel="Device"
        selectedDevice={selectedDevice}
        selectedName={selectedName}
        trigger="lcd"
        value={value}
        onChange={onChange}
      />
      {/* The live switch status, under the dropdown. Kept in the
          accessibility tree while empty, so it is announced when it arrives;
          it takes no space until then. */}
      {switchStatus ? (
        <div aria-live="polite" className={cn(LCD_MESSAGE, 'empty:sr-only')}>
          {switchStatus}
        </div>
      ) : null}
      {/* The level (plan 196), which prints the level and a CLIP flag and
          names it in dB to screen readers. No dB scale (owner 2026-10-25). */}
      <div
        className={cn('py-1', muted && 'opacity-50')}
        data-muted={muted ? '' : undefined}
        data-videorc-mic-level=""
      >
        <MicLcdMeter
          aria-label="Microphone level"
          data-videorc-mic-visualizer=""
          meter={meter}
          scale={false}
        />
        {/* Receiving / Muted / No signal for screen readers, and its state for the perf probe, off screen. */}
        <span className="sr-only" data-videorc-mic-monitor-state={monitorState}>
          {micSignalLabel(monitorState)}
        </span>
      </div>
      <div className={cn(LCD_FADER, 'py-1.5')}>
        <MicrophoneGainFader gainDb={gainDb} onGainChange={onGainChange} />
      </div>
    </>
  )
}

/**
 * System audio's rows: its switch (or the way to the permission) by its
 * title; while On, the level, D6's line while Clips is off, and Gain. Without
 * the grant, Gain shows disabled and there is no level, as in the default
 * look.
 */
function RetroSystemAudioRows({
  view,
  gainDb,
  meter,
  idleLine,
  platform,
  onEnabledChange,
  onGainChange,
  onOpenPermissions,
  onResume
}: SystemAudioRowProps): ReactElement {
  return (
    <div
      data-videorc-studio-system-audio=""
      data-videorc-studio-system-audio-issue={
        view.permissionRequired ? 'permission' : (view.issue ?? undefined)
      }
    >
      <RetroChannelHeader title="System audio">
        <RetroSystemAudioValue
          platform={platform}
          view={view}
          onEnabledChange={onEnabledChange}
          onOpenPermissions={onOpenPermissions}
          onResume={onResume}
        />
      </RetroChannelHeader>
      {view.checked ? (
        <>
          {/* The meter rests with no reading and comes back with the bus. */}
          <div className="py-1" data-videorc-studio-system-audio-level="">
            <MicLcdMeter aria-label="System audio level" meter={meter} scale={false} />
          </div>
          {idleLine}
        </>
      ) : null}
      {view.checked || view.permissionRequired ? (
        <div className={cn(LCD_FADER, 'py-1.5')}>
          <SystemAudioGainFader
            disabled={view.permissionRequired}
            gainDb={gainDb}
            onGainChange={onGainChange}
          />
        </div>
      ) : null}
    </div>
  )
}

/**
 * Sources on one screen (its title and the way to Sources, Screen and Camera
 * with their live switch status under them; System audio is in Audio since
 * plan 201), then Captions on a screen of its
 * own: captions aren't a source (B-15).
 */
export function RetroQuickSettings(): ReactElement {
  const {
    captureConfig,
    switchSourceDeviceLive,
    sourceSwitchReason,
    allowCaptureNone,
    selectedCaptureDevice,
    selectedCamera,
    isSessionActive,
    captionsStatus,
    openStudioPanel,
    discoveryPending,
    captureDevices,
    cameras,
    selectedCaptureId
  } = useStudioSources()
  return (
    <>
      <PanelSection>
        <LcdPanel>
          <LcdPanelHeader
            action={
              <LcdPanelAction onClick={() => openWorkspaceTab('sources')}>
                Open Sources
              </LcdPanelAction>
            }
            title="Sources"
          />
          {/* F-015: the synthetic diagnostic source replaces the screen. */}
          <DevicePicker
            devices={captureDevices}
            disabled={Boolean(sourceSwitchReason('capture'))}
            discoveryPending={discoveryPending}
            groupByKind
            kind="capture"
            label="Screen"
            noneLabel={allowCaptureNone ? 'None' : undefined}
            selectedDevice={selectedCaptureDevice}
            selectedName={captureConfig.sources.screenName ?? captureConfig.sources.windowName}
            selectionLabel={captureConfig.sources.testPattern ? 'Test pattern' : undefined}
            trigger="lcd"
            value={selectedCaptureId}
            onChange={(captureId) =>
              void switchSourceDeviceLive(
                'capture',
                buildCaptureSources(captureConfig.sources, captureDevices, captureId)
              )
            }
          />
          <RetroSwitchStatusLine kind="capture" />
          <LcdDisplaySeparator />
          {/* Off is a choice that sticks (plan 080 S4). */}
          <DevicePicker
            devices={cameras}
            disabled={Boolean(sourceSwitchReason('camera'))}
            discoveryPending={discoveryPending}
            kind="camera"
            label="Camera"
            noneLabel="Off"
            selectedDevice={selectedCamera}
            selectedName={captureConfig.sources.cameraName}
            trigger="lcd"
            value={captureConfig.sources.cameraId}
            onChange={(cameraId) =>
              void switchSourceDeviceLive(
                'camera',
                buildCameraSources(captureConfig.sources, cameras, cameraId)
              )
            }
          />
          <RetroSwitchStatusLine kind="camera" />
        </LcdPanel>
      </PanelSection>
      <PanelSection>
        <LcdPanel>
          <LcdPanelNavRow
            label="Captions"
            value={captionsStatusLabel(captionsStatus, {
              enabled: captureConfig.captions.enabled,
              sessionActive: isSessionActive
            })}
            onNavigate={() => openStudioPanel('captions')}
          />
        </LcdPanel>
      </PanelSection>
    </>
  )
}

/**
 * A source's live switch status on the screen, under its row. Kept in the
 * accessibility tree while empty, so it is announced when it arrives.
 */
function RetroSwitchStatusLine({ kind }: { kind: 'capture' | 'camera' }): ReactElement {
  return (
    <div aria-live="polite" className={cn(LCD_MESSAGE, 'empty:sr-only')}>
      <SourceSwitchStatus kind={kind} look="lcd" />
    </div>
  )
}

/**
 * System audio's value on the screen: the switch reads On or Off itself, so a
 * word beside it only says what is wrong, with the full copy as its tooltip.
 * Without Screen Recording the permission route replaces the switch; when the
 * echo guard paused it, Resume comes first (plan 076).
 */
export function RetroSystemAudioValue({
  view,
  platform,
  onEnabledChange,
  onOpenPermissions,
  onResume
}: {
  view: SystemAudioSwitchView
  platform?: string
  onEnabledChange: (enabled: boolean) => void
  onOpenPermissions: () => void
  onResume: () => void
}): ReactElement {
  if (view.permissionRequired) {
    return (
      <InfoTooltip content="System audio needs Screen Recording permission." focusable={false}>
        <button className={LCD_VALUE_BUTTON} type="button" onClick={onOpenPermissions}>
          <span className="truncate">Needs permission</span>
        </button>
      </InfoTooltip>
    )
  }
  return (
    <>
      {view.issue === 'echo' ? (
        <InfoTooltip content={systemAudioIssueCopy('echo', platform)} focusable={false}>
          <button className={LCD_VALUE_BUTTON} type="button" onClick={onResume}>
            <span className="truncate">Resume</span>
          </button>
        </InfoTooltip>
      ) : view.issue ? (
        <InfoTooltip className="min-w-0" content={systemAudioIssueCopy(view.issue, platform)}>
          <span className="min-w-0 truncate text-(--lcd-display-ink-dim)">
            {systemAudioIssueLabel(view.issue)}
          </span>
        </InfoTooltip>
      ) : null}
      <LcdPanelSwitch
        aria-label="System audio"
        checked={view.checked}
        disabled={view.disabled}
        onCheckedChange={onEnabledChange}
      />
    </>
  )
}

/** The takeovers on a screen: a row per takeover, On while it covers the output. */
export function RetroTakeoverSection(): ReactElement {
  const { activateScreen, activeScreen, clearActiveScreen, ready, disconnectedReason, hint } =
    useTakeovers()
  const { setActive } = useWorkspaceNav()
  const disconnected = disconnectedReason !== null
  return (
    <PanelSection>
      <LcdPanel>
        <LcdPanelHeader
          action={<LcdPanelAction onClick={() => setActive('assets')}>Open Assets</LcdPanelAction>}
          title="Takeover"
        />
        {ready.length === 0 ? (
          <LcdPanelNavRow
            label="None yet"
            value="Add in Assets"
            onNavigate={() => setActive('assets')}
          />
        ) : (
          ready.map((screen, index) => {
            const isActive = activeScreen?.id === screen.id
            return (
              <Fragment key={screen.id}>
                {index > 0 ? <LcdDisplaySeparator /> : null}
                <DisabledReason className="flex flex-col" reason={disconnectedReason}>
                  <LcdPanelPressRow
                    disabled={disconnected}
                    label={screen.name}
                    pressed={isActive}
                    onPressedChange={() =>
                      void (isActive ? clearActiveScreen() : activateScreen(screen.id))
                    }
                  />
                </DisabledReason>
              </Fragment>
            )
          })
        )}
        {/* Two lines reserved, so the three hints never reflow what follows. */}
        {ready.length > 0 ? (
          <p className={cn(LCD_MESSAGE, 'min-h-[calc(2lh+0.75rem)]')}>{hint}</p>
        ) : null}
      </LcdPanel>
    </PanelSection>
  )
}
