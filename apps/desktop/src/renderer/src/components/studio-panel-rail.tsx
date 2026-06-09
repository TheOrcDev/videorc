import { X } from '@phosphor-icons/react'
import type { ReactElement } from 'react'

import { LayoutTab } from '@/components/tabs/layout-tab'
import { RecordingTab } from '@/components/tabs/recording-tab'
import { ScreensTab } from '@/components/tabs/screens-tab'
import { SourcesTab } from '@/components/tabs/sources-tab'
import { StreamingTab } from '@/components/tabs/streaming-tab'
import { Button } from '@/components/ui/button'
import { STUDIO_PANELS, type StudioPanel } from '@/components/workspace-nav'

/**
 * The push rail (plan slice C1): a panel column between the sidebar and the studio.
 * The studio slot resizes to make room — the rail must never overlap the preview
 * (the B3 occlusion contract assumes panels stay outside the studio rect).
 *
 * Panel homes follow decision 5: Layouts owns everything that answers "what is on
 * program output" (presets, scene controls, takeover screens); Live owns
 * destinations and metadata; Audio owns the microphone; Recording owns output.
 */
export function StudioPanelRail({
  panel,
  onClose
}: {
  panel: StudioPanel
  onClose: () => void
}): ReactElement {
  const meta = STUDIO_PANELS.find((candidate) => candidate.id === panel)
  return (
    <aside
      className="flex w-[400px] shrink-0 flex-col border-r bg-background"
      data-videorc-studio-panel={panel}
    >
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          {meta ? <meta.icon className="size-4 text-primary" weight="fill" /> : null}
          <span className="text-sm font-semibold">{meta?.label ?? panel}</span>
        </div>
        <Button
          aria-label="Close panel"
          className="size-7"
          size="icon"
          variant="ghost"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {panel === 'layouts' ? (
          <div className="flex flex-col gap-4">
            <LayoutTab embedded />
            <SourcesTab section="devices" />
            <ScreensTab />
          </div>
        ) : null}
        {panel === 'live' ? <StreamingTab /> : null}
        {panel === 'audio' ? <SourcesTab section="audio" /> : null}
        {panel === 'recording' ? <RecordingTab /> : null}
      </div>
    </aside>
  )
}
