import {
  ArrowSquareOut,
  Gauge,
  Pulse,
  TerminalWindow,
  WarningCircle,
  X
} from '@phosphor-icons/react'
import { useMemo, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStudio } from '@/hooks/use-studio'
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
  SystemPermissionPane
} from '@/lib/backend'
import { compactTime, formatDroppedFrames, formatMetric } from '@/lib/format'

export function DiagnosticsTab(): ReactElement {
  const {
    diagnosticStats,
    healthEvents,
    logs,
    openSystemPermission,
    recording,
    sessions,
    streamHealth,
    previewLiveStatus,
    previewCameraStatus,
    previewScreenStatus,
    previewSurfaceStatus,
    nativePreviewSurfaceEnabled,
    captureConfig
  } = useStudio()
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  const activeSession =
    sessions.find((session) => session.id === recording.sessionId) ?? sessions[0] ?? null
  const actionableEvents = healthEvents.filter((event) => event.permissionPane && !dismissed.has(event.id))
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
  const qualityWarning = useMemo(() => recordingQualityWarning(diagnosticStats.bottleneck), [diagnosticStats.bottleneck])

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col gap-4">
        <PanelSection
          description="Current capture and preview health."
          icon={Gauge}
          title="Live stats"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <DiagnosticMetric label="Output mode" value={diagnosticStats.activeOutputMode ?? 'Idle'} />
            <DiagnosticMetric
              label="Scene revision"
              value={diagnosticStats.activeSceneRevision == null ? 'None' : diagnosticStats.activeSceneRevision.toString()}
            />
            <DiagnosticMetric label="Capture FPS" value={formatMetric(diagnosticStats.captureFps ?? streamHealth?.fps, 'fps')} />
            <DiagnosticMetric label="Render FPS" value={formatMetric(diagnosticStats.renderFps ?? streamHealth?.fps, 'fps')} />
            <DiagnosticMetric label="Skipped frames" value={diagnosticStats.skippedFrames.toString()} />
            <DiagnosticMetric label="Dropped frames" value={formatDroppedFrames(diagnosticStats.droppedFrames || streamHealth?.droppedFrames)} />
            <DiagnosticMetric label="Encoder speed" value={formatMetric(diagnosticStats.encoderSpeed ?? streamHealth?.speed, 'x')} />
            <DiagnosticMetric label="Preview mode" value={formatPreviewTransport(diagnosticStats.previewTransport)} />
            <DiagnosticMetric label="Preview source FPS" value={formatSourceFps(diagnosticStats.previewSourceFps)} />
            <DiagnosticMetric label="Preview present FPS" value={formatMetric(diagnosticStats.previewPresentFps, 'fps')} />
            <DiagnosticMetric label="Preview target" value={formatMetric(diagnosticStats.previewTargetFps, 'fps')} />
            <DiagnosticMetric label="Preview cadence" value={formatMs(diagnosticStats.previewLatencyMs)} />
            <DiagnosticMetric label="Preview age" value={formatMs(diagnosticStats.previewFrameAgeMs)} />
            <DiagnosticMetric label="Input to present" value={formatMs(diagnosticStats.previewInputToPresentLatencyMs)} />
            <DiagnosticMetric label="Render p95" value={formatMs(diagnosticStats.previewRenderFrameTimeP95Ms)} />
            <DiagnosticMetric label="Preview drops" value={diagnosticStats.previewDroppedFrames.toString()} />
            <DiagnosticMetric label="Camera age" value={formatMs(diagnosticStats.previewCameraFrameAgeMs ?? previewCameraStatus.frameAgeMs)} />
            <DiagnosticMetric label="Screen age" value={formatMs(diagnosticStats.previewScreenFrameAgeMs ?? previewScreenStatus.frameAgeMs)} />
            <DiagnosticMetric label="Repeated frames" value={diagnosticStats.previewRepeatedFrames.toString()} />
            <DiagnosticMetric label="Surface resizes" value={diagnosticStats.previewSurfaceResizeCount.toString()} />
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
            <DiagnosticMetric label="Surface state" value={`${previewSurfaceStatus.state} (${previewSurfaceStatus.framesRendered} frames)`} />
            <DiagnosticMetric label="Mic drops" value={diagnosticStats.micDroppedFrames.toString()} />
            <DiagnosticMetric label="Device state" value={diagnosticStats.deviceDisconnected ? 'Disconnected' : 'Connected'} />
            <DiagnosticMetric label="FFmpeg work" value={formatFfmpegWork(diagnosticStats)} />
            <DiagnosticMetric label="FFmpeg procs" value={diagnosticStats.activeFfmpegProcesses.toString()} />
            <DiagnosticMetric label="FFprobe procs" value={diagnosticStats.activeFfprobeProcesses.toString()} />
            <DiagnosticMetric label="Backend RSS" value={formatBytes(diagnosticStats.backendRssBytes)} />
            <DiagnosticMetric label="Duplicate capture" value={formatDuplicateCapture(diagnosticStats.duplicateCaptureSources)} />
            <DiagnosticMetric
              label="Source frame store"
              value={`${diagnosticStats.previewSourceFrameBufferCount} buffers, ${formatBytes(diagnosticStats.previewSourceFrameBytes)}, ${diagnosticStats.previewSourceFrameDroppedFrames} replaced`}
            />
            <DiagnosticMetric label="Source registry" value={formatSourceRegistry(diagnosticStats.sourceRegistry)} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge label="Likely bottleneck" tone={bottleneck.tone} value={bottleneck.label} />
            <StatusBadge label="Preview bottleneck" tone={previewDiagnosis.tone} value={previewDiagnosis.label} />
            <StatusBadge label="Preview" tone={previewStatusTone(previewLiveStatus, previewCameraStatus, previewScreenStatus)} value={previewLiveStatus.state} />
            <StatusBadge label="Preview path" tone={diagnosticStats.previewTransport === 'native-surface' ? 'good' : 'warn'} value={formatPreviewTransport(diagnosticStats.previewTransport)} />
            <StatusBadge label="Camera" tone={previewSourceTone(previewCameraStatus.state)} value={previewCameraStatus.state} />
            <StatusBadge label="Screen" tone={previewSourceTone(previewScreenStatus.state)} value={previewScreenStatus.state} />
            <StatusBadge label="Maintenance" tone={diagnosticStats.ffmpegMaintenanceRunning ? 'warn' : 'good'} value={diagnosticStats.ffmpegMaintenanceRunning ? 'Running' : 'Idle'} />
            {diagnosticStats.duplicateCaptureSources.length ? (
              <StatusBadge label="Duplicate capture" tone="warn" value={diagnosticStats.duplicateCaptureSources.length.toString()} />
            ) : null}
            {diagnosticStats.targetFps ? (
              <Badge variant="outline">Target {diagnosticStats.targetFps} FPS</Badge>
            ) : null}
          </div>
          {qualityWarning ? (
            <p className="text-sm text-warning">{qualityWarning}</p>
          ) : null}
        </PanelSection>

        <PanelSection icon={Pulse} title="Pipeline">
          {recording.pipeline ? (
            <div className="grid gap-2">
              {recording.pipeline.stages.map((stage) => (
                <div key={stage.stage} className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium capitalize">{stage.stage.replaceAll('-', ' ')}</div>
                    {stage.detail ? <div className="truncate text-xs text-muted-foreground">{stage.detail}</div> : null}
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
                  onOpenPermission={openSystemPermission}
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
                logs.slice(-80).map((log) => (
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
    <div className="rounded-lg border bg-muted/40 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function ActionableWarning({
  event,
  onDismiss,
  onOpenPermission
}: {
  event: HealthEvent
  onDismiss: () => void
  onOpenPermission: (pane: SystemPermissionPane) => Promise<void>
}): ReactElement {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border bg-warning/10 px-3 py-2">
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
            aria-label="Open permission settings"
            size="icon"
            title="Open permission settings"
            variant="ghost"
            onClick={() => void onOpenPermission(event.permissionPane!)}
          >
            <ArrowSquareOut />
          </Button>
        ) : null}
        <Button aria-label="Dismiss warning" size="icon" title="Dismiss warning" variant="ghost" onClick={onDismiss}>
          <X />
        </Button>
      </div>
    </div>
  )
}

function LogList({ entries }: { entries: SessionLogEntry[] }): ReactElement {
  if (!entries.length) {
    return <p className="text-sm text-muted-foreground">No persisted logs for the selected session.</p>
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
    <div className="rounded-lg bg-muted/40 px-3 py-2 text-xs">
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

function levelBadgeVariant(level: HealthLevel | string): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline' {
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
  const syntheticNativeSurface = nativePreviewSurfaceEnabled && previewSurfaceStatus.source === 'synthetic'
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
    return { label: 'Screen capture', tone: previewScreenStatus.state === 'failed' ? 'error' : 'warn' }
  }
  if (!nativePreviewSurfaceEnabled || diagnosticStats.previewTransport !== 'native-surface') {
    return { label: 'Fallback', tone: diagnosticStats.previewTransport === 'unavailable' ? 'neutral' : 'warn' }
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
    diagnosticStats.previewRenderFrameTimeP95Ms > 1000 / Math.max(1, targetFps) * 1.5
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
  if (previewCameraStatus.state === 'permission-needed' || previewScreenStatus.state === 'permission-needed') {
    return 'error'
  }
  return previewLiveStatus.state === 'live' ? 'good' : 'warn'
}

function previewSourceTone(state: PreviewCameraStatus['state'] | PreviewScreenStatus['state']): StatusTone {
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
    case 'latest-jpeg-polling':
      return 'JPEG'
    case 'mjpeg-stream':
      return 'MJPEG'
    default:
      return 'Unavailable'
  }
}

function formatSourceFps(sourceFps?: Record<string, number>): string {
  if (!sourceFps || !Object.keys(sourceFps).length) {
    return '-- fps'
  }

  return Object.entries(sourceFps)
    .map(([source, fps]) => `${source}: ${fps.toFixed(1)}`)
    .join(', ')
}
