import { ImageBroken, ImageSquare, UploadSimple } from '@phosphor-icons/react'
import { useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStudio } from '@/hooks/use-studio'
import type { StreamScreen } from '@/lib/backend'

export function ScreensTab(): ReactElement {
  const { importScreenImage, isSessionActive, screenImportPending, screens, wsStatus } = useStudio()
  const uploadDisabled = isSessionActive || screenImportPending || wsStatus !== 'connected'

  return (
    <PanelSection
      action={
        <Button disabled={uploadDisabled} onClick={() => void importScreenImage()}>
          <UploadSimple data-icon="inline-start" weight="bold" />
          {screenImportPending ? 'Importing' : 'Upload'}
        </Button>
      }
      description="Upload full-frame images for stream takeovers. Management is locked while a session is live."
      icon={ImageSquare}
      title="Screens"
    >
      {screens.length === 0 ? (
        <Empty className="py-12">
          <EmptyMedia variant="icon">
            <ImageSquare weight="duotone" />
          </EmptyMedia>
          <EmptyTitle>No Screens yet</EmptyTitle>
          <EmptyDescription>Upload a PNG, JPEG, or WebP image to create the first Screen.</EmptyDescription>
        </Empty>
      ) : (
        <ScrollArea className="h-[calc(100vh-15rem)] pr-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {screens.map((screen) => (
              <ScreenTile key={screen.id} screen={screen} />
            ))}
          </div>
        </ScrollArea>
      )}
    </PanelSection>
  )
}

function ScreenTile({ screen }: { screen: StreamScreen }): ReactElement {
  const [imageFailed, setImageFailed] = useState(false)
  const missing = screen.status === 'missing' || imageFailed

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-background">
      <div className="relative aspect-video bg-muted">
        {!missing ? (
          <img
            alt=""
            className="size-full object-cover"
            src={fileUrlFromPath(screen.imagePath)}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <ImageBroken className="size-8" weight="duotone" />
          </div>
        )}
        <Badge className="absolute right-2 top-2" variant={missing ? 'destructive' : 'success'}>
          {missing ? 'Missing' : 'Ready'}
        </Badge>
      </div>
      <div className="flex min-w-0 flex-col gap-1 p-3">
        <span className="truncate text-sm font-semibold">{screen.name}</span>
        <span className="truncate text-xs text-muted-foreground">{screen.imagePath}</span>
      </div>
    </div>
  )
}

function fileUrlFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const prefix = /^[A-Za-z]:/.test(normalized) ? 'file:///' : 'file://'
  return `${prefix}${encodeURI(normalized)}`
}
