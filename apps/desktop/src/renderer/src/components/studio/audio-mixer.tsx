import { Microphone, SpeakerHigh, SpeakerSlash, WaveSine } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { useStudio } from '@/hooks/use-studio'
import { formatDb } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Audio mixer (SD4 + post-0.9.4 fix F7). During a LIVE session the meter moves
 * on its own: the backend derives a live level from the mic frames the session
 * already captures (diagnostics.stats stream — no extra device open, no idle
 * loop, the idle-perf baseline holds). While idle, the meter stays on-demand
 * (Check level, one 700ms device sample) — the same model Sources uses.
 * System audio shows its honest "unavailable — pending native adapter" state;
 * real capture is Phase-2 (F3).
 */
export function AudioMixer(): ReactElement {
  const {
    captureConfig,
    setCaptureConfig,
    selectedMicrophone,
    audioMeter,
    audioMeterLoading,
    sampleAudioMeter,
    deviceList,
    diagnosticStats
  } = useStudio()
  const { openStudioPanel } = useWorkspaceNav()

  const muted = captureConfig.audio.microphoneMuted
  const liveLevel =
    typeof diagnosticStats?.micLiveLevel === 'number' ? diagnosticStats.micLiveLevel : null
  const hasReading = audioMeter !== null && typeof audioMeter.level === 'number'
  const level = liveLevel ?? (hasReading ? (audioMeter?.level ?? 0) : 0)
  const dbLabel =
    liveLevel !== null && typeof diagnosticStats?.micLivePeakDb === 'number'
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
            level={level}
            muted={muted}
            status={liveLevel !== null ? 'ready' : audioMeter?.status}
          />
          {liveLevel !== null ? (
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
  status,
  muted
}: {
  level: number
  status?: string
  muted: boolean
}): ReactElement {
  const pct = Math.min(100, Math.max(0, Math.round(level * 100)))
  const tone = muted
    ? 'bg-muted-foreground/40'
    : status === 'ready'
      ? 'bg-success'
      : status === 'silent' || status === 'no-frames'
        ? 'bg-warning'
        : 'bg-muted-foreground/40'
  return (
    <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
      <span
        className={cn('block h-full rounded-full transition-[width] duration-100', tone)}
        style={{ width: `${pct}%` }}
      />
    </span>
  )
}
