import { Spinner } from '@/components/ui/spinner'
import { DisabledReason } from '@/components/ui/disabled-reason'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  DeleteIcon,
  EditIcon,
  ImageIcon,
  LivestreamIcon,
  SceneIcon
} from '@/components/icons'
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement } from 'react'

import { BannerThumbnail } from '@/components/banner-thumbnail'
import { BannerTimingChip } from '@/components/banner-timing-chip'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { KebabMenu, type KebabMenuItem } from '@/components/kebab-menu'
import { OfflineAlert } from '@/components/lock-alert'
import { MediaCard } from '@/components/media-card'
import { Gallery } from '@/components/page'
import { PanelSection } from '@/components/panel-section'
import { IN_USE_RING, InUseChip } from '@/components/takeover-screens-section'
import { useWorkspaceNav } from '@/components/workspace-nav'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyTitle } from '@/components/ui/empty'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useStudioBanners } from '@/hooks/use-studio'
import { BANNER_MAX_SHOWN, type Banner } from '@/lib/backend'
import {
  BANNER_SHOWN_LIMIT_REASON,
  bannerImportBlockedReason,
  bannerImportLabel,
  bannerOrderAfterMove
} from '@/lib/banners'
import { shortcutLabel } from '@/lib/platform'
import {
  MOVE_EARLIER_ACCELERATOR,
  MOVE_LATER_ACCELERATOR,
  takeoverMoveKeyStep,
  takeoverMoveTarget
} from '@/lib/takeover-order'
import { cn } from '@/lib/utils'

/** The section's rules: what a banner is for, and the sizes that stay sharp (plan 186 D8). */
export const BANNERS_DESCRIPTION =
  'Images you place on your picture: a sponsor, your socials, a logo. PNG with transparency works best. Sharp sizes: wide banner 2400 × 400, logo 512 × 512, full frame 3840 × 2160.'

/** A banner's name is the file stem, trimmed to this many characters (plan 186). */
const BANNER_NAME_MAX_CHARS = 40

/**
 * Assets → Banners (plan 186 S5): the one home that imports, renames, orders
 * and deletes banners. The Scene page places them and shows or hides them;
 * Show / Hide and Place on Scene here are shortcuts to the same state. None of
 * it waits for a session to end: a banner changes live (D9), and the backend
 * refuses only the delete of a banner that is showing while you record or are
 * live, with its own sentence. The order is also the drawing order: later is
 * on top.
 */
export function BannersSection(): ReactElement {
  const {
    banners,
    bannersLoaded,
    bannersOffline,
    bannerImportPhase,
    importBanner,
    updateBanner,
    reorderBanners,
    deleteBanner,
    toggleBanner,
    selectBanner
  } = useStudioBanners()
  const { openStudioPanel } = useWorkspaceNav()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  // The delete question keeps its banner while it closes, so the sentence
  // never empties mid-fade; `deletePending` holds it up while the delete runs.
  const [deleteTarget, setDeleteTarget] = useState<Banner | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deletePending, setDeletePending] = useState(false)
  const importReason = bannerImportBlockedReason({
    offline: bannersOffline,
    phase: bannerImportPhase,
    count: banners.length
  })
  const shownCount = banners.filter((banner) => banner.shown).length

  const moveTo = (banner: Banner, targetIndex: number): void => {
    const ids = bannerOrderAfterMove(banners, banner.id, targetIndex)
    if (ids) void reorderBanners(ids)
  }

  const importButton = (testId: string): ReactElement => (
    <DisabledReason reason={importReason}>
      <Button
        data-testid={testId}
        disabled={importReason !== null}
        variant="outline"
        onClick={() => void importBanner()}
      >
        {bannerImportPhase !== 'idle' ? (
          <Spinner aria-hidden data-icon="inline-start" />
        ) : (
          <ImageIcon data-icon="inline-start" />
        )}
        {bannerImportLabel(bannerImportPhase)}
      </Button>
    </DisabledReason>
  )

  return (
    <>
      <PanelSection
        action={importButton('banner-import')}
        description={BANNERS_DESCRIPTION}
        icon={ImageIcon}
        title="Banners"
      >
        {bannersOffline ? <OfflineAlert /> : null}
        {banners.length > 0 ? (
          // Bounded like Takeovers: the grid scrolls inside the Assets page,
          // and the padding keeps the Showing rim inside the scroll clip.
          <ScrollArea className="max-h-[28rem] overflow-y-auto pr-3">
            <Gallery className="gap-3 p-0.5">
              {banners.map((banner, index) => (
                <BannerTile
                  banner={banner}
                  canMoveEarlier={takeoverMoveTarget(index, -1, banners.length) !== null}
                  canMoveLater={takeoverMoveTarget(index, 1, banners.length) !== null}
                  disabled={bannersOffline}
                  dragging={draggingId === banner.id}
                  dropTarget={dropIndex === index && draggingId !== banner.id}
                  key={banner.id}
                  renaming={renamingId === banner.id}
                  showLimitReached={shownCount >= BANNER_MAX_SHOWN}
                  onCancelRename={() => setRenamingId(null)}
                  onDelete={() => {
                    setDeleteTarget(banner)
                    setDeleteOpen(true)
                  }}
                  onDragEnd={() => {
                    setDraggingId(null)
                    setDropIndex(null)
                  }}
                  onDragEnter={() => {
                    if (draggingId && draggingId !== banner.id) setDropIndex(index)
                  }}
                  onDragStart={() => setDraggingId(banner.id)}
                  onDrop={() => {
                    const dragged = banners.find((item) => item.id === draggingId)
                    if (dragged && dragged.id !== banner.id) moveTo(dragged, index)
                    setDraggingId(null)
                    setDropIndex(null)
                  }}
                  onMove={(step) => {
                    const target = takeoverMoveTarget(index, step, banners.length)
                    if (target !== null) moveTo(banner, target)
                  }}
                  onPlace={() => {
                    // The Scene page opens with this banner selected on its stage.
                    selectBanner(banner.id)
                    openStudioPanel('layouts')
                  }}
                  onRename={(name) => {
                    setRenamingId(null)
                    const next = name.trim()
                    if (next && next !== banner.name) void updateBanner(banner.id, { name: next })
                  }}
                  onStartRename={() => setRenamingId(banner.id)}
                  onToggle={() => void toggleBanner(banner.id)}
                />
              ))}
            </Gallery>
          </ScrollArea>
        ) : !bannersLoaded ? (
          // Never "No banners yet" before the list is known (J2-8). Offline,
          // the alert above already says why.
          bannersOffline ? null : (
            <Empty className="py-12" data-videorc-banners-loading="">
              <EmptyTitle>Loading banners…</EmptyTitle>
            </Empty>
          )
        ) : (
          <Empty className="py-12" data-videorc-banners-empty="">
            <EmptyTitle>No banners yet</EmptyTitle>
            <EmptyContent>{importButton('banner-import-empty')}</EmptyContent>
          </Empty>
        )}
      </PanelSection>
      <ConfirmDialog
        confirmDisabled={deletePending}
        confirmLabel={deletePending ? 'Deleting…' : 'Delete banner'}
        cancelDisabled={deletePending}
        description={`“${deleteTarget?.name ?? ''}” and its image will be deleted. This can't be undone.`}
        open={deleteOpen}
        testId="banner-delete"
        title="Delete banner?"
        onCancel={() => {
          if (!deletePending) setDeleteOpen(false)
        }}
        onConfirm={() => {
          if (!deleteTarget || deletePending) return
          setDeletePending(true)
          // A refusal ("Hide this banner before you delete it.") is a warning
          // toast from the hook; either way the question closes.
          void deleteBanner(deleteTarget.id).finally(() => {
            setDeletePending(false)
            setDeleteOpen(false)
          })
        }}
      />
    </>
  )
}

function BannerTile({
  banner,
  canMoveEarlier,
  canMoveLater,
  disabled,
  dragging,
  dropTarget,
  renaming,
  showLimitReached,
  onCancelRename,
  onDelete,
  onDragEnd,
  onDragEnter,
  onDragStart,
  onDrop,
  onMove,
  onPlace,
  onRename,
  onStartRename,
  onToggle
}: {
  banner: Banner
  canMoveEarlier: boolean
  canMoveLater: boolean
  /** Videorc is reconnecting: the section's alert says so, and nothing here acts. */
  disabled: boolean
  dragging: boolean
  dropTarget: boolean
  renaming: boolean
  /** Four banners are showing: this one can't join them until one hides. */
  showLimitReached: boolean
  onCancelRename: () => void
  onDelete: () => void
  onDragEnd: () => void
  onDragEnter: () => void
  onDragStart: () => void
  onDrop: () => void
  onMove: (step: -1 | 1) => void
  onPlace: () => void
  onRename: (name: string) => void
  onStartRename: () => void
  onToggle: () => void
}): ReactElement {
  // Escape cancels; the blur that follows must not save the draft.
  const renameCanceled = useRef(false)
  const draggable = !disabled && !renaming
  const showBlocked = !banner.shown && showLimitReached

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

  const items: KebabMenuItem[] = [
    {
      id: 'show',
      label: banner.shown ? 'Hide' : 'Show',
      icon: LivestreamIcon,
      group: 'use',
      disabled: showBlocked,
      disabledReason: showBlocked ? BANNER_SHOWN_LIMIT_REASON : null,
      onSelect: onToggle
    },
    { id: 'place', label: 'Place on Scene', icon: SceneIcon, group: 'use', onSelect: onPlace },
    { id: 'rename', label: 'Rename…', icon: EditIcon, group: 'edit', onSelect: onStartRename },
    {
      id: 'move-earlier',
      label: 'Move earlier',
      icon: ArrowLeftIcon,
      group: 'order',
      disabled: !canMoveEarlier,
      disabledReason: canMoveEarlier ? null : 'This banner is already first.',
      shortcut: shortcutLabel(MOVE_EARLIER_ACCELERATOR),
      onSelect: () => onMove(-1)
    },
    {
      id: 'move-later',
      label: 'Move later',
      icon: ArrowRightIcon,
      group: 'order',
      disabled: !canMoveLater,
      disabledReason: canMoveLater ? null : 'This banner is already last.',
      shortcut: shortcutLabel(MOVE_LATER_ACCELERATOR),
      onSelect: () => onMove(1)
    },
    { id: 'delete', label: 'Delete…', icon: DeleteIcon, destructive: true, onSelect: onDelete }
  ]

  return (
    <MediaCard
      className={cn(
        // `group/kebab-host`: the ⋯ shows on hover and while the tile holds focus.
        'group/kebab-host gap-1.5 p-1.5 transition-opacity',
        draggable && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-40',
        banner.shown && IN_USE_RING,
        dropTarget && 'ring-2 ring-ring'
      )}
      data-shown={banner.shown || undefined}
      data-videorc-banner-tile={banner.id}
      draggable={draggable}
      selected={banner.shown}
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
      {/* The output's own 16:9 box, the image contained in it: a 6:1 strip
          stays a strip, a logo stays square, never cropped. The timer's one
          line sits on its corner, like a takeover's In use. */}
      <div className="relative">
        <BannerThumbnail banner={banner} className="aspect-video rounded-chip" />
        <BannerTimingChip
          banner={banner}
          className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)]"
        />
      </div>
      <div className="flex min-h-7 min-w-0 items-center gap-1.5 pl-1">
        {renaming ? (
          <Input
            autoFocus
            aria-label={`Rename ${banner.name}`}
            defaultValue={banner.name}
            maxLength={BANNER_NAME_MAX_CHARS}
            onBlur={(event) => {
              if (renameCanceled.current) {
                renameCanceled.current = false
                return
              }
              onRename(event.currentTarget.value)
            }}
            onFocus={() => {
              renameCanceled.current = false
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                event.preventDefault()
                renameCanceled.current = true
                onCancelRename()
              }
            }}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {banner.name}
          </span>
        )}
        {banner.shown ? <InUseChip className="shrink-0" label="Showing" /> : null}
        {/* Out while renaming: the closing menu would hand focus back to
            its ⋯ and blur the name field the moment it opens. */}
        {renaming ? null : (
          <KebabMenu
            className="shrink-0"
            disabled={disabled}
            items={items}
            label={`Actions for ${banner.name}`}
            reveal="hover"
          />
        )}
      </div>
    </MediaCard>
  )
}
