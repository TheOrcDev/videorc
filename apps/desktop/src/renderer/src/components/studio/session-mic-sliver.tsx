import type { ReactElement } from 'react'

import { BarVisualizer } from '@/components/ui/bar-visualizer'
import { useDocumentVisible } from '@/hooks/use-document-visible'
import { useMicStream } from '@/hooks/use-mic-stream'
import type { MediaAccessStatus } from '@/lib/backend'
import { fallbackBandLevels } from '@/lib/mic-meter'
import { cn } from '@/lib/utils'

const SLIVER_BAR_COUNT = 5

/**
 * In-session mic confidence sliver (Studio audio rework S5): a passive 5-bar
 * mini visualizer beside the session status badge — one home, rendered by the
 * status cluster wherever it lives (Preview panel header or the docked
 * frame's control row). Visible only while a session runs with a mic
 * selected; its width is reserved for the whole session so mute toggles never
 * shift layout (muted shows flat dim bars). No click target — the mixer owns
 * the controls. The stream releases while the document is hidden.
 */
export function SessionMicSliver({
  sessionActive,
  deviceName,
  muted,
  permissionStatus
}: {
  sessionActive: boolean
  deviceName: string | undefined
  muted: boolean
  permissionStatus: MediaAccessStatus | undefined
}): ReactElement | null {
  const documentVisible = useDocumentVisible()
  const enabled = sessionActive && Boolean(deviceName) && !muted && documentVisible
  const micStream = useMicStream({ deviceName, enabled, permissionStatus })

  if (!sessionActive || !deviceName) {
    return null
  }

  return (
    <span
      className="flex w-9 shrink-0 items-center"
      data-videorc-session-mic-sliver
      title={muted ? 'Microphone muted' : 'Live microphone signal'}
    >
      <BarVisualizer
        centerAlign
        barCount={SLIVER_BAR_COUNT}
        className={cn(
          'h-4 w-full gap-0.5',
          muted ? 'text-muted-foreground/50' : 'text-foreground/70'
        )}
        levels={muted || !micStream.active ? fallbackBandLevels(0, SLIVER_BAR_COUNT) : undefined}
        mediaStream={micStream.stream}
        minHeight={12}
        state="speaking"
      />
    </span>
  )
}
