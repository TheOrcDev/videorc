import { useState, type ReactElement } from 'react'

import { CameraBackgroundArt } from '@/components/camera-background/camera-background-art'
import { CameraBackgroundImageDialog } from '@/components/camera-background/camera-background-image-dialog'
import {
  CameraBackgroundTiles,
  choiceArt
} from '@/components/camera-background/camera-background-tiles'
import { CameraBackgroundViewer } from '@/components/camera-background/camera-background-viewer'
import type { CameraBackgroundControl } from '@/components/camera-background/use-camera-background'
import { ChevronDownIcon, LockIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  CAMERA_BACKGROUND_BLUR_CAVEAT,
  CAMERA_BACKGROUND_LABEL,
  CAMERA_BACKGROUND_LOCK_LINE,
  imagesPickedFirst,
  type CameraBackgroundChoiceId
} from '@/lib/camera-background-view'
import { openSceneBackground } from '@/lib/green-screen'

/** The pictures the popover's Images row shows before Choose image…. */
const POPOVER_IMAGES = 3

/** The art of the camera's current pick, for the trigger and the viewer's fallback. */
export function currentArt(control: CameraBackgroundControl) {
  return choiceArt({ id: control.choiceId ?? 'off', picture: control.picture })
}

/**
 * The popover's body, shared by both looks (the Retro LCD trigger opens the
 * same picker): the live "What viewers see" picture, the tiles in three
 * groups, the blur caveat while a blur is picked, and the lock line
 * with Settings (the Scene page's Background section, the home).
 */
export function CameraBackgroundPicker({
  control,
  onChooseImage,
  onSettings
}: {
  control: CameraBackgroundControl
  onChooseImage: () => void
  onSettings: () => void
}): ReactElement {
  const images = imagesPickedFirst(control.images, control.background.assetId)
  return (
    <div className="flex flex-col gap-3" data-videorc-camera-background-picker="">
      <h4 className="text-section">{CAMERA_BACKGROUND_LABEL}</h4>
      <CameraBackgroundViewer
        fallback={<CameraBackgroundArt art={currentArt(control)} />}
        mirror={control.mirror}
      />
      <CameraBackgroundTiles
        choices={control.choices({ images, imageLimit: POPOVER_IMAGES })}
        grouped
        reason={control.effectReason}
        selected={control.choiceId}
        onChoose={control.choose}
        onChooseImage={onChooseImage}
      />
      {control.background.mode === 'blur' ? (
        <p className="text-xs text-muted-foreground" data-videorc-camera-background-caveat="">
          {CAMERA_BACKGROUND_BLUR_CAVEAT}
        </p>
      ) : null}
      <div className="flex items-center gap-2 border-t border-border pt-2.5 text-xs text-muted-foreground">
        <LockIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{CAMERA_BACKGROUND_LOCK_LINE}</span>
        <Button size="xs" type="button" variant="ghost" onClick={onSettings}>
          Settings
        </Button>
      </div>
    </div>
  )
}

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
          <CameraBackgroundPicker
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
        </PopoverContent>
      </Popover>
      <CameraBackgroundImageDialog
        choices={control.choices().filter((choice) => choice.group === 'images')}
        open={choosingImage}
        reason={control.effectReason}
        selected={control.choiceId}
        onChoose={choose}
        onOpenChange={setChoosingImage}
      />
    </div>
  )
}
