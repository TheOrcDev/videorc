import { Alert, AlertDescription } from '@/components/ui/alert'
import { Spinner } from '@/components/ui/spinner'
import { DisabledReason } from '@/components/ui/disabled-reason'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  DeleteIcon,
  FrameIcon,
  ImageBrokenIcon,
  ImageIcon,
  SaveIcon
} from '@/components/icons'
import { useEffect, useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { OfflineAlert } from '@/components/lock-alert'
import { Gallery } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { useStudioCore } from '@/hooks/use-studio'
import type { StreamScreen } from '@/lib/backend'
import { MediaCard } from '@/components/media-card'
import {
  MOVE_EARLIER_ACCELERATOR,
  MOVE_LATER_ACCELERATOR,
  takeoverMoveKeyStep,
  takeoverMoveTarget
} from '@/lib/takeover-order'
import { shortcutAriaKeys } from '@/lib/platform'
import { cn } from '@/lib/utils'

/**
 * The one "in use" look for a picture on Assets (plan 174 C-25): a rim and a
 * neutral chip, the same for the background on the scene and the takeover on
 * the output. Never a colour: in use is not a status.
 */
export const IN_USE_RING = 'ring-2 ring-foreground/60'

export function InUseChip({ className }: { className?: string }): ReactElement {
  return (
    <Badge className={className} data-videorc-in-use="">
      In use
    </Badge>
  )
}

// Takeover-image manager (import/rename/reorder/delete). Lives on the Assets
// page: the active takeover is global session state, not scene content — it
// replaces the output regardless of scene, so the old Scene-page home was wrong
// on its own terms. Ordering is drag-and-drop (owner request 2026-07-13) and,
// since plan 174 S3.10, Move earlier / Move later and Alt+← / Alt+→: the
// backend applies the full order atomically via screens.reorder.
export function TakeoverScreensSection(): ReactElement {
  const {
    activeScreen,
    deleteScreen,
    importScreenImage,
    isSessionActive,
    reorderScreen,
    renameScreen,
    runtimeInfo,
    screenImportPending,
    screenImportPhase,
    screens,
    screensLoaded,
    wsStatus
  } = useStudioCore()
  const offline = wsStatus !== 'connected'
  const managementDisabled = isSessionActive || offline
  const importDisabled = offline || screenImportPending
  const managementReason = offline
    ? 'Videorc is reconnecting. Try again in a moment.'
    : isSessionActive
      ? 'Stop recording or end the livestream to rename, reorder or delete takeovers.'
      : null
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  // Plan 174 S0.3 (C-1): a delete removes the image file too, so it asks.
  const [deleting, setDeleting] = useState<StreamScreen | null>(null)

  return (
    <>
      <PanelSection
        action={
          <DisabledReason
            reason={
              offline
                ? managementReason
                : screenImportPending
                  ? 'Wait for this import to finish.'
                  : null
            }
          >
            <Button
              data-testid="takeover-import"
              disabled={importDisabled}
              variant="outline"
              onClick={() => void importScreenImage()}
            >
              {screenImportPending ? (
                <Spinner aria-hidden data-icon="inline-start" />
              ) : (
                <ImageIcon data-icon="inline-start" />
              )}
              {screenImportPhase === 'choosing'
                ? 'Choosing image…'
                : screenImportPending
                  ? 'Importing…'
                  : 'Import image…'}
            </Button>
          </DisabledReason>
        }
        description="Full-frame images that cover the output, turned on from the Studio. Turning one on mutes your microphone until you turn it off."
        icon={FrameIcon}
        title="Takeovers"
      >
        {offline ? (
          <OfflineAlert />
        ) : isSessionActive ? (
          <Alert variant="quiet">
            <AlertDescription>
              You can import images now. Stop recording or end the livestream to rename, reorder or
              delete takeovers.
            </AlertDescription>
          </Alert>
        ) : null}
        {screens.length > 0 ? (
          // Bounded section: the grid scrolls inside the Assets page stack.
          // The padding keeps the in-use rim inside the scroll area's clip.
          <ScrollArea className="max-h-[28rem] overflow-y-auto pr-3">
            <Gallery className="gap-3 p-0.5">
              {screens.map((screen, index) => (
                <ScreenTile
                  active={activeScreen?.id === screen.id}
                  canMoveEarlier={takeoverMoveTarget(index, -1, screens.length) !== null}
                  canMoveLater={takeoverMoveTarget(index, 1, screens.length) !== null}
                  disabled={managementDisabled}
                  disabledReason={managementReason}
                  dragging={draggingId === screen.id}
                  dropTarget={dropIndex === index && draggingId !== screen.id}
                  key={screen.id}
                  platform={runtimeInfo?.platform}
                  screen={screen}
                  onDelete={() => setDeleting(screen)}
                  onDragEnd={() => {
                    setDraggingId(null)
                    setDropIndex(null)
                  }}
                  onDragEnter={() => {
                    if (draggingId && draggingId !== screen.id) {
                      setDropIndex(index)
                    }
                  }}
                  onDragStart={() => setDraggingId(screen.id)}
                  onDrop={() => {
                    if (draggingId && draggingId !== screen.id) {
                      void reorderScreen(draggingId, index)
                    }
                    setDraggingId(null)
                    setDropIndex(null)
                  }}
                  onMove={(step) => {
                    const target = takeoverMoveTarget(index, step, screens.length)
                    if (target !== null) void reorderScreen(screen.id, target)
                  }}
                  onRename={(name) => void renameScreen(screen.id, name)}
                />
              ))}
            </Gallery>
          </ScrollArea>
        ) : !screensLoaded ? (
          // Never "No takeovers yet" before the list is known (J2-8). Offline,
          // the alert above already says why.
          offline ? null : (
            <Empty className="py-12" data-videorc-takeovers-loading="">
              <EmptyTitle>Loading takeovers…</EmptyTitle>
            </Empty>
          )
        ) : (
          <Empty className="py-12">
            <EmptyTitle>No takeovers yet</EmptyTitle>
            <EmptyDescription>
              Import a PNG, JPEG or WebP image to make the first one.
            </EmptyDescription>
          </Empty>
        )}
      </PanelSection>
      <ConfirmDialog
        confirmLabel="Delete takeover"
        description="Its image file is deleted from this computer."
        open={deleting !== null}
        testId="takeover-delete"
        title={`Delete ${deleting?.name ?? 'takeover'}?`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) void deleteScreen(deleting.id)
          setDeleting(null)
        }}
      />
    </>
  )
}

function ScreenTile({
  screen,
  active,
  canMoveEarlier,
  canMoveLater,
  disabled,
  disabledReason,
  dragging,
  dropTarget,
  platform,
  onDelete,
  onDragEnd,
  onDragEnter,
  onDragStart,
  onDrop,
  onMove,
  onRename
}: {
  screen: StreamScreen
  active: boolean
  canMoveEarlier: boolean
  canMoveLater: boolean
  disabled: boolean
  disabledReason: string | null
  dragging: boolean
  dropTarget: boolean
  platform?: string
  onDelete: () => void
  onDragEnd: () => void
  onDragEnter: () => void
  onDragStart: () => void
  onDrop: () => void
  onMove: (step: -1 | 1) => void
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

  const moveFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    const target = event.target as HTMLElement
    const step = takeoverMoveKeyStep({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      inTextField: target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
    })
    if (step === null || (step < 0 ? !canMoveEarlier : !canMoveLater)) return
    event.preventDefault()
    onMove(step)
  }

  return (
    <MediaCard
      className={cn(
        'overflow-hidden transition-opacity',
        !disabled && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40',
        active && IN_USE_RING,
        dropTarget && 'ring-2 ring-ring'
      )}
      data-videorc-takeover-tile={screen.id}
      draggable={!disabled}
      selected={active}
      onDragEnd={onDragEnd}
      onDragEnter={onDragEnter}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        // Allow this tile to be a drop target.
        event.preventDefault()
      }}
      onDragStart={(event: DragEvent<HTMLDivElement>) => {
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        onDrop()
      }}
      onKeyDown={moveFromKeyboard}
    >
      {/* The output's own shape (C-25): a 16:9 preview, not 4:3. */}
      <div className="relative aspect-video bg-muted">
        {!missing ? (
          <img
            alt=""
            className="size-full object-cover"
            draggable={false}
            src={managedScreenAssetUrl(screen.imagePath)}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <ImageBrokenIcon className="size-8" weight="duotone" />
          </div>
        )}
        {/* Only news earns a badge: a healthy tile says nothing (C-25). */}
        {missing ? (
          <Badge className="absolute top-2 right-2" variant="warning">
            Missing
          </Badge>
        ) : null}
        {active ? <InUseChip className="absolute top-2 left-2" /> : null}
      </div>
      <form
        aria-describedby={disabledReason ? `takeover-management-${screen.id}` : undefined}
        className="flex min-w-0 flex-col gap-2 p-3"
        onSubmit={(event) => {
          event.preventDefault()
          saveName()
        }}
      >
        {disabledReason ? (
          <span id={`takeover-management-${screen.id}`} className="sr-only">
            {disabledReason}
          </span>
        ) : null}
        <div className="flex min-w-0 gap-2">
          <DisabledReason reason={disabledReason} className="min-w-0 flex-1">
            <Input
              aria-label="Takeover name"
              aria-describedby={disabledReason ? `takeover-management-${screen.id}` : undefined}
              disabled={disabled}
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
            />
          </DisabledReason>
          <DisabledReason reason={disabledReason}>
            <ShortcutTooltip label="Save takeover name" platform={platform}>
              <Button
                aria-label="Save takeover name"
                disabled={disabled || !nameChanged || !nameDraft.trim()}
                size="icon"
                type="submit"
                variant="outline"
              >
                <SaveIcon />
              </Button>
            </ShortcutTooltip>
          </DisabledReason>
        </div>
        {/* Activation lives in the Studio session panel (one home per control);
            tiles are management only. The order moves by drag, by these
            buttons, or by Alt+arrow while the tile holds focus. */}
        <div className="flex min-w-0 items-center gap-1">
          <DisabledReason reason={disabledReason}>
            <ShortcutTooltip
              accelerator={MOVE_EARLIER_ACCELERATOR}
              label="Move earlier"
              platform={platform}
            >
              <Button
                aria-keyshortcuts={shortcutAriaKeys(MOVE_EARLIER_ACCELERATOR, platform)}
                aria-label="Move earlier"
                disabled={disabled || !canMoveEarlier}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() => onMove(-1)}
              >
                <ArrowLeftIcon />
              </Button>
            </ShortcutTooltip>
          </DisabledReason>
          <DisabledReason reason={disabledReason}>
            <ShortcutTooltip
              accelerator={MOVE_LATER_ACCELERATOR}
              label="Move later"
              platform={platform}
            >
              <Button
                aria-keyshortcuts={shortcutAriaKeys(MOVE_LATER_ACCELERATOR, platform)}
                aria-label="Move later"
                disabled={disabled || !canMoveLater}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() => onMove(1)}
              >
                <ArrowRightIcon />
              </Button>
            </ShortcutTooltip>
          </DisabledReason>
          <DisabledReason reason={disabledReason}>
            <ShortcutTooltip label="Delete takeover" platform={platform}>
              <Button
                aria-label="Delete takeover"
                className="ml-auto"
                aria-describedby={disabledReason ? `takeover-management-${screen.id}` : undefined}
                disabled={disabled}
                size="icon"
                type="button"
                variant="destructive"
                onClick={onDelete}
              >
                <DeleteIcon />
              </Button>
            </ShortcutTooltip>
          </DisabledReason>
        </div>
      </form>
    </MediaCard>
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
