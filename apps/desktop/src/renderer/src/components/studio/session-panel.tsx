import {
  AlertIcon,
  BuddyPageIcon,
  FrameIcon,
  ImageIcon,
  InfoIcon,
  LivestreamIcon,
  type AppIcon
} from '@/components/icons'
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'

import { CohostPresenceDot } from '@/components/cohost-status'
import { GoLiveButton } from '@/components/go-live-button'
import { GroupedList } from '@/components/list-row'
import { NavigableRow, NavigableRowHintLines } from '@/components/navigable-row'
import { PanelSection } from '@/components/panel-section'
import { RecordButton, type RecordButtonState } from '@/components/record-button'
import { StatusDot } from '@/components/status-dot'
import { AgentsSessionRow } from '@/components/studio/agents-session-row'
import { OpenPageCog } from '@/components/studio/open-page-cog'
import { SessionRuntimeAlert } from '@/components/studio/session-runtime-alert'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useWorkspaceNav, WorkspaceNavContext } from '@/components/workspace-nav'
import {
  useStudioChat,
  useStudioCloud,
  useStudioCore,
  useStudioDiagnostics,
  useStudioRecording,
  useStudioShell
} from '@/hooks/use-studio'
import { providerStreamOutputPlanOptions, streamOutputVideosForTargets } from '@/lib/capture'
import { cohostPresenceView } from '@/lib/cohost-presence'
import { activeCohostAlerts, cohostAlertLabel } from '@/lib/cohost-view'
import { GO_LIVE_CHECKING_LABEL, GO_LIVE_LABEL, RECORD_LABEL } from '@/lib/go-live-copy'
import { liveDestinationsView, streamHealthFact } from '@/lib/live-session-view'
import { openStudioAudio } from '@/lib/section-doors'
import { sessionOutputSummary } from '@/lib/session-output-video'
import {
  activitySavesRecording,
  MICROPHONE_SILENT_CODE,
  type SessionRuntimeNotice
} from '@/lib/session-runtime-notice'
import type { SessionStartFailure } from '@/lib/session-start-failure'
import type { SettingsTabId } from '@/lib/settings-tabs'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { connectionBlockedReason, START_BLOCKED_COPY } from '@/lib/state-labels'
import { classifyStreamHealthAttribution } from '@/lib/stream-health-attribution'
import {
  cameraCaptureNotice,
  STOP_FINALIZE_OVERRUN_ALERT,
  streamingSummary
} from '@/lib/studio-session-view'
import { topWatchdogAlert, visibleWatchdogAlerts } from '@/lib/watchdog-rank'
import {
  dashboardCloudFromStatus,
  type LiveDashboardCloud
} from '../../../../shared/live-dashboard'
import { WINDOW_NAMES } from '../../../../shared/window-names'

/**
 * The session transport (plan 050 S12): Record / Go Live / Stop at the top of
 * the Studio inspector, right above Session (owner call, 2026-09-23: no
 * buttons in the toolbar's top-right corner). No state row above them (plan
 * 235 D1): the session's state and clock show in the status bar and on the
 * sidebar's Studio row, and why a start is off shows under the buttons. The buttons
 * reuse the transport handlers StudioTab owns (no second session state
 * machine). Record shows its Space key, which lives on the Studio page (plan
 * 174 S0.1), not on this button. The words are D3's (lib/go-live-copy.ts).
 * Record and the stop button are one RecordButton (plan 005 in videorc-ui):
 * it stays mounted from the click to the stop, so keyboard focus stays on it,
 * and it keeps one width through every state's words.
 */
export function SessionTransport({
  active,
  talkShowOutputs,
  canStop,
  stopLabel,
  stopNote,
  stopOverrun = false,
  startRequestPending,
  startingLivestream = false,
  stopRequestPending = false,
  goLivePending = false,
  recordBlockedReason,
  liveStreamBlockedReason,
  blockedReason = null,
  blockedJump = null,
  onRecord,
  onLiveStream,
  onStop
}: {
  active: boolean
  talkShowOutputs?: { recording: boolean; live: boolean; onStopRecording: () => void }
  canStop: boolean
  stopLabel: string
  /** What Stop does beyond its label, said visibly ("Your recording stops too."). */
  stopNote?: string
  /** The stop overran its finalize window (plan 174 S3.1, B-16): explain Force stop. */
  stopOverrun?: boolean
  startRequestPending: boolean
  /** The start in flight is a livestream, so Go Live answers it and Record stays off. */
  startingLivestream?: boolean
  /** A stop is in flight: the button says "Stopping…", stays lit and keeps its focus. */
  stopRequestPending?: boolean
  /** Go Live's first checks are running (B-7): the button reads "Checking…" from the click. */
  goLivePending?: boolean
  recordBlockedReason: string | null
  liveStreamBlockedReason: string | null
  /**
   * The one inline line under the buttons (plan 174 S3.2, B-9): why
   * whichever button is off is off, Record's first, with the jump to the
   * page that fixes it. Hover and focus still carry each button's own.
   */
  blockedReason?: string | null
  blockedJump?: BlockedJump | null
  onRecord: () => void
  onLiveStream: () => void
  onStop: () => void
}): ReactElement {
  const recordActive = talkShowOutputs?.recording ?? active
  const recordStop = talkShowOutputs ? talkShowOutputs.onStopRecording : onStop
  const recordStopLabel = talkShowOutputs ? 'Stop recording' : stopLabel
  const liveActive = talkShowOutputs?.live === true
  const startsBusy = startRequestPending || goLivePending
  // Record answers its own click, lit from the click; a Go Live start,
  // checks included, is Go Live's to answer, so Record is off for it.
  const recordStarting = startRequestPending && !goLivePending && !startingLivestream
  let recordState: RecordButtonState = 'idle'
  if (recordActive) {
    recordState = stopRequestPending ? 'stopping' : 'running'
  } else if (recordStarting) {
    recordState = 'starting'
  }
  const recordWords = (
    <>
      {RECORD_LABEL}
      <ShortcutKeys accelerator={shortcutAccelerator('record-toggle')} className="ml-0.5" />
    </>
  )
  return (
    <section
      aria-label="Session controls"
      className="flex flex-col gap-3 border-b border-border p-gutter"
      data-slot="session-transport"
    >
      {/* One equal column per button; alone, Record takes the row. Each
          button keeps every state's words in one cell to hold its width, and
          both keep "End livestream", so side by side in flex the pair
          outgrew the 20rem inspector and Go Live ran past the right gutter.
          A column holds its share whatever the words or a DisabledReason
          wrapper; the words not showing may sit in the button's padding. */}
      <div className="grid auto-cols-fr grid-flow-col gap-2">
        {/* D8 (plan 208): Record and the stop button are metallic red, lit
            while the session runs; Go Live is polished copper (plan 240). Why a
            start is blocked shows on hover and on keyboard focus (plan 174
            S1.1, B-9): a disabled button never shows a title. */}
        <DisabledReason className="min-w-0" reason={recordActive ? null : recordBlockedReason}>
          <RecordButton
            className="min-w-0 flex-1"
            disabled={
              recordActive
                ? !canStop && !stopRequestPending
                : Boolean(recordBlockedReason) || (startsBusy && !recordStarting)
            }
            labels={{ idle: recordWords, starting: recordWords, running: recordStopLabel }}
            size="lg"
            state={recordState}
            onClick={recordActive ? recordStop : onRecord}
          />
        </DisabledReason>
        {active && !talkShowOutputs ? null : (
          <DisabledReason
            className="min-w-0"
            reason={goLivePending || liveActive ? null : liveStreamBlockedReason}
          >
            <GoLiveButton
              className="min-w-0 flex-1"
              data-testid="go-live-button"
              disabled={liveActive ? !canStop : Boolean(liveStreamBlockedReason) || startsBusy}
              labels={{ idle: GO_LIVE_LABEL, checking: GO_LIVE_CHECKING_LABEL }}
              size="lg"
              state={liveActive ? 'live' : goLivePending ? 'checking' : 'idle'}
              onClick={liveActive ? onStop : onLiveStream}
            />
          </DisabledReason>
        )}
      </div>
      {/* D19: Go Live and Stop are one session, said where the control is,
          never in a title that disabled controls never show. */}
      {active && stopNote ? (
        <p className="text-xs text-muted-foreground" data-slot="session-stop-note">
          {stopNote}
        </p>
      ) : null}
      {!active && blockedReason ? (
        <BlockedReasonLine jump={blockedJump} reason={blockedReason} />
      ) : null}
      {/* B-16: a stop that drags on says what is happening and what Force
          stop does, instead of a bare "Stopping…" that strands the streamer. */}
      {active && stopOverrun ? (
        <Alert data-testid="session-stop-overrun" variant="warning">
          <AlertTitle>{STOP_FINALIZE_OVERRUN_ALERT.title}</AlertTitle>
          <AlertDescription>{STOP_FINALIZE_OVERRUN_ALERT.description}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}

export type BlockedJump = {
  label: string
  to: Parameters<ReturnType<typeof useWorkspaceNav>['setActive']>[0]
  /** With `to: 'settings'`, the Settings tab to open (plan 064). */
  settingsTab?: SettingsTabId
}

/** The reasons whose fix is one step away, so the row is that step (see below). */
const JUMP_IS_THE_ROW: ReadonlySet<string> = new Set([
  START_BLOCKED_COPY.noDestination,
  START_BLOCKED_COPY.destinationSetup
])

/**
 * Why a start cannot run right now, as one quiet line under the transport
 * (plan 174 S3.2, B-9; never the yellow top banner of post-0.9.4 F8), with
 * the jump to the page that owns the fix. Without the shell's navigation
 * (a bare transport under test) the line stands alone.
 *
 * With no destination on, or one still to finish, the fix is one step away,
 * so the row is the step itself (owner calls, 2026-11-27 and 2026-11-28): one
 * "Open Destinations" button across the row, with the reason on its hover and
 * focus. Buttons, not links.
 */
function BlockedReasonLine({
  reason,
  jump
}: {
  reason: string
  jump: BlockedJump | null
}): ReactElement {
  const nav = useContext(WorkspaceNavContext)
  const openJump =
    jump && nav
      ? (): void =>
          jump.to === 'settings' ? nav.openSettings(jump.settingsTab) : nav.setActive(jump.to)
      : null
  if (jump && openJump && JUMP_IS_THE_ROW.has(reason)) {
    return <BlockedJumpButton label={jump.label} reason={reason} onOpen={openJump} />
  }
  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      data-slot="session-blocked-reason"
    >
      <InfoIcon className="size-3.5 shrink-0" />
      <span className="min-w-0">{reason}</span>
      {jump && openJump ? (
        <button
          className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
          type="button"
          onClick={openJump}
        >
          {jump.label}
        </button>
      ) : null}
    </div>
  )
}

/**
 * The blocked row as its own fix: the jump as one button across the row. The
 * reason is its tooltip, on hover and on keyboard focus, and stays in the DOM
 * as the button's description, not only while the tooltip is open.
 */
function BlockedJumpButton({
  label,
  reason,
  onOpen
}: {
  label: string
  reason: string
  onOpen: () => void
}): ReactElement {
  const descriptionId = useId()
  return (
    <div className="flex" data-slot="session-blocked-reason">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-describedby={descriptionId}
              className="min-w-0 flex-1"
              data-testid="session-blocked-jump"
              size="lg"
              onClick={onOpen}
            />
          }
        >
          {label}
        </TooltipTrigger>
        {/* Below: above, it would cover Record and Go Live. */}
        <TooltipContent side="bottom">{reason}</TooltipContent>
      </Tooltip>
      <span hidden id={descriptionId}>
        {reason}
      </span>
    </div>
  )
}

/**
 * The Session inspector (SD1): the glanceable session facts as a grouped
 * label→value list, why a start is blocked, the last refused start, and a
 * mid-session notice. Facts come straight from useStudio. The Storage row is
 * intentionally absent until F1 (disk-free space) lands; no fake number.
 * Navigable rows deep-link to the page that owns the setting.
 */
export type SessionPanelProps = {
  active: boolean
  /** On air (plan 174 S3.2): the live dashboard rows exist only then. */
  live?: boolean
  startRequestPending: boolean
  /** The last refused Record / Go Live (B0): stays until the user starts
   * again or dismisses it; a 4s toast was the only signal. */
  startFailure?: SessionStartFailure | null
  /** Mid-session recording failure/degradation: persists until dismissed or
   * the next session begins. */
  runtimeNotice?: SessionRuntimeNotice | null
  onRetryStart?: () => void
  onDismissStartFailure?: () => void
  onDismissRuntimeNotice?: () => void
}

export function SessionPanel({ live = false, ...notices }: SessionPanelProps): ReactElement {
  const { captureConfig } = useStudioCore()
  const { openStudioPanel } = useWorkspaceNav()
  const outputSummary = useSessionOutputSummary(live)

  return (
    // No "Session" title (plan 235 D3): the rows name themselves, and the
    // group keeps its name for screen readers.
    <PanelSection>
      <GroupedList aria-label="Session" role="group">
        <NavigableRow
          icon={LivestreamIcon}
          label="Livestream"
          value={streamingSummary(captureConfig.streaming.targets)}
          onNavigate={() => openStudioPanel('live')}
        />
        <NavigableRow
          icon={FrameIcon}
          label="Output"
          value={outputSummary}
          onNavigate={() => openStudioPanel('recording')}
        />
        {/* The live dashboard (plan 174 S3.2, B-4): every destination and the
            stream's health, quiet when fine and specific when not, so a
            dropped leg is never only a toast. On air only: a recording
            streams nowhere. */}
        {live ? <LiveDestinationRows /> : null}
        {live ? <LiveStreamHealthRow /> : null}
        {/* Presence W3: while on air, whether Buddy is reading chat is a
            session fact, knowable without the Stream Manager; a recording
            has no chat for it to read. */}
        {live ? <CohostSessionRow /> : null}
        {/* Plan 224 D16: the room's one row, which opens the Guests page. */}
        <GuestsSessionSlot />
        {/* Plan 209 D12: which agents are connected, with Stop. */}
        <AgentsSessionRow />
      </GroupedList>
      <SessionNotices {...notices} />
    </PanelSection>
  )
}

/**
 * The Output row's value. Release test 146, plan 0004: on air this is what
 * the session encodes, not the saved recording setting (a shared encode
 * records at the stream's size).
 */
export function useSessionOutputSummary(live: boolean): string {
  const { captureConfig, streamSharedEncodeFallbackVideo } = useStudioCore()
  return sessionOutputSummary({
    live,
    recordEnabled: captureConfig.recordEnabled,
    saved: captureConfig.video,
    sharedFallback: streamSharedEncodeFallbackVideo,
    streamVideo: live
      ? (streamOutputVideosForTargets(
          captureConfig.video,
          captureConfig.streaming,
          providerStreamOutputPlanOptions(captureConfig)
        )[0]?.video ?? null)
      : null
  })
}

/** The last refused start and a mid-session notice, under the Session facts. */
// The watchdog's cards (plan 223 A5) load with the first alert: the chunk
// holds the card and its words, and the eager Studio keeps only the list.
// Plan 224 D16: the Guests row loads with the room, never with the Studio.
const GuestsSessionRow = lazy(async () => ({
  default: (await import('@/components/studio/guests-session-row')).GuestsSessionRow
}))

/** The Guests row while the room is open, in either look (plan 224 D16). */
export function GuestsSessionSlot(): ReactElement | null {
  const { cloudStatus } = useStudioCloud()
  if (cloudStatus?.room?.phase !== 'open') return null
  return (
    <Suspense fallback={null}>
      <GuestsSessionRow />
    </Suspense>
  )
}

const WatchdogAlertCard = lazy(async () => ({
  default: (await import('@/components/studio/watchdog-alert-card')).WatchdogAlertCard
}))

export function SessionNotices({
  active,
  startRequestPending,
  startFailure = null,
  runtimeNotice = null,
  onRetryStart,
  onDismissStartFailure,
  onDismissRuntimeNotice
}: Omit<SessionPanelProps, 'live'>): ReactElement {
  const { setActive } = useWorkspaceNav()
  const { recording } = useStudioRecording()
  const { diagnosticStats, watchdogAlerts = [], watchdogAct } = useStudioDiagnostics()
  const cameraNotice = cameraCaptureNotice(recording, diagnosticStats)
  // The 1064 silence notice already renders below as a SessionRuntimeAlert;
  // the watchdog's adoption of it (repeats, the notification) draws no
  // second card while that notice is up.
  const silenceNoticeShown =
    runtimeNotice?.kind === 'microphone-input-lost' &&
    runtimeNotice.audioIssues?.every((issue) => issue.code === MICROPHONE_SILENT_CODE) === true
  const cards = visibleWatchdogAlerts(watchdogAlerts).filter(
    (alert) => !(silenceNoticeShown && alert.check === 'mic-silent')
  )
  return (
    <>
      {cards.length > 0 ? (
        <Suspense fallback={null}>
          {cards.map((alert) => (
            <WatchdogAlertCard
              key={alert.id}
              alert={alert}
              onAcknowledge={(target) => watchdogAct({ kind: 'acknowledge', alert: target })}
              onFix={(target, fix) => watchdogAct({ kind: 'fix', alert: target, fix })}
              onSnooze={(target, scope) => watchdogAct({ kind: 'snooze', alert: target, scope })}
            />
          ))}
        </Suspense>
      ) : null}
      {/* A refused start is the ONE place destructive red is allowed on chrome:
          it is status, it persists, and it carries the backend's reason
          verbatim (the toast can be missed mid-stream; this line cannot). */}
      {!active && startFailure ? (
        <Alert data-testid="session-start-failure" key={startFailure.at} variant="destructive">
          <AlertTitle>Couldn't start</AlertTitle>
          <AlertDescription className="min-w-0">
            <p className="line-clamp-3" title={startFailure.message}>
              {startFailure.message}
            </p>
            <div className="flex flex-wrap gap-1 pt-2">
              {onRetryStart ? (
                <Button
                  className="text-foreground"
                  disabled={startRequestPending}
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={onRetryStart}
                >
                  Retry
                </Button>
              ) : null}
              {onDismissStartFailure ? (
                <Button
                  className="text-foreground"
                  size="xs"
                  type="button"
                  variant="outline"
                  onClick={onDismissStartFailure}
                >
                  Dismiss
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {cameraNotice ? (
        <Alert data-testid="session-camera-shared" variant="warning">
          <AlertTitle>Camera opened twice</AlertTitle>
          <AlertDescription>{cameraNotice}</AlertDescription>
        </Alert>
      ) : null}
      {runtimeNotice && onDismissRuntimeNotice ? (
        <SessionRuntimeAlert
          notice={runtimeNotice}
          onDismiss={onDismissRuntimeNotice}
          onOpenAudio={openStudioAudio}
          onOpenLibrary={() => setActive('library')}
          onRevealOutput={
            runtimeNotice.kind === 'recording-failed' &&
            activitySavesRecording(runtimeNotice.activity) &&
            runtimeNotice.sessionId
              ? () => void window.videorc?.revealSession?.(runtimeNotice.sessionId!)
              : undefined
          }
        />
      ) : null}
    </>
  )
}

function FactRow({
  icon,
  className,
  ...props
}: {
  icon?: AppIcon
  className?: string
  label: string
  value: ReactNode
  hint?: ReactNode
  onNavigate: () => void
}): ReactElement {
  return <NavigableRow className={className} icon={icon} {...props} />
}

/**
 * The Videorc Cloud show carrying this session, or null (plan 184 C7): the
 * same view the Stream Manager's dashboard keeps, from the status the
 * backend emits.
 */
function useSessionCloud(): LiveDashboardCloud | null {
  const { cloudStatus } = useStudioCloud()
  const { recording } = useStudioRecording()
  return cloudStatus ? dashboardCloudFromStatus(cloudStatus, recording.sessionId ?? null) : null
}

/** A status dot's words: the row's text, or lit on the screen. */
const dotClassName = (): string => 'text-sm text-foreground'

/**
 * The destinations while on air (plan 174 S3.2, B-4): one quiet "3 of 3 on
 * air" row when every leg is live, else that count and one row per problem
 * ("Twitch · Stopped"), each a door to the Destinations page. Nothing until the
 * backend has reported the session's legs: never an unmeasured zero.
 */
export function LiveDestinationRows(): ReactElement | null {
  const { streamTargets } = useStudioCore()
  const { openStudioPanel } = useWorkspaceNav()
  // Plan 184 C7: through Videorc Cloud the feed legs fold into one row.
  const cloud = useSessionCloud()
  const view = liveDestinationsView(streamTargets, cloud)
  if (!view) {
    return null
  }
  return (
    <>
      <FactRow
        icon={LivestreamIcon}
        label="Destinations"
        value={
          <span data-testid="session-destinations-summary">
            <StatusDot
              className={dotClassName()}
              label={view.summary}
              tone={view.kind === 'quiet' ? 'live' : 'warn'}
            />
          </span>
        }
        onNavigate={() => openStudioPanel('live')}
      />
      {view.kind === 'problems'
        ? view.problems.map((problem) => (
            <FactRow
              key={problem.targetId}
              className="pl-9.5"
              label={problem.label}
              value={
                <span data-testid="session-destination-problem">
                  <StatusDot className={dotClassName()} label={problem.word} tone={problem.tone} />
                </span>
              }
              onNavigate={() => openStudioPanel('live')}
            />
          ))
        : null}
    </>
  )
}

/**
 * One "Stream" fact from the same classifier the Destinations page uses (plan
 * 174 S3.2, B-4): "Healthy" quietly, the earliest failing stage in a few
 * words when not. It opens Health, where the numbers behind it live.
 */
export function LiveStreamHealthRow(): ReactElement {
  const { streamTargets } = useStudioCore()
  const {
    diagnosticStats,
    recentStreamDrops,
    streamHealth,
    watchdogAlerts = []
  } = useStudioDiagnostics()
  const { setActive } = useWorkspaceNav()
  const cloud = useSessionCloud()
  const fact = streamHealthFact(
    classifyStreamHealthAttribution(
      diagnosticStats,
      streamHealth,
      streamTargets,
      recentStreamDrops
    ),
    cloud,
    topWatchdogAlert(watchdogAlerts)
  )
  return (
    <FactRow
      icon={AlertIcon}
      label="Stream"
      value={
        <span data-testid="session-stream-health">
          <StatusDot className={dotClassName()} label={fact.label} tone={fact.tone} />
        </span>
      }
      onNavigate={() => setActive('diagnostics')}
    />
  )
}

/**
 * One co-host line, same derivation as the Stream Manager's Buddy pane so the two
 * surfaces cannot disagree. Dot + label only: this panel is a fact list, not a
 * working surface, so the typing shimmer stays where the work is read. What
 * viewers report through Buddy ("Chat says: no audio · 3 viewers") shows here
 * too (plan 174 S3.2, F-7): a problem the streamer cannot see is news. A click
 * opens the Stream Manager, where Buddy works, and its hint and name say so
 * (plan 213 B2): the Chat row is chat's door, this one is Buddy's.
 */
/** Where the Buddy row goes (plan 213 B2): its last hint line and the end of its name. */
export const COHOST_ROW_OPENS = `Open ${WINDOW_NAMES.streamManager}`

export function CohostSessionRow(): ReactElement {
  const { cohostState } = useStudioChat()
  const { openCommentsWindow } = useStudioShell()
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [])

  const view = cohostPresenceView(cohostState, nowMs)
  const alerts = activeCohostAlerts(cohostState, nowMs)
  const alertLabels = alerts.map((alert) => cohostAlertLabel(alert))
  const hintLines = [...alertLabels, ...view.tooltipLines, COHOST_ROW_OPENS]

  return (
    <FactRow
      icon={BuddyPageIcon}
      label="Sidekick"
      hint={<NavigableRowHintLines lines={hintLines} />}
      value={
        <>
          {alertLabels.length > 0 ? (
            <span data-testid="session-buddy-alert">
              <StatusDot className={dotClassName()} label={alertLabels[0]} tone="warn" />
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5">
              <CohostPresenceDot view={view} />
              <span className="truncate">{view.label}</span>
            </span>
          )}
          {/* The row's name says where it goes, not only its tooltip. */}
          <span className="sr-only">{`. ${COHOST_ROW_OPENS}`}</span>
        </>
      }
      onNavigate={() => void openCommentsWindow()}
    />
  )
}

/**
 * The takeover on-air switch (its ONE home: the Images grid manages images,
 * this flips them). Live-safe: activation only needs the backend socket, so it
 * works mid-session; a takeover replaces the output regardless of scene.
 */
export function TakeoverSection(): ReactElement {
  const { activateScreen, activeScreen, clearActiveScreen, ready, disconnectedReason, hint } =
    useTakeovers()
  const { setActive } = useWorkspaceNav()
  const disconnected = disconnectedReason !== null

  return (
    // The one inspector title left (plan 235 D3): the buttons are only
    // takeover names ("Intro", "BRB"). Its way to Images is the inspector's
    // one cog (D4).
    <PanelSection
      title="Takeover"
      action={<OpenPageCog label="Open Images" onOpen={() => setActive('assets')} />}
    >
      {ready.length === 0 ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ImageIcon className="size-3.5 shrink-0" weight="duotone" />
          <span className="min-w-0">No takeovers yet.</span>
          <Button
            className="shrink-0 text-foreground"
            size="xs"
            type="button"
            variant="outline"
            onClick={() => setActive('assets')}
          >
            Add in Images
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {ready.map((screen) => {
              const isActive = activeScreen?.id === screen.id
              return (
                <DisabledReason key={screen.id} reason={disconnectedReason}>
                  <Button
                    aria-pressed={isActive}
                    disabled={disconnected}
                    // The line under the takeovers says what a click does.
                    variant={isActive ? 'default' : 'outline'}
                    onClick={() =>
                      void (isActive ? clearActiveScreen() : activateScreen(screen.id))
                    }
                  >
                    <ImageIcon data-icon="inline-start" weight={isActive ? 'fill' : 'duotone'} />
                    {screen.name}
                  </Button>
                </DisabledReason>
              )
            })}
          </div>
          {/* Reserve two lines of text-xs so swapping between the three hint
              strings can never reflow the content below (the active-takeover
              copy is longer than the idle hint and used to push everything
              down when it wrapped). */}
          <span className="block min-h-8 text-xs text-muted-foreground">{hint}</span>
        </>
      )}
    </PanelSection>
  )
}

export function useTakeovers() {
  const { activateScreen, activeScreen, clearActiveScreen, screens, wsStatus } = useStudioCore()
  const ready = screens.filter((screen) => screen.status !== 'missing')
  // Plan 174 B-22: the streamer's words for a dropped connection, never "Backend socket".
  const disconnectedReason = connectionBlockedReason(wsStatus)
  const hint =
    disconnectedReason !== null
      ? `${disconnectedReason} Takeovers work once Videorc is connected.`
      : activeScreen
        ? `${activeScreen.name} is covering the output. Click it to return.`
        : 'Click a takeover to cover the output. Works while you’re recording or live.'
  return { activateScreen, activeScreen, clearActiveScreen, ready, disconnectedReason, hint }
}
