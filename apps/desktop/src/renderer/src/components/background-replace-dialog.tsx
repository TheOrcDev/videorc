import { useRef, useState, type KeyboardEvent, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  slotAsset,
  type BackgroundAsset,
  type BackgroundAssetRegistry
} from '@/lib/background-assets'
import { backgroundAssetDisplayUrl, slotDisplayStatus, slotName } from '@/lib/background-library'

// "Replace which background?" (plan 174, C-2 and D14). Every fresh profile has
// all ten slots filled with presets, so Import used to fail with "All preset
// slots are full". Now the picked image waits here while the streamer
// chooses the background it replaces; nothing changes until Replace.

/** An imported image waiting for the slot it replaces. */
export type PendingBackgroundReplace = { asset: BackgroundAsset; preselectedSlotId: string }

/** Radio-group arrow keys: the next, previous, first or last tile; null for any other key. */
export function radioStep(index: number, count: number, key: string): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

export function BackgroundReplaceDialog({
  pending,
  registry,
  onReplace,
  onCancel
}: {
  pending: PendingBackgroundReplace | null
  registry: BackgroundAssetRegistry
  onReplace: (slotId: string, asset: BackgroundAsset) => void
  onCancel: () => void
}): ReactElement {
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent size="xl">
        {pending ? (
          <ReplacePicker
            key={pending.asset.id}
            pending={pending}
            registry={registry}
            onCancel={onCancel}
            onReplace={onReplace}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function ReplacePicker({
  pending,
  registry,
  onReplace,
  onCancel
}: {
  pending: PendingBackgroundReplace
  registry: BackgroundAssetRegistry
  onReplace: (slotId: string, asset: BackgroundAsset) => void
  onCancel: () => void
}): ReactElement {
  const [chosenSlotId, setChosenSlotId] = useState(pending.preselectedSlotId)
  const tiles = useRef(new Map<string, HTMLButtonElement>())
  const chosen = registry.slots.find((slot) => slot.id === chosenSlotId) ?? null
  const choose = (slotId: string): void => {
    setChosenSlotId(slotId)
    tiles.current.get(slotId)?.focus()
  }
  const onTileKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = radioStep(index, registry.slots.length, event.key)
    if (next === null) return
    event.preventDefault()
    choose(registry.slots[next]!.id)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Replace which background?</DialogTitle>
        <DialogDescription>
          All ten slots are in use, so &quot;{pending.asset.name}&quot; takes the place of the one
          you pick.
        </DialogDescription>
      </DialogHeader>
      <div aria-label="Backgrounds" className="grid grid-cols-5 gap-2" role="radiogroup">
        {registry.slots.map((slot, index) => {
          const asset = slotAsset(slot, registry)
          const image = asset?.thumbnailPath ?? asset?.assetPath
          const checked = slot.id === chosenSlotId
          const name = slotName(slot, registry)
          return (
            <button
              aria-checked={checked}
              className="relative flex aspect-video items-end overflow-hidden rounded-row border border-border text-left outline-none hover:border-foreground/30 focus-visible:ring-3 focus-visible:ring-ring/30 aria-checked:border-transparent aria-checked:ring-2 aria-checked:ring-ring"
              data-background-slot={slot.id}
              key={slot.id}
              ref={(element) => {
                if (element) tiles.current.set(slot.id, element)
                else tiles.current.delete(slot.id)
              }}
              role="radio"
              tabIndex={checked ? 0 : -1}
              type="button"
              onClick={() => choose(slot.id)}
              onKeyDown={(event) => onTileKeyDown(event, index)}
            >
              {image && slotDisplayStatus(slot, registry) !== 'missing-file' ? (
                <img
                  alt=""
                  className="absolute inset-0 size-full object-cover"
                  draggable={false}
                  src={backgroundAssetDisplayUrl(image)}
                />
              ) : (
                <span className="absolute inset-0 bg-muted/30" />
              )}
              <span className="relative w-full truncate bg-gradient-to-t from-background/95 via-background/70 to-transparent px-1.5 pt-3 pb-1 text-xs font-medium">
                {name}
              </span>
            </button>
          )
        })}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={!chosen}
          type="button"
          onClick={() => {
            if (chosen) onReplace(chosen.id, pending.asset)
          }}
        >
          Replace {chosen ? slotName(chosen, registry) : 'background'}
        </Button>
      </DialogFooter>
    </>
  )
}
