import {
  ArrowDown,
  ArrowUp,
  FloppyDisk,
  ImageBroken,
  ImageSquare,
  Trash,
  UploadSimple
} from '@phosphor-icons/react'
import { useEffect, useState, type ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStudio } from '@/hooks/use-studio'
import type { StreamScreen } from '@/lib/backend'

export function ScreensTab(): ReactElement {
  const {
    activeScreen,
    activateScreen,
    clearActiveScreen,
    deleteScreen,
    importScreenImage,
    isSessionActive,
    moveScreen,
    renameScreen,
    screenImportPending,
    screens,
    wsStatus
  } = useStudio()
  const managementDisabled = isSessionActive || wsStatus !== 'connected'
  const uploadDisabled = managementDisabled || screenImportPending

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
          <EmptyDescription>
            Upload a PNG, JPEG, or WebP image to create the first Screen.
          </EmptyDescription>
        </Empty>
      ) : (
        // Bounded section: this grid lives inside the Scene page now.
        <ScrollArea className="max-h-[28rem] overflow-y-auto pr-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {screens.map((screen, index) => (
              <ScreenTile
                active={activeScreen?.id === screen.id}
                activationDisabled={wsStatus !== 'connected'}
                disabled={managementDisabled}
                index={index}
                key={screen.id}
                screen={screen}
                total={screens.length}
                onActivate={() =>
                  void (activeScreen?.id === screen.id
                    ? clearActiveScreen()
                    : activateScreen(screen.id))
                }
                onDelete={() => void deleteScreen(screen.id)}
                onMove={(direction) => void moveScreen(screen.id, direction)}
                onRename={(name) => void renameScreen(screen.id, name)}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </PanelSection>
  )
}

function ScreenTile({
  screen,
  active,
  activationDisabled,
  disabled,
  index,
  total,
  onActivate,
  onDelete,
  onMove,
  onRename
}: {
  screen: StreamScreen
  active: boolean
  activationDisabled: boolean
  disabled: boolean
  index: number
  total: number
  onActivate: () => void
  onDelete: () => void
  onMove: (direction: -1 | 1) => void
  onRename: (name: string) => void
}): ReactElement {
  const [imageFailed, setImageFailed] = useState(false)
  const [nameDraft, setNameDraft] = useState(screen.name)
  const missing = screen.status === 'missing' || imageFailed
  const nameChanged = nameDraft.trim() !== screen.name

  useEffect(() => {
    setNameDraft(screen.name)
  }, [screen.name])

  const saveName = (): void => {
    const nextName = nameDraft.trim()
    if (!nextName || nextName === screen.name) {
      setNameDraft(screen.name)
      return
    }
    onRename(nextName)
  }

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
        {active ? (
          <Badge className="absolute left-2 top-2" variant="warning">
            Active
          </Badge>
        ) : null}
      </div>
      <form
        className="flex min-w-0 flex-col gap-2 p-3"
        onSubmit={(event) => {
          event.preventDefault()
          saveName()
        }}
      >
        <div className="flex min-w-0 gap-2">
          <Input
            aria-label="Screen name"
            disabled={disabled}
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
          />
          <Button
            aria-label="Save Screen name"
            disabled={disabled || !nameChanged || !nameDraft.trim()}
            size="icon"
            title="Save Screen name"
            type="submit"
            variant="outline"
          >
            <FloppyDisk />
          </Button>
        </div>
        <span className="truncate text-xs text-muted-foreground">{screen.imagePath}</span>
        <div className="flex items-center gap-2">
          <Button
            disabled={activationDisabled || missing}
            type="button"
            variant={active ? 'default' : 'secondary'}
            onClick={onActivate}
          >
            <ImageSquare data-icon="inline-start" weight="duotone" />
            {active ? 'Active' : 'Activate'}
          </Button>
          <Button
            aria-label="Move Screen up"
            disabled={disabled || index === 0}
            size="icon"
            title="Move Screen up"
            type="button"
            variant="outline"
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            aria-label="Move Screen down"
            disabled={disabled || index === total - 1}
            size="icon"
            title="Move Screen down"
            type="button"
            variant="outline"
            onClick={() => onMove(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            aria-label="Delete Screen"
            className="ml-auto"
            disabled={disabled}
            size="icon"
            title="Delete Screen"
            type="button"
            variant="destructive"
            onClick={onDelete}
          >
            <Trash />
          </Button>
        </div>
      </form>
    </div>
  )
}

function fileUrlFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const prefix = /^[A-Za-z]:/.test(normalized) ? 'file:///' : 'file://'
  return `${prefix}${encodeURI(normalized)}`
}
