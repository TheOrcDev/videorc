import { ArrowsClockwise, Monitor, SpeakerHigh, SpeakerSlash, Warning, Waveform } from '@phosphor-icons/react'
import { useEffect, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { SourceSelect } from '@/components/source-select'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useStudio } from '@/hooks/use-studio'
import {
  MICROPHONE_SYNC_OFFSET_MAX_MS,
  MICROPHONE_SYNC_OFFSET_MIN_MS,
  normalizeMicrophoneSyncOffsetMs,
  parseMicrophoneSyncOffsetInput
} from '@/lib/capture'
import type { Device, DeviceStatus } from '@/lib/backend'
import { formatDb } from '@/lib/format'
import { cn } from '@/lib/utils'

const STATUS_TONE: Record<DeviceStatus, StatusTone> = {
  available: 'good',
  unavailable: 'neutral',
  'permission-required': 'warn'
}

// Panel homes per the studio shell plan (decision 5): the Layouts panel embeds the
// device pickers (`section="devices"`), the Audio panel embeds the microphone mixer
// (`section="audio"`).
export function SourcesTab({
  section = 'all'
}: {
  section?: 'devices' | 'audio' | 'all'
} = {}): ReactElement {
  const {
    deviceList,
    captureConfig,
    setCaptureConfig,
    refreshBackend,
    sampleAudioMeter,
    audioMeter,
    audioMeterLoading,
    meterLevel,
    canSampleAudio,
    selectedMicrophone,
    isSessionActive
  } = useStudio()

  const captureDevices = deviceList.devices.filter((device) => ['screen', 'window'].includes(device.kind))
  const cameras = deviceList.devices.filter((device) => device.kind === 'camera')
  const microphones = deviceList.devices.filter((device) => device.kind === 'microphone')
  const syncOffsetMs = captureConfig.audio.microphoneSyncOffsetMs
  const [syncOffsetDraft, setSyncOffsetDraft] = useState(() => String(syncOffsetMs))

  const meterTone =
    audioMeter?.status === 'ready'
      ? 'bg-success'
      : audioMeter?.status === 'silent' || audioMeter?.status === 'permission-required'
        ? 'bg-warning'
        : 'bg-muted-foreground/40'
  const selectedCaptureId = captureConfig.sources.screenId ?? captureConfig.sources.windowId
  useEffect(() => {
    setSyncOffsetDraft(String(syncOffsetMs))
  }, [syncOffsetMs])

  const commitSyncOffsetDraft = (nextDraft: string, resetInvalid = false): void => {
    const parsed = parseMicrophoneSyncOffsetInput(nextDraft, syncOffsetMs)
    if (parsed === null) {
      if (resetInvalid) {
        setSyncOffsetDraft(String(syncOffsetMs))
      }
      return
    }

    setSyncOffsetDraft(String(parsed))
    setCaptureConfig((current) => ({
      ...current,
      audio: {
        ...current.audio,
        microphoneSyncOffsetMs: parsed,
        microphoneSyncOffsetUserSet: true
      }
    }))
  }

  const showDevices = section !== 'audio'
  const showAudio = section !== 'devices'

  return (
    <div className={section === 'all' ? 'grid gap-4 lg:grid-cols-2' : 'flex flex-col gap-4'}>
      {showDevices ? (
      <PanelSection
        action={
          <Button size="sm" variant="outline" onClick={refreshBackend}>
            <ArrowsClockwise data-icon="inline-start" />
            Refresh
          </Button>
        }
        className={section === 'all' ? 'lg:col-span-2' : undefined}
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
        <div className="grid gap-4 md:grid-cols-3">
          <SourceSelect
            devices={captureDevices}
            disabled={isSessionActive}
            label="Screen / window"
            value={selectedCaptureId}
            onChange={(captureId) =>
              setCaptureConfig((current) => {
                const selectedDevice = captureDevices.find((device) => device.id === captureId)

                return {
                  ...current,
                  sources: {
                    ...current.sources,
                    screenId: selectedDevice?.kind === 'screen' ? captureId : undefined,
                    screenName: selectedDevice?.kind === 'screen' ? selectedDevice.name : undefined,
                    windowId: selectedDevice?.kind === 'window' ? captureId : undefined,
                    windowName: selectedDevice?.kind === 'window' ? selectedDevice.name : undefined
                  }
                }
              })
            }
          />
          <SourceSelect
            allowNone
            devices={cameras}
            disabled={isSessionActive}
            label="Camera"
            value={captureConfig.sources.cameraId}
            onChange={(cameraId) =>
              setCaptureConfig((current) => {
                const selectedCamera = cameras.find((device) => device.id === cameraId)
                return {
                  ...current,
                  sources: {
                    ...current.sources,
                    cameraId,
                    cameraName: selectedCamera?.name
                  }
                }
              })
            }
          />
          <SourceSelect
            allowNone
            devices={microphones}
            disabled={isSessionActive}
            label="Microphone"
            value={captureConfig.sources.microphoneId}
            onChange={(microphoneId) =>
              setCaptureConfig((current) => {
                const selectedMicrophone = microphones.find((device) => device.id === microphoneId)
                return {
                  ...current,
                  sources: {
                    ...current.sources,
                    microphoneId,
                    microphoneName: selectedMicrophone?.name
                  }
                }
              })
            }
          />
        </div>

        {import.meta.env.DEV ? (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed bg-muted/20 px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">Synthetic diagnostic source</span>
              <span className="text-xs text-muted-foreground">
                Dev-only. Replaces the screen with a deterministic frame-number + timecode source
                for regression tests.
              </span>
            </div>
            <Switch
              checked={captureConfig.sources.testPattern === true}
              disabled={isSessionActive}
              size="sm"
              onCheckedChange={(testPattern) =>
                setCaptureConfig((current) => ({
                  ...current,
                  sources: { ...current.sources, testPattern }
                }))
              }
            />
          </div>
        ) : null}
      </PanelSection>
      ) : null}

      {showAudio ? (
      <PanelSection
        description="Native CoreAudio meter with manual source gain. No automatic processing is applied."
        icon={Waveform}
        title="Microphone mixer"
      >
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2 text-muted-foreground">
            {captureConfig.audio.microphoneMuted ? (
              <SpeakerSlash className="size-4" weight="duotone" />
            ) : (
              <SpeakerHigh className="size-4" weight="duotone" />
            )}
            {selectedMicrophone ? selectedMicrophone.name : 'No microphone selected'}
          </span>
          <span className="font-semibold tabular-nums">{formatDb(audioMeter?.peakDb)}</span>
        </div>
        <div className="grid gap-2 rounded-lg border bg-muted/30 px-3 py-2">
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
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">Gain</span>
              <span className="font-mono text-xs tabular-nums">
                {captureConfig.audio.microphoneGainDb > 0 ? '+' : ''}
                {captureConfig.audio.microphoneGainDb} dB
              </span>
            </div>
            <Slider
              max={24}
              min={-24}
              step={1}
              value={[captureConfig.audio.microphoneGainDb]}
              onValueChange={([microphoneGainDb]) =>
                setCaptureConfig((current) => ({
                  ...current,
                  audio: { ...current.audio, microphoneGainDb: microphoneGainDb ?? 0 }
                }))
              }
            />
          </div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">Sync</span>
              <span className="font-mono text-xs tabular-nums">
                {captureConfig.audio.microphoneSyncOffsetMs > 0 ? '+' : ''}
                {captureConfig.audio.microphoneSyncOffsetMs} ms
              </span>
            </div>
            <div className="grid grid-cols-[1fr_auto] items-center gap-3">
              <Slider
                max={MICROPHONE_SYNC_OFFSET_MAX_MS}
                min={MICROPHONE_SYNC_OFFSET_MIN_MS}
                step={5}
                value={[captureConfig.audio.microphoneSyncOffsetMs]}
                onValueChange={([microphoneSyncOffsetMs]) =>
                  setCaptureConfig((current) => ({
                    ...current,
                    audio: {
                      ...current.audio,
                      microphoneSyncOffsetMs: normalizeMicrophoneSyncOffsetMs(
                        microphoneSyncOffsetMs,
                        current.audio.microphoneSyncOffsetMs
                      ),
                      microphoneSyncOffsetUserSet: true
                    }
                  }))
                }
              />
              <Input
                aria-label="Microphone sync offset milliseconds"
                className="w-24 font-mono text-xs tabular-nums"
                max={MICROPHONE_SYNC_OFFSET_MAX_MS}
                min={MICROPHONE_SYNC_OFFSET_MIN_MS}
                step={1}
                type="number"
                value={syncOffsetDraft}
                onBlur={() => commitSyncOffsetDraft(syncOffsetDraft, true)}
                onChange={(event) => {
                  const nextDraft = event.currentTarget.value
                  setSyncOffsetDraft(nextDraft)
                  commitSyncOffsetDraft(nextDraft)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitSyncOffsetDraft(syncOffsetDraft, true)
                    event.currentTarget.blur()
                  }
                }}
              />
            </div>
          </div>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all', meterTone)}
            style={{ width: `${Math.min(100, Math.max(0, meterLevel))}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {audioMeter?.message ?? 'Run a check to confirm the mic is live before recording.'}
        </p>
        <Button
          className="self-start"
          disabled={!canSampleAudio || audioMeterLoading}
          size="sm"
          variant="outline"
          onClick={sampleAudioMeter}
        >
          {audioMeterLoading ? 'Checking...' : 'Check mic'}
        </Button>
      </PanelSection>
      ) : null}

      {showDevices ? (
      <PanelSection
        description="All devices discovered by the backend and their permission state."
        icon={Monitor}
        title="Diagnostics"
      >
        {deviceList.devices.length === 0 ? (
          <Empty className="border-0 py-6">
            <EmptyTitle>No devices yet</EmptyTitle>
            <EmptyDescription>Refresh to query the backend for capture devices.</EmptyDescription>
          </Empty>
        ) : (
          <div className="flex flex-col gap-1.5">
            {deviceList.devices.map((device) => (
              <DiagnosticRow device={device} key={`${device.kind}-${device.id}`} />
            ))}
          </div>
        )}
      </PanelSection>
      ) : null}
    </div>
  )
}

function DiagnosticRow({ device }: { device: Device }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{device.name}</span>
        <span className="text-xs text-muted-foreground capitalize">
          {device.kind}
          {device.detail ? ` · ${device.detail}` : ''}
        </span>
      </div>
      <StatusBadge label="" tone={STATUS_TONE[device.status]} value={device.status} />
    </div>
  )
}
