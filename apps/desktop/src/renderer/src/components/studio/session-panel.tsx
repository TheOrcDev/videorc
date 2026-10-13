import {
  AlertIcon,
  type AppIcon,
  FrameIcon,
  ImageIcon,
  InfoIcon,
  LivestreamIcon,
  BuddyIcon,
  RecordIcon,
  StopIcon
} from '@/components/icons'
import { useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react'

import { CohostPresenceDot } from '@/components/cohost-status'
import { GroupedList } from '@/components/list-row'
import { NavigableRow, NavigableRowHintLines } from '@/components/navigable-row'
import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { StatusDot } from '@/components/status-dot'
import { SessionRuntimeAlert } from '@/components/studio/session-runtime-alert'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { useWorkspaceNav, WorkspaceNavContext } from '@/components/workspace-nav'
import { useSessionElapsedMs } from '@/hooks/use-session-elapsed'
import {
  useStudioChat,
  useStudioCore,
  useStudioDiagnostics,
  useStudioRecording,
  useStudioShell
} from '@/hooks/use-studio'
import { cohostPresenceView } from '@/lib/cohost-presence'
import { activeCohostAlerts, cohostAlertLabel } from '@/lib/cohost-view'
import { formatVideoQuality } from '@/lib/format-video'
import { liveDestinationsView, streamHealthFact } from '@/lib/live-session-view'
import { classifyStreamHealthAttribution } from '@/lib/stream-health-attribution'
import { GO_LIVE_CHECKING_LABEL, GO_LIVE_LABEL, RECORD_LABEL } from '@/lib/go-live-copy'
import { activitySavesRecording, type SessionRuntimeNotice } from '@/lib/session-runtime-notice'
import type { SessionStartFailure } from '@/lib/session-start-failure'
import type { SettingsTabId } from '@/lib/settings-tabs'
import { shortcutAccelerator } from '@/lib/shortcuts'
import {
  STOP_FINALIZE_OVERRUN_ALERT,
  sessionAlsoRecords,
  sessionClockLabel,
  sessionStatusGlyph,
  sessionStatusLabel,
  sessionStatusTone,
  streamingSummary,
  type SessionStatusGlyph,
  type SessionStatusView
} from '@/lib/studio-session-view'
import { connectionBlockedReason } from '@/lib/state-labels'

/**
 * The session transport (plan 050 S12): status, clock, and Record / Go Live… /
 * Stop at the top of the Studio inspector, right above Session (owner call,
 * 2026-09-23: no buttons in the toolbar's top-right corner). The buttons
 * reuse the transport handlers StudioTab owns (no second session state
 * machine). Record shows its Space key, which lives on the Studio page (plan
 * 174 S0.1), not on this button. The words are D3's (lib/go-live-copy.ts).
 */
export function SessionTransport({
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
}: {
  active: boolean
  canStop: boolean
  stopLabel: string
  /** What Stop does beyond its label, said visibly ("Your recording stops too."). */
  stopNote?: string
  /** The stop overran its finalize window (plan 174 S3.1, B-16): explain Force stop. */
  stopOverrun?: boolean
  startRequestPending: boolean
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
  /** The session status chip (and the mic sliver that rides with it). */
  status: ReactNode
  onRecord: () => void
  onLiveStream: () => void
  onStop: () => void
}): ReactElement {
  const startsBusy = startRequestPending || goLivePending
  return (
    <section
      aria-label="Session controls"
      className="flex flex-col gap-3 border-b border-border p-gutter"
      data-slot="session-transport"
    >
      <div className="flex min-h-6 items-center justify-between gap-2">
        {status}
        {active ? <SessionClock /> : null}
      </div>
      <div className="flex gap-2">
        {active ? (
          <Button
            className="flex-1"
            disabled={!canStop}
            size="lg"
            variant="destructive"
            onClick={onStop}
          >
            <StopIcon data-icon="inline-start" weight="fill" />
            {stopLabel}
          </Button>
        ) : (
          <>
            {/* Why a start is blocked shows on hover and on keyboard focus
                (plan 174 S1.1, B-9): a disabled button never shows a title. */}
            <DisabledReason className="flex-1" reason={recordBlockedReason}>
              <Button
                className="flex-1"
                disabled={Boolean(recordBlockedReason) || startsBusy}
                size="lg"
                variant="destructive"
                onClick={onRecord}
              >
                <RecordIcon data-icon="inline-start" weight="fill" />
                {RECORD_LABEL}
                <ShortcutKeys
                  accelerator={shortcutAccelerator('record-toggle')}
                  className="ml-0.5"
                />
              </Button>
            </DisabledReason>
            <DisabledReason
              className="flex-1"
              reason={goLivePending ? null : liveStreamBlockedReason}
            >
              <Button
                className="flex-1"
                data-testid="go-live-button"
                disabled={Boolean(liveStreamBlockedReason) || startsBusy}
                size="lg"
                variant="outline"
                onClick={onLiveStream}
              >
                <LivestreamIcon data-icon="inline-start" weight="fill" />
                {goLivePending ? GO_LIVE_CHECKING_LABEL : GO_LIVE_LABEL}
              </Button>
            </DisabledReason>
          </>
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

type BlockedJump = {
  label: string
  to: Parameters<ReturnType<typeof useWorkspaceNav>['setActive']>[0]
  /** With `to: 'settings'`, the Settings tab to open (plan 064). */
  settingsTab?: SettingsTabId
}

/**
 * Why a start cannot run right now, as one quiet line under the transport
 * (plan 174 S3.2, B-9; never the yellow top banner of post-0.9.4 F8), with
 * the jump to the page that owns the fix. Without the shell's navigation
 * (a bare transport under test) the line stands alone.
 */
function BlockedReasonLine({
  reason,
  jump
}: {
  reason: string
  jump: BlockedJump | null
}): ReactElement {
  const nav = useContext(WorkspaceNavContext)
  return (
    <div
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      data-slot="session-blocked-reason"
    >
      <InfoIcon className="size-3.5 shrink-0" />
      <span className="min-w-0">{reason}</span>
      {jump && nav ? (
        <button
          className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
          type="button"
          onClick={() =>
            jump.to === 'settings' ? nav.openSettings(jump.settingsTab) : nav.setActive(jump.to)
          }
        >
          {jump.label}
        </button>
      ) : null}
    </div>
  )
}

/** The pill's leading icon per state (plan 174 B-17): record, on air, trouble. */
const SESSION_STATUS_ICONS: Record<SessionStatusGlyph, AppIcon> = {
  record: RecordIcon,
  live: LivestreamIcon,
  alert: AlertIcon
}

/**
 * The session status pill. An on-air session reads "On air" in the live
 * tone, and adds a quiet "Rec" when it also records: Go Live is record+stream,
 * which the backend reports as `recording` (plan 095 S5). Recording, on air
 * and trouble each lead with their own icon, and idle reads "Not ready" when
 * nothing can start (plan 174 B-17). A polite live region, so a state change
 * is announced. data hook: the backend-resilience and captions smokes read the
 * pill, never the Rec chip.
 */
export function SessionStatusPill({
  recording,
  wsStatus,
  startBlocked = false
}: {
  recording: SessionStatusView
  wsStatus: string
  /** Nothing can start right now; the Session section says why. */
  startBlocked?: boolean
}): ReactElement {
  const glyph = sessionStatusGlyph(recording, wsStatus)
  return (
    <>
      <span data-videorc-session-status role="status">
        <StatusBadge
          icon={glyph ? SESSION_STATUS_ICONS[glyph] : undefined}
          tone={sessionStatusTone(recording, wsStatus, { startBlocked })}
          value={sessionStatusLabel(recording, wsStatus, { startBlocked })}
        />
      </span>
      {wsStatus === 'connected' && sessionAlsoRecords(recording) ? (
        <InfoTooltip content="Also recording a local file">
          <Badge data-testid="session-also-recording" variant="outline">
            Rec
          </Badge>
        </InfoTooltip>
      ) : null}
    </>
  )
}

/** Ticks from the session's start: running statuses carry no duration. */
function SessionClock(): ReactElement {
  const { recording } = useStudioRecording()
  const elapsedMs = useSessionElapsedMs(recording.startedAt)
  return (
    <span
      className="min-w-11 text-right text-sm font-medium text-foreground tabular-nums"
      data-slot="session-clock"
    >
      {sessionClockLabel(elapsedMs ?? recording.durationMs)}
    </span>
  )
}

/**
 * The Session inspector (SD1): the glanceable session facts as a grouped
 * label→value list, why a start is blocked, the last refused start, and a
 * mid-session notice. Facts come straight from useStudio. The Storage row is
 * intentionally absent until F1 (disk-free space) lands; no fake number.
 * Navigable rows deep-link to the page that owns the setting.
 */
export function SessionPanel({
  active,
  live = false,
  startRequestPending,
  startFailure = null,
  runtimeNotice = null,
  onRetryStart,
  onDismissStartFailure,
  onDismissRuntimeNotice
}: {
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
}): ReactElement {
  const { captureConfig } = useStudioCore()
  const { openStudioPanel, setActive } = useWorkspaceNav()
  const video = captureConfig.video

  return (
    <PanelSection title="Session">
      <GroupedList>
        <NavigableRow
          icon={LivestreamIcon}
          label="Livestream"
          value={streamingSummary(captureConfig.streaming.targets)}
          onNavigate={() => openStudioPanel('live')}
        />
        <NavigableRow
          icon={FrameIcon}
          label="Output"
          value={formatVideoQuality(video)}
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
      </GroupedList>
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
                  disabled={startRequestPending}
                  size="xs"
                  type="button"
                  variant="ghost"
                  onClick={onRetryStart}
                >
                  Retry
                </Button>
              ) : null}
              {onDismissStartFailure ? (
                <Button size="xs" type="button" variant="ghost" onClick={onDismissStartFailure}>
                  Dismiss
                </Button>
              ) : null}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      {runtimeNotice && onDismissRuntimeNotice ? (
        <SessionRuntimeAlert
          notice={runtimeNotice}
          onDismiss={onDismissRuntimeNotice}
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
    </PanelSection>
  )
}

/**
 * The destinations while on air (plan 174 S3.2, B-4): one quiet "3 of 3 on
 * air" row when every leg is live, else that count and one row per problem
 * ("Twitch · Stopped"), each a door to the Livestream page. Nothing until the
 * backend has reported the session's legs: never an unmeasured zero.
 */
function LiveDestinationRows(): ReactElement | null {
  const { streamTargets } = useStudioCore()
  const { openStudioPanel } = useWorkspaceNav()
  const view = liveDestinationsView(streamTargets)
  if (!view) {
    return null
  }
  return (
    <>
      <NavigableRow
        icon={LivestreamIcon}
        label="Destinations"
        value={
          <span data-testid="session-destinations-summary">
            <StatusDot
              className="text-sm text-foreground"
              label={view.summary}
              tone={view.kind === 'quiet' ? 'live' : 'warn'}
            />
          </span>
        }
        onNavigate={() => openStudioPanel('live')}
      />
      {view.kind === 'problems'
        ? view.problems.map((problem) => (
            <NavigableRow
              key={problem.targetId}
              className="pl-9.5"
              label={problem.label}
              value={
                <span data-testid="session-destination-problem">
                  <StatusDot
                    className="text-sm text-foreground"
                    label={problem.word}
                    tone={problem.tone}
                  />
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
 * One "Stream" fact from the same classifier the Livestream page uses (plan
 * 174 S3.2, B-4): "Healthy" quietly, the earliest failing stage in a few
 * words when not. It opens Health, where the numbers behind it live.
 */
function LiveStreamHealthRow(): ReactElement {
  const { streamTargets } = useStudioCore()
  const { diagnosticStats, streamHealth } = useStudioDiagnostics()
  const { setActive } = useWorkspaceNav()
  const fact = streamHealthFact(
    classifyStreamHealthAttribution(diagnosticStats, streamHealth, streamTargets)
  )
  return (
    <NavigableRow
      icon={AlertIcon}
      label="Stream"
      value={
        <span data-testid="session-stream-health">
          <StatusDot className="text-sm text-foreground" label={fact.label} tone={fact.tone} />
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
 * too (plan 174 S3.2, F-7): a problem the streamer cannot see is news.
 */
function CohostSessionRow(): ReactElement {
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
  const hintLines = [...alertLabels, ...view.tooltipLines]

  return (
    <NavigableRow
      icon={BuddyIcon}
      label="Buddy"
      hint={hintLines.length > 0 ? <NavigableRowHintLines lines={hintLines} /> : undefined}
      value={
        alertLabels.length > 0 ? (
          <span data-testid="session-buddy-alert">
            <StatusDot className="text-sm text-foreground" label={alertLabels[0]} tone="warn" />
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <CohostPresenceDot view={view} />
            <span className="truncate">{view.label}</span>
          </span>
        )
      }
      onNavigate={() => void openCommentsWindow()}
    />
  )
}

/**
 * The takeover on-air switch (its ONE home: the Assets grid manages images,
 * this flips them). Live-safe: activation only needs the backend socket, so it
 * works mid-session; a takeover replaces the output regardless of scene.
 */
export function TakeoverSection(): ReactElement {
  const { activateScreen, activeScreen, clearActiveScreen, screens, wsStatus } = useStudioCore()
  const { setActive } = useWorkspaceNav()
  const ready = screens.filter((screen) => screen.status !== 'missing')
  // Plan 174 B-22: the streamer's words for a dropped connection, never "Backend socket".
  const disconnectedReason = connectionBlockedReason(wsStatus)
  const disconnected = disconnectedReason !== null

  return (
    <PanelSection
      title="Takeover"
      action={
        <Button variant="ghost" onClick={() => setActive('assets')}>
          Open Assets
        </Button>
      }
    >
      {ready.length === 0 ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ImageIcon className="size-3.5 shrink-0" weight="duotone" />
          <span className="min-w-0">No takeovers yet.</span>
          <button
            className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
            type="button"
            onClick={() => setActive('assets')}
          >
            Add in Assets
          </button>
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
          <span className="block min-h-8 text-xs text-muted-foreground">
            {disconnected
              ? `${disconnectedReason} Takeovers work once Videorc is connected.`
              : activeScreen
                ? `${activeScreen.name} is covering the output. Click it to return.`
                : 'Click a takeover to cover the output. Works while you’re recording or live.'}
          </span>
        </>
      )}
    </PanelSection>
  )
}
