import { AlertIcon, ExternalLinkIcon, PinIcon } from '@/components/icons'
import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react'

import { GoLiveConfirmationDialog } from '@/components/go-live-dialog'
import { PanelSection } from '@/components/panel-section'
import { PreviewStage } from '@/components/preview-stage'
import { StatusBadge } from '@/components/status-badge'
import { QuickSettings } from '@/components/studio/quick-settings'
import { SessionMicSliver } from '@/components/studio/session-mic-sliver'
import { SessionPanel, SessionTransport, TakeoverSection } from '@/components/studio/session-panel'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
  isSessionTransportActive,
  sessionStatusLabel,
  sessionStatusTone
} from '@/lib/studio-session-view'

const StudioDashboardBottomRow = lazy(async () => ({
  default: (await import('@/components/studio/studio-dashboard-bottom-row'))
    .StudioDashboardBottomRow
}))

export function StudioTab(): ReactElement {
  const studio = useStudioCore()
  const { recording } = useStudioRecordingState()
  const {
    canStop,
    startRequestPending,
    stopRequestPending,
    visibleStartBlockedReason,
    startSession,
    stopSession,
    noteRecordClick,
    captureConfig,
    setCaptureConfig,
    entitlements,
    wsStatus,
    health,
    goLiveConfirmationOpen,
    goLiveConfirmationPending,
    goLivePartialSetup,
    goLivePreflight,
    goLiveCaptionsReadiness,
    streamMetadataDraft,
    patchStreamMetadataDraft,
    cancelGoLiveConfirmation,
    confirmGoLive,
    continueGoLiveWithReadyDestinations,
    continueGoLiveWithoutCaptions,
    resolveGoLiveBlocker,
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
  const recordBlockedReason =
    wsStatus !== 'connected'
      ? `Backend socket is ${wsStatus}.`
      : recordCompatibility.blockingReason
        ? recordCompatibility.blockingReason
        : !health
          ? 'Checking FFmpeg before starting.'
          : !health.ffmpeg.available
            ? (health.ffmpeg.message ?? 'FFmpeg is not available.')
            : null

  // Two-button start: when the click changes the output mode (record vs go-live),
  // set it and start on the next render so startSession and its blocked-reason
  // gate see the updated streamEnabled instead of a stale closure value. When the
  // config already matches the button, start in the same task — the extra
  // render+commit of the whole Studio provider was a measurable slice of the
  // Record click → recording path.
  const [pendingStart, setPendingStart] = useState(false)
  useEffect(() => {
    if (!pendingStart) {
      return
    }
    setPendingStart(false)
    void startSession()
  }, [pendingStart, startSession])

  const handleRecord = (): void => {
    noteRecordClick('start')
    if (captureConfig.recordEnabled && !captureConfig.streamEnabled) {
      void startSession()
      return
    }
    setCaptureConfig((current) => ({ ...current, recordEnabled: true, streamEnabled: false }))
    setPendingStart(true)
  }
  const handleLiveStream = (): void => {
    if (liveStreamBlockedReason) {
      return
    }
    noteRecordClick('start')
    if (captureConfig.streamEnabled) {
      void startSession()
      return
    }
    setCaptureConfig((current) => ({ ...current, streamEnabled: true }))
    setPendingStart(true)
  }
  const handleStop = (): void => {
    noteRecordClick('stop')
    void stopSession()
  }

  const stopLabel = stopRequestPending
    ? 'Stopping…'
    : recording.state === 'stopping'
      ? 'Force stop'
      : recording.state === 'streaming'
        ? 'End livestream'
        : 'Stop recording'

  // data hook: the backend-resilience and captions smokes read this badge.
  // It rides the inspector's transport block, so it exists in every preview
  // mode, docked included, and the mic sliver shares its one home.
  const sessionStatus = (
    <span className="flex items-center gap-1.5">
      <SessionMicSliver
        deviceName={studio.selectedMicrophone?.name}
        muted={captureConfig.audio.microphoneMuted}
        sessionActive={active}
      />
      <span data-videorc-session-status>
        <StatusBadge
          tone={sessionStatusTone(recording.state, wsStatus)}
          value={sessionStatusLabel(recording.state, wsStatus)}
        />
      </span>
    </span>
  )

  return (
    <>
      <GoLiveConfirmationDialog
        draft={streamMetadataDraft}
        captionsReadiness={goLiveCaptionsReadiness}
        entitlementGate={goLiveEntitlement}
        open={goLiveConfirmationOpen}
        pending={goLiveConfirmationPending || startRequestPending}
        preflight={goLivePreflight}
        partialSetup={goLivePartialSetup}
        onCancel={cancelGoLiveConfirmation}
        onConfirm={() => void confirmGoLive()}
        onContinuePartial={() => void continueGoLiveWithReadyDestinations()}
        onContinueWithoutCaptions={continueGoLiveWithoutCaptions}
        onPatchDraft={patchStreamMetadataDraft}
        onResolveBlocker={(targetId, resolution) => void resolveGoLiveBlocker(targetId, resolution)}
      />

      {/* The Studio bench: the preview pane leads, and the inspector (the
          transport, session facts, inputs, takeover) sits beside it, split by
          a hairline. Hard
          blocks surface inside the Session section, never as a yellow top
          banner (post-0.9.4 fix batch F8). */}
      <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="min-w-0 lg:border-r">
          <StudioPreviewPanel />
          {/* Scenes, the vertical leg, and the mixer: deferred so the launch
              surface paints its preview and transport first. */}
          <Suspense fallback={<StudioDashboardBottomRowFallback />}>
            <StudioDashboardBottomRow />
          </Suspense>
        </div>

        <aside aria-label="Session inspector" className="min-w-0 border-t lg:border-t-0">
          {/* Record, Stream, and the clock sit at the top of the inspector,
              right above Session (owner call, 2026-09-23); Space still
              records. */}
          <SessionTransport
            active={active}
            canStop={canStop}
            liveStreamBlockedReason={liveStreamBlockedReason}
            recordBlockedReason={recordBlockedReason}
            startRequestPending={startRequestPending}
            status={sessionStatus}
            stopLabel={stopLabel}
            onLiveStream={handleLiveStream}
            onRecord={handleRecord}
            onStop={handleStop}
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
          {/* Inputs: compact mirrors of Source / Mic / Output / Captions, each
              editing the same captureConfig and deep-linking to its page. */}
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
      <PanelSection title="Audio mixer">
        <div className="h-24 rounded-row bg-foreground/[0.04]" />
      </PanelSection>
    </div>
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
        <AlertIcon weight="fill" />
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

  if (wsStatus !== 'connected') {
    return { title: 'Backend not connected' }
  }
  if (!outputEnabled) {
    return { title: 'No output enabled', jumpTo: 'recording', jumpLabel: 'Open Recording' }
  }
  if (captureConfig.streamEnabled && !goLiveEntitlement.allowed) {
    return {
      title: goLiveEntitlement.upgradeUrl ? 'Premium required' : 'Streaming limit reached',
      jumpTo: 'live',
      jumpLabel: 'Open Live'
    }
  }
  if (captureConfig.streamEnabled && !streamReady) {
    return { title: 'Stream target incomplete', jumpTo: 'live', jumpLabel: 'Open Live' }
  }
  if (health && !health.ffmpeg.available) {
    return {
      title: 'FFmpeg unavailable',
      jumpTo: 'settings',
      settingsTab: 'recording',
      jumpLabel: 'Open Settings'
    }
  }
  return { title: 'Finish setup to start' }
}
