import { useRef, type ReactElement, type RefObject } from 'react'

import { LiveWaveform, type LiveWaveformHandle } from '@/components/ui/live-waveform'
import {
  useStudioMicVisualLifecycle,
  useStudioMicVisualPainter
} from '@/hooks/use-studio-mic-visual'

/**
 * See-before-you-pick mic preview (Studio audio rework S4): a scrolling live
 * waveform of the selected device rendered under the mic pickers, so choosing
 * a microphone is never blind. One shared composition for both picker homes
 * (Quick Settings popover, Sources panel). The workspace provider owns the
 * sole stream, analyser, and frame clock; this surface only paints its rolling
 * snapshots. Failures show an honest inline reason, never a fake wave or toast.
 */
export function MicPickerPreview({
  deviceName
}: {
  /** Backend name of the mic to preview; undefined renders the idle line. */
  deviceName: string | undefined
}): ReactElement {
  const lifecycle = useStudioMicVisualLifecycle()
  const waveformRef = useRef<LiveWaveformHandle>(null)
  useMicPickerFramePainter(waveformRef)
  const enabled = Boolean(deviceName)

  return (
    <div className="flex flex-col gap-1" data-videorc-mic-preview>
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
      {enabled && lifecycle.status === 'unavailable' ? (
        <span className="text-xs text-muted-foreground">
          Live preview unavailable — the mic may be in use or needs permission. Recording is
          unaffected.
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
