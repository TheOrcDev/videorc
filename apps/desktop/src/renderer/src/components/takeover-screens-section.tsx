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

import { Gallery } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStudioCore } from '@/hooks/use-studio'
import type { StreamScreen } from '@/lib/backend'

// Takeover-image manager (upload/rename/reorder/delete). Lives on the Assets
// page: the active takeover is global session state, not scene content — it
// replaces the output regardless of scene, so the old Scene-page home was wrong
// on its own terms.
export function TakeoverScreensSection(): ReactElement {
  const {
    activeScreen,
    deleteScreen,
    importScreenImage,
    isSessionActive,
    moveScreen,
    renameScreen,
    screenImportPending,
    screens,
    wsStatus
  } = useStudioCore()
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
      description="Full-frame images that cover the output — flip them on from the Studio session panel. Management is locked while a session is live."
      icon={ImageSquare}
      title="Takeover screens"
    >
      {screens.length === 0 ? (
        <Empty className="py-12">
          <EmptyMedia variant="icon">
            <ImageSquare weight="duotone" />
          </EmptyMedia>
          <EmptyTitle>No takeovers yet</EmptyTitle>
          <EmptyDescription>
            Upload a PNG, JPEG, or WebP image to create the first takeover.
          </EmptyDescription>
        </Empty>
      ) : (
        // Bounded section: the grid scrolls inside the Assets page stack.
        <ScrollArea className="max-h-[28rem] overflow-y-auto pr-3">
          <Gallery className="gap-3">
            {screens.map((screen, index) => (
              <ScreenTile
                active={activeScreen?.id === screen.id}
                disabled={managementDisabled}
                index={index}
                key={screen.id}
                screen={screen}
                total={screens.length}
                onDelete={() => void deleteScreen(screen.id)}
                onMove={(direction) => void moveScreen(screen.id, direction)}
                onRename={(name) => void renameScreen(screen.id, name)}
              />
            ))}
          </Gallery>
        </ScrollArea>
      )}
    </PanelSection>
  )
}

function ScreenTile({
  screen,
  active,
  disabled,
  index,
  total,
  onDelete,
  onMove,
  onRename
}: {
  screen: StreamScreen
  active: boolean
  disabled: boolean
  index: number
  total: number
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
    <div className="flex min-w-0 flex-col overflow-hidden rounded-row border bg-background">
      <div className="relative aspect-[4/3] bg-muted">
        {!missing ? (
          <img
            alt=""
            className="size-full object-cover"
            src={managedScreenAssetUrl(screen.imagePath)}
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
            aria-label="Takeover name"
            disabled={disabled}
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
          />
          <Button
            aria-label="Save takeover name"
            disabled={disabled || !nameChanged || !nameDraft.trim()}
            size="icon"
            title="Save takeover name"
            type="submit"
            variant="outline"
          >
            <FloppyDisk />
          </Button>
        </div>
        <span className="truncate text-xs text-muted-foreground">{screen.imagePath}</span>
        {/* Activation lives in the Studio session panel (one home per control);
            tiles are management only — the Active badge still reports state. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <Button
            aria-label="Move takeover up"
            disabled={disabled || index === 0}
            size="icon-sm"
            title="Move takeover up"
            type="button"
            variant="outline"
            onClick={() => onMove(-1)}
          >
            <ArrowUp />
          </Button>
          <Button
            aria-label="Move takeover down"
            disabled={disabled || index === total - 1}
            size="icon-sm"
            title="Move takeover down"
            type="button"
            variant="outline"
            onClick={() => onMove(1)}
          >
            <ArrowDown />
          </Button>
          <Button
            aria-label="Delete takeover"
            className="ml-auto"
            disabled={disabled}
            size="icon-sm"
            title="Delete takeover"
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

// Raw file:// subresource loads are blocked by the renderer origin, so every
// card errored and read "Missing" while the upload sat safely in app storage.
// The managed videorc-asset://screen host serves the Screens dir by basename.
function managedScreenAssetUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1)
  return `videorc-asset://screen/${encodeURIComponent(basename)}`
}
