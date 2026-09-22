import { LockIcon } from '@/components/icons'
import { useRef, useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupInput, InputGroupAddon } from '@/components/ui/input-group'
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
 * (sanitized, unsnapped) value echoes back into the fields, so the two
 * paths can never disagree.
 */
export function SourceTransformFields({
  source,
  disabled = false,
  disabledReason,
  sizeEditable = true,
  aspectForced = false,
  aspectLocked: aspectLockedChoice = true,
  onAspectLockedChange,
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
  aspectLocked?: boolean
  onAspectLockedChange?: (locked: boolean) => void
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
  const draftsRef = useRef(drafts)
  const updateDraft = (field: TransformFieldId, value: string | undefined): void => {
    draftsRef.current = { ...draftsRef.current, [field]: value }
    setDrafts(draftsRef.current)
  }
  const aspectLocked = aspectForced || aspectLockedChoice

  const commitField = (field: TransformFieldId): void => {
    const draft = draftsRef.current[field]
    updateDraft(field, undefined)
    if (disabled || draft === undefined) {
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
          onClick={() => onAspectLockedChange?.(!aspectLockedChoice)}
        >
          <LockIcon weight={aspectLocked ? 'fill' : 'regular'} />
        </Button>
      </div>

      <FieldGroup className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TRANSFORM_FIELD_IDS.map((field) => {
          const isSize = field === 'width' || field === 'height'
          const fieldDisabled = disabled || (isSize && !sizeEditable)
          const value = drafts[field] ?? formatPercentValue(committed[field])
          return (
            <Field key={field} className="min-w-0 gap-1" data-disabled={fieldDisabled}>
              <FieldLabel htmlFor={`${source.id}-${field}`}>
                {TRANSFORM_FIELD_LABELS[field]}
              </FieldLabel>
              <InputGroup>
                <InputGroupInput
                  id={`${source.id}-${field}`}
                  aria-label={`${TRANSFORM_FIELD_LABELS[field]} percent of canvas`}
                  className="text-right tabular-nums"
                  data-videorc-transform-field={field}
                  disabled={fieldDisabled}
                  inputMode="decimal"
                  value={value}
                  onBlur={() => commitField(field)}
                  onChange={(event) => updateDraft(field, event.target.value)}
                  onFocus={() =>
                    updateDraft(
                      field,
                      draftsRef.current[field] ?? formatPercentValue(committed[field])
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitField(field)
                    } else if (event.key === 'Escape') {
                      updateDraft(field, undefined)
                      event.currentTarget.blur()
                    }
                  }}
                />
                <InputGroupAddon align="inline-end">%</InputGroupAddon>
              </InputGroup>
            </Field>
          )
        })}
      </FieldGroup>

      {aspectForced ? (
        <p className="text-xs text-muted-foreground">Aspect locked by the camera shape.</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {pixelReadout(committed, outputWidth, outputHeight)}
      </p>
      {disabled && disabledReason ? (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}
    </div>
  )
}
