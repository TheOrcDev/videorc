import { lazy, Suspense, useEffect, useEffectEvent, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { PreviewStage } from '@/components/preview-stage'
import { QuickSettings } from '@/components/studio/quick-settings'
import { SessionMicSliver } from '@/components/studio/session-mic-sliver'
import {
  SessionPanel,
  SessionStatusPill,
  SessionTransport,
  TakeoverSection
} from '@/components/studio/session-panel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import type { StudioPanel, WorkspaceTab } from '@/components/workspace-nav'
import {
  useStudioCore,
  useStudioDiagnostics,
  useStudioPreview,
  useStudioRecordingState
} from '@/hooks/use-studio'
import { videoProfileCompatibility } from '@/lib/capture'
import { goLiveEntitlementGate } from '@/lib/entitlement-ui'
import { entitlementDisabledReason } from '@/lib/entitlements'
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
import { connectionBlockedReason, START_BLOCKED_COPY } from '@/lib/state-labels'

const StudioDashboardBottomRow = lazy(async () => ({
  default: (await import('@/components/studio/studio-dashboard-bottom-row'))
    .StudioDashboardBottomRow
}))
// The meter brings audiocn: its own chunk, so the inspector paints first.
const MicrophoneSection = lazy(async () => ({
  default: (await import('@/components/studio/microphone-section')).MicrophoneSection
}))

export function StudioTab(): ReactElement {
  const studio = useStudioCore()
  const { recording } = useStudioRecordingState()
  const {
    canStop,
    startRequestPending,
    stopRequestPending,
    visibleStartBlockedReason,
    startRecording,
    startLivestream,
    requestStopSession,
    noteRecordClick,
    captureConfig,
    entitlements,
    wsStatus,
    health,
    sessionStartFailure,
    dismissSessionStartFailure,
    sessionRuntimeNotice,
    dismissSessionRuntimeNotice,
    retrySessionStart
  } = studio

  const active = isSessionTransportActive(recording.state)
  const banner = studioBlocker(studio)
  const liveStreamCompatibility = videoProfileCompatibility({
    ...captureConfig,
    streamEnabled: true
  })
  const liveStreamEntitlementReason = entitlementDisabledReason(entitlements, 'livestreaming')
  const goLiveEntitlement = goLiveEntitlementGate({
    entitlements,
    streaming: captureConfig.streaming
  })
  const goLiveEntitlementBlocker = goLiveEntitlement.allowed ? null : goLiveEntitlement
  const liveStreamBlockedReason =
    liveStreamEntitlementReason ??
    goLiveEntitlementBlocker?.reason ??
    liveStreamCompatibility.blockingReason
  const recordCompatibility = videoProfileCompatibility({
    ...captureConfig,
    recordEnabled: true,
    streamEnabled: false
  })
  // The start-blocking copy table (plan 174 B-22), shared with the session's own gate.
  const recordBlockedReason =
    connectionBlockedReason(wsStatus) ??
    recordCompatibility.blockingReason ??
    (!health
      ? START_BLOCKED_COPY.checkingRecorder
      : !health.ffmpeg.available
        ? START_BLOCKED_COPY.recorderMissing
        : null)

  // Two-button start (plan 174 D3): Record and Go Live…, the same two starts
  // ⌘K offers, so the provider owns them. The latency clock arms on the click.
  const handleRecord = (): void => {
    noteRecordClick('start')
    startRecording()
  }
  const handleLiveStream = (): void => {
    if (liveStreamBlockedReason) {
      return
    }
    noteRecordClick('start')
    startLivestream()
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
    if (!recordBlockedReason && !startRequestPending) handleRecord()
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
  const stopControl = sessionStopControl(recording, stopRequestPending, captureConfig.streamEnabled)

  // The status pill rides the inspector's transport block, so it exists in
  // every preview mode, docked included, and the mic sliver shares its one
  // home.
  const sessionStatus = (
    <span className="flex items-center gap-1.5">
      <SessionMicSliver
        deviceName={studio.selectedMicrophone?.name}
        muted={captureConfig.audio.microphoneMuted}
        sessionActive={active}
      />
      <SessionStatusPill
        recording={recording}
        startBlocked={Boolean(visibleStartBlockedReason)}
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
          <SessionTransport
            active={active}
            canStop={canStop}
            liveStreamBlockedReason={liveStreamBlockedReason}
            recordBlockedReason={recordBlockedReason}
            startRequestPending={startRequestPending}
            status={sessionStatus}
            stopLabel={stopControl.label}
            stopNote={stopControl.note}
            onLiveStream={handleLiveStream}
            onRecord={handleRecord}
            onStop={() => handleStop('button')}
          />
        </div>

        <aside aria-label="Session inspector" className={STUDIO_INSPECTOR}>
          <SessionPanel
            active={active}
            blockedJump={
              banner?.jumpTo && banner.jumpLabel
                ? { label: banner.jumpLabel, to: banner.jumpTo, settingsTab: banner.settingsTab }
                : null
            }
            blockedReason={visibleStartBlockedReason}
            runtimeNotice={sessionRuntimeNotice}
            startFailure={sessionStartFailure}
            startRequestPending={startRequestPending}
            onDismissRuntimeNotice={dismissSessionRuntimeNotice}
            onDismissStartFailure={dismissSessionStartFailure}
            onRetryStart={retrySessionStart}
          />
          {/* The microphone and its live level, between Session and Inputs
              (owner call, 2026-10-02): a check that runs all the time. */}
          <Suspense fallback={<MicrophoneSectionFallback />}>
            <MicrophoneSection />
          </Suspense>
          {/* Sources (Screen, Camera, System audio) and Captions: compact
              mirrors editing the same captureConfig, each with a way to its
              page. Output is the Session row above (plan 174 S3.3, B-15). */}
          <QuickSettings />
          <TakeoverSection />
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

/** The Microphone section's height while its chunk loads: the picker and the meter row. */
function MicrophoneSectionFallback(): ReactElement {
  return (
    <PanelSection title="Microphone">
      <Skeleton className="h-control rounded-chip" />
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
  const active = isSessionTransportActive(recording.state)
  const previewHealth = studioHealth(
    diagnosticStats,
    active,
    runtimeInfo?.platform,
    previewSurfaceStatus.nativePreviewHostKind
  )
  const docked =
    nativePreviewSurfaceEnabled && previewWindow.open && previewWindow.mode === 'docked'

  const healthErrorRow =
    previewHealth.tone === 'error' && previewHealth.detail ? (
      <Alert data-testid="capture-health-alert" variant="destructive">
        <AlertTitle>{previewHealth.value}</AlertTitle>
        <AlertDescription className="min-w-0">
          <p className="line-clamp-3" title={previewHealth.detail}>
            {previewHealth.detail}
          </p>
        </AlertDescription>
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

function studioBlocker(studio: ReturnType<typeof useStudioCore>): {
  title: string
  jumpTo?: WorkspaceTab | StudioPanel
  /** With `jumpTo: 'settings'`, the Settings tab that owns the fix. */
  settingsTab?: SettingsTabId
  jumpLabel?: string
} | null {
  const { wsStatus, outputEnabled, captureConfig, streamReady, health, entitlements } = studio
  const goLiveEntitlement = captureConfig.streamEnabled
    ? goLiveEntitlementGate({ entitlements, streaming: captureConfig.streaming })
    : { allowed: true as const }

  // The start-blocking copy (plan 174 B-22): the streamer's words and the
  // page's real name on every jump.
  const disconnected = connectionBlockedReason(wsStatus)
  if (disconnected) {
    return { title: disconnected }
  }
  if (!outputEnabled) {
    return { title: 'Nothing to record or stream', jumpTo: 'recording', jumpLabel: 'Open Output' }
  }
  if (captureConfig.streamEnabled && !goLiveEntitlement.allowed) {
    return {
      title: goLiveEntitlement.upgradeUrl ? 'Premium required' : 'Streaming limit reached',
      jumpTo: 'live',
      jumpLabel: 'Open Livestream'
    }
  }
  if (captureConfig.streamEnabled && !streamReady) {
    return {
      title: 'Finish setting up your destination',
      jumpTo: 'live',
      jumpLabel: 'Open Livestream'
    }
  }
  if (health && !health.ffmpeg.available) {
    return {
      title: "Videorc's recorder isn't available",
      jumpTo: 'settings',
      settingsTab: 'recording',
      jumpLabel: 'Open Settings'
    }
  }
  return { title: 'Finish setup to start' }
}
