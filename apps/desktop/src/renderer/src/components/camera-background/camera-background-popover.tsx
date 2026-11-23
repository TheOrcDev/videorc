import { lazy, Suspense, useState, type ReactElement } from 'react'

import {
  CameraBackgroundArt,
  choiceArt
} from '@/components/camera-background/camera-background-art'
import type { CameraBackgroundControl } from '@/components/camera-background/use-camera-background'
import { ChevronDownIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  CAMERA_BACKGROUND_LABEL,
  type CameraBackgroundChoiceId
} from '@/lib/camera-background-view'
import { openSceneBackground } from '@/lib/green-screen'

/** The art of the camera's current pick, for the trigger. */
export function currentArt(control: CameraBackgroundControl) {
  return choiceArt({ id: control.choiceId ?? 'off', picture: control.picture })
}

/** The picker's body and Choose image…, loaded on first use (launch bundle budget). */
export const LazyCameraBackgroundPicker = lazy(() =>
  import('@/components/camera-background/camera-background-picker').then((module) => ({
    default: module.CameraBackgroundPicker
  }))
)
export const LazyCameraBackgroundImageDialog = lazy(() =>
  import('@/components/camera-background/camera-background-image-dialog').then((module) => ({
    default: module.CameraBackgroundImageDialog
  }))
)

/**
 * Plan 258 S5: the Studio Camera row's Background line (mockup §1). Plan
 * 248's segmented Green screen line became one select-like trigger,
 * "Background · Strong blur" with a small picture of the pick, opening the
 * picker on the popup tier. A pick applies at once and the stage confirms
 * it, so no toast. One height whatever is picked, so nothing below moves.
 */
export function CameraBackgroundLine({
  control
}: {
  control: CameraBackgroundControl
}): ReactElement | null {
  const [open, setOpen] = useState(false)
  const [choosingImage, setChoosingImage] = useState(false)
  if (!control.available) return null
  const choose = (choice: CameraBackgroundChoiceId): void => control.choose(choice)
  return (
    <div
      className="flex min-h-8 items-center pr-1 pb-2 pl-9.5"
      data-mode={control.background.mode}
      data-slot="camera-background"
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              aria-label={`${CAMERA_BACKGROUND_LABEL}: ${control.valueLabel}`}
              className="w-full justify-start gap-2 pl-0.5"
              data-videorc-camera-background-trigger=""
              size="xs"
              type="button"
              variant="secondary"
            />
          }
        >
          <span className="relative h-4.5 w-7.5 shrink-0 overflow-hidden rounded-chip bg-video-ground">
            <CameraBackgroundArt art={currentArt(control)} />
          </span>
          <span className="shrink-0 font-normal text-muted-foreground">
            {CAMERA_BACKGROUND_LABEL}
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{control.valueLabel}</span>
          <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-subtle" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80" data-videorc-camera-background-popover="">
          <Suspense fallback={null}>
            <LazyCameraBackgroundPicker
              control={control}
              onChooseImage={() => {
                setOpen(false)
                setChoosingImage(true)
              }}
              onSettings={() => {
                setOpen(false)
                openSceneBackground()
              }}
            />
          </Suspense>
        </PopoverContent>
      </Popover>
      {choosingImage ? (
        <Suspense fallback={null}>
          <LazyCameraBackgroundImageDialog
            choices={control.choices().filter((choice) => choice.group === 'images')}
            open={choosingImage}
            reason={control.effectReason}
            selected={control.choiceId}
            onChoose={choose}
            onOpenChange={setChoosingImage}
          />
        </Suspense>
      ) : null}
    </div>
  )
}
