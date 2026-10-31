import { SyncIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { ConfigGrid, CONFIG_GRID_PAIR, PageHeader } from '@/components/page'
import { SourcePermissionAlerts } from '@/components/sources/source-permission-alerts'
import { SourcesAudioMixer } from '@/components/sources/sources-audio-mixer'
import { VideoSources } from '@/components/sources/video-sources'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useStudioCore, useStudioPreview } from '@/hooks/use-studio'
import { sourcesPageDescription } from '@/lib/platform-copy'
import { screenShareNeedsAsking } from '@/lib/screen-share-recovery'

// The single home for every capture device (UI rewrite plan V1/V2,
// 2026-06-10). Plan 173 rebuilt it as the Config-grid page `page.tsx` names:
// Video (Screen, Camera) beside Audio (Microphone, System audio) at `lg`,
// stacked below it, every source in the same SourceItem shape. The page's one
// action, Refresh, re-reads every device, so it sits on the intro line. What
// blocks a source leads the page: one alert per missing permission (plan 174
// S3.8).
export function SourcesTab(): ReactElement {
  const { captureConfig, refreshDevices, refreshPreview, runtimeInfo } = useStudioCore()
  const { previewScreenStatus } = useStudioPreview()
  const [refreshing, setRefreshing] = useState(false)

  return (
    <div className="flex min-h-full flex-col" data-videorc-sources-page="">
      <PageHeader
        action={
          <Tooltip>
            {/* The words stay exactly "Refresh": smoke-scene-presets finds the
                button by them, and waits for it to come back enabled. */}
            <TooltipTrigger
              render={
                <Button
                  disabled={refreshing}
                  variant="outline"
                  onClick={() => {
                    setRefreshing(true)
                    // Devices and media access only (plan 174 C-32), and never an
                    // answer from a read that started before the click: a camera
                    // plugged in a moment ago must show up. A Linux share
                    // dialog that ended without a share is asked again.
                    const askAgain = screenShareNeedsAsking({
                      selectedId: captureConfig.sources.windowId ?? captureConfig.sources.screenId,
                      state: previewScreenStatus.state
                    })
                    void refreshDevices()
                      .then(() => (askAgain ? refreshPreview() : undefined))
                      .finally(() => setRefreshing(false))
                  }}
                />
              }
            >
              <SyncIcon
                className={refreshing ? 'animate-spin' : undefined}
                data-icon="inline-start"
              />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </TooltipTrigger>
            <TooltipContent>
              Look again for screens, windows, cameras and microphones
            </TooltipContent>
          </Tooltip>
        }
        className="border-b border-border py-2"
        description={sourcesPageDescription(runtimeInfo?.platform)}
        title="Sources"
      />
      <SourcePermissionAlerts />
      <ConfigGrid className={CONFIG_GRID_PAIR}>
        <VideoSources />
        <SourcesAudioMixer />
      </ConfigGrid>
    </div>
  )
}
