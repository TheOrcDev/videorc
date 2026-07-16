import {
  ArrowSquareOut,
  CaretDown,
  Gauge,
  Heartbeat,
  Pulse,
  TerminalWindow,
  WarningCircle,
  X
} from '@phosphor-icons/react'
import { useMemo, useState, type ReactElement, type ReactNode } from 'react'

import { PanelSection } from '@/components/panel-section'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  useStudioAudio,
  useStudioCore,
  useStudioDiagnostics,
  useStudioPreview,
  useStudioRecording
} from '@/hooks/use-studio'
import type {
  DiagnosticBottleneck,
  DiagnosticStats,
  HealthEvent,
  HealthLevel,
  PreviewCameraStatus,
  SessionLogEntry,
  PreviewLiveStatus,
  PreviewScreenStatus,
  PreviewSurfaceStatus,
  StreamTargetRuntime,
  SystemPermissionPane,
  WebSocketQueueDiagnosticStats
} from '@/lib/backend'
import { compactTime, formatDroppedFrames, formatMetric } from '@/lib/format'
import { systemAccessAction, systemAccessRows } from '@/lib/system-access'

export function DiagnosticsTab(): ReactElement {
  const {
    handleSystemPermission,
    sessions,
    streamTargets,
    nativePreviewSurfaceEnabled,
    captureConfig,
    deviceList,
    mediaAccess,
    runtimeInfo,
    exportSupportBundle,
    supportBundleExportPending
  } = useStudioCore()
  const { audioMeter } = useStudioAudio()
  const { recording } = useStudioRecording()
  const { previewLiveStatus, previewCameraStatus, previewScreenStatus } = useStudioPreview()
  const { diagnosticStats, healthEvents, logs, previewSurfaceStatus, streamHealth } =
    useStudioDiagnostics()
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const activeSession =
    sessions.find((session) => session.id === recording.sessionId) ?? sessions[0] ?? null
  const accessRows = systemAccessRows({
    deviceList,
    audioMeter,
    platform: runtimeInfo?.platform,
    mediaAccess
  })
  const permissionAction = (pane: SystemPermissionPane) => {
    const row = accessRows.find((candidate) => candidate.id === pane)
    return systemAccessAction({
      pane,
      state: row?.state,
      platform: runtimeInfo?.platform,
      mediaAccessStatus:
        pane === 'camera' || pane === 'microphone' ? mediaAccess?.[pane] : undefined
    })
  }
  const actionableEvents = healthEvents.filter(
    (event) =>
      event.permissionPane &&
      !dismissed.has(event.id) &&
      permissionAction(event.permissionPane) !== null
  )
  const sessionLogs = activeSession?.sessionLogs ?? []

  const bottleneck = useMemo(
    () => bottleneckCopy(diagnosticStats.bottleneck),
    [diagnosticStats.bottleneck]
  )
  const previewDiagnosis = useMemo(
    () =>
      previewDiagnosisCopy({
        diagnosticStats,
        expectsCamera: Boolean(captureConfig.sources.cameraId),
        expectsScreen: Boolean(captureConfig.sources.screenId || captureConfig.sources.windowId),
        nativePreviewSurfaceEnabled,
        previewCameraStatus,
        previewLiveStatus,
        previewScreenStatus,
        previewSurfaceStatus
      }),
    [
      diagnosticStats,
      captureConfig.sources.cameraId,
      captureConfig.sources.screenId,
      captureConfig.sources.windowId,
      nativePreviewSurfaceEnabled,
      previewCameraStatus,
      previewLiveStatus,
      previewScreenStatus,
      previewSurfaceStatus
    ]
  )
  const qualityWarning = useMemo(
    () => recordingQualityWarning(diagnosticStats.bottleneck),
    [diagnosticStats.bottleneck]
  )
  const sourceSummary = useMemo(
    () => sourceSummaryCopy(diagnosticStats, previewCameraStatus, previewScreenStatus),
    [diagnosticStats, previewCameraStatus, previewScreenStatus]
  )
  const compositorSummary = useMemo(() => compositorSummaryCopy(diagnosticStats), [diagnosticStats])
  const encoderSummary = useMemo(
    () => encoderSummaryCopy(diagnosticStats, streamHealth),
    [diagnosticStats, streamHealth]
  )
  const repairSummary = useMemo(() => repairSummaryCopy(diagnosticStats), [diagnosticStats])
  const memorySummary = useMemo(
    () => memorySummaryCopy(diagnosticStats.backendRssBytes),
    [diagnosticStats.backendRssBytes]
  )
  const networkSummary = useMemo(() => networkSummaryCopy(streamTargets), [streamTargets])

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col gap-4">
        {/* Verdicts first (ux-ia plan, slice 8): the page answers "is anything
            wrong?" before offering the numbers. */}
        <PanelSection description="Is anything wrong right now?" icon={Heartbeat} title="Verdicts">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              label="Likely bottleneck"
              tone={bottleneck.tone}
              value={bottleneck.label}
            />
            <StatusBadge
              label="Preview bottleneck"
              tone={previewDiagnosis.tone}
              value={previewDiagnosis.label}
            />
            <StatusBadge label="Source" tone={sourceSummary.tone} value={sourceSummary.label} />
            <StatusBadge
              label="Compositor"
              tone={compositorSummary.tone}
              value={compositorSummary.label}
            />
            <StatusBadge label="Encoder" tone={encoderSummary.tone} value={encoderSummary.label} />
            <StatusBadge label="Repair" tone={repairSummary.tone} value={repairSummary.label} />
            <StatusBadge label="Memory" tone={memorySummary.tone} value={memorySummary.label} />
            <StatusBadge label="Network" tone={networkSummary.tone} value={networkSummary.label} />
            <StatusBadge
              label="Preview"
              tone={previewStatusTone(previewLiveStatus, previewCameraStatus, previewScreenStatus)}
              value={previewLiveStatus.state}
            />
            <StatusBadge
              label="Preview path"
              tone={
                previewPathBadge(
                  diagnosticStats.previewTransport,
                  diagnosticStats.previewSurfaceBacking
                ).tone
              }
              value={
                previewPathBadge(
                  diagnosticStats.previewTransport,
                  diagnosticStats.previewSurfaceBacking
                ).label
              }
            />
            <StatusBadge
              label="Recording"
              tone={recordingBadge(diagnosticStats).tone}
              value={recordingBadge(diagnosticStats).label}
            />
            <StatusBadge
              label="Camera"
              tone={previewSourceTone(previewCameraStatus.state)}
              value={previewCameraStatus.state}
            />
            <StatusBadge
              label="Screen"
              tone={previewSourceTone(previewScreenStatus.state)}
              value={previewScreenStatus.state}
            />
            <StatusBadge
              label="Maintenance"
              tone={diagnosticStats.ffmpegMaintenanceRunning ? 'warn' : 'good'}
              value={diagnosticStats.ffmpegMaintenanceRunning ? 'Running' : 'Idle'}
            />
            {diagnosticStats.duplicateCaptureSources.length ? (
              <StatusBadge
                label="Duplicate capture"
                tone="warn"
                value={diagnosticStats.duplicateCaptureSources.length.toString()}
              />
            ) : null}
            {diagnosticStats.targetFps ? (
              <Badge variant="outline">Target {diagnosticStats.targetFps} FPS</Badge>
            ) : null}
          </div>
          {diagnosticStats.recordingAtRisk ? (
            <p className="text-sm text-destructive">
              Recording at risk: {diagnosticStats.recordingRiskReasons.join('; ')}
            </p>
          ) : null}
          {qualityWarning ? <p className="text-sm text-warning">{qualityWarning}</p> : null}
        </PanelSection>

        <PanelSection
          description="Current capture and preview health."
          icon={Gauge}
          title="Live stats"
        >
          <MetricGroup title="Pipeline">
            <DiagnosticMetric
              label="Output mode"
              value={diagnosticStats.activeOutputMode ?? 'Idle'}
            />
            <DiagnosticMetric
              label="Scene revision"
              value={
                diagnosticStats.activeSceneRevision == null
                  ? 'None'
                  : diagnosticStats.activeSceneRevision.toString()
              }
            />
            <DiagnosticMetric
              label="Capture FPS"
              value={formatMetric(diagnosticStats.captureFps ?? streamHealth?.fps, 'fps')}
            />
            <DiagnosticMetric
              label="Render FPS"
              value={formatMetric(diagnosticStats.renderFps ?? streamHealth?.fps, 'fps')}
            />
            <DiagnosticMetric
              label="Skipped frames"
              value={diagnosticStats.skippedFrames.toString()}
            />
            <DiagnosticMetric
              label="Dropped frames"
              value={formatDroppedFrames(
                diagnosticStats.droppedFrames || streamHealth?.droppedFrames
              )}
            />
            <DiagnosticMetric
              label="Encoder speed"
              value={formatMetric(diagnosticStats.encoderSpeed ?? streamHealth?.speed, 'x')}
            />
            <DiagnosticMetric
              label="Bridge queue"
              value={diagnosticStats.encoderBridgeQueueDepth.toString()}
            />
            <DiagnosticMetric
              label="Recording queue"
              value={`${diagnosticStats.encoderBridgeRecordingQueueDepth} · ${formatMetric(diagnosticStats.encoderBridgeRecordingQueueOldestFrameAgeMs, 'ms')} oldest · ${diagnosticStats.encoderBridgeRecordingQueueCapacityPressureEvents} pressure · ${diagnosticStats.encoderBridgeRecordingQueueDroppedFrames} dropped`}
            />
            <DiagnosticMetric
              label="Stream queue"
              value={`${diagnosticStats.encoderBridgeStreamQueueDepth} · ${formatMetric(diagnosticStats.encoderBridgeStreamQueueOldestFrameAgeMs, 'ms')} oldest · ${diagnosticStats.encoderBridgeStreamQueueCapacityPressureEvents} pressure · ${diagnosticStats.encoderBridgeStreamQueueDroppedFrames} dropped`}
            />
            <DiagnosticMetric
              label="Bridge FPS"
              value={formatMetric(diagnosticStats.encoderBridgeInputFps, 'fps')}
            />
            <DiagnosticMetric
              label="Bridge drops"
              value={diagnosticStats.encoderBridgeDroppedFrames.toString()}
            />
            <DiagnosticMetric
              label="Bridge error"
              value={diagnosticStats.encoderBridgeError ?? 'None'}
            />
          </MetricGroup>
          <MetricGroup title="WebSocket transport">
            <DiagnosticMetric
              label="Reliable responses"
              value={formatWebSocketQueue(diagnosticStats.websocketTransport.reliableResponseQueue)}
            />
            <DiagnosticMetric
              label="Incoming commands"
              value={formatWebSocketQueue(diagnosticStats.websocketTransport.incomingCommandQueue)}
            />
            <DiagnosticMetric
              label="Coalesced telemetry"
              value={formatWebSocketQueue(
                diagnosticStats.websocketTransport.coalescedTelemetryQueue
              )}
            />
            <DiagnosticMetric
              label="Slow-peer disconnects"
              value={diagnosticStats.websocketTransport.slowPressureDisconnectCount.toString()}
            />
          </MetricGroup>
          <MetricGroup title="Preview">
            <DiagnosticMetric
              label="Preview mode"
              value={formatPreviewTransport(diagnosticStats.previewTransport)}
            />
            <DiagnosticMetric
              label="Compositor backend"
              value={formatCompositorBackend(diagnosticStats)}
            />
            <DiagnosticMetric
              label="Preview source FPS"
              value={formatSourceFps(diagnosticStats.previewSourceFps)}
            />
            <DiagnosticMetric
              label="Preview present FPS"
              value={formatMetric(diagnosticStats.previewPresentFps, 'fps')}
            />
            <DiagnosticMetric
              label="Preview target"
              value={formatMetric(diagnosticStats.previewTargetFps, 'fps')}
            />
            <DiagnosticMetric
              label="Preview cadence"
              value={formatMs(diagnosticStats.previewLatencyMs)}
            />
            <DiagnosticMetric
              label="Preview age"
              value={formatMs(diagnosticStats.previewFrameAgeMs)}
            />
            <DiagnosticMetric
              label="Input to present"
              value={formatMs(diagnosticStats.previewInputToPresentLatencyMs)}
            />
            <DiagnosticMetric
              label="Render p95"
              value={formatMs(diagnosticStats.previewRenderFrameTimeP95Ms)}
            />
            <DiagnosticMetric
              label="Tick gap p95"
              value={formatMs(diagnosticStats.compositorTickGapP95Ms)}
            />
            <DiagnosticMetric
              label="Tick gap max"
              value={formatMs(diagnosticStats.compositorTickGapMaxMs)}
            />
            <DiagnosticMetric
              label="Source fetch p95"
              value={formatMs(diagnosticStats.compositorSourceFetchP95Ms)}
            />
            <DiagnosticMetric
              label="Metal p95"
              value={formatMs(diagnosticStats.compositorGpuTotalP95Ms)}
            />
            <DiagnosticMetric
              label="Preview lag"
              value={formatFrameLag(diagnosticStats.previewCompositorFrameLag)}
            />
            <DiagnosticMetric
              label="Preview drops"
              value={diagnosticStats.previewDroppedFrames.toString()}
            />
            <DiagnosticMetric
              label="Camera age"
              value={formatMs(
                diagnosticStats.previewCameraFrameAgeMs ?? previewCameraStatus.frameAgeMs
              )}
            />
            <DiagnosticMetric
              label="Screen age"
              value={formatMs(
                diagnosticStats.previewScreenFrameAgeMs ?? previewScreenStatus.frameAgeMs
              )}
            />
            <DiagnosticMetric
              label="Repeated frames"
              value={diagnosticStats.previewRepeatedFrames.toString()}
            />
            <DiagnosticMetric
              label="Surface resizes"
              value={diagnosticStats.previewSurfaceResizeCount.toString()}
            />
            <DiagnosticMetric
              label="Camera source"
              value={formatPreviewSourceStatus(
                previewCameraStatus.state,
                diagnosticStats.previewCameraSourceFps ?? previewCameraStatus.sourceFps,
                diagnosticStats.previewCameraDroppedFrames ?? previewCameraStatus.droppedFrames
              )}
            />
            <DiagnosticMetric
              label="Screen source"
              value={formatPreviewSourceStatus(
                previewScreenStatus.state,
                diagnosticStats.previewScreenSourceFps ?? previewScreenStatus.sourceFps,
                diagnosticStats.previewScreenDroppedFrames ?? previewScreenStatus.droppedFrames
              )}
            />
            <DiagnosticMetric
              label="Surface state"
              value={`${previewSurfaceStatus.state} (${previewSurfaceStatus.framesRendered} frames)`}
            />
            <DiagnosticMetric
              label="Surface backing"
              value={formatPreviewSurfaceBacking(
                diagnosticStats.previewSurfaceBacking ?? previewSurfaceStatus.backing
              )}
            />
          </MetricGroup>
          <MetricGroup title="Recording & encoder">
            <DiagnosticMetric
              label="Mic drops"
              value={diagnosticStats.micDroppedFrames.toString()}
            />
            <DiagnosticMetric
              label="Mic coverage"
              value={formatCoverage(diagnosticStats.micCaptureCoverage)}
            />
            <DiagnosticMetric
              label="Encode backend"
              value={formatEncodeBackend(diagnosticStats.encodeBackend)}
            />
            <DiagnosticMetric
              label="Recording repeats"
              value={diagnosticStats.encoderBridgeRepeatedFrames.toString()}
            />
            <DiagnosticMetric
              label="Repeat bursts"
              value={diagnosticStats.encoderBridgeRepeatedFrameBursts.toString()}
            />
            <DiagnosticMetric
              label="Repeat max run"
              value={diagnosticStats.encoderBridgeMaxRepeatedFrameRun.toString()}
            />
            <DiagnosticMetric
              label="Synthetic frames"
              value={diagnosticStats.encoderBridgeSyntheticFrames.toString()}
            />
            <DiagnosticMetric
              label="Bridge src age"
              value={formatMs(diagnosticStats.encoderBridgeSourceAgeMs)}
            />
            <DiagnosticMetric
              label="Src age p95"
              value={formatMs(diagnosticStats.encoderBridgeSourceAgeP95Ms)}
            />
            <DiagnosticMetric
              label="Repeat age p95"
              value={formatMs(diagnosticStats.encoderBridgeRepeatedFrameAgeP95Ms)}
            />
            <DiagnosticMetric
              label="Bridge wait p95"
              value={formatMs(diagnosticStats.encoderBridgeCompositorWaitP95Ms)}
            />
            <DiagnosticMetric
              label="Writer total p95"
              value={formatMs(diagnosticStats.encoderBridgeWriterLoopP95Ms)}
            />
            <DiagnosticMetric
              label="Writer active p95"
              value={formatMs(diagnosticStats.encoderBridgeWriterActiveP95Ms)}
            />
            <DiagnosticMetric
              label="FIFO enqueue p95"
              value={formatMs(diagnosticStats.encoderBridgeVideoToolboxFifoEnqueueP95Ms)}
            />
            <DiagnosticMetric
              label="FIFO enqueue max"
              value={formatMs(diagnosticStats.encoderBridgeVideoToolboxFifoEnqueueMaxMs)}
            />
            <DiagnosticMetric
              label="Record writer p95"
              value={formatMs(diagnosticStats.encoderBridgeRecordingWriterLoopP95Ms)}
            />
            <DiagnosticMetric
              label="Stream writer p95"
              value={formatMs(diagnosticStats.encoderBridgeStreamWriterLoopP95Ms)}
            />
            <DiagnosticMetric
              label="Deadline lag"
              value={`${formatMs(diagnosticStats.encoderBridgeDeadlineLagP95Ms)} / ${diagnosticStats.encoderBridgeLateDeadlineTicks}`}
            />
            <DiagnosticMetric
              label="Metal targets"
              value={diagnosticStats.encoderBridgeMetalTargetFrames.toString()}
            />
            <DiagnosticMetric
              label="VT probe"
              value={`${diagnosticStats.encoderBridgeVideoToolboxProbeFrames} / ${formatBytes(diagnosticStats.encoderBridgeVideoToolboxProbeBytes)}`}
            />
            <DiagnosticMetric
              label="VT output"
              value={`${diagnosticStats.encoderBridgeVideoToolboxOutputFrames} / ${formatBytes(diagnosticStats.encoderBridgeVideoToolboxOutputBytes)}`}
            />
            <DiagnosticMetric
              label="VT encode max"
              value={formatMs(diagnosticStats.encoderBridgeVideoToolboxOutputEncodeMs)}
            />
          </MetricGroup>
          <MetricGroup title="System & sources">
            <DiagnosticMetric
              label="Image polls"
              value={formatImagePolls(diagnosticStats.previewImagePollCounts)}
            />
            <DiagnosticMetric
              label="Device state"
              value={diagnosticStats.deviceDisconnected ? 'Disconnected' : 'Connected'}
            />
            <DiagnosticMetric label="FFmpeg work" value={formatFfmpegWork(diagnosticStats)} />
            <DiagnosticMetric
              label="FFmpeg procs"
              value={diagnosticStats.activeFfmpegProcesses.toString()}
            />
            <DiagnosticMetric
              label="FFprobe procs"
              value={diagnosticStats.activeFfprobeProcesses.toString()}
            />
            <DiagnosticMetric
              label="Backend RSS"
              value={formatBytes(diagnosticStats.backendRssBytes)}
            />
            <DiagnosticMetric
              label="Duplicate capture"
              value={formatDuplicateCapture(diagnosticStats.duplicateCaptureSources)}
            />
            <DiagnosticMetric
              label="Source try-locks"
              value={formatSourceTryLocks(
                diagnosticStats.compositorCameraSourceTryLockMisses,
                diagnosticStats.compositorScreenSourceTryLockMisses
              )}
            />
            <DiagnosticMetric
              label="Source frame store"
              value={`${diagnosticStats.previewSourceFrameBufferCount} buffers, ${formatBytes(diagnosticStats.previewSourceFrameBytes)}, ${diagnosticStats.previewSourceFrameDroppedFrames} replaced`}
            />
            <DiagnosticMetric
              label="Source registry"
              value={formatSourceRegistry(diagnosticStats.sourceRegistry)}
            />
          </MetricGroup>
        </PanelSection>

        <PanelSection icon={Pulse} title="Pipeline">
          {recording.pipeline ? (
            <div className="grid gap-2">
              {recording.pipeline.stages.map((stage) => (
                <div
                  key={stage.stage}
                  className="flex items-center justify-between gap-3 rounded-row bg-muted/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium capitalize">
                      {stage.stage.replaceAll('-', ' ')}
                    </div>
                    {stage.detail ? (
                      <div className="truncate text-xs text-muted-foreground">{stage.detail}</div>
                    ) : null}
                  </div>
                  <Badge variant={stageBadgeVariant(stage.state)}>{stage.state}</Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No active recording pipeline.</p>
          )}
        </PanelSection>
      </div>

      <div className="flex flex-col gap-4">
        <PanelSection icon={TerminalWindow} title="Support bundle">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Redacted diagnostics JSON</p>
              <p className="truncate text-xs text-muted-foreground">Logs, health, sessions.</p>
            </div>
            <Button
              size="sm"
              disabled={supportBundleExportPending}
              onClick={() => void exportSupportBundle()}
            >
              <ArrowSquareOut className="mr-2 size-4" />
              {supportBundleExportPending ? 'Exporting' : 'Export'}
            </Button>
          </div>
        </PanelSection>

        <PanelSection icon={WarningCircle} title="Actionable warnings">
          {actionableEvents.length ? (
            <div className="flex flex-col gap-2">
              {actionableEvents.map((event) => (
                <ActionableWarning
                  key={event.id}
                  event={event}
                  onDismiss={() =>
                    setDismissed((current) => {
                      const next = new Set(current)
                      next.add(event.id)
                      return next
                    })
                  }
                  onHandlePermission={handleSystemPermission}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No permission warnings need action.</p>
          )}
        </PanelSection>

        <PanelSection icon={TerminalWindow} title="Session logs">
          <ScrollArea className="h-64 pr-3">
            <LogList entries={sessionLogs} />
          </ScrollArea>
        </PanelSection>

        <PanelSection icon={TerminalWindow} title="Backend logs">
          <ScrollArea className="h-64 pr-3">
            <div className="flex flex-col gap-1.5">
              {logs.length ? (
                logs
                  .slice(-80)
                  .map((log) => (
                    <LogRow
                      key={`${log.timestamp}-${log.message}`}
                      code={log.level}
                      createdAt={log.timestamp}
                      level={log.level}
                      message={log.message}
                    />
                  ))
              ) : (
                <p className="text-sm text-muted-foreground">No backend log lines yet.</p>
              )}
            </div>
          </ScrollArea>
        </PanelSection>
      </div>
    </div>
  )
}

function DiagnosticMetric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="rounded-row border bg-muted/40 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  )
}

// One collapsible per metric theme (ux-ia plan, slice 8): the verdicts panel
// answers "is anything wrong?"; these groups hold the numbers for when the
// answer is yes. Default closed.
function MetricGroup({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-row px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <CaretDown className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        <span>{title}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-2 pt-1.5 sm:grid-cols-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ActionableWarning({
  event,
  onDismiss,
  onHandlePermission
}: {
  event: HealthEvent
  onDismiss: () => void
  onHandlePermission: (pane: SystemPermissionPane) => Promise<void>
}): ReactElement {
  return (
    <div className="flex items-start justify-between gap-3 rounded-row border bg-warning/10 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge variant="warning">{event.code}</Badge>
          <span className="text-xs text-muted-foreground">{compactTime(event.createdAt)}</span>
        </div>
        <p className="mt-1 text-sm">{event.message}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {event.permissionPane ? (
          <Button
            aria-label="Resolve permission"
            size="icon"
            title="Resolve permission"
            variant="ghost"
            onClick={() => void onHandlePermission(event.permissionPane!)}
          >
            <ArrowSquareOut />
          </Button>
        ) : null}
        <Button
          aria-label="Dismiss warning"
          size="icon"
          title="Dismiss warning"
          variant="ghost"
          onClick={onDismiss}
        >
          <X />
        </Button>
      </div>
    </div>
  )
}

function LogList({ entries }: { entries: SessionLogEntry[] }): ReactElement {
  if (!entries.length) {
    return (
      <p className="text-sm text-muted-foreground">No persisted logs for the selected session.</p>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {entries.slice(-120).map((entry) => (
        <LogRow
          key={entry.id}
          code={entry.code}
          createdAt={entry.createdAt}
          level={entry.level}
          message={entry.message}
          sourceId={entry.sourceId}
        />
      ))}
    </div>
  )
}

function LogRow({
  code,
  createdAt,
  level,
  message,
  sourceId
}: {
  code: string
  createdAt: string
  level: HealthLevel | string
  message: string
  sourceId?: string
}): ReactElement {
  return (
    <div className="rounded-row bg-muted/40 px-3 py-2 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Badge variant={levelBadgeVariant(level)}>{level}</Badge>
        <span className="font-medium">{code}</span>
        {sourceId ? <span className="text-muted-foreground">{sourceId}</span> : null}
        <span className="ml-auto text-muted-foreground">{compactTime(createdAt)}</span>
      </div>
      <p className="break-words text-muted-foreground">{message}</p>
    </div>
  )
}

function stageBadgeVariant(
  state: string
): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline' {
  if (state === 'failed') {
    return 'destructive'
  }
  if (state === 'finalizing' || state === 'starting') {
    return 'warning'
  }
  if (state === 'running' || state === 'finished') {
    return 'success'
  }
  return 'secondary'
}

function levelBadgeVariant(
  level: HealthLevel | string
): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline' {
  if (level === 'error') {
    return 'destructive'
  }
  if (level === 'warn') {
    return 'warning'
  }
  return 'secondary'
}

function bottleneckCopy(bottleneck: DiagnosticBottleneck): { label: string; tone: StatusTone } {
  switch (bottleneck) {
    case 'audio':
      return { label: 'Audio', tone: 'warn' }
    case 'capture':
      return { label: 'Capture', tone: 'warn' }
    case 'render':
      return { label: 'Render', tone: 'warn' }
    case 'encoder':
      return { label: 'Encoder', tone: 'warn' }
    case 'preview':
      return { label: 'Preview', tone: 'warn' }
    case 'device':
      return { label: 'Device', tone: 'error' }
    case 'unknown':
      return { label: 'Collecting', tone: 'neutral' }
    default:
      return { label: 'None', tone: 'good' }
  }
}

function recordingQualityWarning(bottleneck: DiagnosticBottleneck): string | null {
  switch (bottleneck) {
    case 'encoder':
      return 'Recording is below real time. Lower bitrate or resolution if the final video is laggy.'
    case 'capture':
    case 'render':
      return 'Capture is not keeping up with the target FPS. Lower resolution or close heavy apps if the final video is laggy.'
    case 'audio':
      return 'Microphone capture dropped frames. Check the selected mic or reduce system load.'
    case 'preview':
      return 'Preview dropped frames. Recording quality is kept unchanged.'
    default:
      return null
  }
}

function sourceSummaryCopy(
  stats: DiagnosticStats,
  previewCameraStatus: PreviewCameraStatus,
  previewScreenStatus: PreviewScreenStatus
): { label: string; tone: StatusTone } {
  if (stats.deviceDisconnected) {
    return { label: 'Device disconnected', tone: 'error' }
  }
  if (stats.duplicateCaptureSources.length) {
    return { label: 'Duplicate capture', tone: 'warn' }
  }
  if (
    stats.previewCameraDroppedFrames > 0 ||
    stats.previewScreenDroppedFrames > 0 ||
    previewCameraStatus.droppedFrames > 0 ||
    previewScreenStatus.droppedFrames > 0
  ) {
    return { label: 'Source drops', tone: 'warn' }
  }
  if (stats.captureFps && stats.targetFps && stats.captureFps < stats.targetFps * 0.9) {
    return { label: 'Capture slow', tone: 'warn' }
  }
  return { label: 'Healthy', tone: 'good' }
}

function compositorSummaryCopy(stats: DiagnosticStats): { label: string; tone: StatusTone } {
  const targetFps = stats.targetFps ?? stats.previewTargetFps
  if (targetFps) {
    const frameBudgetMs = 1000 / Math.max(1, targetFps)
    if (
      typeof stats.compositorTickGapP95Ms === 'number' &&
      stats.compositorTickGapP95Ms > frameBudgetMs * 1.5
    ) {
      return { label: 'Tick gap high', tone: 'warn' }
    }
    if (
      typeof stats.compositorTickGapMaxMs === 'number' &&
      stats.compositorTickGapMaxMs > frameBudgetMs * 3
    ) {
      return { label: 'Tick spike', tone: 'warn' }
    }
  }
  if (stats.renderFps && stats.targetFps && stats.renderFps < stats.targetFps * 0.9) {
    return { label: 'Render slow', tone: 'warn' }
  }
  if (stats.previewRenderFrameTimeP95Ms && stats.previewTargetFps) {
    const frameBudgetMs = 1000 / Math.max(1, stats.previewTargetFps)
    if (stats.previewRenderFrameTimeP95Ms > frameBudgetMs * 1.5) {
      return { label: 'Frame time high', tone: 'warn' }
    }
  }
  return {
    label: stats.renderFps ? `${stats.renderFps.toFixed(1)} fps` : 'Idle',
    tone: stats.renderFps ? 'good' : 'neutral'
  }
}

function encoderSummaryCopy(
  stats: DiagnosticStats,
  streamHealth: { speed?: number; droppedFrames?: number } | null
): { label: string; tone: StatusTone } {
  const speed = stats.encoderSpeed ?? streamHealth?.speed
  const drops = stats.droppedFrames || streamHealth?.droppedFrames || 0
  if (drops > 0) {
    return { label: `${drops} drop`, tone: 'warn' }
  }
  if (typeof speed === 'number' && speed < 0.98) {
    return { label: `${speed.toFixed(2)}x`, tone: 'warn' }
  }
  return {
    label: typeof speed === 'number' ? `${speed.toFixed(2)}x` : 'Idle',
    tone: typeof speed === 'number' ? 'good' : 'neutral'
  }
}

function repairSummaryCopy(stats: DiagnosticStats): { label: string; tone: StatusTone } {
  if (stats.ffmpegMaintenanceCancelRequested) {
    return { label: 'Cancelling', tone: 'warn' }
  }
  if (stats.ffmpegMaintenanceRunning) {
    return { label: 'Running', tone: 'warn' }
  }
  if (stats.ffmpegMaintenanceDeferredReason) {
    return { label: 'Deferred', tone: 'neutral' }
  }
  return { label: 'Idle', tone: 'good' }
}

function memorySummaryCopy(bytes?: number): { label: string; tone: StatusTone } {
  if (typeof bytes !== 'number') {
    return { label: 'Unknown', tone: 'neutral' }
  }
  const mib = bytes / (1024 * 1024)
  if (mib >= 2048) {
    return { label: formatBytes(bytes), tone: 'error' }
  }
  if (mib >= 1024) {
    return { label: formatBytes(bytes), tone: 'warn' }
  }
  return { label: formatBytes(bytes), tone: 'good' }
}

function networkSummaryCopy(targets: StreamTargetRuntime[]): { label: string; tone: StatusTone } {
  if (!targets.length) {
    return { label: 'Idle', tone: 'neutral' }
  }
  const failed = targets.filter((target) => target.state === 'failed').length
  if (failed) {
    return { label: `${failed} failed`, tone: 'warn' }
  }
  const live = targets.filter((target) => target.state === 'live').length
  if (live) {
    return { label: `${live}/${targets.length} live`, tone: 'good' }
  }
  const waiting = targets.filter(
    (target) => target.state === 'connecting' || target.state === 'warning'
  ).length
  if (waiting) {
    return { label: `${waiting} waiting`, tone: 'warn' }
  }
  return { label: 'Ready', tone: 'neutral' }
}

type PreviewDiagnosis = {
  label: string
  tone: StatusTone
}

function previewDiagnosisCopy({
  diagnosticStats,
  expectsCamera,
  expectsScreen,
  nativePreviewSurfaceEnabled,
  previewCameraStatus,
  previewLiveStatus,
  previewScreenStatus,
  previewSurfaceStatus
}: {
  diagnosticStats: DiagnosticStats
  expectsCamera: boolean
  expectsScreen: boolean
  nativePreviewSurfaceEnabled: boolean
  previewCameraStatus: PreviewCameraStatus
  previewLiveStatus: PreviewLiveStatus
  previewScreenStatus: PreviewScreenStatus
  previewSurfaceStatus: PreviewSurfaceStatus
}): PreviewDiagnosis {
  const syntheticNativeSurface =
    nativePreviewSurfaceEnabled && previewSurfaceStatus.source === 'synthetic'
  const shouldCheckCamera = expectsCamera && !syntheticNativeSurface
  const shouldCheckScreen = expectsScreen && !syntheticNativeSurface
  if (
    (shouldCheckCamera && previewCameraStatus.state === 'permission-needed') ||
    (shouldCheckScreen && previewScreenStatus.state === 'permission-needed')
  ) {
    return { label: 'Permission', tone: 'error' }
  }
  if (
    shouldCheckCamera &&
    (previewCameraStatus.state === 'failed' || previewCameraStatus.state === 'device-missing')
  ) {
    return { label: 'Camera capture', tone: 'error' }
  }
  if (
    shouldCheckScreen &&
    (previewScreenStatus.state === 'failed' || previewScreenStatus.state === 'source-missing')
  ) {
    return {
      label: 'Screen capture',
      tone: previewScreenStatus.state === 'failed' ? 'error' : 'warn'
    }
  }
  if (!nativePreviewSurfaceEnabled) {
    return {
      label: 'Fallback',
      tone: diagnosticStats.previewTransport === 'unavailable' ? 'neutral' : 'warn'
    }
  }
  if (diagnosticStats.previewTransport === 'electron-proof-surface') {
    return { label: 'Proof surface', tone: 'warn' }
  }
  if (diagnosticStats.previewTransport !== 'native-surface') {
    return {
      label: 'Fallback',
      tone: diagnosticStats.previewTransport === 'unavailable' ? 'neutral' : 'warn'
    }
  }
  if (diagnosticStats.previewSurfaceBacking !== 'cametal-layer') {
    return { label: 'Surface backing', tone: 'warn' }
  }

  const targetFps = diagnosticStats.previewTargetFps ?? previewSurfaceStatus.targetFps
  const minimumSourceFps = targetFps * 0.9
  if (
    shouldCheckCamera &&
    previewCameraStatus.state === 'live' &&
    typeof previewCameraStatus.sourceFps === 'number' &&
    previewCameraStatus.sourceFps < minimumSourceFps
  ) {
    return { label: 'Camera capture', tone: 'warn' }
  }
  if (
    shouldCheckScreen &&
    previewScreenStatus.state === 'live' &&
    typeof previewScreenStatus.sourceFps === 'number' &&
    previewScreenStatus.sourceFps < minimumSourceFps
  ) {
    return { label: 'Screen capture', tone: 'warn' }
  }
  if (
    typeof diagnosticStats.previewRenderFrameTimeP95Ms === 'number' &&
    diagnosticStats.previewRenderFrameTimeP95Ms > (1000 / Math.max(1, targetFps)) * 1.5
  ) {
    return { label: 'Render', tone: 'warn' }
  }
  if (
    typeof diagnosticStats.previewPresentFps === 'number' &&
    diagnosticStats.previewPresentFps < minimumSourceFps
  ) {
    return { label: 'Present', tone: 'warn' }
  }
  if (
    diagnosticStats.previewDroppedFrames > 0 ||
    diagnosticStats.previewRepeatedFrames > targetFps ||
    (typeof diagnosticStats.previewCompositorFrameLag === 'number' &&
      diagnosticStats.previewCompositorFrameLag > 2) ||
    (typeof diagnosticStats.previewInputToPresentLatencyP95Ms === 'number' &&
      diagnosticStats.previewInputToPresentLatencyP95Ms > 50) ||
    (typeof diagnosticStats.previewInputToPresentLatencyMs === 'number' &&
      diagnosticStats.previewInputToPresentLatencyMs > 150)
  ) {
    return { label: 'Renderer UI', tone: 'warn' }
  }
  if (previewLiveStatus.state !== 'live') {
    return { label: 'Collecting', tone: 'neutral' }
  }
  return { label: 'None', tone: 'good' }
}

function previewStatusTone(
  previewLiveStatus: PreviewLiveStatus,
  previewCameraStatus: PreviewCameraStatus,
  previewScreenStatus: PreviewScreenStatus
): StatusTone {
  if (
    previewCameraStatus.state === 'permission-needed' ||
    previewScreenStatus.state === 'permission-needed'
  ) {
    return 'error'
  }
  return previewLiveStatus.state === 'live' ? 'good' : 'warn'
}

function previewSourceTone(
  state: PreviewCameraStatus['state'] | PreviewScreenStatus['state']
): StatusTone {
  if (state === 'live') {
    return 'good'
  }
  if (state === 'permission-needed' || state === 'failed') {
    return 'error'
  }
  return 'neutral'
}

function formatPreviewSourceStatus(
  state: PreviewCameraStatus['state'] | PreviewScreenStatus['state'],
  sourceFps?: number,
  droppedFrames?: number
): string {
  const fps = typeof sourceFps === 'number' ? `${sourceFps.toFixed(1)} fps` : '-- fps'
  return `${state}, ${fps}, ${droppedFrames ?? 0} drop`
}

function formatFfmpegWork(stats: DiagnosticStats): string {
  if (stats.ffmpegMaintenanceCancelRequested) {
    return 'Cancelling maintenance'
  }
  if (stats.ffmpegCaptureActive) {
    return 'Capture active'
  }
  if (stats.ffmpegFinalizingActive) {
    return 'Finalizing'
  }
  if (stats.ffmpegMaintenanceRunning) {
    return 'Maintenance running'
  }
  return stats.ffmpegMaintenanceDeferredReason ?? 'Idle'
}

function formatMs(value?: number): string {
  return typeof value === 'number' ? `${value.toFixed(0)} ms` : '-- ms'
}

function formatFrameLag(value?: number): string {
  return typeof value === 'number' ? `${value.toFixed(0)} frames` : '-- frames'
}

function formatBytes(value?: number): string {
  if (typeof value !== 'number') {
    return '--'
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(0)} KiB`
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function formatDuplicateCapture(sources: string[]): string {
  return sources.length ? sources.join(', ') : 'None'
}

function formatSourceTryLocks(cameraMisses: number, screenMisses: number): string {
  return `cam ${cameraMisses}, screen ${screenMisses}`
}

export function formatWebSocketQueue(queue: WebSocketQueueDiagnosticStats): string {
  const oldest = queue.oldestAgeMs == null ? '--' : `${queue.oldestAgeMs} ms`
  return `${queue.currentDepth}/${queue.maxDepth} current/max · ${oldest} oldest · ${queue.coalescedCount} coalesced · ${queue.evictedOrDroppedCount} evicted/dropped`
}

function formatSourceRegistry(registry?: DiagnosticStats['sourceRegistry']): string {
  const entries = registry?.entries ?? []
  if (!entries.length) {
    return 'None'
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
    case 'electron-proof-surface':
      return 'Proof'
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
    case 'electron-browser-window':
      return 'Electron BrowserWindow'
    case 'none':
      return 'None'
    default:
      return '--'
  }
}

function formatCoverage(value?: number): string {
  return typeof value === 'number' ? `${(value * 100).toFixed(0)}%` : '--'
}

function formatEncodeBackend(backend?: string): string {
  switch (backend) {
    case 'software-x264':
      return 'Software (x264)'
    case 'hardware-videotoolbox':
      return 'Hardware (VideoToolbox)'
    case 'hardware-media-foundation':
      return 'Hardware (MediaFoundation)'
    case 'software-media-foundation':
      return 'Software (MediaFoundation)'
    case 'software-open-h264':
      return 'Software (OpenH264)'
    default:
      return '--'
  }
}

function formatCompositorBackend(stats: DiagnosticStats): string {
  switch (stats.compositorBackend) {
    case 'metal':
      return 'Metal'
    case 'cpu-fallback': {
      const frames = stats.compositorCpuFallbackFrames ?? 0
      const reason = stats.compositorFallbackReason ? `: ${stats.compositorFallbackReason}` : ''
      return `CPU fallback (${frames})${reason}`
    }
    default:
      return '--'
  }
}

function formatImagePolls(counts?: DiagnosticStats['previewImagePollCounts']): string {
  if (!counts) {
    return '--'
  }
  const total = counts.cameraPng + counts.screenPng + counts.liveJpeg + counts.liveMjpeg
  return total === 0
    ? 'None'
    : `${total} (cam ${counts.cameraPng}, scr ${counts.screenPng}, jpg ${counts.liveJpeg}, mjpeg ${counts.liveMjpeg})`
}

// The plan's "OBS-native preview" vs "Fallback preview" badge. Only the real Metal
// layer may report native-surface; the Electron proof window stays explicitly non-native.
function previewPathBadge(
  transport?: string,
  backing?: string
): { label: string; tone: StatusTone } {
  switch (transport) {
    case 'native-surface':
      return backing === 'cametal-layer'
        ? { label: 'OBS-native', tone: 'good' }
        : { label: 'Surface proof', tone: 'warn' }
    case 'electron-proof-surface':
      return { label: 'Proof surface', tone: 'warn' }
    case 'latest-jpeg-polling':
      return { label: 'Fallback (JPEG)', tone: 'warn' }
    case 'mjpeg-stream':
      return { label: 'Fallback (MJPEG)', tone: 'warn' }
    default:
      return { label: 'Off', tone: 'neutral' }
  }
}

// "Recording at risk" when a measured problem compromises the output; "Protected" when
// consuming the compositor through the protected encoder-bridge path; else "Active"/"Idle".
function recordingBadge(stats: DiagnosticStats): { label: string; tone: StatusTone } {
  if (stats.recordingAtRisk) {
    return { label: 'At risk', tone: 'error' }
  }
  if (stats.recordingProtected) {
    return { label: 'Protected', tone: 'good' }
  }
  if (stats.activeOutputMode) {
    return { label: 'Active', tone: 'good' }
  }
  return { label: 'Idle', tone: 'neutral' }
}

function formatSourceFps(sourceFps?: Record<string, number>): string {
  if (!sourceFps || !Object.keys(sourceFps).length) {
    return '-- fps'
  }

  return Object.entries(sourceFps)
    .map(([source, fps]) => `${source}: ${fps.toFixed(1)}`)
    .join(', ')
}
