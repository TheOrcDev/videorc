import { CloudSection } from './cloud-section'

import { StreamQualityControl } from './stream-quality-control'
import { withStreamQuality } from '@/lib/output-quality'
import { AlertIcon, SuccessIcon, SyncIcon } from '@/components/icons'
import { lazy, Suspense, useMemo, type ReactElement, type ReactNode } from 'react'

import { NavigableRow } from '@/components/navigable-row'
import { PanelSection } from '@/components/panel-section'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import {
  useStudioCloud,
  useStudioCore,
  useStudioDiagnostics,
  useStudioRecording,
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
  streamVideoProfileValidationReason,
  type CaptureConfig,
  type ProviderStreamOutputPlan,
  videoProfileCompatibility
} from '@/lib/capture'
import { captureConfigForIntent, livestreamIntent } from '@/lib/session-start-intent'
import {
  CAPTION_OUTPUT_RULE_LABELS,
  livestreamCaptionsBlockerFor,
  type CaptionOutputRule
} from '@/lib/captions-preflight'
import { destinationSetup, destinationSetupHint } from '@/lib/destination-readiness'
import { NO_VALUE } from '@/lib/format'
import { PAGE_TRAIL_COLUMN } from '@/lib/page-layout'
import { destinationLabel } from '@/lib/platform-copy'
import { formatVideoQuality } from '@/lib/format-video'
import {
  classifyStreamHealthAttribution,
  liveProblemLabel,
  type RecentStreamDrops,
  type StreamHealthAttribution
} from '@/lib/stream-health-attribution'
import { cloudStreamReading } from '@/lib/live-session-view'

import {
  dashboardCloudFromStatus,
  type LiveDashboardCloud
} from '../../../../shared/live-dashboard'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

// The Watchdog section (plan 223 D7) loads with the page's first paint of it;
// its rows, the QR code and the phone list stay out of the eager bundle.
// Below the imports: the dev server turns `import { lazy }` into a const at
// that line, so a use above it throws "Cannot access 'lazy' before
// initialization" and the Destinations page shows its error panel.
const WatchdogSection = lazy(async () => ({
  default: (await import('./watchdog-section')).WatchdogSection
}))
// Plan 237: the stream report email's switch, loaded the same way.
const StreamReportEmailSection = lazy(async () => ({
  default: (await import('./stream-report-email-section')).StreamReportEmailSection
}))

// The Livestream right column (plan 080 S7). Owner, 2026-09-30: "Live stream
// should be about connecting your accounts and not about reading some tech
// data." A short checklist in plain words says whether you can go live. The
// encoder paths and frame counters live in Health only (owner, 2026-11-20:
// "This is technical"). This component owns the diagnostics subscription, so
// the stats tick no longer re-renders the destination list and the Broadcast
// info form.

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
  const { diagnosticStats, recentStreamDrops, streamHealth } = useStudioDiagnostics()
  const { cloudStatus } = useStudioCloud()
  const { recording } = useStudioRecording()
  // Plan 184 C7: the cloud show carrying this session, for the health rows.
  const cloud = cloudStatus
    ? dashboardCloudFromStatus(cloudStatus, recording.sessionId ?? null)
    : null
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
  let providerPlan = goLiveProviderPlan(captureConfig, video, separateEncodedOutputRoleAvailable)
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
    <div className={cn('flex flex-col', PAGE_TRAIL_COLUMN)}>
      {compatibilityMessage ? (
        <div className="border-b border-border p-gutter">
          <Alert variant="warning">
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
      <CloudSection />
      <Suspense fallback={null}>
        <WatchdogSection />
      </Suspense>
      <Suspense fallback={null}>
        <StreamReportEmailSection />
      </Suspense>
      <ReadyToGoLive
        cloud={cloud}
        accountByPlatform={accountByPlatform}
        captions={
          captureConfig.captions.enabled
            ? { blocker: livestreamCaptionsBlockerFor(captureConfig) }
            : undefined
        }
        diagnosticStats={diagnosticStats}
        ffmpegReady={Boolean(health?.ffmpeg.available)}
        liveOutputActive={liveOutputActive}
        preflight={streamOutputTopologyPreflight}
        profileCompatible={!compatibility.blockingReason}
        providerPlan={providerPlan}
        recentStreamDrops={recentStreamDrops}
        recordEnabled={captureConfig.recordEnabled}
        recordingMatchesStream={streamSharedEncodeFallbackVideo !== null}
        recordingVideo={video}
        streamHealth={currentStreamHealth}
        streamTargets={streamTargets}
        targets={streaming.targets}
        onOpenDestination={onOpenDestination}
        onRetry={refreshStreamOutputTopology}
      />
    </div>
  )
}

/**
 * The plan the Ready panel describes: what Go Live will run. Go Live streams
 * whatever the saved output mode says (plan 174 S3.1), so planning with the
 * saved mode's "no stream" showed the recording's quality, upload and disk
 * as the stream's (plan 0016).
 */
export function goLiveProviderPlan(
  captureConfig: Pick<CaptureConfig, 'recordEnabled' | 'streamEnabled' | 'streaming' | 'layout'>,
  video: VideoSettings,
  separateEncodedOutputRoleAvailable: boolean
): ProviderStreamOutputPlan {
  const goLiveConfig = captureConfigForIntent(
    captureConfig,
    livestreamIntent(captureConfig.recordEnabled)
  )
  return resolveProviderStreamOutputPlan(
    video,
    goLiveConfig.streaming,
    providerStreamOutputPlanOptions(goLiveConfig, separateEncodedOutputRoleAvailable)
  )
}

export function ReadyToGoLive({
  targets,
  accountByPlatform,
  captions,
  ffmpegReady,
  profileCompatible,
  providerPlan,
  recordEnabled,
  recordingMatchesStream = false,
  recordingVideo,
  preflight,
  liveOutputActive,
  cloud = null,
  diagnosticStats,
  recentStreamDrops,
  streamHealth,
  streamTargets,
  onOpenDestination,
  onRetry
}: {
  targets: StreamTargetSettings[]
  /** The Videorc Cloud show carrying the session, if any (plan 184 C7). */
  cloud?: LiveDashboardCloud | null
  accountByPlatform: ReadonlyMap<StreamPlatform, PlatformAccount>
  /**
   * Live captions, when on: the output rule a livestream would break (plan
   * 174 S3.4, D-9), so the Go Live dialog is never the first to say it.
   */
  captions?: { blocker: { rule: CaptionOutputRule; description: string } | null }
  ffmpegReady: boolean
  profileCompatible: boolean
  providerPlan: ProviderStreamOutputPlan
  recordEnabled: boolean
  recordingMatchesStream?: boolean
  recordingVideo: VideoSettings
  preflight: StreamOutputTopologyPreflight
  liveOutputActive: boolean
  diagnosticStats: DiagnosticStats
  recentStreamDrops: RecentStreamDrops
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
        // Each link opens its destination and moves focus to it (plan 174
        // S3.5a, D-24), on a 24 px target.
        <div className="-mt-1 flex flex-col gap-1 pl-6" data-slot="destinations-not-ready">
          {notReady.map(({ target, hint }) => (
            <Button
              className="max-w-full justify-start self-start text-foreground"
              key={target.id}
              size="xs"
              variant="outline"
              onClick={() => onOpenDestination(target.id)}
            >
              {destinationLabel(target.label)} · {hint}
            </Button>
          ))}
        </div>
      ) : null}
      {liveOutputActive ? (
        <LiveStreamRow
          cloud={cloud}
          diagnosticStats={diagnosticStats}
          recentStreamDrops={recentStreamDrops}
          streamHealth={streamHealth}
          streamTargets={streamTargets}
        />
      ) : enabled.length ? (
        <StreamCheckRow preflight={preflight} onRetry={onRetry} />
      ) : null}
      <ChecklistRow
        detail={presetOk ? quality.text : `${quality.text} · choose a stream-safe preset`}
        description={quality.lines ? <QualityLines lines={quality.lines} /> : undefined}
        label="Quality"
        ok={presetOk}
      />
      {captions ? (
        <>
          <ChecklistRow
            detail={captions.blocker ? CAPTION_OUTPUT_RULE_LABELS[captions.blocker.rule] : 'On'}
            label="Captions"
            ok={!captions.blocker}
          />
          {captions.blocker ? (
            <p className="-mt-1 pl-6 text-xs text-muted-foreground" data-slot="captions-not-ready">
              {captions.blocker.description}
            </p>
          ) : null}
        </>
      ) : null}
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
        // A row that goes where FFmpeg is fixed (D-24), like Studio's
        // "Videorc's recorder isn't available": Health, since S3.6 removed
        // Settings → Recording.
        <NavigableRow
          className="-mx-3 w-[calc(100%+1.5rem)]"
          icon={AlertIcon}
          label="FFmpeg"
          value="Missing"
          onNavigate={() => openWorkspaceTab('diagnostics')}
        />
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
        <div className="flex flex-col gap-1">
          {/* The raw probe message is one hover or focus away, not inline
              (plan 174 S1.10, D-23). */}
          <ChecklistRow
            detail="Couldn't check"
            detailHint={preflight.message}
            label="Stream settings"
            ok={false}
          />
          <div className="flex items-center justify-between gap-2 pl-6">
            <span className="text-xs text-muted-foreground">
              Go Live checks again when you start.
            </span>
            <Button
              size="xs"
              variant="outline"
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
  cloud = null,
  diagnosticStats,
  recentStreamDrops,
  streamHealth,
  streamTargets
}: {
  cloud?: LiveDashboardCloud | null
  diagnosticStats: DiagnosticStats
  recentStreamDrops: RecentStreamDrops
  streamHealth: StreamHealth | null
  streamTargets: StreamTargetRuntime[]
}): ReactElement {
  const attribution = classifyStreamHealthAttribution(
    diagnosticStats,
    streamHealth,
    streamTargets,
    recentStreamDrops
  )
  // Plan 184 C7: while the cloud holds or resumes the show, that is the word.
  const cloudReading = cloudStreamReading(cloud)
  const healthy = attribution === 'healthy' && !cloudReading
  return (
    <ChecklistRow
      detail={cloudReading ?? (healthy ? 'Healthy' : liveProblemLabel(attribution))}
      // The problem's whole sentence on hover and on focus (plan 174 S1.10).
      detailHint={streamHealthDescription(attribution)}
      label="Stream"
      ok={healthy}
    />
  )
}

type StreamOutput = { target?: StreamTargetSettings; video: VideoSettings }

function streamOutputs(plan: ProviderStreamOutputPlan): StreamOutput[] {
  return plan.targets.length
    ? plan.targets.map(({ target, video }) => ({ target: target ?? undefined, video }))
    : [{ video: plan.streamVideo }]
}

/** "1080p · 30 fps · 6 Mbps"; portrait canvases keep both sides (plan 174 S1.4). */
function formatQuality(video: VideoSettings): string {
  return formatVideoQuality(video, { bitrate: true })
}

/**
 * One quality line for every destination. Identical outputs read once;
 * different ones say so and list each destination by its own name, one line
 * each under the row (plan 174 S1.10, D-23).
 */
export function qualitySummary(outputs: StreamOutput[]): { text: string; lines?: string[] } {
  const lines = outputs.map(({ target, video }) => ({
    label: target?.label,
    quality: formatQuality(
      target?.outputOrientation === 'vertical' ? coerceVideoToOrientation(video, 'vertical') : video
    )
  }))
  const distinct = new Set(lines.map((line) => line.quality))
  if (distinct.size <= 1) return { text: lines[0]?.quality ?? NO_VALUE }
  return {
    text: 'Varies by destination',
    lines: lines.map((line) => `${line.label ?? 'Stream'}: ${line.quality}`)
  }
}

function streamHealthDescription(attribution: StreamHealthAttribution): string {
  switch (attribution) {
    case 'device':
      return 'A disconnected capture device is interrupting the stream.'
    case 'audio':
      return 'Audio capture is dropping data before the stream encode.'
    case 'choppy':
      return 'The stream is skipping frames that could not be sent in time, so viewers see a stutter. The recording is unaffected.'
    case 'uplink':
      return 'Your connection can’t carry this stream to every destination. Videorc lowers the stream’s bitrate to keep it moving; fewer destinations give it more room.'
    case 'capture':
      return 'Capture is running below the target frame rate.'
    case 'render':
      return 'The scene is rendering below the target frame rate.'
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

/**
 * One readiness fact (plan 174 S1.10, D-23): never a native title.
 * `description` is what the short `detail` stands for, as visible lines under
 * it; `detailHint` explains the detail on hover and on keyboard focus.
 */
function ChecklistRow({
  label,
  detail,
  ok,
  description,
  detailHint
}: {
  label: string
  detail: string
  ok: boolean
  description?: ReactNode
  detailHint?: ReactNode
}): ReactElement {
  const row = (
    <div
      className="flex items-start justify-between gap-3 text-sm"
      data-ok={ok}
      data-slot="checklist-row"
    >
      <div className="flex items-center gap-2">
        {ok ? (
          <SuccessIcon className="size-4 shrink-0 text-primary" weight="fill" />
        ) : (
          <AlertIcon className="size-4 shrink-0 text-muted-foreground" weight="fill" />
        )}
        <span>{label}</span>
      </div>
      <InfoTooltip align="end" content={detailHint}>
        <span className="text-right text-xs text-muted-foreground">{detail}</span>
      </InfoTooltip>
    </div>
  )
  if (!description) return row
  return (
    <div className="flex flex-col gap-1">
      {row}
      <div className="pl-6 text-xs text-muted-foreground" data-slot="checklist-row-description">
        {description}
      </div>
    </div>
  )
}

/** One line per destination when their qualities differ. */
function QualityLines({ lines }: { lines: readonly string[] }): ReactElement {
  return (
    <ul className="flex flex-col gap-0.5">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
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
