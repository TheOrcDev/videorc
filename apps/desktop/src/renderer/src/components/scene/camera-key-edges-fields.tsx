import { ResetIcon } from '@/components/icons'
import { useRef, useState, type ReactElement } from 'react'

import { SectionLabel } from '@/components/section-label'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import type { CameraKeyEdges } from '@/lib/backend'
import { NO_CAMERA_KEY_EDGES } from '@/lib/capture'

import {
  CAMERA_KEY_EDGE_IDS,
  CAMERA_KEY_EDGE_LABELS,
  cameraKeyEdgesPatch,
  cameraKeyEdgesSet,
  type CameraKeyEdgeId
} from './camera-key-edges'

/**
 * Hide edges (plan 227 B), in the Green screen section while Key out
 * background is on: left, top, right and bottom as a percent of the camera
 * as you see it. Those edges become see-through, green or not, so a curtain
 * or a light stand at the edge of the frame never shows. The camera keeps
 * its framing. Laid out like the screen's Crop fields.
 */
export function CameraKeyEdgesFields({
  edges,
  onCommit
}: {
  edges: CameraKeyEdges
  onCommit: (edges: CameraKeyEdges) => void
}): ReactElement {
  const [drafts, setDrafts] = useState<Partial<Record<CameraKeyEdgeId, string>>>({})
  const draftsRef = useRef(drafts)
  const updateDraft = (side: CameraKeyEdgeId, value: string | undefined): void => {
    draftsRef.current = { ...draftsRef.current, [side]: value }
    setDrafts(draftsRef.current)
  }
  const commitSide = (side: CameraKeyEdgeId): void => {
    const draft = draftsRef.current[side]
    updateDraft(side, undefined)
    if (draft === undefined) return
    const next = cameraKeyEdgesPatch(edges, side, draft)
    if (next) onCommit(next)
  }

  return (
    <div className="grid gap-2" data-videorc-key-edges>
      <SectionLabel>Hide edges</SectionLabel>
      <FieldGroup className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CAMERA_KEY_EDGE_IDS.map((side) => (
          <Field key={side} className="min-w-0 gap-1">
            <FieldLabel htmlFor={`camera-key-edge-${side}`}>
              {CAMERA_KEY_EDGE_LABELS[side]}
            </FieldLabel>
            <InputGroup>
              <InputGroupInput
                id={`camera-key-edge-${side}`}
                aria-label={`Hide ${CAMERA_KEY_EDGE_LABELS[side].toLowerCase()} edge, percent of the camera`}
                className="text-right tabular-nums"
                data-videorc-key-edge={side}
                inputMode="numeric"
                value={drafts[side] ?? String(edges[side])}
                onBlur={() => commitSide(side)}
                onChange={(event) => updateDraft(side, event.target.value)}
                onFocus={() => updateDraft(side, draftsRef.current[side] ?? String(edges[side]))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitSide(side)
                  } else if (event.key === 'Escape') {
                    updateDraft(side, undefined)
                    event.currentTarget.blur()
                  }
                }}
              />
              <InputGroupAddon align="inline-end">%</InputGroupAddon>
            </InputGroup>
          </Field>
        ))}
      </FieldGroup>
      <p className="text-xs text-muted-foreground">
        Makes the camera&apos;s edges see-through, for anything there that isn&apos;t green screen,
        like a curtain or a light stand. Up to 25% a side, as you see the camera.
      </p>
      {cameraKeyEdgesSet(edges) ? (
        <Button
          className="w-fit"
          data-videorc-key-edges-reset
          size="xs"
          variant="ghost"
          onClick={() => onCommit({ ...NO_CAMERA_KEY_EDGES })}
        >
          <ResetIcon data-icon="inline-start" />
          Show all edges
        </Button>
      ) : null}
    </div>
  )
}
