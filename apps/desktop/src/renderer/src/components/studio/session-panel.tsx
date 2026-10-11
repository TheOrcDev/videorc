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
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'

import { CohostPresenceDot } from '@/components/cohost-status'
import { GroupedList } from '@/components/list-row'
import { NavigableRow } from '@/components/navigable-row'
import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { SessionRuntimeAlert } from '@/components/studio/session-runtime-alert'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useSessionElapsedMs } from '@/hooks/use-session-elapsed'
import {
  useStudioChat,
  useStudioCore,
  useStudioRecording,
  useStudioShell
} from '@/hooks/use-studio'
import { cohostPresenceView } from '@/lib/cohost-presence'
import { formatVideoQuality } from '@/lib/format-video'
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
                data-slot="go-live-button"
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
        <Badge
          data-testid="session-also-recording"
          title="Also recording a local file"
          variant="outline"
        >
          Rec
        </Badge>
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
  startRequestPending,
  blockedReason = null,
  blockedJump = null,
  startFailure = null,
  runtimeNotice = null,
  onRetryStart,
  onDismissStartFailure,
  onDismissRuntimeNotice
}: {
  active: boolean
  startRequestPending: boolean
  /** Why the session cannot start right now (hard block): a quiet inline
   * line, never the yellow top banner (post-0.9.4 fix batch F8). */
  blockedReason?: string | null
  blockedJump?: {
    label: string
    to: Parameters<ReturnType<typeof useWorkspaceNav>['setActive']>[0]
    /** With `to: 'settings'`, the Settings tab to open (plan 064). */
    settingsTab?: SettingsTabId
  } | null
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
  const { openStudioPanel, setActive, openSettings } = useWorkspaceNav()
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
        {/* Presence W3: while a session runs, whether the co-host is reading
            chat is a session fact, knowable without the Comments window.
            Streaming only: the co-host reads LIVE chat, so a record-only
            session has no chat for it to read. */}
        {active && captureConfig.streamEnabled ? <CohostSessionRow /> : null}
      </GroupedList>
      {!active && blockedReason ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <InfoIcon className="size-3.5 shrink-0" />
          <span className="min-w-0">{blockedReason}</span>
          {blockedJump ? (
            <button
              className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
              type="button"
              onClick={() =>
                blockedJump.to === 'settings'
                  ? openSettings(blockedJump.settingsTab)
                  : setActive(blockedJump.to)
              }
            >
              {blockedJump.label}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* A refused start is the ONE place destructive red is allowed on chrome:
          it is status, it persists, and it carries the backend's reason
          verbatim (the toast can be missed mid-stream; this line cannot). */}
      {!active && startFailure ? (
        <Alert data-testid="session-start-failure" key={startFailure.at} variant="destructive">
          <AlertTitle>Could not start.</AlertTitle>
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
 * One co-host line, same derivation as the Stream Manager's Buddy pane so the two
 * surfaces cannot disagree. Dot + label only: this panel is a fact list, not a
 * working surface, so the typing shimmer stays where the work is read.
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

  return (
    <NavigableRow
      icon={BuddyIcon}
      label="Buddy"
      title={view.tooltipLines.join('\n') || undefined}
      value={
        <span className="flex min-w-0 items-center gap-1.5">
          <CohostPresenceDot view={view} />
          <span className="truncate">{view.label.replace(/^Buddy\s*(·\s*)?/, '')}</span>
        </span>
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
  const disconnected = wsStatus !== 'connected'

  return (
    <PanelSection title="Takeover">
      {ready.length === 0 ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ImageIcon className="size-3.5 shrink-0" weight="duotone" />
          <span className="min-w-0">No takeover screens yet.</span>
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
                <DisabledReason
                  key={screen.id}
                  reason={disconnected ? `Backend socket is ${wsStatus}.` : null}
                >
                  <Button
                    aria-pressed={isActive}
                    disabled={disconnected}
                    size="sm"
                    title={
                      disconnected
                        ? undefined
                        : isActive
                          ? `Take ${screen.name} off the output`
                          : `Put ${screen.name} on the output`
                    }
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
              ? `Backend socket is ${wsStatus}. Takeovers need the backend.`
              : activeScreen
                ? `${activeScreen.name} is covering the output. Click it to return.`
                : 'Click a takeover to cover the output. Works while live.'}
          </span>
        </>
      )}
    </PanelSection>
  )
}
