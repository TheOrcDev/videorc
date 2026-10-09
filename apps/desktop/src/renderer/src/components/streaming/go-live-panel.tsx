import { StreamQualityControl } from './stream-quality-control'
import { withStreamQuality } from '@/lib/output-quality'
import { AlertIcon, ChevronDownIcon, SuccessIcon, SyncIcon } from '@/components/icons'
import { useMemo, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  useStudioCore,
  useStudioDiagnostics,
  type StreamOutputTopologyPreflight
} from '@/hooks/use-studio'
import type {
  DiagnosticStats,
  PlatformAccount,
  StreamHealth,
  StreamPlatform,
  StreamTargetRuntime,
  StreamTargetSettings,
  VideoSettings
} from '@/lib/backend'
import {
  coerceVideoToOrientation,
  simulcastArmed,
  simulcastStreamVideo,
  providerStreamOutputPlanOptions,
  resolveProviderStreamOutputPlan,
  STREAM_OUTPUT_GOP_SECONDS,
  streamVideoProfileValidationReason,
  type ProviderStreamOutputPlan,
  videoProfileCompatibility
} from '@/lib/capture'
import { destinationSetup, destinationSetupHint } from '@/lib/destination-readiness'
import {
  classifyStreamHealthAttribution,
  type StreamHealthAttribution
} from '@/lib/stream-health-attribution'
import { cn } from '@/lib/utils'

// The Livestream right column (plan 080 S7). Owner, 2026-09-30: "Live stream
// should be about connecting your accounts and not about reading some tech
// data." A short checklist in plain words says whether you can go live; the
// encoder paths and frame counters sit in Technical details, closed by
// default. This component owns the diagnostics subscription, so the stats
// tick no longer re-renders the destination list and the Broadcast info form.

type BadgeTone = 'success' | 'warning' | 'destructive' | 'live' | 'outline'

/** Per-viewer convenience only; the page renders the closed default without it. */
export const TECHNICAL_DETAILS_STORAGE_KEY = 'videorc.livestream.technicalDetails'

export function GoLivePanel({
  onOpenDestination
}: {
  onOpenDestination: (targetId: string) => void
}): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    goLiveConfirmationPending,
    goLivePartialSetup,
    health,
    isSessionActive,
    platformAccounts,
    streamOutputTopologyPreflight,
    refreshStreamOutputTopology,
    streamSharedEncodeFallbackVideo,
    streamTargets
  } = useStudioCore()
  const { diagnosticStats, streamHealth } = useStudioDiagnostics()
  const streaming = captureConfig.streaming
  // No separate stream encoder on this computer: the session records at the
  // stream's profile, so show that instead of the Output setting.
  const video = streamSharedEncodeFallbackVideo ?? captureConfig.video
  const preflightProvesSeparateOutput =
    streamOutputTopologyPreflight.state === 'ready' &&
    streamOutputTopologyPreflight.result.outputRoles.length === 2 &&
    streamOutputTopologyPreflight.result.outputRoles[0] === 'recording' &&
    streamOutputTopologyPreflight.result.outputRoles[1] === 'stream' &&
    streamOutputTopologyPreflight.result.effectiveBridgeOutput !== 'raw-yuv420p' &&
    (streamOutputTopologyPreflight.result.probeState === 'passed' ||
      streamOutputTopologyPreflight.result.probeState === 'not-required')
  const separateEncodedOutputRoleAvailable = isSessionActive
    ? diagnosticStats.encoderBridgeSeparateOutputEncodersActive
    : preflightProvesSeparateOutput
  let providerPlan = resolveProviderStreamOutputPlan(
    video,
    captureConfig.streamEnabled ? streaming : undefined,
    providerStreamOutputPlanOptions(captureConfig, separateEncodedOutputRoleAvailable)
  )
  if (simulcastArmed(captureConfig)) {
    const verticalVideo = simulcastStreamVideo(video, streaming)
    providerPlan = {
      ...providerPlan,
      targets: [
        ...providerPlan.targets,
        ...streaming.targets
          .filter((target) => target.enabled && target.outputOrientation === 'vertical')
          .map((target) => ({ target, video: verticalVideo }))
      ]
    }
  }
  const compatibility = videoProfileCompatibility(captureConfig)
  const compatibilityMessage = compatibility.blockingReason ?? compatibility.warning
  const accountByPlatform = useMemo(() => {
    const map = new Map<StreamPlatform, PlatformAccount>()
    for (const account of platformAccounts) map.set(account.platform, account)
    return map
  }, [platformAccounts])
  const streamEnabled = captureConfig.streamEnabled && streaming.enabled
  const liveOutputActive = isSessionActive && streamEnabled
  const currentStreamHealth =
    streamHealth &&
    (!diagnosticStats.sessionId || diagnosticStats.sessionId === streamHealth.sessionId)
      ? streamHealth
      : null

  return (
    <div className="flex min-w-0 flex-col border-t lg:border-t-0">
      {compatibilityMessage ? (
        <div className="border-b border-border p-gutter">
          <Alert variant="warning">
            <AlertIcon weight="fill" />
            <AlertDescription>{compatibilityMessage}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      <PanelSection title="Output quality">
        <StreamQualityControl
          value={streaming.defaultOutputPreset}
          disabled={isSessionActive || goLiveConfirmationPending || Boolean(goLivePartialSetup)}
          youtube={streaming.targets.some(
            (target) => target.enabled && target.platform === 'youtube'
          )}
          onChange={(preset) => {
            if (preset !== 'default')
              setCaptureConfig((current) => ({
                ...current,
                streaming: withStreamQuality(current.streaming, preset)
              }))
          }}
        />
      </PanelSection>
      <ReadyToGoLive
        accountByPlatform={accountByPlatform}
        diagnosticStats={diagnosticStats}
        ffmpegReady={Boolean(health?.ffmpeg.available)}
        liveOutputActive={liveOutputActive}
        preflight={streamOutputTopologyPreflight}
        profileCompatible={!compatibility.blockingReason}
        providerPlan={providerPlan}
        recordEnabled={captureConfig.recordEnabled}
        recordingMatchesStream={streamSharedEncodeFallbackVideo !== null}
        recordingVideo={video}
        streamHealth={currentStreamHealth}
        streamTargets={streamTargets}
        targets={streaming.targets}
        onOpenDestination={onOpenDestination}
        onRetry={refreshStreamOutputTopology}
      />
      <TechnicalDetails
        diagnosticStats={diagnosticStats}
        liveOutputActive={liveOutputActive}
        preflight={streamOutputTopologyPreflight}
        providerPlan={providerPlan}
        streamHealth={currentStreamHealth}
        streamTargets={streamTargets}
      />
    </div>
  )
}

export function ReadyToGoLive({
  targets,
  accountByPlatform,
  ffmpegReady,
  profileCompatible,
  providerPlan,
  recordEnabled,
  recordingMatchesStream = false,
  recordingVideo,
  preflight,
  liveOutputActive,
  diagnosticStats,
  streamHealth,
  streamTargets,
  onOpenDestination,
  onRetry
}: {
  targets: StreamTargetSettings[]
  accountByPlatform: ReadonlyMap<StreamPlatform, PlatformAccount>
  ffmpegReady: boolean
  profileCompatible: boolean
  providerPlan: ProviderStreamOutputPlan
  recordEnabled: boolean
  recordingMatchesStream?: boolean
  recordingVideo: VideoSettings
  preflight: StreamOutputTopologyPreflight
  liveOutputActive: boolean
  diagnosticStats: DiagnosticStats
  streamHealth: StreamHealth | null
  streamTargets: StreamTargetRuntime[]
  onOpenDestination: (targetId: string) => void
  onRetry: () => Promise<void>
}): ReactElement {
  const enabled = targets.filter((target) => target.enabled)
  const notReady = enabled.flatMap((target) => {
    const hint = destinationSetupHint(
      destinationSetup(target, accountByPlatform.get(target.platform))
    )
    return hint ? [{ target, hint }] : []
  })
  const readyCount = enabled.length - notReady.length
  const outputs = streamOutputs(providerPlan)
  const presetOk =
    profileCompatible &&
    outputs.every(
      ({ target, video }) => streamVideoProfileValidationReason(video, target?.platform) === null
    )
  const quality = qualitySummary(outputs)
  const uploadMbps = enabled.length
    ? Math.round(
        (outputs.reduce((total, { video }) => total + video.bitrateKbps + 128, 0) * 1.1) / 100
      ) / 10
    : 0
  const diskGbPerHour = Math.round((recordingVideo.bitrateKbps / 8 / 1000) * 3600) / 1000
  const showRecordingOutput =
    recordEnabled &&
    (providerPlan.separateEncodedOutputRole ||
      outputs.some(({ video }) => video.preset === 'stream-youtube-4k30'))

  return (
    <PanelSection contentClassName="gap-2.5" title="Ready to go live">
      <ChecklistRow
        detail={
          enabled.length
            ? `${readyCount} of ${enabled.length} ready`
            : 'Turn on at least one destination'
        }
        label="Destinations"
        ok={enabled.length > 0 && notReady.length === 0}
      />
      {notReady.length ? (
        <div className="-mt-1 flex flex-col pl-6" data-slot="destinations-not-ready">
          {notReady.map(({ target, hint }) => (
            <Button
              className="h-auto justify-start px-0 py-0.5 text-xs font-normal text-muted-foreground hover:text-foreground"
              key={target.id}
              size="xs"
              variant="link"
              onClick={() => onOpenDestination(target.id)}
            >
              {target.label} · {hint}
            </Button>
          ))}
        </div>
      ) : null}
      {liveOutputActive ? (
        <LiveStreamRow
          diagnosticStats={diagnosticStats}
          streamHealth={streamHealth}
          streamTargets={streamTargets}
        />
      ) : enabled.length ? (
        <StreamCheckRow preflight={preflight} onRetry={onRetry} />
      ) : null}
      <ChecklistRow
        detail={presetOk ? quality.text : `${quality.text} · choose a stream-safe preset`}
        label="Quality"
        ok={presetOk}
        title={quality.title}
      />
      {recordEnabled && recordingMatchesStream ? (
        <InfoRow
          detail={`${formatQuality(recordingVideo)} · matches the stream`}
          label="Recording"
        />
      ) : showRecordingOutput ? (
        <InfoRow detail={formatQuality(recordingVideo)} label="Recording" />
      ) : null}
      {enabled.length ? (
        <InfoRow detail={`About ${uploadMbps} Mbps`} label="Upload needed" />
      ) : null}
      {recordEnabled ? (
        <InfoRow detail={`About ${diskGbPerHour} GB per hour`} label="Disk" />
      ) : null}
      {ffmpegReady ? null : (
        <ChecklistRow detail="Missing. Check Settings." label="FFmpeg" ok={false} />
      )}
    </PanelSection>
  )
}

/** The output-path preflight, the one idle check that blocks Go Live. */
function StreamCheckRow({
  preflight,
  onRetry
}: {
  preflight: StreamOutputTopologyPreflight
  onRetry: () => Promise<void>
}): ReactElement {
  switch (preflight.state) {
    case 'ready':
      return <ChecklistRow detail="Checked" label="Stream settings" ok />
    case 'pending':
      return <ChecklistRow detail="Checking…" label="Stream settings" ok={false} />
    case 'failed':
      return (
        <div className="flex flex-col gap-1" title={preflight.message}>
          <ChecklistRow detail="Couldn't check" label="Stream settings" ok={false} />
          <div className="flex items-center justify-between gap-2 pl-6">
            <span className="text-xs text-muted-foreground">
              Go Live checks again when you start.
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                void onRetry().catch(() => {})
              }}
            >
              <SyncIcon data-icon="inline-start" weight="bold" />
              Retry
            </Button>
          </div>
        </div>
      )
    default:
      return (
        <ChecklistRow
          detail="Not checked yet. Go Live checks it first."
          label="Stream settings"
          ok={false}
        />
      )
  }
}

/** While live: quiet when healthy, the problem in a few words when not. */
function LiveStreamRow({
  diagnosticStats,
  streamHealth,
  streamTargets
}: {
  diagnosticStats: DiagnosticStats
  streamHealth: StreamHealth | null
  streamTargets: StreamTargetRuntime[]
}): ReactElement {
  const attribution = classifyStreamHealthAttribution(diagnosticStats, streamHealth, streamTargets)
  const healthy = attribution === 'healthy'
  return (
    <ChecklistRow
      detail={healthy ? 'Healthy' : liveProblemLabel(attribution)}
      label="Stream"
      ok={healthy}
      title={streamHealthDescription(attribution, true, { state: 'not-requested' })}
    />
  )
}

export function TechnicalDetails({
  diagnosticStats,
  liveOutputActive,
  preflight,
  providerPlan,
  streamHealth,
  streamTargets
}: {
  diagnosticStats: DiagnosticStats
  liveOutputActive: boolean
  preflight: StreamOutputTopologyPreflight
  providerPlan: ProviderStreamOutputPlan
  streamHealth: StreamHealth | null
  streamTargets: StreamTargetRuntime[]
}): ReactElement {
  const [open, setOpen] = useState(readTechnicalDetailsOpen)
  const attribution = liveOutputActive
    ? classifyStreamHealthAttribution(diagnosticStats, streamHealth, streamTargets)
    : preflightAttribution(preflight)
  const badge = streamHealthBadge(attribution, liveOutputActive)
  const probeResult = !liveOutputActive && preflight.state === 'ready' ? preflight.result : null
  const requestedPath = liveOutputActive
    ? diagnosticStats.encoderBridgeRequestedVideoOutput
    : probeResult?.requestedBridgeOutput
  const effectivePath = liveOutputActive
    ? diagnosticStats.encoderBridgeEffectiveVideoOutput
    : probeResult?.effectiveBridgeOutput
  const effectiveEncoder = liveOutputActive
    ? diagnosticStats.encodeBackend
    : probeResult?.effectiveEncodeBackend
  const fallbackReason = liveOutputActive
    ? diagnosticStats.encoderBridgeEncodedOutputFallbackReason
    : probeResult?.fallbackReason
  const coalescedFrames = diagnosticStats.encoderBridgeSeparateOutputEncodersActive
    ? diagnosticStats.encoderBridgeStreamQueueDroppedFrames
    : diagnosticStats.encoderBridgeOutputQueueDroppedFrames
  const bitrate = streamHealth?.bitrateKbps ?? diagnosticStats.streamMeasuredBitrateKbps
  const summary = liveOutputActive
    ? attribution === 'healthy'
      ? [formatMbps(bitrate), formatLiveFps(streamHealth?.fps)].filter(Boolean).join(' · ')
      : liveProblemLabel(attribution)
    : null
  const outputs = streamOutputs(providerPlan)

  return (
    <Collapsible
      className="border-b border-border"
      data-testid="technical-details"
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        writeTechnicalDetailsOpen(next)
      }}
    >
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-gutter py-3 text-left text-[13px] font-semibold text-foreground hover:bg-accent">
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        <span className="flex-1">Technical details</span>
        {summary ? (
          <span
            className={cn(
              'truncate text-xs font-normal tabular-nums',
              attribution === 'healthy' ? 'text-muted-foreground' : 'text-warning'
            )}
          >
            {summary}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 px-gutter pb-gutter">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {streamHealthDescription(attribution, liveOutputActive, preflight)}
          </span>
          <Badge variant={badge.tone}>{badge.label}</Badge>
        </div>

        {liveOutputActive ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <OutputMetric label="Frame rate" value={formatLiveFps(streamHealth?.fps) || '-'} />
            <OutputMetric label="Bitrate" value={formatLiveBitrate(bitrate)} />
            <OutputMetric
              label="Encoder speed"
              value={formatEncoderSpeed(streamHealth?.speed ?? diagnosticStats.encoderSpeed)}
            />
            <OutputMetric
              label="Dropped frames"
              value={formatFrameCount(streamHealth?.droppedFrames ?? diagnosticStats.droppedFrames)}
            />
            <OutputMetric
              label="Duplicated frames"
              value={formatFrameCount(
                streamHealth?.duplicatedFrames ?? diagnosticStats.streamDuplicatedFrames
              )}
            />
            <OutputMetric label="Coalesced frames" value={formatFrameCount(coalescedFrames)} />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Stats appear when you go live.</p>
        )}

        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <DetailRow label="Encoder" value={encoderLabel(effectiveEncoder)} />
          <DetailRow
            code
            label="Output path"
            value={
              effectivePath && requestedPath && requestedPath !== effectivePath
                ? `${effectivePath} (requested ${requestedPath})`
                : effectivePath
            }
          />
          {fallbackReason ? <DetailRow label="Fallback reason" value={fallbackReason} /> : null}
          <DetailRow label="Keyframe interval" value={`${STREAM_OUTPUT_GOP_SECONDS} s`} />
          <DetailRow
            label="Encode sharing"
            value={
              providerPlan.separateEncodedOutputRole
                ? 'Separate recording and stream encoders'
                : 'One shared encode (strictest destination)'
            }
          />
          {outputs.map(({ target, video }, index) => (
            <DetailRow
              key={target?.id ?? `stream-${index}`}
              label={target?.label ?? 'Stream'}
              value={formatEffectiveStreamProfile(video)}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{encodeFootnote(providerPlan, outputs)}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

function readTechnicalDetailsOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(TECHNICAL_DETAILS_STORAGE_KEY) === 'open'
  } catch {
    return false
  }
}

function writeTechnicalDetailsOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(TECHNICAL_DETAILS_STORAGE_KEY, open ? 'open' : 'closed')
  } catch {
    // Storage is a convenience; the closed default is always correct.
  }
}

type StreamOutput = { target?: StreamTargetSettings; video: VideoSettings }

function streamOutputs(plan: ProviderStreamOutputPlan): StreamOutput[] {
  return plan.targets.length
    ? plan.targets.map(({ target, video }) => ({ target: target ?? undefined, video }))
    : [{ video: plan.streamVideo }]
}

/** "1080p · 30 fps · 6 Mbps"; portrait canvases keep both sides ("1080×1920"). */
export function formatQuality(video: VideoSettings): string {
  const size = video.height > video.width ? `${video.width}×${video.height}` : `${video.height}p`
  return `${size} · ${video.fps} fps · ${formatMbps(video.bitrateKbps)}`
}

/**
 * One quality line for every destination. Identical outputs read once;
 * different ones say so and list each destination by its own name on hover.
 */
export function qualitySummary(outputs: StreamOutput[]): { text: string; title?: string } {
  const lines = outputs.map(({ target, video }) => ({
    label: target?.label,
    quality: formatQuality(
      target?.outputOrientation === 'vertical' ? coerceVideoToOrientation(video, 'vertical') : video
    )
  }))
  const distinct = new Set(lines.map((line) => line.quality))
  if (distinct.size <= 1) return { text: lines[0]?.quality ?? '-' }
  return {
    text: 'Varies by destination',
    title: lines.map((line) => `${line.label ?? 'Stream'}: ${line.quality}`).join('\n')
  }
}

function formatMbps(kbps?: number): string {
  if (typeof kbps !== 'number' || !Number.isFinite(kbps)) return ''
  const mbps = Math.round(kbps / 100) / 10
  return `${mbps.toLocaleString()} Mbps`
}

/** "hardware-videotoolbox" → "VideoToolbox · hardware"; unknown values pass through. */
export function encoderLabel(value?: string): string | undefined {
  if (!value) return undefined
  const match = /^(hardware|software)-(.+)$/.exec(value)
  if (!match) return value
  const names: Record<string, string> = {
    videotoolbox: 'VideoToolbox',
    nvenc: 'NVENC',
    qsv: 'Quick Sync',
    amf: 'AMF',
    mediafoundation: 'Media Foundation',
    'media-foundation': 'Media Foundation',
    x264: 'x264',
    openh264: 'OpenH264',
    vaapi: 'VA-API'
  }
  return `${names[match[2]] ?? match[2]} · ${match[1]}`
}

function liveProblemLabel(attribution: StreamHealthAttribution): string {
  switch (attribution) {
    case 'device':
      return 'Capture device lost'
    case 'audio':
      return 'Audio dropping'
    case 'capture':
      return 'Capture running slow'
    case 'render':
      return 'Rendering slow'
    case 'encoder':
      return 'Encoder dropping frames'
    case 'fallback':
      return 'Encoder fallback'
    case 'network':
      return 'Delivery degraded'
    case 'preview':
      return 'Preview degraded'
    case 'healthy':
      return 'Healthy'
    default:
      return 'Checking…'
  }
}

function encodeFootnote(plan: ProviderStreamOutputPlan, outputs: StreamOutput[]): string {
  const true4k = outputs.some(({ video }) => video.preset === 'stream-youtube-4k30')
  if (true4k) {
    return outputs.some(({ video }) => video.preset !== 'stream-youtube-4k30')
      ? 'YouTube 4K30 uses normal latency. Other destinations get separate stream-safe 1080p outputs; upload is the sum of every destination.'
      : 'YouTube 4K30 uses normal latency. Keep stable upload comfortably above 30 Mbps.'
  }
  return plan.separateEncodedOutputRole
    ? 'Recording and streaming use separate encoders; the stream stays platform-safe for every destination.'
    : 'All destinations share one encode, so the bitrate is capped by the strictest platform (Twitch about 6 Mbps).'
}

function preflightAttribution(preflight: StreamOutputTopologyPreflight): StreamHealthAttribution {
  if (preflight.state !== 'ready') {
    return 'unknown'
  }
  const result = preflight.result
  return result.fallbackReason ||
    result.requestedBridgeOutput !== result.effectiveBridgeOutput ||
    result.probeState === 'rejected' ||
    result.probeState === 'unsupported'
    ? 'fallback'
    : 'healthy'
}

function streamHealthBadge(
  attribution: StreamHealthAttribution,
  liveOutputActive: boolean
): { label: string; tone: BadgeTone } {
  if (!liveOutputActive && attribution === 'healthy') {
    return { label: 'Ready', tone: 'success' }
  }
  if (attribution === 'healthy') {
    return { label: 'Healthy', tone: 'success' }
  }
  if (attribution === 'unknown') {
    return { label: 'Unknown', tone: 'outline' }
  }
  if (attribution === 'fallback' || attribution === 'network' || attribution === 'preview') {
    return {
      label: attribution.charAt(0).toUpperCase() + attribution.slice(1),
      tone: 'warning'
    }
  }
  return {
    label: attribution.charAt(0).toUpperCase() + attribution.slice(1),
    tone: 'destructive'
  }
}

function streamHealthDescription(
  attribution: StreamHealthAttribution,
  liveOutputActive: boolean,
  preflight: StreamOutputTopologyPreflight
): string {
  if (!liveOutputActive) {
    switch (preflight.state) {
      case 'not-requested':
        return 'The output path has not been checked yet.'
      case 'pending':
        return 'Checking the output path…'
      case 'failed':
        return `Output path check failed: ${preflight.message}`
      case 'ready':
        return attribution === 'fallback'
          ? 'Checked. This profile uses a fallback output path.'
          : 'Checked. This profile uses its exact output path.'
    }
  }

  switch (attribution) {
    case 'device':
      return 'A disconnected capture device is interrupting the stream.'
    case 'audio':
      return 'Audio capture is dropping data before the stream encode.'
    case 'capture':
      return 'Capture is running below the target frame rate.'
    case 'render':
      return 'The compositor is running below the target frame rate.'
    case 'encoder':
      return 'The encoder or its output queue is losing frames.'
    case 'fallback':
      return 'The stream is using a confirmed fallback output path.'
    case 'network':
      return 'Media is healthy, but delivery or a destination is degraded.'
    case 'preview':
      return 'The stream is healthy; only the local preview is degraded.'
    case 'healthy':
      return 'Media and delivery are healthy.'
    default:
      return 'Waiting for enough evidence to judge the stream.'
  }
}

function OutputMetric({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-medium tabular-nums">{value}</div>
    </div>
  )
}

function DetailRow({
  label,
  value,
  code = false
}: {
  label: string
  value?: string
  code?: boolean
}): ReactElement {
  return (
    <div className="flex items-start justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      {code ? (
        <code className="min-w-0 text-right break-words text-foreground">{value ?? 'unknown'}</code>
      ) : (
        <span className="min-w-0 text-right break-words text-foreground">{value ?? 'unknown'}</span>
      )}
    </div>
  )
}

function formatLiveFps(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)} fps` : ''
}

function formatLiveBitrate(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value).toLocaleString()} kbps`
    : '-'
}

function formatEncoderSpeed(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}×` : '-'
}

function formatFrameCount(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value)).toLocaleString()
    : '-'
}

function formatEffectiveStreamProfile(video: VideoSettings): string {
  return `${video.width}×${video.height} @ ${video.fps} fps · ${video.bitrateKbps.toLocaleString()} kbps CBR`
}

function ChecklistRow({
  label,
  detail,
  ok,
  title
}: {
  label: string
  detail: string
  ok: boolean
  title?: string
}): ReactElement {
  return (
    <div
      className="flex items-start justify-between gap-3 text-sm"
      data-ok={ok}
      data-slot="checklist-row"
      title={title}
    >
      <div className="flex items-center gap-2">
        {ok ? (
          <SuccessIcon className="size-4 shrink-0 text-primary" weight="fill" />
        ) : (
          <AlertIcon className="size-4 shrink-0 text-muted-foreground" weight="fill" />
        )}
        <span>{label}</span>
      </div>
      <span className="text-right text-xs text-muted-foreground">{detail}</span>
    </div>
  )
}

function InfoRow({ label, detail }: { label: string; detail: string }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="pl-6 text-muted-foreground">{label}</span>
      <span className="text-xs tabular-nums">{detail}</span>
    </div>
  )
}
