import { ChevronDownIcon, CloseIcon, HeartbeatIcon, WarningIcon } from '@/components/icons'
import { useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from 'react'

import { GroupedList } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { SupportBundleButton } from '@/components/support-bundle-button'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  useStudioCore,
  useStudioDiagnostics,
  useStudioPreview,
  useStudioRecording
} from '@/hooks/use-studio'
import type {
  BackendCrashRecord,
  DiagnosticStats,
  SessionLogEntry,
  SystemPermissionPane,
  ToolStatus,
  WebSocketQueueDiagnosticStats
} from '@/lib/backend'
import { backendCrashView, latestBackendCrash } from '@/lib/backend-crash-view'
import { NO_VALUE, compactTime, formatDroppedFrames, formatMetric, plural } from '@/lib/format'
import { formatBitrate, formatFrameRate } from '@/lib/format-video'
import {
  RECORDING_AT_RISK_ADVICE,
  checkNeedsAttention,
  formatBytes,
  healthChecks,
  healthVerdict,
  logLevelLabel,
  logTruncationNote,
  permissionWarnings,
  pipelineStageLabel,
  pipelineStateWords,
  slowdownAdvice,
  type HealthCheck,
  type HealthCheckId,
  type PermissionWarning
} from '@/lib/health-checks'
import { isMacPlatform } from '@/lib/platform'
import { formatLatencyMs, formatTimelineSummary, slowestTimelinePhase } from '@/lib/record-latency'
import { unknownDeviceWarnings } from '@/lib/source-status'
import { previewSourceStateLabel } from '@/lib/state-labels'
import { statusWordFromValue } from '@/lib/status-word'
import { mediaAccessStatusForPane, systemAccessAction } from '@/lib/system-access'
import { useSystemAccessRows } from '@/hooks/use-system-access-rows'
import { systemAccessActionLabel } from '@/lib/system-access-view'

// Health (plan 174 S3.18, I-4, I-25, V-7, D9): the page answers "is anything
// wrong?" first. One verdict, the warnings the streamer can act on, the
// checks that need attention (the rest behind "Show all checks"), and the
// support bundle. The engineering numbers, the recording pipeline and the
// logs fold into one closed "Technical details"; a group in it that is
// unhealthy opens itself.

/** How many log lines each log shows; the support bundle keeps more. */
const RECORDING_LOG_LIMIT = 120
const APP_LOG_LIMIT = 80

export function DiagnosticsTab(): ReactElement {
  const {
    handleSystemPermission,
    sessions,
    sessionDetails,
    sessionDetailsLoading,
    sessionDetailError,
    loadSessionDetails,
    streamTargets,
    nativePreviewSurfaceEnabled,
    captureConfig,
    deviceList,
    mediaAccess,
    runtimeInfo,
    health
  } = useStudioCore()
  const { recording } = useStudioRecording()
  const { previewLiveStatus, previewCameraStatus, previewScreenStatus } = useStudioPreview()
  const { diagnosticStats, healthEvents, logs, previewSurfaceStatus, recordLatency, streamHealth } =
    useStudioDiagnostics()
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const platform = runtimeInfo?.platform
  const currentSession = sessions.find((session) => session.id === recording.sessionId) ?? null
  const logSession = currentSession ?? sessions[0] ?? null
  const logSessionId = logSession?.id

  useEffect(() => {
    if (logSessionId) {
      void loadSessionDetails(logSessionId)
    }
  }, [logSessionId, loadSessionDetails])

  const accessRows = useSystemAccessRows()
  const deviceWarnings = unknownDeviceWarnings(deviceList.warnings)
  const permissionAction = (pane: SystemPermissionPane) =>
    systemAccessAction({
      pane,
      checking: accessRows.find((row) => row.id === pane)?.checking,
      state: accessRows.find((row) => row.id === pane)?.state,
      platform,
      mediaAccessStatus: mediaAccessStatusForPane(mediaAccess, pane)
    })
  const warnings = permissionWarnings(
    healthEvents,
    (pane) => permissionAction(pane) !== null,
    dismissed
  )
  const permissionName = (pane: SystemPermissionPane): string | null =>
    accessRows.find((row) => row.id === pane)?.label ?? null

  // Before runtimeInfo arrives the page assumes macOS, like the rest of Health.
  const checks = useMemo(
    () =>
      healthChecks({
        diagnosticStats,
        expectsCamera: Boolean(captureConfig.sources.cameraId),
        expectsScreen: Boolean(captureConfig.sources.screenId || captureConfig.sources.windowId),
        nativePreviewSurfaceEnabled,
        platform: platform ?? 'darwin',
        previewCameraStatus,
        previewLiveStatus,
        previewScreenStatus,
        previewSurfaceStatus,
        streamHealth,
        streamTargets
      }),
    [
      diagnosticStats,
      captureConfig.sources.cameraId,
      captureConfig.sources.screenId,
      captureConfig.sources.windowId,
      nativePreviewSurfaceEnabled,
      platform,
      previewCameraStatus,
      previewLiveStatus,
      previewScreenStatus,
      previewSurfaceStatus,
      streamHealth,
      streamTargets
    ]
  )
  const verdict = healthVerdict({
    checks,
    warnings: warnings.map((warning) => {
      const name = permissionName(warning.pane)
      return name ? `${name} permission` : 'A permission'
    }),
    advice:
      slowdownAdvice(diagnosticStats.bottleneck) ??
      (diagnosticStats.recordingAtRisk ? RECORDING_AT_RISK_ADVICE : null)
  })
  const needs = (...ids: HealthCheckId[]): boolean =>
    checks.some((check) => ids.includes(check.id) && checkNeedsAttention(check))

  const sessionLogs = (logSessionId && sessionDetails[logSessionId]?.sessionLogs) || []
  const sessionLogsError =
    logSessionId && sessionDetailError?.sessionId === logSessionId
      ? sessionDetailError.message
      : null
  const sessionLogsLoading = Boolean(logSessionId && sessionDetailsLoading.has(logSessionId))
  const pipelineFailed = Boolean(
    recording.pipeline?.stages.some((stage) => stage.state === 'failed')
  )
  // The FFmpeg line lives here since Settings → Recording went (plan 174 S3.6).
  const ffmpegMissing = Boolean(health && !health.ffmpeg.available)

  return (
    <div className="flex min-w-0 flex-col" data-testid="health-page">
      <PanelSection description="Is anything wrong right now?" icon={HeartbeatIcon} title="Checks">
        <Alert data-testid="health-verdict" role="status" variant={verdict.variant}>
          <AlertTitle>{verdict.title}</AlertTitle>
          {verdict.description ? <AlertDescription>{verdict.description}</AlertDescription> : null}
        </Alert>
        {warnings.map((warning) => (
          <PermissionWarningAlert
            key={warning.pane}
            actionLabel={systemAccessActionLabel(permissionAction(warning.pane), platform)}
            detail={accessRows.find((row) => row.id === warning.pane)?.detail ?? null}
            name={permissionName(warning.pane)}
            warning={warning}
            onDismiss={() => setDismissed((current) => new Set([...current, ...warning.eventIds]))}
            onFix={() => void handleSystemPermission(warning.pane)}
          />
        ))}
        {ffmpegMissing ? (
          <Alert data-testid="health-ffmpeg-missing" variant="warning">
            <AlertTitle>Videorc&apos;s recorder isn&apos;t available</AlertTitle>
            <AlertDescription>
              {import.meta.env.DEV
                ? 'For local development, install FFmpeg with “brew install ffmpeg”.'
                : 'It ships with Videorc, so this usually means the install is damaged. Reinstall Videorc.'}
            </AlertDescription>
          </Alert>
        ) : null}
        <CheckList checks={checks} />
      </PanelSection>

      <PanelSection
        action={<SupportBundleButton />}
        description="Redacted logs and Health's checks in one file, to send with a problem report."
        title="Support bundle"
      />

      <TechnicalDetails>
        <MetricGroup attention={needs('recording', 'slowdown', 'encoder')} title="Overview">
          <OverviewMetrics stats={diagnosticStats} streamHealth={streamHealth} />
        </MetricGroup>
        <MetricGroup title="Start and stop">
          <MetricGrid>
            <DiagnosticMetric
              label="Click → recording"
              value={formatLatencyMs(
                recordLatency.start?.kind === 'start'
                  ? recordLatency.start.clickToRecordingMs
                  : undefined
              )}
            />
            <DiagnosticMetric
              label="Click → idle"
              value={formatLatencyMs(
                recordLatency.stop?.kind === 'stop' ? recordLatency.stop.clickToIdleMs : undefined
              )}
            />
            <DiagnosticMetric
              label="Start timeline"
              value={formatTimelineSummary(diagnosticStats.recordingStartTimeline)}
            />
            <DiagnosticMetric
              label="Slowest start phase"
              value={formatSlowestPhase(diagnosticStats.recordingStartTimeline)}
            />
            <DiagnosticMetric
              label="Stop timeline"
              value={formatTimelineSummary(diagnosticStats.recordingStopTimeline)}
            />
            <DiagnosticMetric
              label="Slowest stop phase"
              value={formatSlowestPhase(diagnosticStats.recordingStopTimeline)}
            />
          </MetricGrid>
        </MetricGroup>
        <MetricGroup title="App connection">
          <ConnectionMetrics transport={diagnosticStats.websocketTransport} />
        </MetricGroup>
        <MetricGroup
          attention={needs('camera', 'screen', 'preview', 'preview-speed', 'preview-path')}
          title="Preview"
        >
          <PreviewMetrics macOS={isMacPlatform(platform ?? 'darwin')} />
        </MetricGroup>
        <MetricGroup
          attention={needs('recording', 'encoder') || ffmpegMissing}
          title="Recording and encoder"
        >
          <EncoderMetrics ffmpeg={health?.ffmpeg} macOS={isMacPlatform(platform ?? 'darwin')} />
        </MetricGroup>
        <MetricGroup
          attention={needs('sources', 'memory') || deviceWarnings.length > 0}
          title="System and sources"
        >
          <SystemMetrics stats={diagnosticStats} />
          {/* What the device list reported that no Sources alert covers (plan
              174 C-8): Sources says only that something is here. */}
          {deviceWarnings.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1 px-2" data-videorc-device-warnings="">
              {deviceWarnings.map((warning) => (
                <li
                  key={warning}
                  className="flex items-start gap-1.5 text-xs text-foreground select-text"
                >
                  <WarningIcon
                    aria-hidden
                    className="mt-0.5 size-3.5 shrink-0 text-warning"
                    weight="fill"
                  />
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}
        </MetricGroup>
        {/* The one Pipeline (V-7): the recording's stages, each state in words. */}
        <MetricGroup attention={pipelineFailed} title="Pipeline">
          {recording.pipeline ? (
            <GroupedList>
              {recording.pipeline.stages.map((stage) => {
                const state = pipelineStateWords(stage.state)
                return (
                  <div
                    key={stage.stage}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{pipelineStageLabel(stage.stage)}</div>
                      {stage.detail ? (
                        <div className="truncate text-xs text-muted-foreground">{stage.detail}</div>
                      ) : null}
                    </div>
                    <StatusBadge tone={state.tone} value={state.value} />
                  </div>
                )
              })}
            </GroupedList>
          ) : (
            <p className="px-2 text-sm text-muted-foreground">Nothing is recording.</p>
          )}
        </MetricGroup>
        {/* Logs say whose they are and when they were cut (I-25). */}
        <MetricGroup
          meta={logSession ? logSession.title : undefined}
          title={currentSession ? 'Log of this recording' : 'Log of the last recording'}
        >
          <LogPanel
            note={logTruncationNote(
              Math.min(sessionLogs.length, RECORDING_LOG_LIMIT),
              Math.max(sessionLogs.length, logSession?.sessionLogCount ?? 0)
            )}
          >
            {!logSession ? (
              <p className="text-sm text-muted-foreground">No recordings yet.</p>
            ) : sessionLogsLoading && sessionLogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading the log…</p>
            ) : sessionLogsError && sessionLogs.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-foreground">
                <WarningIcon aria-hidden className="size-3.5 shrink-0 text-warning" weight="fill" />
                Couldn&apos;t load this recording&apos;s log. Try again in a moment.
              </p>
            ) : sessionLogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">This recording has no log lines.</p>
            ) : (
              sessionLogs
                .slice(-RECORDING_LOG_LIMIT)
                .map((entry) => <SessionLogRow key={entry.id} entry={entry} />)
            )}
          </LogPanel>
        </MetricGroup>
        <MetricGroup meta={plural(logs.length, 'line')} title="App log">
          <LastEngineCrash record={latestBackendCrash(runtimeInfo?.backendCrashes)} />
          <LogPanel
            note={
              logs.length >= APP_LOG_LIMIT
                ? `Showing the last ${APP_LOG_LIMIT} lines. The support bundle keeps more.`
                : null
            }
          >
            {logs.length ? (
              logs
                .slice(-APP_LOG_LIMIT)
                .map((log, index) => (
                  <LogRow
                    key={`${log.timestamp}-${index}`}
                    createdAt={log.timestamp}
                    level={log.level}
                    message={log.message}
                  />
                ))
            ) : (
              <p className="text-sm text-muted-foreground">No log lines yet.</p>
            )}
          </LogPanel>
        </MetricGroup>
      </TechnicalDetails>
    </div>
  )
}

/**
 * The checks that need attention, then "Show all checks" for the rest. With
 * nothing amber or red the chips stay folded: the verdict already said so.
 */
function CheckList({ checks }: { checks: readonly HealthCheck[] }): ReactElement {
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  const attention = checks.filter(checkNeedsAttention)
  const shown = showAll ? checks : attention
  return (
    <div className="flex flex-col items-start gap-2">
      {shown.length ? (
        <ul aria-label="Checks" className="flex flex-wrap items-center gap-2" id={listId}>
          {shown.map((check) => (
            <li key={check.id} data-check={check.id}>
              <StatusBadge label={check.label} tone={check.tone} value={check.value} />
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        aria-controls={shown.length ? listId : undefined}
        aria-expanded={showAll}
        data-testid="health-show-all-checks"
        size="xs"
        type="button"
        variant="ghost"
        onClick={() => setShowAll((current) => !current)}
      >
        {showAll ? 'Show fewer checks' : `Show all checks (${checks.length})`}
      </Button>
    </div>
  )
}

/** A permission the streamer can fix (I-4, I-25): named, with its fix as a labelled button. */
function PermissionWarningAlert({
  warning,
  name,
  detail,
  actionLabel,
  onFix,
  onDismiss
}: {
  warning: PermissionWarning
  name: string | null
  detail: string | null
  actionLabel: string | null
  onFix: () => void
  onDismiss: () => void
}): ReactElement {
  return (
    <Alert data-pane={warning.pane} data-testid="health-permission-warning" variant="warning">
      <AlertTitle>{name ? `${name} needs permission` : 'Videorc needs a permission'}</AlertTitle>
      <AlertDescription>
        {detail ?? 'Allow it in your system settings.'} Last asked at{' '}
        {compactTime(warning.createdAt)}.
      </AlertDescription>
      {actionLabel ? (
        <div className="col-start-2 mt-1.5">
          <Button size="xs" type="button" variant="outline" onClick={onFix}>
            {actionLabel}
          </Button>
        </div>
      ) : null}
      <AlertAction>
        <Button
          aria-label="Dismiss"
          size="icon-xs"
          type="button"
          variant="ghost"
          onClick={onDismiss}
        >
          <CloseIcon />
        </Button>
      </AlertAction>
    </Alert>
  )
}

/** The engineering numbers, closed until someone asks (J2 owner item). */
function TechnicalDetails({ children }: { children: ReactNode }): ReactElement {
  return (
    <Collapsible className="border-b border-border" data-testid="health-technical-details">
      <h2>
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-gutter py-3 text-left text-section font-semibold text-foreground hover:bg-accent">
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          Technical details
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent className="flex flex-col gap-1 px-gutter pb-gutter">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * One theme of numbers. It opens itself while `attention` is true, until the
 * streamer opens or closes it by hand.
 */
function MetricGroup({
  title,
  meta,
  attention = false,
  children
}: {
  title: string
  meta?: string
  attention?: boolean
  children: ReactNode
}): ReactElement {
  const [choice, setChoice] = useState<boolean | null>(null)
  return (
    <Collapsible
      data-attention={attention || undefined}
      open={choice ?? attention}
      onOpenChange={setChoice}
    >
      <h3>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 rounded-row px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
          <ChevronDownIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          <span className="shrink-0">{title}</span>
          {attention ? (
            <>
              <WarningIcon aria-hidden className="size-3.5 shrink-0 text-warning" weight="fill" />
              <span className="sr-only">, needs a look</span>
            </>
          ) : null}
          {meta ? <span className="ml-auto min-w-0 truncate text-xs">{meta}</span> : null}
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="pt-2 pb-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function MetricGrid({ children }: { children: ReactNode }): ReactElement {
  return <div className="grid gap-x-4 gap-y-3 px-2 sm:grid-cols-2">{children}</div>
}

function DiagnosticMetric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold break-words tabular-nums select-text">{value}</div>
    </div>
  )
}

function OverviewMetrics({
  stats,
  streamHealth
}: {
  stats: DiagnosticStats
  streamHealth: { fps?: number; speed?: number; droppedFrames?: number } | null
}): ReactElement {
  return (
    <MetricGrid>
      {stats.recordingAtRisk ? (
        <DiagnosticMetric
          label="Why the recording is at risk"
          value={stats.recordingRiskReasons.join('; ') || NO_VALUE}
        />
      ) : null}
      <DiagnosticMetric
        label="Output mode"
        value={stats.activeOutputMode ? statusWordFromValue(stats.activeOutputMode) : 'Idle'}
      />
      <DiagnosticMetric
        label="Target frame rate"
        value={stats.targetFps ? formatFrameRate(stats.targetFps) : NO_VALUE}
      />
      <DiagnosticMetric
        label="Scene version"
        value={stats.activeSceneRevision == null ? NO_VALUE : stats.activeSceneRevision.toString()}
      />
      <DiagnosticMetric
        label="Capture FPS"
        value={formatMetric(stats.captureFps ?? streamHealth?.fps, 'fps')}
      />
      <DiagnosticMetric
        label="Render FPS"
        value={formatMetric(stats.renderFps ?? streamHealth?.fps, 'fps')}
      />
      <DiagnosticMetric label="Skipped frames" value={stats.skippedFrames.toString()} />
      <DiagnosticMetric
        label="Dropped frames"
        value={formatDroppedFrames(stats.droppedFrames || streamHealth?.droppedFrames)}
      />
      <DiagnosticMetric
        label="Encoder speed"
        value={formatMetric(stats.encoderSpeed ?? streamHealth?.speed, 'x')}
      />
      <DiagnosticMetric label="Bridge queue" value={stats.encoderBridgeQueueDepth.toString()} />
      <DiagnosticMetric
        label="Recording queue"
        value={`${stats.encoderBridgeRecordingQueueDepth} · ${formatMetric(stats.encoderBridgeRecordingQueueOldestFrameAgeMs, 'ms')} oldest · ${stats.encoderBridgeRecordingQueueCapacityPressureEvents} pressure · ${stats.encoderBridgeRecordingQueueDroppedFrames} dropped`}
      />
      <DiagnosticMetric
        label="Stream queue"
        value={`${stats.encoderBridgeStreamQueueDepth} · ${formatMetric(stats.encoderBridgeStreamQueueOldestFrameAgeMs, 'ms')} oldest · ${stats.encoderBridgeStreamQueueCapacityPressureEvents} pressure · ${stats.encoderBridgeStreamQueueDroppedFrames} dropped`}
      />
      <DiagnosticMetric
        label="Bridge FPS"
        value={formatMetric(stats.encoderBridgeInputFps, 'fps')}
      />
      <DiagnosticMetric label="Bridge drops" value={stats.encoderBridgeDroppedFrames.toString()} />
      <DiagnosticMetric label="Bridge error" value={stats.encoderBridgeError ?? NO_VALUE} />
    </MetricGrid>
  )
}

function ConnectionMetrics({
  transport
}: {
  transport: DiagnosticStats['websocketTransport']
}): ReactElement {
  return (
    <MetricGrid>
      <DiagnosticMetric
        label="Reliable responses"
        value={formatWebSocketQueue(transport.reliableResponseQueue)}
      />
      <DiagnosticMetric
        label="Incoming commands"
        value={formatWebSocketQueue(transport.incomingCommandQueue)}
      />
      <DiagnosticMetric
        label="Coalesced telemetry"
        value={formatWebSocketQueue(transport.coalescedTelemetryQueue)}
      />
      <DiagnosticMetric
        label="Slow-peer disconnects"
        value={transport.slowPressureDisconnectCount.toString()}
      />
      {Object.entries(transport.commandLanes).map(([lane, stats]) => (
        <DiagnosticMetric
          key={lane}
          label={`${statusWordFromValue(lane)} lane`}
          value={`${formatWebSocketQueue(stats.queue)} · ${stats.expiredBeforeDispatchCount} expired · ${stats.rejectedBeforeDispatchCount} rejected`}
        />
      ))}
    </MetricGrid>
  )
}

function PreviewMetrics({ macOS }: { macOS: boolean }): ReactElement {
  const { previewCameraStatus, previewScreenStatus } = useStudioPreview()
  const { diagnosticStats: stats, previewSurfaceStatus } = useStudioDiagnostics()
  return (
    <MetricGrid>
      <DiagnosticMetric
        label="Preview mode"
        value={formatPreviewTransport(stats.previewTransport)}
      />
      <DiagnosticMetric label="Graphics" value={formatGraphicsPath(stats)} />
      <DiagnosticMetric
        label="Preview source FPS"
        value={formatSourceFps(stats.previewSourceFps)}
      />
      <DiagnosticMetric
        label="Preview present FPS"
        value={formatMetric(stats.previewPresentFps, 'fps')}
      />
      <DiagnosticMetric
        label="Preview target"
        value={formatMetric(stats.previewTargetFps, 'fps')}
      />
      <DiagnosticMetric label="Preview cadence" value={formatMs(stats.previewLatencyMs)} />
      <DiagnosticMetric label="Preview age" value={formatMs(stats.previewFrameAgeMs)} />
      <DiagnosticMetric
        label="Input to present"
        value={formatMs(stats.previewInputToPresentLatencyMs)}
      />
      <DiagnosticMetric label="Render p95" value={formatMs(stats.previewRenderFrameTimeP95Ms)} />
      <DiagnosticMetric label="Tick gap p95" value={formatMs(stats.compositorTickGapP95Ms)} />
      <DiagnosticMetric label="Tick gap max" value={formatMs(stats.compositorTickGapMaxMs)} />
      <DiagnosticMetric
        label="Source fetch p95"
        value={formatMs(stats.compositorSourceFetchP95Ms)}
      />
      {/* Metal and VideoToolbox exist only on macOS (plan 174 I-9). */}
      {macOS ? (
        <DiagnosticMetric label="Metal p95" value={formatMs(stats.compositorGpuTotalP95Ms)} />
      ) : null}
      <DiagnosticMetric
        label="Preview lag"
        value={formatFrameLag(stats.previewCompositorFrameLag)}
      />
      <DiagnosticMetric label="Preview drops" value={stats.previewDroppedFrames.toString()} />
      <DiagnosticMetric
        label="Camera age"
        value={formatMs(stats.previewCameraFrameAgeMs ?? previewCameraStatus.frameAgeMs)}
      />
      <DiagnosticMetric
        label="Screen age"
        value={formatMs(stats.previewScreenFrameAgeMs ?? previewScreenStatus.frameAgeMs)}
      />
      <DiagnosticMetric label="Repeated frames" value={stats.previewRepeatedFrames.toString()} />
      <DiagnosticMetric
        label="Surface resizes"
        value={stats.previewSurfaceResizeCount.toString()}
      />
      <DiagnosticMetric
        label="Camera source"
        value={formatPreviewSourceStatus(
          previewCameraStatus.state,
          stats.previewCameraSourceFps ?? previewCameraStatus.sourceFps,
          stats.previewCameraDroppedFrames ?? previewCameraStatus.droppedFrames
        )}
      />
      <DiagnosticMetric
        label="Screen source"
        value={formatPreviewSourceStatus(
          previewScreenStatus.state,
          stats.previewScreenSourceFps ?? previewScreenStatus.sourceFps,
          stats.previewScreenDroppedFrames ?? previewScreenStatus.droppedFrames
        )}
      />
      <DiagnosticMetric
        label="Surface state"
        value={`${statusWordFromValue(previewSurfaceStatus.state)}, ${plural(previewSurfaceStatus.framesRendered, 'frame')}`}
      />
      <DiagnosticMetric
        label="Surface backing"
        value={formatPreviewSurfaceBacking(
          stats.previewSurfaceBacking ?? previewSurfaceStatus.backing
        )}
      />
    </MetricGrid>
  )
}

function EncoderMetrics({
  ffmpeg,
  macOS
}: {
  ffmpeg: ToolStatus | undefined
  macOS: boolean
}): ReactElement {
  const { diagnosticStats: stats, streamHealth } = useStudioDiagnostics()
  return (
    <MetricGrid>
      <DiagnosticMetric label="FFmpeg" value={formatFfmpegStatus(ffmpeg)} />
      <DiagnosticMetric label="Microphone drops" value={stats.micDroppedFrames.toString()} />
      <DiagnosticMetric
        label="Microphone coverage"
        value={formatCoverage(stats.micCaptureCoverage)}
      />
      <DiagnosticMetric label="Encoder" value={formatEncoder(stats.encodeBackend)} />
      <DiagnosticMetric
        label="Requested output"
        value={stats.encoderBridgeRequestedVideoOutput ?? NO_VALUE}
      />
      <DiagnosticMetric
        label="Effective output"
        value={stats.encoderBridgeEffectiveVideoOutput ?? NO_VALUE}
      />
      <DiagnosticMetric
        label="Output fallback"
        value={stats.encoderBridgeEncodedOutputFallbackReason ?? NO_VALUE}
      />
      <DiagnosticMetric
        label="Stream bitrate"
        value={formatKbps(stats.streamMeasuredBitrateKbps)}
      />
      <DiagnosticMetric
        label="Stream bitrate range"
        value={`${formatKbps(stats.streamMeasuredBitrateMinKbps)} / ${formatKbps(stats.streamMeasuredBitrateMaxKbps)}`}
      />
      <DiagnosticMetric label="Stream bytes" value={formatBytes(stats.streamOutputTotalBytes)} />
      <DiagnosticMetric
        label="Stream duplicated"
        value={formatOptionalCounter(stats.streamDuplicatedFrames)}
      />
      <DiagnosticMetric
        label="Stream dropped"
        value={formatOptionalCounter(streamHealth?.droppedFrames ?? stats.droppedFrames)}
      />
      <DiagnosticMetric
        label="Stream coalesced"
        value={formatOptionalCounter(
          stats.encoderBridgeSeparateOutputEncodersActive
            ? stats.encoderBridgeStreamQueueDroppedFrames
            : stats.encoderBridgeOutputQueueDroppedFrames
        )}
      />
      <DiagnosticMetric
        label="Recording repeats"
        value={stats.encoderBridgeRepeatedFrames.toString()}
      />
      <DiagnosticMetric
        label="Repeat bursts"
        value={stats.encoderBridgeRepeatedFrameBursts.toString()}
      />
      <DiagnosticMetric
        label="Repeat max run"
        value={stats.encoderBridgeMaxRepeatedFrameRun.toString()}
      />
      <DiagnosticMetric
        label="Synthetic frames"
        value={stats.encoderBridgeSyntheticFrames.toString()}
      />
      <DiagnosticMetric
        label="Bridge source age"
        value={formatMs(stats.encoderBridgeSourceAgeMs)}
      />
      <DiagnosticMetric
        label="Source age p95"
        value={formatMs(stats.encoderBridgeSourceAgeP95Ms)}
      />
      <DiagnosticMetric
        label="Repeat age p95"
        value={formatMs(stats.encoderBridgeRepeatedFrameAgeP95Ms)}
      />
      <DiagnosticMetric
        label="Bridge wait p95"
        value={formatMs(stats.encoderBridgeCompositorWaitP95Ms)}
      />
      <DiagnosticMetric
        label="Writer total p95"
        value={formatMs(stats.encoderBridgeWriterLoopP95Ms)}
      />
      <DiagnosticMetric
        label="Writer active p95"
        value={formatMs(stats.encoderBridgeWriterActiveP95Ms)}
      />
      {macOS ? (
        <>
          <DiagnosticMetric
            label="FIFO enqueue p95"
            value={formatMs(stats.encoderBridgeVideoToolboxFifoEnqueueP95Ms)}
          />
          <DiagnosticMetric
            label="FIFO enqueue max"
            value={formatMs(stats.encoderBridgeVideoToolboxFifoEnqueueMaxMs)}
          />
        </>
      ) : null}
      <DiagnosticMetric
        label="Record writer p95"
        value={formatMs(stats.encoderBridgeRecordingWriterLoopP95Ms)}
      />
      <DiagnosticMetric
        label="Stream writer p95"
        value={formatMs(stats.encoderBridgeStreamWriterLoopP95Ms)}
      />
      <DiagnosticMetric
        label="Deadline lag"
        value={`${formatMs(stats.encoderBridgeDeadlineLagP95Ms)} / ${stats.encoderBridgeLateDeadlineTicks}`}
      />
      {macOS ? (
        <>
          <DiagnosticMetric
            label="Metal targets"
            value={stats.encoderBridgeMetalTargetFrames.toString()}
          />
          <DiagnosticMetric
            label="VT probe"
            value={`${stats.encoderBridgeVideoToolboxProbeFrames} / ${formatBytes(stats.encoderBridgeVideoToolboxProbeBytes)}`}
          />
          <DiagnosticMetric
            label="VT output"
            value={`${stats.encoderBridgeVideoToolboxOutputFrames} / ${formatBytes(stats.encoderBridgeVideoToolboxOutputBytes)}`}
          />
          <DiagnosticMetric
            label="VT encode max"
            value={formatMs(stats.encoderBridgeVideoToolboxOutputEncodeMs)}
          />
        </>
      ) : null}
    </MetricGrid>
  )
}

function SystemMetrics({ stats }: { stats: DiagnosticStats }): ReactElement {
  return (
    <MetricGrid>
      <DiagnosticMetric
        label="Image polls"
        value={formatImagePolls(stats.previewImagePollCounts)}
      />
      <DiagnosticMetric
        label="Device state"
        value={stats.deviceDisconnected ? 'Disconnected' : 'Connected'}
      />
      <DiagnosticMetric label="FFmpeg work" value={formatFfmpegWork(stats)} />
      <DiagnosticMetric label="FFmpeg processes" value={stats.activeFfmpegProcesses.toString()} />
      <DiagnosticMetric label="FFprobe processes" value={stats.activeFfprobeProcesses.toString()} />
      <DiagnosticMetric label="Engine memory" value={formatBytes(stats.backendRssBytes)} />
      <DiagnosticMetric
        label="Duplicate capture"
        value={stats.duplicateCaptureSources.join(', ') || NO_VALUE}
      />
      <DiagnosticMetric
        label="Source try-locks"
        value={`Camera ${stats.compositorCameraSourceTryLockMisses}, screen ${stats.compositorScreenSourceTryLockMisses}`}
      />
      <DiagnosticMetric
        label="Source frame store"
        value={`${plural(stats.previewSourceFrameBufferCount, 'buffer')}, ${formatBytes(stats.previewSourceFrameBytes)}, ${stats.previewSourceFrameDroppedFrames} replaced`}
      />
      <DiagnosticMetric
        label="Source registry"
        value={formatSourceRegistry(stats.sourceRegistry)}
      />
    </MetricGrid>
  )
}

/** A log's scroll box, with what was cut said under it (I-25). */
function LogPanel({ note, children }: { note: string | null; children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col gap-1.5 px-2">
      <ScrollArea className="h-64 pr-3">
        <div className="flex flex-col">{children}</div>
      </ScrollArea>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  )
}

function SessionLogRow({ entry }: { entry: SessionLogEntry }): ReactElement {
  return (
    <LogRow
      code={entry.code}
      createdAt={entry.createdAt}
      level={entry.level}
      message={entry.message}
      sourceId={entry.sourceId ?? undefined}
    />
  )
}

/**
 * Persisted crash evidence (runtimeInfo.backendCrashes, written by main at
 * the moment of the exit). The live log starts at the current run, so
 * without this row a crash that already restarted is invisible.
 */
function LastEngineCrash({ record }: { record: BackendCrashRecord | null }): ReactElement | null {
  if (!record) {
    return null
  }
  const view = backendCrashView(record)
  return (
    // A record of the past, not news: a note, never an assertive alert.
    <Alert
      className="mx-2 mb-2 w-auto"
      role="note"
      variant={view.intentional ? 'default' : 'destructive'}
    >
      <AlertTitle>
        {view.intentional ? "Videorc's engine restarted" : "Videorc's engine stopped unexpectedly"}{' '}
        at {compactTime(record.at)}
      </AlertTitle>
      <AlertDescription className="text-xs select-text">
        <p>
          Run {record.generation} · {view.exit} · after {view.uptime}
          {view.attempt !== null ? ` · restart ${view.attempt}` : ''}
        </p>
        <p className="font-mono break-words">
          {view.headline ?? 'It printed nothing before it stopped.'}
        </p>
        <p>
          The support bundle includes its last {plural(record.stderrTail.length, 'output line')}.
        </p>
      </AlertDescription>
    </Alert>
  )
}

/** One log line: the level as a word, its code only when it says more (V-7: no "info info"). */
function LogRow({
  code,
  createdAt,
  level,
  message,
  sourceId
}: {
  code?: string
  createdAt: string
  level: string
  message: string
  sourceId?: string
}): ReactElement {
  return (
    <div className="border-b border-border py-2 text-xs select-text last:border-b-0">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge variant={levelBadgeVariant(level)}>{logLevelLabel(level)}</Badge>
        {code && code !== level ? <span className="font-mono">{code}</span> : null}
        {sourceId ? <span className="text-muted-foreground">{sourceId}</span> : null}
        <span className="ml-auto text-muted-foreground">{compactTime(createdAt)}</span>
      </div>
      <p className="break-words text-muted-foreground">{message}</p>
    </div>
  )
}

function levelBadgeVariant(level: string): 'destructive' | 'warning' | 'outline' {
  if (level === 'error') {
    return 'destructive'
  }
  if (level === 'warn') {
    return 'warning'
  }
  return 'outline'
}

function formatPreviewSourceStatus(
  state: Parameters<typeof previewSourceStateLabel>[0],
  sourceFps?: number,
  droppedFrames?: number
): string {
  const fps = typeof sourceFps === 'number' ? `${sourceFps.toFixed(1)} fps` : NO_VALUE
  return `${previewSourceStateLabel(state)}, ${fps}, ${plural(droppedFrames ?? 0, 'drop')}`
}

/** The recorder's version, or that it is missing (plan 174 S3.6). */
function formatFfmpegStatus(ffmpeg: ToolStatus | undefined): string {
  if (!ffmpeg) return 'Checking…'
  if (!ffmpeg.available) return 'Missing'
  return ffmpeg.version ? `Ready · ${ffmpeg.version}` : 'Ready'
}

function formatFfmpegWork(stats: DiagnosticStats): string {
  if (stats.ffmpegMaintenanceCancelRequested) {
    return 'Canceling file repair'
  }
  if (stats.ffmpegCaptureActive) {
    return 'Capturing'
  }
  if (stats.ffmpegFinalizingActive) {
    return 'Finishing a recording'
  }
  if (stats.ffmpegMaintenanceRunning) {
    return 'Repairing files'
  }
  return stats.ffmpegMaintenanceDeferredReason ?? 'Idle'
}

function formatMs(value?: number): string {
  return typeof value === 'number' ? `${value.toFixed(0)} ms` : NO_VALUE
}

function formatKbps(value?: number): string {
  return formatBitrate(value) || NO_VALUE
}

function formatOptionalCounter(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value)).toLocaleString()
    : NO_VALUE
}

function formatFrameLag(value?: number): string {
  return typeof value === 'number' ? plural(Math.round(value), 'frame') : NO_VALUE
}

export function formatSlowestPhase(snapshot: Parameters<typeof slowestTimelinePhase>[0]): string {
  const slowest = slowestTimelinePhase(snapshot)
  return slowest ? `${slowest.phase} · ${formatLatencyMs(slowest.deltaMs)}` : NO_VALUE
}

export function formatWebSocketQueue(queue: WebSocketQueueDiagnosticStats): string {
  const oldest = queue.oldestAgeMs == null ? NO_VALUE : `${queue.oldestAgeMs} ms`
  return `${queue.currentDepth}/${queue.maxDepth} current/max · ${oldest} oldest · ${queue.coalescedCount} coalesced · ${queue.evictedOrDroppedCount} evicted/dropped`
}

function formatSourceRegistry(registry?: DiagnosticStats['sourceRegistry']): string {
  const entries = registry?.entries ?? []
  if (!entries.length) {
    return NO_VALUE
  }
  return entries
    .map(
      (entry) =>
        `${entry.key.kind}:${entry.key.id} ${entry.status} [${entry.consumers.join(', ') || 'no consumers'}] ${entry.identityConfidence}`
    )
    .join('; ')
}

function formatPreviewTransport(transport?: string): string {
  switch (transport) {
    case 'native-surface':
      return 'Native'
    case 'd3d11-shared-texture':
      return 'D3D11'
    case 'electron-proof-surface':
      return 'Fallback window'
    case 'latest-jpeg-polling':
      return 'JPEG'
    case 'mjpeg-stream':
      return 'MJPEG'
    default:
      return 'Unavailable'
  }
}

function formatPreviewSurfaceBacking(backing?: string): string {
  switch (backing) {
    case 'cametal-layer':
      return 'CAMetalLayer'
    case 'directcomposition-swapchain':
      return 'DirectComposition swap chain'
    case 'electron-browser-window':
      return 'Browser window'
    default:
      return NO_VALUE
  }
}

function formatCoverage(value?: number): string {
  return typeof value === 'number' ? `${(value * 100).toFixed(0)}%` : NO_VALUE
}

function formatEncoder(encoder?: string): string {
  switch (encoder) {
    case 'software-x264':
      return 'Software (x264)'
    case 'hardware-videotoolbox':
      return 'Hardware (VideoToolbox)'
    case 'hardware-vaapi':
      return 'Hardware (VAAPI)'
    case 'hardware-media-foundation':
      return 'Hardware (MediaFoundation)'
    case 'software-media-foundation':
      return 'Software (MediaFoundation)'
    case 'software-open-h264':
      return 'Software (OpenH264)'
    case 'hardware-qsv':
      return 'Hardware (Intel Quick Sync)'
    default:
      return NO_VALUE
  }
}

/** What draws the program: the GPU path, or the CPU fallback with its reason (AGENTS.md). */
function formatGraphicsPath(stats: DiagnosticStats): string {
  switch (stats.compositorBackend) {
    case 'metal':
      return 'Metal'
    case 'd3d11':
      return 'D3D11'
    case 'cpu':
      return 'CPU'
    case 'cpu-fallback': {
      const frames = plural(stats.compositorCpuFallbackFrames ?? 0, 'frame')
      const reason = stats.compositorFallbackReason ? `: ${stats.compositorFallbackReason}` : ''
      return `CPU fallback (${frames})${reason}`
    }
    default:
      return NO_VALUE
  }
}

function formatImagePolls(counts?: DiagnosticStats['previewImagePollCounts']): string {
  if (!counts) {
    return NO_VALUE
  }
  const total =
    counts.cameraPng +
    counts.screenPng +
    counts.productionPng +
    counts.cameraBmp +
    counts.screenBmp +
    counts.liveJpeg +
    counts.liveMjpeg
  return total === 0
    ? '0'
    : `${total} (PNG camera ${counts.cameraPng}, screen ${counts.screenPng}, program ${counts.productionPng}; BMP camera ${counts.cameraBmp}, screen ${counts.screenBmp}; JPEG ${counts.liveJpeg}, MJPEG ${counts.liveMjpeg})`
}

function formatSourceFps(sourceFps?: Record<string, number>): string {
  if (!sourceFps || !Object.keys(sourceFps).length) {
    return NO_VALUE
  }

  return Object.entries(sourceFps)
    .map(([source, fps]) => `${source}: ${fps.toFixed(1)}`)
    .join(', ')
}
