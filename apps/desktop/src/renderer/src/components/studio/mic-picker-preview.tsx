import { useEffect, useRef, type ReactElement, type RefObject } from 'react'

import { LiveWaveform, type LiveWaveformHandle } from '@/components/ui/live-waveform'
import { useStudioCore } from '@/hooks/use-studio'
import {
  useStudioMicVisualLifecycle,
  useStudioMicVisualPainter
} from '@/hooks/use-studio-mic-visual'
import type { MicStreamFailureReason } from '@/lib/mic-stream'

/**
 * Plan 080 S3: the reason decides the words. The old line blamed permission
 * for every failure, yet this state is only reachable once the OS has
 * granted the mic; only a real refusal may mention permission.
 */
export function micPreviewUnavailableCopy(reason: MicStreamFailureReason | undefined): string {
  switch (reason) {
    case 'permission-denied':
      return "Videorc can't use this mic. Check Settings → Permissions."
    case 'device-busy':
      return "Another app is using this mic. The preview comes back when it's free. Recording still works."
    case 'no-label-match':
    case 'ambiguous-label':
    case 'labels-hidden':
    case 'device-missing':
    case 'overconstrained':
      return 'No live preview for this mic. Recording still works.'
    default:
      return 'Live preview unavailable. Recording still works.'
  }
}

/**
 * See-before-you-pick mic preview (Studio audio rework S4): a scrolling live
 * waveform of the selected device rendered under the mic pickers, so choosing
 * a microphone is never blind. One shared composition for both picker homes
 * (Quick Settings popover, Sources panel). The workspace provider owns the
 * sole stream, analyser, and frame clock; this surface only paints its rolling
 * snapshots. Failures show an honest inline reason, never a fake wave or toast.
 * While no session runs the analyser only opens with "Monitor input" on
 * (live feedback batch 3, B2), so the idle line offers that toggle inline.
 */
export function MicPickerPreview({
  deviceName
}: {
  /** Backend name of the mic to preview; undefined renders the idle line. */
  deviceName: string | undefined
}): ReactElement {
  const lifecycle = useStudioMicVisualLifecycle()
  const { captureConfig } = useStudioCore()
  const waveformRef = useRef<LiveWaveformHandle>(null)
  useMicPickerFramePainter(waveformRef)
  const enabled = Boolean(deviceName)
  const muted = enabled && captureConfig.audio.microphoneMuted
  const unavailableReason =
    enabled && lifecycle.status === 'unavailable' ? (lifecycle.reason ?? 'unknown') : undefined
  useEffect(() => {
    if (unavailableReason && import.meta.env.DEV) {
      console.debug('[videorc] mic preview unavailable', { deviceName, reason: unavailableReason })
    }
  }, [deviceName, unavailableReason])

  return (
    <div
      className="flex flex-col gap-1"
      data-videorc-mic-preview
      data-videorc-mic-preview-reason={unavailableReason}
      aria-label="Visual microphone preview"
    >
      <div className="rounded-row border bg-muted/20 px-2 py-1 text-foreground/70">
        <LiveWaveform
          ref={waveformRef}
          active={lifecycle.active}
          barGap={1}
          barWidth={2}
          height={28}
          mode="scrolling"
          processing={enabled && lifecycle.status === 'acquiring'}
        />
      </div>
      {unavailableReason ? (
        <span className="text-xs text-muted-foreground">
          {micPreviewUnavailableCopy(unavailableReason)}
        </span>
      ) : muted ? (
        // The one honest reason the waveform is flat while the picker is open:
        // idle no longer silences it, so a mute is worth naming.
        <span className="text-xs text-muted-foreground">
          Microphone is muted. Unmute to see its level.
        </span>
      ) : null}
    </div>
  )
}

/** Shared by both picker homes and the provider integration regression. */
export function useMicPickerFramePainter(waveformRef: RefObject<LiveWaveformHandle | null>): void {
  useStudioMicVisualPainter((frame) =>
    waveformRef.current?.paint(frame.historyRing, frame.historyStart, frame.historyLength)
  )
}
