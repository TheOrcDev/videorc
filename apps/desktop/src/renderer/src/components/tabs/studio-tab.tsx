import { ExternalLinkIcon, PinIcon } from '@/components/icons'
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
import { Button } from '@/components/ui/button'
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
import type { SettingsTabId } from '@/lib/settings-tabs'
import { studioHealth } from '@/lib/studio-health'
import {
  isSessionTransportActive,
  sessionIsLive,
  sessionStopControl
} from '@/lib/studio-session-view'
import { spaceShortcutBlocked } from '@/lib/studio-space-shortcut'

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

  const active = isSessionTransportActive(recording.state)
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

  // The Go Live confirmation is the shell's (GoLiveDialogGate), so it opens
  // over every page, not only this one (plan 174 S0.6, B-5).
  return (
    <>
      {/* The Studio bench: the preview pane leads, and the inspector (the
          transport, session facts, microphone, inputs, takeover) sits beside
          it, split by a hairline. Hard
          blocks surface inside the Session section, never as a yellow top
          banner (post-0.9.4 fix batch F8). */}
      <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="min-w-0 lg:border-r">
          <StudioPreviewPanel />
          {/* Scenes and the vertical leg: deferred so the launch surface
              paints its preview and transport first. */}
          <Suspense fallback={<StudioDashboardBottomRowFallback />}>
            <StudioDashboardBottomRow />
          </Suspense>
        </div>

        <aside aria-label="Session inspector" className="min-w-0 border-t lg:border-t-0">
          {/* Record, Go Live…, and the clock sit at the top of the
              inspector, right above Session (owner call, 2026-09-23); Space
              still records. */}
          <SessionTransport
            active={active}
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
          {/* Inputs: compact mirrors of Screen / Camera / System audio / Output
              / Captions, each editing the same captureConfig and deep-linking
              to its page. */}
          <QuickSettings />
          <TakeoverSection />
        </aside>
      </div>
    </>
  )
}

function StudioDashboardBottomRowFallback(): ReactElement {
  return (
    <div className="flex flex-col" aria-label="Loading Studio controls">
      <PanelSection title="Scenes">
        <div className="h-24 rounded-row bg-foreground/[0.04]" />
      </PanelSection>
    </div>
  )
}

/** The Microphone section's height while its chunk loads: the picker and the meter row. */
function MicrophoneSectionFallback(): ReactElement {
  return (
    <PanelSection title="Microphone">
      <div className="h-control rounded-chip bg-foreground/[0.04]" />
      <div className="h-4 rounded-chip bg-foreground/[0.04]" />
    </PanelSection>
  )
}

function StudioPreviewPanel(): ReactElement {
  const {
    nativePreviewSurfaceEnabled,
    handleSystemPermission,
    openPreviewWindow,
    previewWindow,
    refreshPreview,
    runtimeInfo,
    setPreviewWindowMode
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

  return (
    <PanelSection
      title="Preview"
      action={
        <div className="flex items-center gap-1.5">
          {previewWindow.open && previewWindow.mode === 'floating' ? (
            <Button
              aria-label="Stick preview into the app"
              size="icon"
              title="Stick the preview into this panel"
              variant="ghost"
              onClick={() => void setPreviewWindowMode('docked')}
            >
              <PinIcon className="size-4" />
            </Button>
          ) : previewWindow.open ? (
            <Button
              aria-label="Pop preview out into its own window"
              size="icon"
              title="Pop the preview out into its own window"
              variant="ghost"
              onClick={() => void setPreviewWindowMode('floating')}
            >
              <ExternalLinkIcon className="size-4" />
            </Button>
          ) : (
            <Button
              aria-label="Open preview window"
              size="icon"
              title="Open preview in its own window"
              variant="ghost"
              onClick={() => void openPreviewWindow()}
            >
              <ExternalLinkIcon className="size-4" />
            </Button>
          )}
        </div>
      }
    >
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
  jumpTo?: WorkspaceTab | StudioPanel
  /** With `jumpTo: 'settings'`, the Settings tab that owns the fix. */
  settingsTab?: SettingsTabId
  jumpLabel?: string
} | null {
  const { wsStatus, recordBlockedReason, captureConfig, health, entitlements } = studio
  if (wsStatus !== 'connected') {
    return null
  }
  if (recordBlockedReason) {
    if (health && !health.ffmpeg.available) {
      return { jumpTo: 'settings', settingsTab: 'recording', jumpLabel: 'Open Settings' }
    }
    return null
  }
  const goLiveEntitlement = goLiveEntitlementGate({
    entitlements,
    streaming: captureConfig.streaming
  })
  if (!goLiveEntitlement.allowed || !areEnabledStreamTargetsStartReady(captureConfig.streaming)) {
    return { jumpTo: 'live', jumpLabel: 'Open Livestream' }
  }
  return null
}
