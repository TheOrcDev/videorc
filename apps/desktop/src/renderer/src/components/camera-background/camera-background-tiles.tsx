import { useId, useRef, type KeyboardEvent, type ReactElement } from 'react'

import {
  CameraBackgroundArt,
  choiceArt
} from '@/components/camera-background/camera-background-art'
import { ImageIcon } from '@/components/icons'
import { MediaCard } from '@/components/media-card'
import { SectionLabel } from '@/components/section-label'
import {
  CAMERA_BACKGROUND_GROUP_LABELS,
  CHOOSE_IMAGE_LABEL,
  type CameraBackgroundChoice,
  type CameraBackgroundChoiceId,
  type CameraBackgroundGroup
} from '@/lib/camera-background-view'
import { cn } from '@/lib/utils'

/**
 * The Background tiles (plan 258 UX): one card per choice with its picture
 * and name, `MediaCard`'s look, the pick on the chrome plate. Arrow keys move
 * between tiles and Enter or Space picks (a pick changes every output, so it
 * never follows focus alone). A disabled tile says why in the one line under
 * the tiles, which it points at.
 */
export function CameraBackgroundTiles({
  choices,
  selected,
  onChoose,
  onChooseImage,
  grouped = false,
  reason,
  label = 'Background'
}: {
  choices: CameraBackgroundChoice[]
  selected: CameraBackgroundChoiceId | null
  onChoose: (choice: CameraBackgroundChoiceId) => void
  /** Adds the Choose image… tile after the pictures. */
  onChooseImage?: () => void
  /** Headings per group (the popover); one grid otherwise (the Scene page). */
  grouped?: boolean
  /** The line under the tiles: why the disabled ones can't be picked. */
  reason?: string | null
  label?: string
}): ReactElement {
  const reasonId = useId()
  const tiles = useRef<Map<string, HTMLButtonElement>>(new Map())
  const order = [
    ...choices.filter((choice) => !choice.disabledReason).map((choice) => choice.id),
    ...(onChooseImage ? ['choose-image'] : [])
  ]
  const focusable = selected && order.includes(selected) ? selected : order[0]
  const onKeyDown = (event: KeyboardEvent, id: string): void => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const index = order.indexOf(id)
    const next = order[(index + step + order.length) % order.length]
    if (next) tiles.current.get(next)?.focus()
  }
  const tile = (choice: CameraBackgroundChoice): ReactElement => {
    const checked = choice.id === selected
    const disabled = choice.disabledReason !== null
    return (
      <MediaCard
        interactive={!disabled}
        key={choice.id}
        render={
          <button
            aria-checked={checked}
            aria-describedby={disabled && reason ? reasonId : undefined}
            data-videorc-camera-background-choice={choice.id}
            disabled={disabled}
            ref={(element) => {
              if (element) tiles.current.set(choice.id, element)
              else tiles.current.delete(choice.id)
            }}
            role="radio"
            tabIndex={choice.id === focusable ? 0 : -1}
            type="button"
            onClick={() => onChoose(choice.id)}
            onKeyDown={(event) => onKeyDown(event, choice.id)}
          />
        }
        selected={checked}
        className="gap-1 p-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50"
      >
        <span className="relative aspect-[16/10] overflow-hidden rounded-chip bg-video-ground">
          <CameraBackgroundArt art={choiceArt(choice)} />
        </span>
        <span
          className={cn(
            'truncate px-0.5 text-center text-label',
            checked ? 'text-foreground' : 'font-normal text-muted-foreground'
          )}
        >
          {choice.label}
        </span>
      </MediaCard>
    )
  }
  const chooseImage = onChooseImage ? (
    <MediaCard
      interactive
      key="choose-image"
      render={
        <button
          data-videorc-camera-background-choose-image=""
          ref={(element) => {
            if (element) tiles.current.set('choose-image', element)
            else tiles.current.delete('choose-image')
          }}
          tabIndex={focusable === 'choose-image' ? 0 : -1}
          type="button"
          onClick={onChooseImage}
          onKeyDown={(event) => onKeyDown(event, 'choose-image')}
        />
      }
      className="gap-1 p-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <span className="flex aspect-[16/10] items-center justify-center rounded-chip bg-inset text-muted-foreground">
        <ImageIcon aria-hidden className="size-4" />
      </span>
      <span className="truncate px-0.5 text-center text-label font-normal text-muted-foreground">
        {CHOOSE_IMAGE_LABEL}
      </span>
    </MediaCard>
  ) : null
  const groups: CameraBackgroundGroup[] = ['blur', 'images', 'screens']
  return (
    <div className="flex flex-col gap-2">
      <div aria-label={label} className="flex flex-col gap-2" role="radiogroup">
        {grouped ? (
          groups.map((group) => {
            const inGroup = choices.filter((choice) => choice.group === group)
            const extra = group === 'images' ? chooseImage : null
            if (inGroup.length === 0 && !extra) return null
            return (
              <div className="flex flex-col gap-1.5" key={group}>
                <SectionLabel>{CAMERA_BACKGROUND_GROUP_LABELS[group]}</SectionLabel>
                <div className="grid grid-cols-4 gap-1.5">
                  {inGroup.map(tile)}
                  {extra}
                </div>
              </div>
            )
          })
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {choices.filter((choice) => choice.group !== 'screens').map(tile)}
            {chooseImage}
            {choices.filter((choice) => choice.group === 'screens').map(tile)}
          </div>
        )}
      </div>
      {reason ? (
        <p
          className="text-xs text-muted-foreground"
          data-videorc-camera-background-reason=""
          id={reasonId}
        >
          {reason}
        </p>
      ) : null}
    </div>
  )
}
