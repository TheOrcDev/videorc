import { useEffect, useState, type ReactElement } from 'react'

import { CameraBackgroundImageDialog } from '@/components/camera-background/camera-background-image-dialog'
import { CameraBackgroundTiles } from '@/components/camera-background/camera-background-tiles'
import { useCameraBackground } from '@/components/camera-background/use-camera-background'
import { PanelSection } from '@/components/panel-section'
import { PowerSlider } from '@/components/power-slider'
import { CameraKeyEdgesFields } from '@/components/scene/camera-key-edges-fields'
import { NO_CAMERA_KEY_EDGES } from '@/lib/capture'
import {
  CAMERA_BACKGROUND_SLIGHT_BLUR_PCT,
  CAMERA_BACKGROUND_STRONG_BLUR_PCT,
  type CameraBackgroundKey
} from '@/lib/backend'
import {
  BLUR_STRENGTH_LABEL,
  CAMERA_BACKGROUND_BLUR_CAVEAT,
  CAMERA_BACKGROUND_DESCRIPTION,
  CAMERA_BACKGROUND_HINT,
  CAMERA_BACKGROUND_LABEL,
  CAMERA_BACKGROUND_NO_CAMERA,
  CAMERA_BACKGROUND_SCREEN_HINT,
  cameraBackgroundKeyOf,
  imagesPickedFirst
} from '@/lib/camera-background-view'

/** The pictures the section shows before Choose image… (one row of four with the blur tiles). */
const SECTION_IMAGES = 2

/** The strength's marks: Slight and Strong (D5). */
const BLUR_MARKS = [
  { value: CAMERA_BACKGROUND_SLIGHT_BLUR_PCT, label: 'Slight' },
  { value: CAMERA_BACKGROUND_STRONG_BLUR_PCT, label: 'Strong' }
]

/**
 * Plan 258 S5: the camera's Background section on the Scene page, the home
 * (mockup §2). It replaced Green screen in place, right under the camera's
 * name: the tiles, then the tuning for the pick folded open under them
 * (Blur strength for a blur; the key's Similarity, Smoothness, Spill
 * removal and Hide edges for a screen). It edits the camera's own setting,
 * so it says the same in every scene. Edges, Fit, video and Cut out come
 * with S6 and S7.
 */
export function CameraBackgroundSection({
  focus,
  onFocused
}: {
  /** Bring the section into view and focus the pick (Studio's Settings, ⌘K's Background settings). */
  focus: boolean
  onFocused: () => void
}): ReactElement {
  const control = useCameraBackground()
  const [choosingImage, setChoosingImage] = useState(false)
  const { background } = control
  useEffect(() => {
    if (!focus) return
    const section = document.querySelector<HTMLElement>('[data-videorc-camera-background-section]')
    section?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    section
      ?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')
      ?.focus({ preventScroll: true })
    onFocused()
  }, [focus, onFocused])
  const key = cameraBackgroundKeyOf(background)
  const setKey = (patch: Partial<CameraBackgroundKey>, commit: boolean): void =>
    control.set({ ...background, key: { ...key, ...patch } }, { commit })
  const screen = background.mode === 'green' || background.mode === 'blue'
  const hint =
    background.mode === 'blur'
      ? `${CAMERA_BACKGROUND_HINT} ${CAMERA_BACKGROUND_BLUR_CAVEAT}`
      : screen
        ? CAMERA_BACKGROUND_SCREEN_HINT
        : CAMERA_BACKGROUND_HINT
  return (
    <PanelSection
      className="min-w-0"
      data-videorc-camera-background-section=""
      description={CAMERA_BACKGROUND_DESCRIPTION}
      headingLevel={3}
      title={CAMERA_BACKGROUND_LABEL}
    >
      <CameraBackgroundTiles
        choices={control.choices({
          images: imagesPickedFirst(control.images, background.assetId),
          imageLimit: SECTION_IMAGES
        })}
        reason={control.available ? control.effectReason : CAMERA_BACKGROUND_NO_CAMERA}
        selected={control.choiceId}
        onChoose={control.choose}
        onChooseImage={control.available ? () => setChoosingImage(true) : undefined}
      />
      {background.mode === 'blur' ? (
        <PowerSlider
          defaultValue={CAMERA_BACKGROUND_STRONG_BLUR_PCT}
          label={BLUR_STRENGTH_LABEL}
          marks={BLUR_MARKS}
          max={100}
          min={10}
          numericInput
          step={1}
          suffix="%"
          value={background.blurPct}
          onChange={(blurPct) => control.set({ ...background, blurPct }, { commit: false })}
          onCommit={(blurPct) => control.set({ ...background, blurPct })}
        />
      ) : null}
      {screen ? (
        <>
          <PowerSlider
            label="Similarity"
            max={100}
            min={0}
            numericInput
            step={1}
            suffix="%"
            value={key.similarityPct}
            onChange={(similarityPct) => setKey({ similarityPct }, false)}
            onCommit={(similarityPct) => setKey({ similarityPct }, true)}
          />
          <PowerSlider
            label="Smoothness"
            max={100}
            min={0}
            numericInput
            step={1}
            suffix="%"
            value={key.smoothnessPct}
            onChange={(smoothnessPct) => setKey({ smoothnessPct }, false)}
            onCommit={(smoothnessPct) => setKey({ smoothnessPct }, true)}
          />
          <PowerSlider
            label="Spill removal"
            max={100}
            min={0}
            numericInput
            step={1}
            suffix="%"
            value={key.spillPct}
            onChange={(spillPct) => setKey({ spillPct }, false)}
            onCommit={(spillPct) => setKey({ spillPct }, true)}
          />
          <CameraKeyEdgesFields
            edges={key.hideEdges ?? NO_CAMERA_KEY_EDGES}
            onCommit={(hideEdges) => setKey({ hideEdges }, true)}
          />
        </>
      ) : null}
      {control.available ? (
        <p className="text-xs text-muted-foreground" data-videorc-camera-background-hint="">
          {hint}
        </p>
      ) : null}
      <CameraBackgroundImageDialog
        choices={control.choices().filter((choice) => choice.group === 'images')}
        open={choosingImage}
        reason={control.effectReason}
        selected={control.choiceId}
        onChoose={control.choose}
        onOpenChange={setChoosingImage}
      />
    </PanelSection>
  )
}
