import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  Check,
  Monitor,
  SpeakerHigh,
  SpeakerSlash,
  UploadSimple,
  VideoCamera,
  Warning,
  Waveform
} from '@phosphor-icons/react'
import { useRef, useState, type ReactElement } from 'react'

import { ConfigGrid } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { SourceSelect } from '@/components/source-select'
import { MicPickerPreview } from '@/components/studio/mic-picker-preview'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { PowerSlider } from '@/components/power-slider'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useStudioCore, useStudioDiagnostics, useStudioPreview } from '@/hooks/use-studio'
import { cameraFormatShortfall, cameraFormatShortfallMessage } from '@/lib/camera-format-shortfall'
import {
  MICROPHONE_SYNC_OFFSET_MAX_MS,
  MICROPHONE_SYNC_OFFSET_MIN_MS,
  applyAudioSyncRecommendation,
  buildCameraSources,
  buildCaptureSources,
  buildMicrophoneSources,
  capturePickerDevices,
  microphonePickerDevices,
  audioSyncCalibrationState,
  normalizeMicrophoneSyncOffsetMs,
  parseAudioSyncRecommendationJson,
  resetAudioSyncCalibration,
  type AudioSyncRecommendationReport
} from '@/lib/capture'
import type { SourceSelection } from '@/lib/backend'
import { systemAccessAction, systemAccessRows } from '@/lib/system-access'

// Live chip for a capture source (UI rewrite V3): what the preview pipeline says
// about the source RIGHT NOW. A live source whose newest frame is old is reported
// honestly — for cameras that means trouble; screens only deliver on change, so
// staleness is normal there and not flagged.
function sourceRuntimeChip({
  state,
  frameAgeMs,
  message,
  staleWarnMs
}: {
  state?: 'starting' | 'live' | 'permission-needed' | 'source-missing' | 'device-missing' | 'failed'
  frameAgeMs?: number
  message?: string
  staleWarnMs?: number
}): { label: string; tone: StatusTone; hint?: string } | null {
  switch (state) {
    case 'live':
      if (staleWarnMs && typeof frameAgeMs === 'number' && frameAgeMs > staleWarnMs) {
        return {
          label: `Stale ${Math.round(frameAgeMs / 1000)}s`,
          tone: 'warn',
          hint: 'No fresh frames — re-select the source to restart it.'
        }
      }
      return { label: 'Live', tone: 'good' }
    case 'starting':
      return { label: 'Starting', tone: 'warn' }
    case 'permission-needed':
      return { label: 'Permission needed', tone: 'warn', hint: message }
    case 'failed':
      return { label: 'Failed', tone: 'error', hint: message ?? 'Re-select the source to retry.' }
    case 'source-missing':
    case 'device-missing':
      return null
    default:
      return null
  }
}

function RuntimeChip({
  chip
}: {
  chip: { label: string; tone: StatusTone; hint?: string } | null
}): ReactElement | null {
  if (!chip) {
    return null
  }
  return (
    <span className="flex items-center gap-2" title={chip.hint}>
      <StatusBadge label="" tone={chip.tone} value={chip.label} />
    </span>
  )
}

// The single home for every capture device — screen/window, camera, and microphone
// with its mixer — so changing what gets captured never spans pages (UI rewrite plan
// V1/V2, 2026-06-10).
export function SourcesTab(): ReactElement {
  const {
    deviceList,
    captureConfig,
    setCaptureConfig,
    refreshBackend,
    selectedMicrophone,
    isSessionActive,
    layoutSwitchPending,
    sourceDeviceSwitchPending,
    switchSourceDeviceLive,
    handleSystemPermission,
    revealPermissionTarget,
    runtimeInfo,
    mediaAccess,
    wsStatus
  } = useStudioCore()
  const { previewCameraStatus, previewScreenStatus } = useStudioPreview()
  const { diagnosticStats } = useStudioDiagnostics()
  // Q6 (plan 022): explicit select states while device discovery is pending.
  const discoveryPending = wsStatus !== 'connected'
  // S5 (plan 024): the selected camera format can't meet the requested fps/res.
  const cameraShortfall = captureConfig.sources.cameraId
    ? cameraFormatShortfall(diagnosticStats)
    : null
  const captureDevices = capturePickerDevices(deviceList.devices)
  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  const microphones = microphonePickerDevices(deviceList.devices)
  const hasCapturePermissionRequired = captureDevices.some(
    (device) => device.status === 'permission-required'
  )
  const cameraAccess = systemAccessRows({
    deviceList,
    audioMeter: null,
    platform: runtimeInfo?.platform,
    mediaAccess
  }).find((row) => row.id === 'camera')
  const hasCameraPermissionRequired =
    cameraAccess?.state === 'first-use' || cameraAccess?.state === 'not-granted'
  const cameraPermissionAction = systemAccessAction({
    pane: 'camera',
    state: cameraAccess?.state,
    platform: runtimeInfo?.platform,
    mediaAccessStatus: mediaAccess?.camera
  })
  const capturePermissionTargetName =
    runtimeInfo?.capturePermissionTargetName ?? runtimeInfo?.permissionTargetName ?? 'Videorc'
  const [syncRecommendation, setSyncRecommendation] =
    useState<AudioSyncRecommendationReport | null>(null)
  const [syncCalibrationMessage, setSyncCalibrationMessage] = useState<string | null>(null)
  const [showSyncStimulusInstructions, setShowSyncStimulusInstructions] = useState(false)
  const syncMeasurementInputRef = useRef<HTMLInputElement | null>(null)
  const syncCalibration = audioSyncCalibrationState(syncRecommendation, captureConfig.audio)

  const selectedCaptureId = captureConfig.sources.screenId ?? captureConfig.sources.windowId
  const liveDeviceSwitchDisabled = Boolean(sourceDeviceSwitchPending || layoutSwitchPending)

  const captureSourcesForDevice = (captureId: string | undefined): SourceSelection =>
    buildCaptureSources(captureConfig.sources, captureDevices, captureId)

  const cameraSourcesForDevice = (cameraId: string | undefined): SourceSelection =>
    buildCameraSources(captureConfig.sources, cameras, cameraId)

  const applyCaptureSource = (captureId: string | undefined): void => {
    const sources = captureSourcesForDevice(captureId)
    if (isSessionActive) {
      void switchSourceDeviceLive('capture', sources)
      return
    }
    setCaptureConfig((current) => ({ ...current, sources }))
  }

  const applyCameraSource = (cameraId: string | undefined): void => {
    const sources = cameraSourcesForDevice(cameraId)
    if (isSessionActive) {
      void switchSourceDeviceLive('camera', sources)
      return
    }
    setCaptureConfig((current) => ({ ...current, sources }))
  }

  const importSyncMeasurementFile = async (file: File | null): Promise<void> => {
    if (!file) {
      return
    }

    const parsed = parseAudioSyncRecommendationJson(await file.text())
    if (!parsed.ok) {
      setSyncRecommendation(null)
      setSyncCalibrationMessage(parsed.error)
      return
    }

    const nextState = audioSyncCalibrationState(parsed.recommendation, captureConfig.audio)
    setSyncRecommendation(parsed.recommendation)
    setSyncCalibrationMessage(`${nextState.measuredLagLabel}. ${nextState.detail}`)
  }

  const applySyncRecommendation = (): void => {
    if (!syncRecommendation) {
      return
    }

    setCaptureConfig((current) => ({
      ...current,
      audio: applyAudioSyncRecommendation(current.audio, syncRecommendation)
    }))
    if (syncCalibration.recommendedOffsetMs != null) {
      setSyncCalibrationMessage(`Applied ${syncCalibration.recommendedOffsetMs} ms sync offset.`)
    }
  }

  const resetSyncCalibration = (): void => {
    setCaptureConfig((current) => ({
      ...current,
      audio: resetAudioSyncCalibration(current.audio)
    }))
    setSyncCalibrationMessage('Reset microphone sync to structural default.')
  }

  return (
    <ConfigGrid>
      <PanelSection
        action={
          <Button size="sm" variant="outline" onClick={() => void refreshBackend()}>
            <ArrowsClockwise data-icon="inline-start" />
            Refresh
          </Button>
        }
        className="lg:col-span-2"
        description="Pick what gets captured. Unavailable devices need permission or reconnection."
        icon={Monitor}
        title="Capture sources"
      >
        {deviceList.warnings.map((warning) => (
          <Alert key={warning} variant="warning">
            <Warning weight="fill" />
            <AlertTitle>{warning}</AlertTitle>
          </Alert>
        ))}
        {hasCapturePermissionRequired ? (
          <Alert variant="warning">
            <Warning weight="fill" />
            <AlertTitle>
              Screen Recording permission is required for {capturePermissionTargetName}.
            </AlertTitle>
            <AlertDescription className="flex flex-wrap gap-2 pt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleSystemPermission('screen-recording')}
              >
                <Monitor data-icon="inline-start" />
                Open Screen Recording
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void revealPermissionTarget()}>
                <UploadSimple data-icon="inline-start" />
                Show Capture Helper
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {hasCameraPermissionRequired ? (
          <Alert variant="warning">
            <Warning weight="fill" />
            <AlertTitle>
              Camera permission is required for {capturePermissionTargetName}.
            </AlertTitle>
            <AlertDescription className="flex flex-wrap gap-2 pt-2">
              {cameraPermissionAction ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void handleSystemPermission('camera')}
                >
                  <VideoCamera data-icon="inline-start" />
                  {cameraPermissionAction === 'request-media-access'
                    ? 'Enable Camera'
                    : 'Open Camera Settings'}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => void revealPermissionTarget()}>
                <UploadSimple data-icon="inline-start" />
                Show Capture Helper
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <SourceSelect
              devices={captureDevices}
              discoveryPending={discoveryPending}
              disabled={isSessionActive && liveDeviceSwitchDisabled}
              label="Screen / window"
              value={selectedCaptureId}
              onChange={applyCaptureSource}
            />
            <RuntimeChip
              chip={
                sourceDeviceSwitchPending === 'capture'
                  ? { label: 'Switching', tone: 'warn' }
                  : selectedCaptureId
                    ? sourceRuntimeChip({
                        state: previewScreenStatus?.state,
                        frameAgeMs: previewScreenStatus?.frameAgeMs,
                        message: previewScreenStatus?.message
                      })
                    : null
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <SourceSelect
              allowNone
              devices={cameras}
              disabled={isSessionActive && liveDeviceSwitchDisabled}
              discoveryPending={discoveryPending}
              label="Camera"
              value={captureConfig.sources.cameraId}
              onChange={applyCameraSource}
            />
            <RuntimeChip
              chip={
                sourceDeviceSwitchPending === 'camera'
                  ? { label: 'Switching', tone: 'warn' }
                  : captureConfig.sources.cameraId
                    ? sourceRuntimeChip({
                        state: previewCameraStatus?.state,
                        frameAgeMs: previewCameraStatus?.frameAgeMs,
                        message: previewCameraStatus?.message,
                        staleWarnMs: 3000
                      })
                    : null
              }
            />
            {/* Q024 S5: a capture camera (e.g. a Cam Link mirroring 4K@25 PAL)
                whose only format can't meet the requested fps/resolution used
                to fall back silently — name the mismatch so 25fps isn't a
                mystery. */}
            {cameraShortfall ? (
              <p className="flex items-start gap-1.5 text-xs text-warning">
                <Warning className="mt-0.5 size-3.5 shrink-0" weight="fill" />
                <span>{cameraFormatShortfallMessage(cameraShortfall)}</span>
              </p>
            ) : null}
          </div>
        </div>
        {isSessionActive ? (
          <p className="text-xs text-muted-foreground">
            Video sources switch live after the target source produces fresh frames.
          </p>
        ) : null}

        {import.meta.env.DEV ? (
          <div className="flex items-center justify-between gap-3 rounded-row border border-dashed bg-muted/20 px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Synthetic diagnostic source</span>
              <span className="text-xs text-muted-foreground">
                Dev-only. Replaces the screen with a deterministic frame-number + timecode source
                for regression tests.
              </span>
            </div>
            <Switch
              checked={captureConfig.sources.testPattern === true}
              data-videorc-synthetic-source-toggle
              disabled={isSessionActive}
              size="sm"
              onCheckedChange={(testPattern) =>
                setCaptureConfig((current) => ({
                  ...current,
                  sources: testPattern
                    ? {
                        ...current.sources,
                        screenId: undefined,
                        screenName: undefined,
                        windowId: undefined,
                        windowName: undefined,
                        testPattern
                      }
                    : { ...current.sources, testPattern }
                }))
              }
            />
          </div>
        ) : null}
      </PanelSection>

      <PanelSection
        className="lg:col-span-2"
        description="Live input meter with manual source gain. No automatic processing is applied."
        icon={Waveform}
        title="Microphone mixer"
      >
        <SourceSelect
          allowNone
          devices={microphones}
          disabled={isSessionActive}
          discoveryPending={discoveryPending}
          label="Microphone"
          value={captureConfig.sources.microphoneId}
          onChange={(microphoneId) =>
            setCaptureConfig((current) => ({
              ...current,
              sources: buildMicrophoneSources(current.sources, microphones, microphoneId)
            }))
          }
        />
        {/* See-before-you-pick: live waveform of the selected mic (shared with
            the Quick Settings popover). */}
        <MicPickerPreview deviceName={selectedMicrophone?.name} />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {captureConfig.audio.microphoneMuted ? (
            <SpeakerSlash className="size-4" weight="duotone" />
          ) : (
            <SpeakerHigh className="size-4" weight="duotone" />
          )}
          {selectedMicrophone ? selectedMicrophone.name : 'No microphone selected'}
        </div>
        <div className="grid gap-2 rounded-row border bg-muted/30 px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-muted-foreground">Mute</span>
            <Switch
              checked={captureConfig.audio.microphoneMuted}
              size="sm"
              onCheckedChange={(microphoneMuted) =>
                setCaptureConfig((current) => ({
                  ...current,
                  audio: { ...current.audio, microphoneMuted }
                }))
              }
            />
          </div>
          <PowerSlider
            bipolar
            label="Gain"
            max={24}
            min={-24}
            numericInput
            suffix=" dB"
            value={captureConfig.audio.microphoneGainDb}
            onChange={(microphoneGainDb) =>
              setCaptureConfig((current) => ({
                ...current,
                audio: { ...current.audio, microphoneGainDb }
              }))
            }
          />
          <div className="grid gap-2">
            <PowerSlider
              bipolar
              label="Sync"
              largeStep={5}
              max={MICROPHONE_SYNC_OFFSET_MAX_MS}
              min={MICROPHONE_SYNC_OFFSET_MIN_MS}
              numericInput
              suffix=" ms"
              value={captureConfig.audio.microphoneSyncOffsetMs}
              onChange={(microphoneSyncOffsetMs) =>
                setCaptureConfig((current) => ({
                  ...current,
                  audio: {
                    ...current.audio,
                    microphoneSyncOffsetMs: normalizeMicrophoneSyncOffsetMs(microphoneSyncOffsetMs),
                    microphoneSyncOffsetUserSet: true
                  }
                }))
              }
            />
            <div className="grid gap-2 rounded-row border border-border/70 bg-muted/20 p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Badge
                  variant={
                    syncCalibration.status === 'recommended'
                      ? 'warning'
                      : syncCalibration.status === 'unavailable'
                        ? 'outline'
                        : 'secondary'
                  }
                >
                  {syncCalibration.measuredLagLabel}
                </Badge>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="xs"
                    type="button"
                    variant="outline"
                    onClick={() => setShowSyncStimulusInstructions((open) => !open)}
                  >
                    <Waveform data-icon="inline-start" />
                    Stimulus
                  </Button>
                  <Button
                    size="xs"
                    type="button"
                    variant="outline"
                    onClick={() => syncMeasurementInputRef.current?.click()}
                  >
                    <UploadSimple data-icon="inline-start" />
                    Import JSON
                  </Button>
                  <Button
                    disabled={!syncCalibration.canApply}
                    size="xs"
                    type="button"
                    variant="secondary"
                    onClick={applySyncRecommendation}
                  >
                    <Check data-icon="inline-start" />
                    Apply
                  </Button>
                  <Button size="xs" type="button" variant="ghost" onClick={resetSyncCalibration}>
                    <ArrowCounterClockwise data-icon="inline-start" />
                    Reset
                  </Button>
                </div>
              </div>
              <input
                ref={syncMeasurementInputRef}
                accept="application/json,.json"
                className="hidden"
                type="file"
                onChange={(event) => {
                  void importSyncMeasurementFile(event.currentTarget.files?.[0] ?? null)
                  event.currentTarget.value = ''
                }}
              />
              <p className="text-xs text-muted-foreground">
                {syncCalibrationMessage ?? syncCalibration.detail}
              </p>
              {showSyncStimulusInstructions ? (
                <div className="grid gap-1 rounded-chip border border-border/70 bg-background p-2 font-mono text-[11px] leading-5 text-muted-foreground">
                  <span>
                    pnpm measure:av-sync --make-fixture /tmp/videorc-sync.mp4 --seconds 120
                  </span>
                  <span>pnpm measure:av-sync &lt;recording-or-evidence.json&gt; --json</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </PanelSection>
    </ConfigGrid>
  )
}
