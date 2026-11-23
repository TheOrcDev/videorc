import type { ReactElement } from 'react'

import { choiceArt } from '@/components/camera-background/camera-background-art'
import { CameraBackgroundOrcArt } from '@/components/camera-background/camera-background-orc-art'
import { CameraBackgroundTiles } from '@/components/camera-background/camera-background-tiles'
import { CameraBackgroundViewer } from '@/components/camera-background/camera-background-viewer'
import type { CameraBackgroundControl } from '@/components/camera-background/use-camera-background'
import { LockIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  CAMERA_BACKGROUND_BLUR_CAVEAT,
  CAMERA_BACKGROUND_LABEL,
  CAMERA_BACKGROUND_LOCK_LINE,
  imagesPickedFirst
} from '@/lib/camera-background-view'

// Its own chunk (loaded on the first open): the Studio inspector is in the
// launch bundle, and the picker's tiles, pictures and live view are not
// needed until the popover opens (renderer asset budget, plan 113).

/** The pictures the popover's Images row shows before Choose image…. */
const POPOVER_IMAGES = 3

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
      {/* A new pick starts a new picture: nothing drawn before it stays. */}
      <CameraBackgroundViewer
        key={control.choiceId ?? control.background.mode}
        fallback={
          <CameraBackgroundOrcArt
            art={choiceArt({ id: control.choiceId ?? 'off', picture: control.picture })}
          />
        }
        mirror={control.mirror}
      />
      <CameraBackgroundTiles
        choices={control.choices({ images, imageLimit: POPOVER_IMAGES })}
        compact
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
