import {
  ArrowSquareOut,
  Broadcast,
  CaretDown,
  GearSix,
  Record,
  StopCircle,
  WarningCircle,
  X
} from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { BlockingBanner } from '@/components/blocking-banner'
import { GoLiveConfirmationDialog } from '@/components/go-live-dialog'
import { LiveChatRail } from '@/components/live-chat-rail'
import { PageHeader, PageStack } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { PreviewStage } from '@/components/preview-stage'
import { StatusBadge } from '@/components/status-badge'
import { AudioMixer } from '@/components/studio/audio-mixer'
import { QuickSettings } from '@/components/studio/quick-settings'
import { ScenesGallery } from '@/components/studio/scenes-gallery'
import { SessionPanel } from '@/components/studio/session-panel'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { useWorkspaceNav, type StudioPanel, type WorkspaceTab } from '@/components/workspace-nav'
import { useStudio } from '@/hooks/use-studio'
import { videoProfileCompatibility } from '@/lib/capture'
import { goLiveEntitlementGate } from '@/lib/entitlement-ui'
import { entitlementDisabledReason } from '@/lib/entitlements'
import { liveChatRailAvailable, shouldAutoOpenLiveChatRail } from '@/lib/live-chat-surface'
import { studioHealth } from '@/lib/studio-health'
import { sessionStatusLabel, sessionStatusTone } from '@/lib/studio-session-view'

export function StudioTab(): ReactElement {
  const studio = useStudio()
  const {
    recording,
    elapsed,
    canStop,
    startRequestPending,
    stopRequestPending,
    visibleStartBlockedReason,
    startSession,
    stopSession,
    captureConfig,
    setCaptureConfig,
    entitlements,
    previewLiveStatus,
    previewSurfaceStatus,
    nativePreviewSurfaceEnabled,
    refreshPreview,
    openPreviewPermissions,
    openPreviewWindow,
    wsStatus,
    health,
    diagnosticStats,
    goLiveConfirmationOpen,
    goLiveConfirmationPending,
    goLivePartialSetup,
    goLivePreflight,
    streamMetadataDraft,
    patchStreamMetadataDraft,
    cancelGoLiveConfirmation,
    confirmGoLive,
    continueGoLiveWithReadyDestinations,
    resolveGoLiveBlocker
  } = studio

  const active = recording.state === 'recording' || recording.state === 'streaming'
  const previewHealth = studioHealth(diagnosticStats, active)
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

  // Live chat rail: live while streaming, retained after stop while the in-memory
  // transcript still has comments. It clears once the local chat view is cleared.
  const chatProvidersAttached = studio.liveChatSnapshot.providers.length > 0
  const chatRailAvailable = liveChatRailAvailable(recording.state, studio.liveChatSnapshot)
  const [chatRailOpen, setChatRailOpen] = useState(false)
  const chatAutoOpened = useRef(false)
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
        snapshot: studio.liveChatSnapshot
      })
    ) {
      chatAutoOpened.current = true
      setChatRailOpen(true)
    }
  }, [chatRailAvailable, chatProvidersAttached, recording.state, studio.liveChatSnapshot])
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
          entitlementGate={goLiveEntitlement}
          open={goLiveConfirmationOpen}
          pending={goLiveConfirmationPending || startRequestPending}
          preflight={goLivePreflight}
          partialSetup={goLivePartialSetup}
          onCancel={cancelGoLiveConfirmation}
          onConfirm={() => void confirmGoLive()}
          onContinuePartial={() => void continueGoLiveWithReadyDestinations()}
          onPatchDraft={patchStreamMetadataDraft}
          onResolveBlocker={(targetId, resolution) =>
            void resolveGoLiveBlocker(targetId, resolution)
          }
        />

        <PageStack>
          {/* Dashboard header: title + the transport (Record split-button + Go
              Live, or the timer + Stop while live). Reuses the existing
              record/go-live/stop handlers — no second session state machine. */}
          <PageHeader
            title="Studio"
            description="Professional recording and streaming made simple."
            action={
              <StudioTransport
                active={active}
                canStop={canStop}
                elapsed={elapsed}
                liveStreamBlockedReason={liveStreamBlockedReason}
                recordBlockedReason={recordBlockedReason}
                recordingMessage={recording.message ?? null}
                recordingState={recording.state}
                startRequestPending={startRequestPending}
                stopLabel={stopLabel}
                wsStatus={wsStatus}
                onLiveStream={handleLiveStream}
                onRecord={handleRecord}
                onStop={stopSession}
              />
            }
          />

          {/* Hard block (can't start): a banner with a jump to the owning page. */}
          {visibleStartBlockedReason && banner ? (
            <BlockingBanner
              description={visibleStartBlockedReason}
              jumpLabel={banner.jumpLabel}
              jumpTo={banner.jumpTo}
              title={banner.title}
              tone="warning"
            />
          ) : null}

          {/* Soft, dismissible compatibility warning (the mockup's 4K banner). */}
          <StudioWarningBanner reason={!active ? liveStreamBlockedReason : null} />

          {/* Preview (left, the hero) + Session facts & controls (right). */}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <PanelSection
              title="Preview"
              action={
                <div className="flex items-center gap-1.5">
                  <StatusBadge
                    tone={sessionStatusTone(recording.state)}
                    value={sessionStatusLabel(recording.state)}
                  />
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
                </div>
              }
            >
              <PreviewStage
                nativePreviewSurfaceEnabled={nativePreviewSurfaceEnabled}
                previewLiveStatus={previewLiveStatus}
                previewSurfaceStatus={previewSurfaceStatus}
                onOpenPermissions={openPreviewPermissions}
                onRetry={refreshPreview}
              />
              {previewHealth.tone === 'error' && previewHealth.detail ? (
                <div className="flex items-center gap-2 rounded-row border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive">
                  <WarningCircle className="size-4 shrink-0" weight="fill" />
                  <span className="min-w-0">{previewHealth.detail}</span>
                </div>
              ) : null}
            </PanelSection>

            <SessionPanel
              active={active}
              canStop={canStop}
              liveStreamBlockedReason={liveStreamBlockedReason}
              recordBlockedReason={recordBlockedReason}
              recordingState={recording.state}
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
          <div className="grid gap-5 lg:grid-cols-2">
            <ScenesGallery />
            <AudioMixer />
          </div>
        </PageStack>
      </div>

      {chatRailOpen && chatRailAvailable ? (
        <LiveChatRail
          snapshot={studio.liveChatSnapshot}
          windowOpen={studio.commentsWindow.open}
          onClearLocal={studio.clearLiveChat}
          onClose={() => setChatRailOpen(false)}
          onPopOut={studio.toggleCommentsWindow}
        />
      ) : null}
    </div>
  )
}

// Dashboard transport (Record split-button + Go Live; timer + Stop while live).
// Pure presentation: it calls the same handlers StudioTab owns (record/go-live
// set the mode then start; Go Live flows through the existing preflight dialog),
// so there is no second session state machine. Blocked reasons surface as the
// button title; a 'failed' state shows inline so it is never lost.
function StudioTransport({
  active,
  canStop,
  elapsed,
  startRequestPending,
  stopLabel,
  recordBlockedReason,
  liveStreamBlockedReason,
  recordingState,
  recordingMessage,
  wsStatus,
  onRecord,
  onLiveStream,
  onStop
}: {
  active: boolean
  canStop: boolean
  elapsed: string
  startRequestPending: boolean
  stopLabel: string
  recordBlockedReason: string | null
  liveStreamBlockedReason: string | null
  recordingState: string
  recordingMessage: string | null
  wsStatus: string
  onRecord: () => void
  onLiveStream: () => void
  onStop: () => void
}): ReactElement {
  const { openStudioPanel } = useWorkspaceNav()

  return (
    <div className="flex items-center gap-2">
      {/* Live region: recording state is otherwise conveyed only by the button
          set, so announce idle→recording→streaming→stopped/failed for screen
          readers. A failure also renders visibly here. */}
      <div aria-atomic="true" aria-live="polite">
        {recordingState === 'failed' ? (
          <span className="flex items-center gap-1.5 rounded-chip bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
            <WarningCircle className="size-3.5 shrink-0" weight="fill" />
            {recordingMessage ?? 'Recording failed'}
          </span>
        ) : (
          <span className="sr-only">{`Recording ${recordingState}. ${recordingMessage ?? ''}`}</span>
        )}
      </div>

      {active ? (
        <>
          <time className="px-1.5 font-heading text-lg font-semibold tabular-nums">{elapsed}</time>
          <Button disabled={!canStop} size="sm" variant="destructive" onClick={onStop}>
            <StopCircle data-icon="inline-start" weight="fill" />
            {stopLabel}
            <Kbd className="ml-1.5">␣</Kbd>
          </Button>
        </>
      ) : (
        <>
          {/* Record split-button: primary records to file; the caret carries
              record-specific options (settings shortcut). */}
          <div className="flex items-center">
            <Button
              className="rounded-r-none"
              disabled={Boolean(recordBlockedReason) || startRequestPending}
              size="sm"
              title={recordBlockedReason ?? 'Record to a file (Space)'}
              variant="destructive"
              onClick={onRecord}
            >
              <Record data-icon="inline-start" weight="fill" />
              {startRequestPending ? 'Starting…' : 'Record'}
              <Kbd className="ml-1.5">␣</Kbd>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Record options"
                  className="rounded-l-none border-l border-l-black/15 px-1.5 dark:border-l-white/15"
                  disabled={startRequestPending}
                  size="sm"
                  variant="destructive"
                >
                  <CaretDown className="size-3.5" weight="bold" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={Boolean(recordBlockedReason)}
                  onSelect={(event) => {
                    event.preventDefault()
                    onRecord()
                  }}
                >
                  <Record data-icon="inline-start" weight="fill" />
                  Record to file
                  <Kbd className="ml-auto">␣</Kbd>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => openStudioPanel('recording')}>
                  <GearSix data-icon="inline-start" />
                  Recording settings…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button
            disabled={
              wsStatus !== 'connected' || startRequestPending || Boolean(liveStreamBlockedReason)
            }
            size="sm"
            title={liveStreamBlockedReason ?? 'Start livestream'}
            variant="outline"
            onClick={onLiveStream}
          >
            <Broadcast data-icon="inline-start" weight="fill" />
            Go Live
          </Button>
        </>
      )}
    </div>
  )
}

// Dismissible compatibility warning (the mockup's "4K livestreaming…" strip).
// Keyed by the reason text so a different/new warning re-appears after dismiss.
function StudioWarningBanner({ reason }: { reason: string | null }): ReactElement | null {
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!reason || dismissed === reason) {
    return null
  }
  return (
    <div className="flex items-start gap-2.5 rounded-row border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-sm text-warning-foreground dark:text-warning">
      <WarningCircle className="mt-px size-4 shrink-0" weight="fill" />
      <span className="min-w-0 flex-1">{reason}</span>
      <button
        aria-label="Dismiss"
        className="-mr-1 -mt-0.5 shrink-0 rounded-chip p-1 text-warning-foreground/70 transition-colors hover:bg-warning/20 hover:text-warning-foreground dark:text-warning/70 dark:hover:text-warning"
        type="button"
        onClick={() => setDismissed(reason)}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

function studioBlocker(studio: ReturnType<typeof useStudio>): {
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
