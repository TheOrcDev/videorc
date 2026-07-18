import { Microphone, SpeakerHigh, SpeakerSlash, WaveSine } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'

import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { BarVisualizer, paintBarVisualizer } from '@/components/ui/bar-visualizer'
import { Button } from '@/components/ui/button'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudioAudio, useStudioCore, useStudioDiagnostics } from '@/hooks/use-studio'
import {
  useStudioMicVisualLifecycle,
  useStudioMicVisualPainter,
  useStudioMicVisualPeakDb
} from '@/hooks/use-studio-mic-visual'
import type { AudioMeterStatus } from '@/lib/backend'
import { formatDb } from '@/lib/format'
import { resampleMicVisualLevelsInto } from '@/lib/mic-visual-frame'
import { advanceClipHoldDeadline, fallbackBandLevels } from '@/lib/mic-meter'
import { systemAccessAction, systemAccessRows, type SystemAccessAction } from '@/lib/system-access'
import { cn } from '@/lib/utils'

const MIXER_BAR_COUNT = 28

export function audioMixerNotice(
  permissionAction: SystemAccessAction,
  meterStatus: AudioMeterStatus | undefined,
  deviceIssue: boolean
): 'permission' | 'silent' | 'no-frames' | 'device-issue' | null {
  if (permissionAction) return 'permission'
  if (meterStatus === 'silent' || meterStatus === 'no-frames') return meterStatus
  return deviceIssue ? 'device-issue' : null
}

export function audioMixerSignalLive(
  muted: boolean,
  rendererActive: boolean,
  backendLiveLevel: number | null
): boolean {
  return !muted && (rendererActive || backendLiveLevel !== null)
}

/**
 * Audio mixer (SD4 + post-0.9.4 fix F7 + 2026-07-10 live-meter fix + Studio
 * audio ElevenLabs rework S3). The VISUAL is a multi-band bar visualizer over
 * the shared renderer mic pipeline at display rate. The provider's WebAudio
 * frame also supplies the peak-dB label and clip hold. The
 * backend stays the capture/health authority: its 1 Hz `micLiveLevel` and the
 * on-demand 700 ms "Check level" sample drive a deterministic coarse-band
 * fallback whenever the analyser cannot open the selected device. The stream
 * releases while the document is hidden (idle-CPU discipline). System audio
 * shows its honest "unavailable — pending native adapter" state; real capture
 * is Phase-2 (F3).
 */
export function AudioMixer(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    selectedMicrophone,
    sampleAudioMeter,
    deviceList,
    handleSystemPermission,
    mediaAccess,
    runtimeInfo
  } = useStudioCore()
  const { audioMeter, audioMeterLoading } = useStudioAudio()
  const { diagnosticStats } = useStudioDiagnostics()
  const { openStudioPanel } = useWorkspaceNav()

  const muted = captureConfig.audio.microphoneMuted
  const micVisual = useStudioMicVisualLifecycle()

  const liveLevel =
    typeof diagnosticStats?.micLiveLevel === 'number' ? diagnosticStats.micLiveLevel : null
  const hasReading = audioMeter !== null && typeof audioMeter.level === 'number'
  const level = liveLevel ?? (hasReading ? (audioMeter?.level ?? 0) : 0)
  const fallbackDbLabel =
    liveLevel !== null && typeof diagnosticStats?.micLivePeakDb === 'number'
      ? formatDb(diagnosticStats.micLivePeakDb)
      : audioMeter && typeof audioMeter.peakDb === 'number'
        ? formatDb(audioMeter.peakDb)
        : formatDb(captureConfig.audio.microphoneGainDb)
  const systemAudio = deviceList.devices.find((device) => device.kind === 'system-audio')

  // Explicit visual state map (plan S3) — every path states what drives it:
  // - live analyser: bars from the stream, chrome tone;
  // - muted: flat dim bars (the analyser sees pre-mute signal — dancing bars
  //   under a mute would lie about the recording);
  // - coarse fallback (backend 1 Hz / sampled level): deterministic
  //   center-weighted bands from the real level;
  // - silent/no-frames: warning tone over whatever level path is active;
  // - no mic: flat dim bars.
  const meterStatus = micVisual.active || liveLevel !== null ? 'ready' : audioMeter?.status
  const microphoneAccess = systemAccessRows({
    deviceList,
    audioMeter,
    platform: runtimeInfo?.platform,
    mediaAccess
  }).find((row) => row.id === 'microphone')
  const microphonePermissionAction = systemAccessAction({
    pane: 'microphone',
    state: microphoneAccess?.state,
    platform: runtimeInfo?.platform,
    mediaAccessStatus: mediaAccess?.microphone
  })
  const notice = audioMixerNotice(
    microphonePermissionAction,
    meterStatus,
    microphoneAccess?.state === 'device-issue'
  )
  const analyserDriven = micVisual.active && !muted
  const signalLive = audioMixerSignalLive(muted, micVisual.active, liveLevel)
  const fallbackLevels = fallbackBandLevels(
    muted || !selectedMicrophone ? 0 : level,
    MIXER_BAR_COUNT
  )
  const meterTone =
    muted || !selectedMicrophone
      ? 'text-muted-foreground/50'
      : meterStatus === 'silent' || meterStatus === 'no-frames'
        ? 'text-warning'
        : meterStatus === 'ready'
          ? 'text-foreground/80'
          : 'text-muted-foreground/70'

  return (
    <PanelSection
      title="Audio mixer"
      action={
        <Button size="sm" variant="ghost" onClick={() => openStudioPanel('sources')}>
          Audio settings
        </Button>
      }
    >
      {/* Microphone */}
      <div className="flex flex-col gap-2 rounded-row border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <Microphone className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
            <span className="truncate text-sm font-medium">
              {selectedMicrophone?.name ?? 'No microphone'}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <MicSignalReadout fallbackLabel={fallbackDbLabel} muted={muted} />
            {selectedMicrophone ? (
              <Button
                aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
                aria-pressed={muted}
                className="size-7"
                size="icon"
                variant="ghost"
                onClick={() =>
                  setCaptureConfig((current) => ({
                    ...current,
                    audio: { ...current.audio, microphoneMuted: !current.audio.microphoneMuted }
                  }))
                }
              >
                {muted ? (
                  <SpeakerSlash className="size-4 text-warning" weight="fill" />
                ) : (
                  <SpeakerHigh className="size-4" weight="fill" />
                )}
              </Button>
            ) : null}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <AudioMixerBars
            analyserDriven={analyserDriven}
            fallbackLevels={fallbackLevels}
            meterTone={meterTone}
          />
          {signalLive ? (
            <span className="shrink-0 text-xs text-muted-foreground">Live</span>
          ) : (
            <Button
              className="shrink-0"
              disabled={!selectedMicrophone || audioMeterLoading}
              size="xs"
              variant="outline"
              onClick={() => void sampleAudioMeter()}
            >
              {audioMeterLoading ? 'Checking…' : 'Check level'}
            </Button>
          )}
        </div>
        {notice === 'permission' ? (
          <div className="flex items-center justify-between gap-2 text-xs text-warning">
            <span>Microphone permission is required before levels can be read.</span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void handleSystemPermission('microphone')}
            >
              {microphonePermissionAction === 'request-media-access'
                ? 'Enable microphone'
                : 'Open settings'}
            </Button>
          </div>
        ) : notice === 'silent' || notice === 'no-frames' ? (
          <span className="text-xs text-warning">
            {notice === 'silent'
              ? 'The mic delivered only silence on the last check.'
              : 'The mic opened but did not send audio frames.'}
          </span>
        ) : notice === 'device-issue' ? (
          <span className="text-xs text-warning">{microphoneAccess?.detail}</span>
        ) : null}
      </div>

      {/* System audio — honest unavailable state until the native adapter lands. */}
      {systemAudio ? (
        <div className="flex items-center justify-between gap-2 rounded-row border border-dashed bg-muted/10 p-3">
          <span className="flex min-w-0 items-center gap-2">
            <WaveSine className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{systemAudio.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                Pending native system-audio adapter
              </span>
            </span>
          </span>
          <StatusBadge tone="neutral" value="Unavailable" />
        </div>
      ) : null}
    </PanelSection>
  )
}

function AudioMixerBars({
  analyserDriven,
  fallbackLevels,
  meterTone
}: {
  analyserDriven: boolean
  fallbackLevels: number[]
  meterTone: string
}): ReactElement {
  if (analyserDriven) {
    return <LiveAudioMixerBars meterTone={meterTone} />
  }

  return (
    <BarVisualizer
      centerAlign
      barCount={MIXER_BAR_COUNT}
      className={cn('h-12 min-w-0 flex-1', meterTone)}
      data-videorc-mic-visualizer
      levels={fallbackLevels}
      minHeight={8}
      state="speaking"
    />
  )
}

function LiveAudioMixerBars({ meterTone }: { meterTone: string }): ReactElement {
  const visualizerRef = useRef<HTMLDivElement>(null)
  useAudioMixerFramePainter(visualizerRef)

  return (
    <BarVisualizer
      ref={visualizerRef}
      centerAlign
      barCount={MIXER_BAR_COUNT}
      className={cn('h-12 min-w-0 flex-1', meterTone)}
      data-videorc-mic-visualizer
      levels={fallbackBandLevels(0, MIXER_BAR_COUNT)}
      minHeight={8}
      state="speaking"
    />
  )
}

/** Shared by the real mixer surface and the provider integration regression. */
export function useAudioMixerFramePainter(visualizerRef: RefObject<HTMLDivElement | null>): void {
  const levelsRef = useRef<number[] | null>(null)
  if (!levelsRef.current) levelsRef.current = new Array<number>(MIXER_BAR_COUNT).fill(0)
  useStudioMicVisualPainter((frame) => {
    const levels = levelsRef.current
    if (!levels) return
    resampleMicVisualLevelsInto(frame.bands, levels)
    paintBarVisualizer(visualizerRef.current, levels, { minHeight: 8 })
  })
}

function MicSignalReadout({
  fallbackLabel,
  muted
}: {
  fallbackLabel: string
  muted: boolean
}): ReactElement {
  if (muted) {
    return <MicSignalReadoutValue fallbackLabel={fallbackLabel} peakDb={null} />
  }

  return <LiveMicSignalReadout fallbackLabel={fallbackLabel} />
}

function LiveMicSignalReadout({ fallbackLabel }: { fallbackLabel: string }): ReactElement {
  const peakDb = useStudioMicVisualPeakDb()
  return <MicSignalReadoutValue fallbackLabel={fallbackLabel} peakDb={peakDb} />
}

function MicSignalReadoutValue({
  fallbackLabel,
  peakDb
}: {
  fallbackLabel: string
  peakDb: number | null
}): ReactElement {
  const clipping = useClipIndicator(peakDb)
  const dbLabel = peakDb === null ? fallbackLabel : formatDb(peakDb)

  return (
    <>
      {/* Clip hold keeps its width reserved so the label row never shifts. */}
      <span
        aria-hidden={!clipping}
        className={cn(
          'flex items-center gap-1 text-xs font-medium text-warning transition-opacity duration-150',
          clipping ? 'opacity-100' : 'opacity-0'
        )}
        data-videorc-mic-clip={clipping || undefined}
      >
        <span className="size-1.5 rounded-full bg-warning" />
        Clip
      </span>
      <span className="text-xs tabular-nums text-muted-foreground">{dbLabel}</span>
    </>
  )
}

/**
 * Clip indicator with hold: peaks at/above the clip threshold arm it and the
 * deadline extends while the input stays hot (advanceClipHoldDeadline), so a
 * single hot transient stays readable for MIC_CLIP_HOLD_MS.
 */
function useClipIndicator(peakDb: number | null): boolean {
  const deadlineRef = useRef(0)
  const [clipping, setClipping] = useState(false)

  useEffect(() => {
    const now = performance.now()
    deadlineRef.current = advanceClipHoldDeadline(deadlineRef.current, peakDb, now)
    if (now < deadlineRef.current) {
      setClipping(true)
    }
  }, [peakDb])

  useEffect(() => {
    if (!clipping) {
      return
    }
    const interval = window.setInterval(() => {
      if (performance.now() >= deadlineRef.current) {
        setClipping(false)
      }
    }, 250)
    return () => window.clearInterval(interval)
  }, [clipping])

  return clipping
}
