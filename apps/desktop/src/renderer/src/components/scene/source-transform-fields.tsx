import { LockIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SceneSource } from '@/lib/backend'
import { cn } from '@/lib/utils'
import type { StageRect } from './stage-transform'
import {
  TRANSFORM_FIELD_IDS,
  TRANSFORM_FIELD_LABELS,
  formatPercentValue,
  parsePercentValue,
  pixelReadout,
  transformFieldPatch,
  type TransformFieldId
} from './transform-fields-math'

/**
 * The Inspector's precise twin of the stage gestures: numeric X/Y/W/H in
 * percent of the canvas. Every commit goes through the same backend-owned
 * scene commit as a drag (scene.source.transform.update), and the committed
 * (sanitized, possibly snapped) value echoes back into the fields, so the two
 * paths can never disagree.
 */
export function SourceTransformFields({
  source,
  disabled = false,
  disabledReason,
  sizeEditable = true,
  aspectForced = false,
  outputWidth,
  outputHeight,
  onCommit
}: {
  source: SceneSource
  disabled?: boolean
  disabledReason?: string
  /** Size fields stay read-only where the layout owns the box (fixed presets). */
  sizeEditable?: boolean
  /** The source's aspect is law (circle / forced camera aspect): the lock cannot open. */
  aspectForced?: boolean
  outputWidth: number
  outputHeight: number
  onCommit: (patch: { x?: number; y?: number; width?: number; height?: number }) => void
}): ReactElement {
  const committed: StageRect = {
    x: source.transform.x,
    y: source.transform.y,
    width: source.transform.width,
    height: source.transform.height
  }
  const [drafts, setDrafts] = useState<Partial<Record<TransformFieldId, string>>>({})
  const [aspectLockedChoice, setAspectLockedChoice] = useState(true)
  const aspectLocked = aspectForced || aspectLockedChoice

  const commitField = (field: TransformFieldId): void => {
    const draft = drafts[field]
    setDrafts((current) => ({ ...current, [field]: undefined }))
    if (draft === undefined) {
      return
    }
    const parsed = parsePercentValue(draft)
    if (parsed === null || parsed === committed[field]) {
      return
    }
    onCommit(transformFieldPatch(field, parsed, committed, aspectLocked))
  }

  return (
    <div className="grid gap-2" data-videorc-transform-fields={source.id}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] leading-none font-medium text-subtle">
          Position and size
        </span>
        <Button
          aria-label={aspectLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
          aria-pressed={aspectLocked}
          className={cn('text-muted-foreground', aspectLocked && 'text-foreground')}
          disabled={disabled || aspectForced || !sizeEditable}
          size="icon-xs"
          title={
            aspectForced
              ? 'The aspect is set by the camera shape'
              : aspectLocked
                ? 'Aspect locked. Size edits keep the shape.'
                : 'Aspect free. Width and height move alone.'
          }
          variant={aspectLocked ? 'secondary' : 'ghost'}
          onClick={() => setAspectLockedChoice((locked) => !locked)}
        >
          <LockIcon weight={aspectLocked ? 'fill' : 'regular'} />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TRANSFORM_FIELD_IDS.map((field) => {
          const isSize = field === 'width' || field === 'height'
          const fieldDisabled = disabled || (isSize && !sizeEditable)
          const value = drafts[field] ?? formatPercentValue(committed[field])
          return (
            <label key={field} className="flex min-w-0 flex-col gap-1">
              <span className="text-[11px] leading-none text-muted-foreground">
                {TRANSFORM_FIELD_LABELS[field]}
              </span>
              <div className="relative">
                <Input
                  aria-label={`${TRANSFORM_FIELD_LABELS[field]} percent of canvas`}
                  className="h-7 pr-6 text-right font-mono text-xs tabular-nums"
                  data-videorc-transform-field={field}
                  disabled={fieldDisabled}
                  inputMode="decimal"
                  value={value}
                  onBlur={() => commitField(field)}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [field]: event.target.value }))
                  }
                  onFocus={() =>
                    setDrafts((current) => ({
                      ...current,
                      [field]: current[field] ?? formatPercentValue(committed[field])
                    }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitField(field)
                    } else if (event.key === 'Escape') {
                      setDrafts((current) => ({ ...current, [field]: undefined }))
                      event.currentTarget.blur()
                    }
                  }}
                />
                <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[10px] text-muted-foreground">
                  %
                </span>
              </div>
            </label>
          )
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        {pixelReadout(committed, outputWidth, outputHeight)}
      </p>
      {disabled && disabledReason ? (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}
    </div>
  )
}
