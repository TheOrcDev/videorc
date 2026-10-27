import { lazy, Suspense, useEffect, useEffectEvent, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { PreviewStage } from '@/components/preview-stage'
import { QuickSettings } from '@/components/studio/quick-settings'
import {
  RetroQuickSettings,
  RetroSessionPanel,
  RetroSessionStatus,
  RetroSessionTransport,
  RetroTakeoverSection
} from '@/components/studio/retro-lcd-studio'
import { SessionMicSliver } from '@/components/studio/session-mic-sliver'
import {
  SessionPanel,
  SessionStatusPill,
  SessionTransport,
  TakeoverSection
} from '@/components/studio/session-panel'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { StudioPanel, WorkspaceTab } from '@/components/workspace-nav'
import {
  useStudioCore,
  useStudioDiagnostics,
  useStudioPreview,
  useStudioRecordingState
} from '@/hooks/use-studio'
import { areEnabledStreamTargetsStartReady } from '@/lib/capture'
import { goLiveEntitlementGate } from '@/lib/entitlement-ui'
import { shouldIgnoreGoLiveAction } from '@/lib/go-live-flow'
import { OPEN_HEALTH_LABEL, openHealth } from '@/lib/health-door'
import type { SettingsTabId } from '@/lib/settings-tabs'
import { studioHealth } from '@/lib/studio-health'
import {
  STUDIO_CONTAINER,
  STUDIO_GRID,
  STUDIO_INSPECTOR,
  STUDIO_PREVIEW_COLUMN,
  studioTransportRowClass
} from '@/lib/studio-layout'
import {
  isSessionTransportActive,
  sessionIsLive,
  sessionStopControl
} from '@/lib/studio-session-view'
import { spaceShortcutBlocked } from '@/lib/studio-space-shortcut'
import { studioChatShows } from '@/lib/studio-chat'
import { connectionBlockedReason } from '@/lib/state-labels'

const StudioDashboardBottomRow = lazy(async () => ({
  default: (await import('@/components/studio/studio-dashboard-bottom-row'))
    .StudioDashboardBottomRow
}))
// The meters and faders bring audiocn: their own chunk, so the inspector paints first.
const AudioSection = lazy(async () => ({
  default: (await import('@/components/studio/audio-section')).AudioSection
}))
// Chat in Studio (plan 204): the rows, the list and their imports are their
// own chunk; the page holds only the gate (`lib/studio-chat.ts`).
const StudioChatSection = lazy(async () => ({
  default: (await import('@/components/studio/studio-chat')).StudioChatSection
}))

export function StudioTab(): ReactElement {
  const studio = useStudioCore()
  // Settings → General → Retro LCD (plan 197): the inspector on LCD screens.
  const retro = studio.settings.retroLcdStudio === true
  const Transport = retro ? RetroSessionTransport : SessionTransport
  const StatusPill = retro ? RetroSessionStatus : SessionStatusPill
  const InspectorSession = retro ? RetroSessionPanel : SessionPanel
  const { recording } = useStudioRecordingState()
  const {
    canStop,
    startRequestPending,
    stopRequestPending,
    goLiveConfirmationPending,
    visibleStartBlockedReason,
    recordBlockedReason,
    liveStreamBlockedReason,
    sessionStartIntent,
    sessionStopOverrun,
    startRecording,
    startLivestream,
    requestStopSession,
    noteRecordClick,
    captureConfig,
    wsStatus,
    sessionStartFailure,
    dismissSessionStartFailure,
    sessionRuntimeNotice,
    dismissSessionRuntimeNotice,
    retrySessionStart
  } = studio

  const active = isSessionTransportActive(recording.state, recording.replayOnly)
  const banner = studioBlocker(studio)
  // A Go Live in flight owns the transport (plan 174 S3.1, the Phase 0
  // review): while its preflight runs or a start is in flight, Record,
  // Space and a second Go Live click do nothing.
  const startsBusy = shouldIgnoreGoLiveAction({ goLiveConfirmationPending, startRequestPending })

  // Two-button start (plan 174 D3): Record and Go Live…, the same two starts
  // ⌘K offers, so the provider owns them, and the reasons each is off come
  // from the provider's one function (S3.1). The latency clock arms on the
  // click.
  const handleRecord = (): void => {
    if (startsBusy || recordBlockedReason) {
      return
    }
    noteRecordClick('start')
    void startRecording()
  }
  const handleLiveStream = (): void => {
    if (startsBusy || liveStreamBlockedReason) {
      return
    }
    noteRecordClick('start')
    void startLivestream()
  }
  // Every stop goes through the provider's decision (plan 174 S0.1, D2): a
  // recording stops at once, a livestream asks first. The latency clock arms
  // on the click that stops; while live that is the dialog's confirm, not
  // the click that only asks.
  const handleStop = (origin: 'button' | 'space' = 'button'): void => {
    if (!sessionIsLive(recording)) noteRecordClick('stop')
    void requestStopSession(origin)
  }

  // Space (D1): Record when idle, Stop recording while recording, the End
  // livestream question while live. It exists only on this page, and yields
  // to a dialog, a menu, a focused control or widget, and a stage gesture.
  const onSpace = useEffectEvent((event: KeyboardEvent): void => {
    if (spaceShortcutBlocked(event, document)) return
    event.preventDefault()
    if (active) {
      if (canStop) handleStop('space')
      return
    }
    handleRecord()
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === 'Space') onSpace(event)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Go Live is record+stream, which the backend reports as `recording`: the
  // stream URL is what makes it on air (plan 095 S5). While it starts, the
  // control cancels the livestream rather than "stopping a recording" (B-16).
  // The start's own intent says which it is (S3.1); a session this renderer
  // did not start falls back to the saved mode.
  const stopControl = sessionStopControl(
    recording,
    stopRequestPending,
    sessionStartIntent?.stream ?? captureConfig.streamEnabled
  )

  // The status pill rides the inspector's transport block, so it exists in
  // every preview mode, docked included, and the mic sliver shares its one
  // home.
  const sessionStatus = (
    <span className="flex items-center gap-1.5">
      <SessionMicSliver
        ink={retro}
        deviceName={studio.selectedMicrophone?.name}
        muted={captureConfig.audio.microphoneMuted}
        sessionActive={active}
      />
      {/* "Not ready" only when nothing can start (B-17): one working button
          is a ready Studio. */}
      <StatusPill
        recording={recording}
        startBlocked={Boolean(recordBlockedReason && liveStreamBlockedReason)}
        wsStatus={wsStatus}
      />
    </span>
  )

  // The docked preview is a native surface glued over its slot: a pinned
  // transport row would scroll under it (lib/studio-layout.ts).
  const previewDocked =
    studio.nativePreviewSurfaceEnabled &&
    studio.previewWindow.open &&
    studio.previewWindow.mode === 'docked'

  // The Go Live confirmation is the shell's (GoLiveDialogGate), so it opens
  // over every page, not only this one (plan 174 S0.6, B-5).
  return (
    <div className={STUDIO_CONTAINER}>
      {/* The Studio bench: the preview pane leads, and the inspector (the
          transport, session facts, microphone, sources, takeover) sits beside
          it, split by a hairline, from 720 px of content (a container query,
          so the smallest window keeps Stop in view; plan 174 S3.3, B-10).
          Narrower, the transport row leads the page above the preview. Hard
          blocks surface inside the Session section, never as a yellow top
          banner (post-0.9.4 fix batch F8). */}
      <div className={STUDIO_GRID}>
        <div className={STUDIO_PREVIEW_COLUMN}>
          <StudioPreviewPanel />
          {/* Scenes and the vertical leg: deferred so the launch surface
              paints its preview and transport first. */}
          <Suspense fallback={<StudioDashboardBottomRowFallback />}>
            <StudioDashboardBottomRow />
          </Suspense>
        </div>

        <div className={studioTransportRowClass(previewDocked)}>
          {/* Record, Go Live…, and the clock sit at the top of the
              inspector, right above Session (owner call, 2026-09-23); Space
              still records. */}
          <Transport
            active={active}
            blockedJump={
              banner?.jumpTo && banner.jumpLabel
                ? { label: banner.jumpLabel, to: banner.jumpTo, settingsTab: banner.settingsTab }
                : null
            }
            blockedReason={visibleStartBlockedReason}
            canStop={canStop}
            goLivePending={goLiveConfirmationPending}
            liveStreamBlockedReason={liveStreamBlockedReason}
            recordBlockedReason={recordBlockedReason}
            startRequestPending={startRequestPending}
            status={sessionStatus}
            stopLabel={stopControl.label}
            stopNote={stopControl.note}
            stopOverrun={sessionStopOverrun}
            onLiveStream={handleLiveStream}
            onRecord={handleRecord}
            onStop={() => handleStop('button')}
          />
        </div>

        <aside aria-label="Session inspector" className={STUDIO_INSPECTOR}>
          <InspectorSession
            active={active}
            live={sessionIsLive(recording)}
            runtimeNotice={sessionRuntimeNotice}
            startFailure={sessionStartFailure}
            startRequestPending={startRequestPending}
            onDismissRuntimeNotice={dismissSessionRuntimeNotice}
            onDismissStartFailure={dismissSessionStartFailure}
            onRetryStart={retrySessionStart}
          />
          {/* Chat in Studio (plan 204, owner 2026-10-27): while on air and
              switched on, the livestream's chat under Session, where the
              streamer glances most, and a click puts a message on stream.
              The same section in both looks (owner: no Retro LCD screen in
              the first version). The inspector keeps its width, so the
              docked preview's slot never moves when it appears. */}
          {studioChatShows({ settings: studio.settings, recording }) ? (
            <Suspense fallback={<StudioChatSectionFallback />}>
              <StudioChatSection />
            </Suspense>
          ) : null}
          {/* Audio: the Microphone and System audio levels on one scale, each
              with its Gain, between Session and Sources (plan 201 D1; the
              Microphone section since the owner call of 2026-10-02): a check
              that runs all the time. */}
          <Suspense fallback={<AudioSectionFallback retro={retro} />}>
            <AudioSection />
          </Suspense>
          {/* Sources (Screen and Camera) and Captions: compact mirrors editing
              the same captureConfig, each with a way to its page. Output is
              the Session row above (plan 174 S3.3, B-15). */}
          {retro ? <RetroQuickSettings /> : <QuickSettings />}
          {retro ? <RetroTakeoverSection /> : <TakeoverSection />}
        </aside>
      </div>
    </div>
  )
}

function StudioDashboardBottomRowFallback(): ReactElement {
  return (
    <div className="flex flex-col" aria-label="Loading Studio controls">
      <PanelSection title="Scenes">
        <Skeleton className="h-24" />
      </PanelSection>
    </div>
  )
}

/**
 * The Chat section's height while its chunk loads: the header row and the
 * fixed list area (`STUDIO_CHAT_LIST_HEIGHT`), so nothing under it jumps.
 */
function StudioChatSectionFallback(): ReactElement {
  return (
    <PanelSection title="Chat">
      <Skeleton className="h-64 rounded-row" />
    </PanelSection>
  )
}

/**
 * The Audio section's height while its chunk loads: the picker, two level
 * bars and two Gain faders, or with Retro LCD the Microphone screen (about
 * 150 px).
 */
function AudioSectionFallback({ retro }: { retro: boolean }): ReactElement {
  if (retro) {
    return (
      <PanelSection>
        <Skeleton className="h-36 rounded-row" />
      </PanelSection>
    )
  }
  return (
    <PanelSection title="Audio">
      <Skeleton className="h-control rounded-chip" />
      <Skeleton className="h-4 rounded-chip" />
      <Skeleton className="h-4 rounded-chip" />
      <Skeleton className="h-4 rounded-chip" />
      <Skeleton className="h-4 rounded-chip" />
    </PanelSection>
  )
}

function StudioPreviewPanel(): ReactElement {
  const {
    nativePreviewSurfaceEnabled,
    handleSystemPermission,
    previewWindow,
    refreshPreview,
    runtimeInfo
  } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const { previewLiveStatus } = useStudioPreview()
  const { diagnosticStats, previewSurfaceStatus } = useStudioDiagnostics()
  const active = isSessionTransportActive(recording.state, recording.replayOnly)
  const previewHealth = studioHealth(
    diagnosticStats,
    active,
    runtimeInfo?.platform,
    previewSurfaceStatus.nativePreviewHostKind
  )
  const docked =
    nativePreviewSurfaceEnabled && previewWindow.open && previewWindow.mode === 'docked'

  // B-26: the degraded preview says what it means and why, and offers the
  // two things to do about it: try the preview again, or read Health.
  const healthErrorRow =
    previewHealth.tone === 'error' && previewHealth.detail ? (
      <Alert data-testid="capture-health-alert" variant="destructive">
        <AlertTitle>{previewHealth.value}</AlertTitle>
        <AlertDescription className="min-w-0">
          <p className="line-clamp-3">{previewHealth.detail}</p>
          <div className="flex flex-wrap gap-1 pt-2">
            <Button size="xs" type="button" variant="ghost" onClick={refreshPreview}>
              Retry preview
            </Button>
          </div>
        </AlertDescription>
        {/* The door to Health (plan 174 D9): the details live there. */}
        <AlertAction>
          <Button size="xs" type="button" variant="outline" onClick={openHealth}>
            {OPEN_HEALTH_LABEL}
          </Button>
        </AlertAction>
      </Alert>
    ) : null

  const previewStage = (
    <PreviewStage
      nativePreviewSurfaceEnabled={nativePreviewSurfaceEnabled}
      previewLiveStatus={previewLiveStatus}
      previewSurfaceStatus={previewSurfaceStatus}
      onOpenPermissions={(pane) => void handleSystemPermission(pane)}
      onRetry={refreshPreview}
    />
  )

  // Docked ("stick") mode: the preview stands alone, with no section header.
  // The native surface and its black frame ARE the pane; the docked frame's
  // own control row carries the dock actions.
  if (docked) {
    return (
      <div className="flex min-w-0 flex-col gap-3 border-b border-border p-gutter">
        {previewStage}
        {healthErrorRow}
      </div>
    )
  }

  // The stage itself offers Open, Stick, Pop out and Close: no header icons
  // repeating them in other words (plan 174 S3.3, B-23).
  return (
    <PanelSection title="Preview">
      {previewStage}
      {healthErrorRow}
    </PanelSection>
  )
}

/**
 * Where the shown blocked reason is fixed (plan 174 S3.1): the reason line
 * follows the record intent first, then Go Live, so the jump does too. A
 * Record that cannot start points at what records; a Go Live that cannot
 * start points at Livestream.
 */
function studioBlocker(studio: ReturnType<typeof useStudioCore>): {
  title?: string
  jumpTo?: WorkspaceTab | StudioPanel
  /** With `jumpTo: 'settings'`, the Settings tab that owns the fix. */
  settingsTab?: SettingsTabId
  jumpLabel?: string
} | null {
  const { wsStatus, recordBlockedReason, captureConfig, health, entitlements } = studio
  if (connectionBlockedReason(wsStatus)) {
    return null
  }
  if (recordBlockedReason) {
    if (health && !health.ffmpeg.available) {
      return {
        title: "Videorc's recorder isn't available",
        // Health says why and what to do (plan 174 S3.6: Settings → Recording is gone).
        jumpTo: 'diagnostics',
        jumpLabel: OPEN_HEALTH_LABEL
      }
    }
    return null
  }
  const goLiveEntitlement = goLiveEntitlementGate({
    entitlements,
    streaming: captureConfig.streaming
  })
  if (!goLiveEntitlement.allowed) {
    return {
      title: goLiveEntitlement.upgradeUrl ? 'Premium required' : 'Streaming limit reached',
      jumpTo: 'live',
      jumpLabel: 'Open Livestream'
    }
  }
  if (!areEnabledStreamTargetsStartReady(captureConfig.streaming)) {
    return {
      title: 'Finish setting up your destination',
      jumpTo: 'live',
      jumpLabel: 'Open Livestream'
    }
  }
  return null
}
