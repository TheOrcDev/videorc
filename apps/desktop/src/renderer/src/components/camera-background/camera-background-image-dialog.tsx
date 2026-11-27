import type { ReactElement } from 'react'

import { CameraBackgroundTiles } from '@/components/camera-background/camera-background-tiles'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Empty } from '@/components/ui/empty'
import type { CameraBackgroundChoice, CameraBackgroundChoiceId } from '@/lib/camera-background-view'
import { openWorkspaceTab } from '@/lib/workspace-navigation'

/**
 * Choose image… (plan 258 UX): every picture in the Images library as a
 * tile. A pick applies at once and closes; Open Images is where pictures
 * are added and removed (the library is the one home of the pictures).
 */
export function CameraBackgroundImageDialog({
  open,
  onOpenChange,
  choices,
  selected,
  reason,
  onChoose
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The picture choices only. */
  choices: CameraBackgroundChoice[]
  selected: CameraBackgroundChoiceId | null
  reason: string | null
  onChoose: (choice: CameraBackgroundChoiceId) => void
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-videorc-camera-background-image-dialog="" size="lg">
        <DialogHeader>
          <DialogTitle>Choose an image</DialogTitle>
          <DialogDescription>It shows behind you on this camera, in every scene.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {choices.length > 0 ? (
            <CameraBackgroundTiles
              choices={choices}
              label="Images"
              reason={reason}
              selected={selected}
              onChoose={(choice) => {
                onChoose(choice)
                onOpenChange(false)
              }}
            />
          ) : (
            <Empty>No images yet. Add one in Images.</Empty>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false)
              openWorkspaceTab('assets')
            }}
          >
            Open Images
          </Button>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
