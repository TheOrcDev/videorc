import type { ReactElement } from 'react'

import { LiveWaveform } from '@/components/ui/live-waveform'
import { useDocumentVisible } from '@/hooks/use-document-visible'
import { useMicStream } from '@/hooks/use-mic-stream'
import type { MediaAccessStatus } from '@/lib/backend'

/**
 * See-before-you-pick mic preview (Studio audio rework S4): a scrolling live
 * waveform of the selected device rendered under the mic pickers, so choosing
 * a microphone is never blind. One shared composition for both picker homes
 * (Quick Settings popover, Sources panel). The stream opens through
 * use-mic-stream while the preview is mounted and visible, and hard-stops on
 * unmount (popover close, panel leave) — it must never linger. Failures show
 * an honest inline reason, never a fake wave and never a toast.
 */
export function MicPickerPreview({
  deviceName,
  permissionStatus
}: {
  /** Backend name of the mic to preview; undefined renders the idle line. */
  deviceName: string | undefined
  /** Exact OS access status; unresolved/non-granted states stay passive. */
  permissionStatus: MediaAccessStatus | undefined
}): ReactElement {
  const documentVisible = useDocumentVisible()
  const enabled = Boolean(deviceName) && documentVisible
  const micStream = useMicStream({ deviceName, enabled, permissionStatus })

  return (
    <div className="flex flex-col gap-1" data-videorc-mic-preview>
      <div className="rounded-row border bg-muted/20 px-2 py-1 text-foreground/70">
        <LiveWaveform
          barGap={1}
          barWidth={2}
          height={28}
          mediaStream={micStream.stream}
          mode="scrolling"
          processing={enabled && micStream.status === 'acquiring'}
        />
      </div>
      {enabled && micStream.status === 'unavailable' ? (
        <span className="text-xs text-muted-foreground">
          Live preview unavailable — the mic may be in use or needs permission. Recording is
          unaffected.
        </span>
      ) : null}
    </div>
  )
}
