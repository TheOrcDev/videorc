import { ArrowSquareOut, Monitor, VideoCamera } from '@phosphor-icons/react'
import { useRef, useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import type { CameraShape, Scene, SceneSource } from '@/lib/backend'
import { cn } from '@/lib/utils'

// SC1 (Scene rework): a pure-SVG schematic of the committed composition. The
// Scene tab used to make you edit transforms BLIND — the live preview is a
// detached window by design (idle-perf law: no always-on compositing in tabs),
// so this diagram renders the real normalized transforms with zero IPC cost.
// It is deliberately a diagram, not pixels; "Open preview" is the ground truth.

const STAGE_W = 160

/** Stage height follows the OUTPUT canvas aspect — a portrait (9:16) canvas
 * must not be drawn on a 16:9 stage or camera drag/snap positions lie
 * (vertical scene plan S4). Display height is capped in CSS; the viewBox only
 * carries the aspect. */
function stageHeight(outputAspect: number): number {
  const aspect = Number.isFinite(outputAspect) && outputAspect > 0 ? outputAspect : 16 / 9
  return Math.round(STAGE_W / aspect)
}

export function SceneStage({
  scene,
  selectedSourceId,
  hasBackground,
  previewOpen,
  cameraShape = 'rectangle',
  cameraCornerRadiusPct = 12,
  dragEnabled = false,
  outputAspect = 16 / 9,
  onSelectSource,
  onTogglePreview,
  onCommitPosition,
  onSnapCorner
}: {
  scene: Scene | null
  selectedSourceId: string | null
  hasBackground: boolean
  previewOpen: boolean
  /** Camera bubble shape — the stage must not lie about rounded/circle corners. */
  cameraShape?: CameraShape
  /** Corner radius (% of the shorter side) when cameraShape is 'rounded'. */
  cameraCornerRadiusPct?: number
  /** SC3: allow dragging the camera rect (disabled in split/full layouts + live sessions). */
  dragEnabled?: boolean
  /** Output canvas aspect (width / height); drives the stage shape. */
  outputAspect?: number
  onSelectSource: (sourceId: string) => void
  onTogglePreview: () => void
  onCommitPosition?: (sourceId: string, position: { x: number; y: number }) => void
  onSnapCorner?: (corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') => void
}): ReactElement {
  const sources = scene?.sources ?? []
  const stageH = stageHeight(outputAspect)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const dragRef = useRef<{
    sourceId: string
    pointerId: number
    startClientX: number
    startClientY: number
    startX: number
    startY: number
    width: number
    height: number
    moved: boolean
  } | null>(null)
  // Live drag position (normalized) — visual only until pointerup commits.
  const [dragPosition, setDragPosition] = useState<{
    sourceId: string
    x: number
    y: number
  } | null>(null)

  const normalizedDelta = (event: { clientX: number; clientY: number }) => {
    const drag = dragRef.current
    const rect = svgRef.current?.getBoundingClientRect()
    if (!drag || !rect) {
      return null
    }
    const dx = (event.clientX - drag.startClientX) / rect.width
    const dy = (event.clientY - drag.startClientY) / rect.height
    return {
      x: Math.min(Math.max(drag.startX + dx, 0), 1 - drag.width),
      y: Math.min(Math.max(drag.startY + dy, 0), 1 - drag.height)
    }
  }

  const beginDrag = (source: SceneSource, event: React.PointerEvent<SVGGElement>): void => {
    if (!dragEnabled || source.kind !== 'camera' || source.transform.width >= 1) {
      return
    }
    dragRef.current = {
      sourceId: source.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: source.transform.x,
      startY: source.transform.y,
      width: source.transform.width,
      height: source.transform.height,
      moved: false
    }
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
  }

  const moveDrag = (event: React.PointerEvent<SVGGElement>): void => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) {
      return
    }
    const next = normalizedDelta(event)
    if (!next) {
      return
    }
    drag.moved = true
    setDragPosition({ sourceId: drag.sourceId, ...next })
  }

  const endDrag = (event: React.PointerEvent<SVGGElement>): void => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) {
      return
    }
    dragRef.current = null
    const next = normalizedDelta(event)
    setDragPosition(null)
    if (!drag.moved || !next) {
      return
    }
    // Corner snap: release near a canvas corner re-enters preset mode.
    const snap = 0.06
    const nearLeft = next.x <= snap
    const nearRight = next.x + drag.width >= 1 - snap
    const nearTop = next.y <= snap
    const nearBottom = next.y + drag.height >= 1 - snap
    if (onSnapCorner && (nearLeft || nearRight) && (nearTop || nearBottom)) {
      onSnapCorner(
        `${nearTop ? 'top' : 'bottom'}-${nearLeft ? 'left' : 'right'}` as
          | 'top-left'
          | 'top-right'
          | 'bottom-left'
          | 'bottom-right'
      )
      return
    }
    onCommitPosition?.(drag.sourceId, next)
  }

  return (
    <div className="relative overflow-hidden rounded-row border border-border bg-muted/20">
      <svg
        ref={svgRef}
        aria-label="Scene composition diagram"
        className="mx-auto block max-h-[420px] w-full"
        role="img"
        viewBox={`0 0 ${STAGE_W} ${stageH}`}
      >
        {/* Canvas */}
        <rect
          className={cn(hasBackground ? 'fill-primary/10' : 'fill-transparent')}
          height={stageH}
          width={STAGE_W}
          x={0}
          y={0}
        />
        {sources.map((source) => (
          <StageSourceRect
            key={source.id}
            cameraCornerRadiusPct={cameraCornerRadiusPct}
            cameraShape={cameraShape}
            stageH={stageH}
            draggable={dragEnabled && source.kind === 'camera' && source.transform.width < 1}
            dragPosition={dragPosition?.sourceId === source.id ? dragPosition : null}
            selected={source.id === selectedSourceId}
            source={source}
            onPointerDown={(event) => {
              onSelectSource(source.id)
              beginDrag(source, event)
            }}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onSelect={() => onSelectSource(source.id)}
          />
        ))}
        {sources.length === 0 ? (
          <text
            className="fill-muted-foreground"
            fontSize={5}
            textAnchor="middle"
            x={STAGE_W / 2}
            y={stageH / 2}
          >
            No sources in the scene yet
          </text>
        ) : null}
      </svg>

      {/* Legend chips (HTML overlay, top-left) */}
      {/* FX7: max-w-24 clipped "Screen capture Utility…" mid-word straight
          into the next chip, reading as overlap. Wrap + a wider budget keeps
          names legible; truncation stays as the last resort. */}
      <div className="pointer-events-none absolute left-2 right-2 top-2 flex flex-wrap gap-1.5">
        {sources.map((source) => (
          <button
            key={source.id}
            aria-label={`Select ${source.name}`}
            aria-pressed={source.id === selectedSourceId}
            className={cn(
              'pointer-events-auto flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-[11px] backdrop-blur-sm transition-colors',
              source.id === selectedSourceId
                ? 'border-ring bg-accent text-foreground'
                : 'border-border bg-background/70 text-muted-foreground hover:text-foreground',
              !source.visible && 'opacity-50'
            )}
            type="button"
            onClick={() => onSelectSource(source.id)}
          >
            {source.kind === 'camera' ? (
              <VideoCamera className="size-3" weight="duotone" />
            ) : (
              <Monitor className="size-3" weight="duotone" />
            )}
            <span className="max-w-44 truncate">{source.name}</span>
          </button>
        ))}
      </div>

      {/* Ground truth lives in the detached preview window. */}
      <div className="absolute inset-x-0 bottom-2 flex justify-center">
        <Button size="sm" variant="secondary" onClick={onTogglePreview}>
          <ArrowSquareOut data-icon="inline-start" />
          {previewOpen ? 'Close preview' : 'Open preview'}
        </Button>
      </div>
    </div>
  )
}

function StageSourceRect({
  source,
  stageH,
  selected,
  draggable = false,
  dragPosition,
  cameraShape,
  cameraCornerRadiusPct,
  onSelect,
  onPointerDown,
  onPointerMove,
  onPointerUp
}: {
  source: SceneSource
  stageH: number
  selected: boolean
  draggable?: boolean
  dragPosition: { x: number; y: number } | null
  cameraShape: CameraShape
  cameraCornerRadiusPct: number
  onSelect: () => void
  onPointerDown?: (event: React.PointerEvent<SVGGElement>) => void
  onPointerMove?: (event: React.PointerEvent<SVGGElement>) => void
  onPointerUp?: (event: React.PointerEvent<SVGGElement>) => void
}): ReactElement {
  const x = (dragPosition?.x ?? source.transform.x) * STAGE_W
  const y = (dragPosition?.y ?? source.transform.y) * stageH
  const width = Math.max(2, source.transform.width * STAGE_W)
  const height = Math.max(2, source.transform.height * stageH)
  const camera = source.kind === 'camera'
  // Mirror the compositors' mask geometry in schematic form: circle = fully
  // rounded (its box is square by construction), rounded = pct% of the shorter
  // side, rectangle = the hairline default.
  const cornerRadius = !camera
    ? 1.5
    : cameraShape === 'circle'
      ? Math.min(width, height) / 2
      : cameraShape === 'rounded'
        ? (Math.min(width, height) * Math.min(cameraCornerRadiusPct, 50)) / 100
        : 1.5

  return (
    <g
      className={draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}
      data-videorc-stage-source={source.id}
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <rect
        className={cn(
          camera ? 'fill-primary/25' : 'fill-muted-foreground/15',
          selected ? 'stroke-ring' : camera ? 'stroke-primary/60' : 'stroke-muted-foreground/50',
          !source.visible && 'opacity-40'
        )}
        height={height}
        rx={cornerRadius}
        strokeDasharray={source.visible ? undefined : '2 1.5'}
        strokeWidth={selected ? 1.2 : 0.6}
        width={width}
        x={x}
        y={y}
      />
      {/* Label only when the rect is big enough to hold it. Shaped camera
          bubbles (circle / strongly rounded) cut the rect's corners away, so
          the bottom-left anchor would float OUTSIDE the visible shape —
          center the label in those. Rectangles keep bottom-left: the HTML
          legend chips overlay the stage's top-left, so a rect touching the
          top edge (side-by-side's screen box) had its label buried under the
          chips (plan 021 F4). */}
      {width > 24 && height > 10 ? (
        cornerRadius >= Math.min(width, height) / 4 ? (
          <text
            className={cn('select-none', camera ? 'fill-primary' : 'fill-muted-foreground')}
            dominantBaseline="central"
            fontSize={4.2}
            textAnchor="middle"
            x={x + width / 2}
            y={y + height / 2}
          >
            {source.name}
          </text>
        ) : (
          <text
            className={cn('select-none', camera ? 'fill-primary' : 'fill-muted-foreground')}
            fontSize={4.2}
            x={x + 2.5}
            y={y + height - 2.5}
          >
            {source.name}
          </text>
        )
      ) : null}
    </g>
  )
}
