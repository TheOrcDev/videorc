import {
  AlertIcon,
  type AppIcon,
  ChevronRightIcon,
  CohostIcon,
  FrameIcon,
  ImageIcon,
  InfoIcon,
  LivestreamIcon,
  RecordIcon,
  StopIcon
} from '@/components/icons'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'

import { CohostPresenceDot } from '@/components/cohost-status'
import { GroupedList } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { SessionRuntimeAlert } from '@/components/studio/session-runtime-alert'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { useWorkspaceNav } from '@/components/workspace-nav'
import {
  useStudioChat,
  useStudioCore,
  useStudioRecording,
  useStudioShell
} from '@/hooks/use-studio'
import { cohostPresenceView } from '@/lib/cohost-presence'
import type { SessionRuntimeNotice } from '@/lib/session-runtime-notice'
import type { SessionStartFailure } from '@/lib/session-start-failure'
import type { SettingsTabId } from '@/lib/settings-tabs'
import { outputSummary, sessionClockLabel, streamingSummary } from '@/lib/studio-session-view'

/**
 * The session transport (plan 050 S12): status, clock, and Record / Stream /
 * Stop at the top of the Studio inspector, right above Session (owner call,
 * 2026-09-23: no buttons in the toolbar's top-right corner). The buttons
 * reuse the transport handlers StudioTab owns (no second session state
 * machine). Space still records: that shortcut lives in the Studio provider,
 * not on this button.
 */
export function SessionTransport({
  active,
  canStop,
  stopLabel,
  startRequestPending,
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
  startRequestPending: boolean
  recordBlockedReason: string | null
  liveStreamBlockedReason: string | null
  /** The session status chip (and the mic sliver that rides with it). */
  status: ReactNode
  onRecord: () => void
  onLiveStream: () => void
  onStop: () => void
}): ReactElement {
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
            <Button
              className="flex-1"
              disabled={Boolean(recordBlockedReason) || startRequestPending}
              size="lg"
              title={recordBlockedReason ?? undefined}
              variant="destructive"
              onClick={onRecord}
            >
              <RecordIcon data-icon="inline-start" weight="fill" />
              Record
              <Kbd className="ml-0.5">␣</Kbd>
            </Button>
            <Button
              className="flex-1"
              disabled={Boolean(liveStreamBlockedReason) || startRequestPending}
              size="lg"
              title={liveStreamBlockedReason ?? undefined}
              variant="outline"
              onClick={onLiveStream}
            >
              <LivestreamIcon data-icon="inline-start" weight="fill" />
              Stream
            </Button>
          </>
        )}
      </div>
    </section>
  )
}

function SessionClock(): ReactElement {
  const { recording } = useStudioRecording()
  return (
    <span
      className="min-w-11 text-right text-sm font-medium text-foreground tabular-nums"
      data-slot="session-clock"
    >
      {sessionClockLabel(recording.durationMs)}
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
        <SessionRow
          icon={LivestreamIcon}
          label="Streaming"
          value={streamingSummary(captureConfig.streamEnabled, captureConfig.streaming.targets)}
          onNavigate={() => openStudioPanel('live')}
        />
        <SessionRow
          icon={FrameIcon}
          label="Output"
          value={outputSummary(video)}
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
          <AlertIcon weight="fill" />
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
            runtimeNotice.activity === 'recording' &&
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
 * One co-host line, same derivation as the Stream Manager's Orcle pane so the two
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
    <SessionRow
      icon={CohostIcon}
      label="Orcle"
      title={view.tooltipLines.join('\n') || undefined}
      value={
        <span className="flex min-w-0 items-center gap-1.5">
          <CohostPresenceDot view={view} />
          <span className="truncate">{view.label.replace(/^Orcle\s*(·\s*)?/, '')}</span>
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
                <Button
                  aria-pressed={isActive}
                  disabled={disconnected}
                  key={screen.id}
                  size="sm"
                  title={
                    disconnected
                      ? `Backend socket is ${wsStatus}.`
                      : isActive
                        ? `Take ${screen.name} off the output`
                        : `Put ${screen.name} on the output`
                  }
                  variant={isActive ? 'default' : 'outline'}
                  onClick={() => void (isActive ? clearActiveScreen() : activateScreen(screen.id))}
                >
                  <ImageIcon data-icon="inline-start" weight={isActive ? 'fill' : 'duotone'} />
                  {screen.name}
                </Button>
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

// Label→value row in the Session group. Navigable rows render as a button with
// a trailing caret and deep-link to the owning page; static facts render as a
// div.
function SessionRow({
  icon: RowIcon,
  label,
  value,
  title,
  onNavigate
}: {
  icon: AppIcon
  label: string
  value: ReactNode
  /** Native tooltip for rows whose value is a summary of more facts. */
  title?: string
  onNavigate?: () => void
}): ReactElement {
  const body = (
    <>
      <RowIcon className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
      <span className="flex-1 truncate text-left text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
        {typeof value === 'string' ? <span className="truncate">{value}</span> : value}
        {onNavigate ? (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
      </span>
    </>
  )

  if (onNavigate) {
    return (
      <button
        className="flex h-row items-center gap-2.5 px-3 text-sm hover:bg-accent"
        title={title}
        type="button"
        onClick={onNavigate}
      >
        {body}
      </button>
    )
  }
  return (
    <div className="flex h-row items-center gap-2.5 px-3 text-sm" title={title}>
      {body}
    </div>
  )
}
