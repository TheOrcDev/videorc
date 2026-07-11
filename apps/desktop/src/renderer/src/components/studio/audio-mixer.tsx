import { Microphone, SpeakerHigh, SpeakerSlash, WaveSine } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useMicLevelMeter, type MicLevelMeter } from '@/hooks/use-mic-level-meter'
import { useStudioAudio, useStudioCore, useStudioDiagnostics } from '@/hooks/use-studio'
import { formatDb } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Audio mixer (SD4 + post-0.9.4 fix F7 + 2026-07-10 live-meter fix). The
 * VISUAL meter runs on a renderer WebAudio analyser at display rate, driven
 * imperatively (use-mic-level-meter) — instant response with peak hold, both
 * idle and in-session. The backend stays the capture/health authority: its
 * 1 Hz `micLiveLevel` and the on-demand 700 ms "Check level" sample remain
 * the fallback whenever the analyser cannot open the selected device.
 * System audio shows its honest "unavailable — pending native adapter" state;
 * real capture is Phase-2 (F3).
 */
export function AudioMixer(): ReactElement {
  const { captureConfig, setCaptureConfig, selectedMicrophone, sampleAudioMeter, deviceList } =
    useStudioCore()
  const { audioMeter, audioMeterLoading } = useStudioAudio()
  const { diagnosticStats } = useStudioDiagnostics()
  const { openStudioPanel } = useWorkspaceNav()

  const muted = captureConfig.audio.microphoneMuted
  const micMeter = useMicLevelMeter({
    deviceName: selectedMicrophone?.name,
    enabled: Boolean(selectedMicrophone),
    muted
  })
  const liveLevel =
    typeof diagnosticStats?.micLiveLevel === 'number' ? diagnosticStats.micLiveLevel : null
  const hasReading = audioMeter !== null && typeof audioMeter.level === 'number'
  const level = liveLevel ?? (hasReading ? (audioMeter?.level ?? 0) : 0)
  const dbLabel =
    micMeter.active && micMeter.peakDb !== null
      ? formatDb(micMeter.peakDb)
      : liveLevel !== null && typeof diagnosticStats?.micLivePeakDb === 'number'
        ? formatDb(diagnosticStats.micLivePeakDb)
        : audioMeter && typeof audioMeter.peakDb === 'number'
          ? formatDb(audioMeter.peakDb)
          : formatDb(captureConfig.audio.microphoneGainDb)
  const systemAudio = deviceList.devices.find((device) => device.kind === 'system-audio')

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
            <span className="text-xs tabular-nums text-muted-foreground">{dbLabel}</span>
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
        <div className="flex items-center gap-2">
          <MeterBar
            level={micMeter.active ? null : level}
            live={micMeter.active ? micMeter : undefined}
            muted={muted}
            status={micMeter.active || liveLevel !== null ? 'ready' : audioMeter?.status}
          />
          {micMeter.active || liveLevel !== null ? (
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

function MeterBar({
  level,
  live,
  status,
  muted
}: {
  /** Static level for the fallback paths; null while the analyser drives the bar. */
  level: number | null
  /** When set, fill width and peak marker are written imperatively at rAF rate. */
  live?: Pick<MicLevelMeter, 'fillRef' | 'peakRef'>
  status?: string
  muted: boolean
}): ReactElement {
  const pct = level === null ? 0 : Math.min(100, Math.max(0, Math.round(level * 100)))
  const tone = muted
    ? 'bg-muted-foreground/40'
    : status === 'ready'
      ? 'bg-success'
      : status === 'silent' || status === 'no-frames'
        ? 'bg-warning'
        : 'bg-muted-foreground/40'
  return (
    <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
      <span
        ref={live?.fillRef}
        // The analyser's own ballistics animate the live bar; a CSS width
        // transition would smear every frame. Keep it only on the 1 Hz
        // fallback paths so their jumps stay readable.
        className={cn(
          'block h-full rounded-full',
          !live && 'transition-[width] duration-100',
          tone
        )}
        style={live ? undefined : { width: `${pct}%` }}
      />
      {live ? (
        <span
          ref={live.peakRef}
          aria-hidden
          className="absolute top-0 h-full w-0.5 rounded-full bg-foreground/70"
          style={{ left: 0, opacity: 0 }}
        />
      ) : null}
    </span>
  )
}
