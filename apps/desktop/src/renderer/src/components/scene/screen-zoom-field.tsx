import { useState } from 'react'
import type { ReactElement } from 'react'

import { PowerSlider } from '@/components/power-slider'
import type { SceneSource } from '@/lib/backend'
import {
  SCREEN_ZOOM_HINT,
  SCREEN_ZOOM_MAX,
  SCREEN_ZOOM_MIN,
  screenZoomOf,
  screenZoomPatch
} from './screen-zoom'
import type { StageRect } from './stage-transform'

/**
 * The screen's Zoom in Freeform (plan 215 E4, D2): 100 to 400% of the canvas,
 * scaling the box around its centre. What runs past the canvas is cut off,
 * never squashed. The drag shows its value here; the box moves on release,
 * through the same backend scene commit as a drag on the stage, and the
 * committed size echoes back.
 */
export function ScreenZoomField({
  source,
  disabled = false,
  disabledReason,
  onCommit
}: {
  source: Pick<SceneSource, 'id' | 'transform'>
  disabled?: boolean
  /** Why it can't change now (a recording or a livestream), or undefined. */
  disabledReason?: string
  onCommit: (patch: StageRect) => void
}): ReactElement {
  const committed: StageRect = {
    x: source.transform.x,
    y: source.transform.y,
    width: source.transform.width,
    height: source.transform.height
  }
  const [draft, setDraft] = useState<number | null>(null)
  const commit = (zoom: number): void => {
    setDraft(null)
    if (disabled) return
    const patch = screenZoomPatch(committed, zoom)
    if (
      patch.x === committed.x &&
      patch.y === committed.y &&
      patch.width === committed.width &&
      patch.height === committed.height
    )
      return
    onCommit(patch)
  }

  return (
    <div className="flex flex-col gap-1.5" data-videorc-screen-zoom={source.id}>
      <PowerSlider
        defaultValue={SCREEN_ZOOM_MIN}
        disabled={disabled}
        disabledReason={disabledReason}
        label="Zoom"
        max={SCREEN_ZOOM_MAX}
        min={SCREEN_ZOOM_MIN}
        numericInput
        step={5}
        suffix="%"
        value={draft ?? screenZoomOf(committed)}
        onChange={setDraft}
        onCommit={commit}
      />
      <p className="text-xs text-muted-foreground">{SCREEN_ZOOM_HINT}</p>
    </div>
  )
}
