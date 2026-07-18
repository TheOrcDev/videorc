import { ArrowSquareOut, PushPinSimple, WarningCircle } from '@phosphor-icons/react'
import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from 'react'

import { GoLiveConfirmationDialog } from '@/components/go-live-dialog'
import { LiveChatRail } from '@/components/live-chat-rail'
import { ObsImportNudge } from '@/components/obs-import-nudge'
import { PageStack } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { PreviewStage } from '@/components/preview-stage'
import { StatusBadge } from '@/components/status-badge'
import { QuickSettings } from '@/components/studio/quick-settings'
import { SessionMicSliver } from '@/components/studio/session-mic-sliver'
import { SessionPanel } from '@/components/studio/session-panel'
import { Button } from '@/components/ui/button'
import type { StudioPanel, WorkspaceTab } from '@/components/workspace-nav'
import {
  useStudioChat,
  useStudioCore,
  useStudioDiagnostics,
  useStudioPreview,
  useStudioRecordingState
} from '@/hooks/use-studio'
import { videoProfileCompatibility } from '@/lib/capture'
import { goLiveEntitlementGate } from '@/lib/entitlement-ui'
import { entitlementDisabledReason } from '@/lib/entitlements'
import { liveChatRailAvailable, shouldAutoOpenLiveChatRail } from '@/lib/live-chat-surface'
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
    resolveGoLiveBlocker
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

  // Two-button start: set the intended mode, then start on the next render so startSession
  // sees the updated streamEnabled (record vs go-live) instead of a stale closure value.
  const [pendingStart, setPendingStart] = useState(false)
  useEffect(() => {
    if (!pendingStart) {
      return
    }
    setPendingStart(false)
    void startSession()
  }, [pendingStart, startSession])

  const handleRecord = (): void => {
    setCaptureConfig((current) => ({ ...current, recordEnabled: true, streamEnabled: false }))
    setPendingStart(true)
  }
  const handleLiveStream = (): void => {
    if (liveStreamBlockedReason) {
      return
    }
    setCaptureConfig((current) => ({ ...current, streamEnabled: true }))
    setPendingStart(true)
  }

  const stopLabel = stopRequestPending
    ? 'Stopping…'
    : recording.state === 'stopping'
      ? 'Force stop'
      : recording.state === 'streaming'
        ? 'End livestream'
        : 'Stop recording'

  return (
    <div className="flex items-start gap-5">
      <div className="min-w-0 flex-1">
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
          onResolveBlocker={(targetId, resolution) =>
            void resolveGoLiveBlocker(targetId, resolution)
          }
        />

        <PageStack>
          {/* Fresh-profile OBS hint (O5): quiet, dismissible, gone forever once
              a capture source exists — never a nag. */}
          <ObsImportNudge />
          {/* Hard blocks surface INSIDE the Session panel next to the disabled
              buttons (quiet inline line + jump link) — the yellow top banner
              made the Studio read as broken (post-0.9.4 fix batch F8). */}

          {/* Preview (left, the hero) + Session facts & controls (right). */}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <StudioPreviewPanel />

            <SessionPanel
              active={active}
              blockedJump={
                banner?.jumpTo && banner.jumpLabel
                  ? { label: banner.jumpLabel, to: banner.jumpTo }
                  : null
              }
              blockedReason={visibleStartBlockedReason}
              canStop={canStop}
              liveStreamBlockedReason={liveStreamBlockedReason}
              recordBlockedReason={recordBlockedReason}
              startRequestPending={startRequestPending}
              stopLabel={stopLabel}
              onLiveStream={handleLiveStream}
              onRecord={handleRecord}
              onStop={stopSession}
            />
          </div>

          {/* Quick Settings: compact mirrors of Source / Mic / Layout / Output,
              each editing the same captureConfig and deep-linking to its page. */}
          <QuickSettings />

          {/* Scenes + Audio mixer — the dashboard's bottom row. Collapses to a
              single column below lg. */}
          <Suspense fallback={<StudioDashboardBottomRowFallback />}>
            <StudioDashboardBottomRow />
          </Suspense>
        </PageStack>
      </div>

      <StudioLiveChatRail />
    </div>
  )
}

function StudioDashboardBottomRowFallback(): ReactElement {
  return (
    <div className="grid gap-5 lg:grid-cols-2" aria-label="Loading Studio controls">
      <PanelSection title="Scenes">
        <div className="h-24 rounded-row border bg-muted/20" />
      </PanelSection>
      <PanelSection title="Audio mixer">
        <div className="h-24 rounded-row border bg-muted/20" />
      </PanelSection>
    </div>
  )
}

function StudioPreviewPanel(): ReactElement {
  const {
    captureConfig,
    nativePreviewSurfaceEnabled,
    handleSystemPermission,
    openPreviewWindow,
    previewWindow,
    refreshPreview,
    runtimeInfo,
    selectedMicrophone,
    setPreviewWindowMode,
    wsStatus
  } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const { previewLiveStatus } = useStudioPreview()
  const { diagnosticStats, previewSurfaceStatus } = useStudioDiagnostics()
  const active = isSessionTransportActive(recording.state)
  const previewHealth = studioHealth(diagnosticStats, active, runtimeInfo?.platform)
  const docked =
    nativePreviewSurfaceEnabled && previewWindow.open && previewWindow.mode === 'docked'

  // data hook: the backend-resilience smoke reads this badge (the old probe
  // grepped for a "Status" text prefix that died with the session-panel
  // declutter). It must exist in every preview mode, docked included. The mic
  // sliver rides the same cluster so it has exactly one home wherever the
  // status renders (panel header or docked control row).
  const sessionStatusBadge = (
    <span className="flex items-center gap-1.5">
      <SessionMicSliver
        deviceName={selectedMicrophone?.name}
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

  const healthErrorRow =
    previewHealth.tone === 'error' && previewHealth.detail ? (
      <div className="flex items-center gap-2 rounded-row border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive">
        <WarningCircle className="size-4 shrink-0" weight="fill" />
        <span className="min-w-0">{previewHealth.detail}</span>
      </div>
    ) : null

  const previewStage = (
    <PreviewStage
      dockedFooterStart={sessionStatusBadge}
      nativePreviewSurfaceEnabled={nativePreviewSurfaceEnabled}
      previewLiveStatus={previewLiveStatus}
      previewSurfaceStatus={previewSurfaceStatus}
      onOpenPermissions={(pane) => void handleSystemPermission(pane)}
      onRetry={refreshPreview}
    />
  )

  // Docked ("stick") mode: the preview stands alone — no glass card, no
  // border, no panel header. The native surface and its black frame ARE the
  // panel; the docked frame's own control row carries status and dock actions.
  if (docked) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
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
          {sessionStatusBadge}
          {previewWindow.open && previewWindow.mode === 'floating' ? (
            <Button
              aria-label="Stick preview into the app"
              className="size-8"
              size="icon"
              title="Stick the preview into this panel"
              variant="ghost"
              onClick={() => void setPreviewWindowMode('docked')}
            >
              <PushPinSimple className="size-4" />
            </Button>
          ) : previewWindow.open ? (
            <Button
              aria-label="Pop preview out into its own window"
              className="size-8"
              size="icon"
              title="Pop the preview out into its own window"
              variant="ghost"
              onClick={() => void setPreviewWindowMode('floating')}
            >
              <ArrowSquareOut className="size-4" />
            </Button>
          ) : (
            <Button
              aria-label="Open preview window"
              className="size-8"
              size="icon"
              title="Open preview in its own window"
              variant="ghost"
              onClick={() => void openPreviewWindow()}
            >
              <ArrowSquareOut className="size-4" />
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

function StudioLiveChatRail(): ReactElement | null {
  const studio = useStudioCore()
  const { recording } = useStudioRecordingState()
  const { liveChatSnapshot } = useStudioChat()
  const chatProvidersAttached = liveChatSnapshot.providers.length > 0
  const chatRailAvailable = liveChatRailAvailable(recording.state, liveChatSnapshot)
  const [chatRailOpen, setChatRailOpen] = useState(false)
  const chatAutoOpened = useRef(false)

  // Live while streaming, retained after stop while the in-memory transcript
  // still has comments. It clears once the local chat view is cleared.
  useEffect(() => {
    if (!chatRailAvailable) {
      chatAutoOpened.current = false
      setChatRailOpen(false)
      return
    }
    if (
      shouldAutoOpenLiveChatRail({
        alreadyAutoOpened: chatAutoOpened.current,
        providersAttached: chatProvidersAttached,
        recordingState: recording.state,
        snapshot: liveChatSnapshot
      })
    ) {
      chatAutoOpened.current = true
      setChatRailOpen(true)
    }
  }, [chatRailAvailable, chatProvidersAttached, liveChatSnapshot, recording.state])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'j' && !event.shiftKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        if (chatRailAvailable) {
          setChatRailOpen((value) => !value)
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [chatRailAvailable])

  if (!chatRailOpen || !chatRailAvailable) {
    return null
  }

  return (
    <LiveChatRail
      highlightedId={studio.highlightedCommentId}
      highlightApplyingId={studio.commentHighlightApplyingId}
      highlightFailure={studio.commentHighlightFailure}
      highlightState={studio.commentHighlightState}
      snapshot={liveChatSnapshot}
      windowOpen={studio.commentsWindow.open}
      onClearLocal={studio.clearLiveChat}
      onClose={() => setChatRailOpen(false)}
      onHighlight={studio.toggleCommentHighlight}
      onPopOut={studio.toggleCommentsWindow}
      platform={studio.runtimeInfo?.platform}
    />
  )
}

function studioBlocker(studio: ReturnType<typeof useStudioCore>): {
  title: string
  jumpTo?: WorkspaceTab | StudioPanel
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
    return { title: 'FFmpeg unavailable', jumpTo: 'settings', jumpLabel: 'Open Settings' }
  }
  return { title: 'Finish setup to start' }
}
