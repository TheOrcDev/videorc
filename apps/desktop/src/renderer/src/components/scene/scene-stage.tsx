import { CameraIcon, DisplayIcon, ExternalLinkIcon } from '@/components/icons'
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import type { CameraShape, EffectiveSceneBackground, Scene, SceneSource } from '@/lib/backend'
import { backgroundAssetDisplayUrl } from '@/lib/background-assets'
import { cn } from '@/lib/utils'
import {
  handleCursor,
  moveGhost,
  resizeGhost,
  roundRectForCommit,
  stageHandlePoints,
  stageSnapTargets,
  type SnapGuide,
  type StageHandleId,
  type StageRect
} from './stage-transform'

// SC1 (Scene rework): a pure-SVG schematic of the committed composition. The
// Scene tab used to make you edit transforms BLIND — the live preview is a
// detached window by design (idle-perf law: no always-on compositing in tabs),
// so this diagram renders the real normalized transforms with zero IPC cost.
// It is deliberately a diagram, not pixels; "Open preview" is the ground truth.
//
// Direct manipulation: drag moves a source, the selection frame's handles
// resize it. Both render a LOCAL ghost during the gesture and commit ONCE on
// release through the backend-owned scene commit (scene.source.transform.update
// via onCommitTransform) — the stage never owns scene state. Gesture math
// lives in stage-transform.ts (pure, unit-tested).

const STAGE_W = 160

/** Stage height follows the OUTPUT canvas aspect — a portrait (9:16) canvas
 * must not be drawn on a 16:9 stage or camera drag/snap positions lie
 * (vertical scene plan S4). Display height is capped in CSS; the viewBox only
 * carries the aspect. */
function stageHeight(outputAspect: number): number {
  const aspect = Number.isFinite(outputAspect) && outputAspect > 0 ? outputAspect : 16 / 9
  return Math.round(STAGE_W / aspect)
}

type StageGesture = {
  sourceId: string
  pointerId: number
  /** 'move' or the resize handle being pulled. */
  kind: 'move' | StageHandleId
  startClientX: number
  startClientY: number
  startRect: StageRect
  /** The source's aspect is law (circle / forced camera aspect): Shift cannot free it. */
  aspectForced: boolean
  moved: boolean
}

type StageGhost = {
  sourceId: string
  rect: StageRect
  guides: SnapGuide[]
}

export function SceneStage({
  scene,
  selectedSourceId,
  background = null,
  previewOpen,
  cameraShape = 'rectangle',
  cameraCornerRadiusPct = 12,
  dragEnabled = false,
  resizeEnabled = false,
  cameraAspectLocked = false,
  freeform = false,
  outputAspect = 16 / 9,
  onSelectSource,
  onTogglePreview,
  onCommitTransform,
  onGestureActiveChange,
  onSnapCorner,
  onRequestFreeform
}: {
  scene: Scene | null
  selectedSourceId: string | null
  /** The committed scene background, rendered on the canvas (WYSIWYG). */
  background?: EffectiveSceneBackground | null
  previewOpen: boolean
  /** Camera bubble shape — the stage must not lie about rounded/circle corners. */
  cameraShape?: CameraShape
  /** Corner radius (% of the shorter side) when cameraShape is 'rounded'. */
  cameraCornerRadiusPct?: number
  /** SC3: allow dragging source rects (disabled in fixed layouts + live sessions). */
  dragEnabled?: boolean
  /** Show resize handles on the selected source and commit width/height changes. */
  resizeEnabled?: boolean
  /** The camera's aspect is owned by the mask law (circle / square / portrait). */
  cameraAspectLocked?: boolean
  /** Freeform arrangement: every source is editable, full-canvas included. */
  freeform?: boolean
  /** Output canvas aspect (width / height); drives the stage shape. */
  outputAspect?: number
  onGestureActiveChange?: (active: boolean) => void
  onSelectSource: (sourceId: string) => void
  onTogglePreview: () => void
  onCommitTransform?: (
    sourceId: string,
    transform: { x: number; y: number; width?: number; height?: number }
  ) => void
  onSnapCorner?: (corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') => void
  /** Offered when a fixed arrangement blocks a gesture ("Make freeform"). */
  onRequestFreeform?: () => void
}): ReactElement {
  const sources = scene?.sources ?? []
  const stageH = stageHeight(outputAspect)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const gradientId = useId()
  // A background whose managed file cannot render falls back to the glass
  // gradient instead of a blank hole; a replaced asset gets a fresh try.
  const [failedBackgroundAssetId, setFailedBackgroundAssetId] = useState<string | null>(null)
  const backgroundUrl =
    background && background.assetId !== failedBackgroundAssetId
      ? backgroundAssetDisplayUrl(background.managedAssetPath)
      : null
  const gestureRef = useRef<StageGesture | null>(null)
  // Live gesture ghost (normalized) — visual only until pointerup commits.
  const [ghost, setGhost] = useState<StageGhost | null>(null)
  // One-line affordance when a gesture lands on a fixed arrangement.
  const [showFreeformHint, setShowFreeformHint] = useState(false)

  useEffect(() => {
    setShowFreeformHint(false)
  }, [freeform, dragEnabled])

  // Escape cancels an in-flight gesture without committing.
  useEffect(() => {
    if (!ghost) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        gestureRef.current = null
        onGestureActiveChange?.(false)
        setGhost(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [ghost, onGestureActiveChange])

  useEffect(() => () => onGestureActiveChange?.(false), [onGestureActiveChange])

  // Freeform lifts the full-canvas restriction: shrinking a 100% screen is
  // exactly what the mode is for. Fixed presets keep it (a full-canvas box
  // has nowhere to move).
  const sourceEditableRect = (source: SceneSource): boolean =>
    freeform || source.transform.width < 1 || source.transform.height < 1

  const sourceMoveable = (source: SceneSource): boolean =>
    dragEnabled && !source.locked && sourceEditableRect(source)

  const sourceResizable = (source: SceneSource): boolean =>
    resizeEnabled && !source.locked && sourceEditableRect(source)

  // Takes the gesture explicitly: the old ref-reading version silently
  // returned null from endDrag, which had ALREADY cleared the ref — the
  // release commit never fired (latent since the original SC3 drag).
  const normalizedDelta = (
    gesture: StageGesture,
    event: { clientX: number; clientY: number }
  ): { dx: number; dy: number } | null => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return null
    }
    return {
      dx: (event.clientX - gesture.startClientX) / rect.width,
      dy: (event.clientY - gesture.startClientY) / rect.height
    }
  }

  const ghostForGesture = (
    gesture: StageGesture,
    delta: { dx: number; dy: number },
    modifiers: { shiftKey: boolean; altKey: boolean }
  ): StageGhost => {
    if (gesture.kind === 'move') {
      const others = sources
        .filter((candidate) => candidate.id !== gesture.sourceId)
        .map((candidate) => candidate.transform)
      const { rect, guides } = moveGhost({
        start: gesture.startRect,
        dx: delta.dx,
        dy: delta.dy,
        constrainAxis: modifiers.shiftKey,
        disableSnap: modifiers.altKey,
        targets: stageSnapTargets(others)
      })
      return { sourceId: gesture.sourceId, rect, guides }
    }
    const isCorner = gesture.kind.length === 2
    const { rect, guides } = resizeGhost({
      start: gesture.startRect,
      handle: gesture.kind,
      dx: delta.dx,
      dy: delta.dy,
      // Corner pulls keep the aspect by default; Shift frees a rectangle.
      // Shaped sources (circle, forced camera aspect) stay locked always.
      lockAspect: gesture.aspectForced || (isCorner && !modifiers.shiftKey)
    })
    return { sourceId: gesture.sourceId, rect, guides }
  }

  const beginGesture = (
    source: SceneSource,
    kind: StageGesture['kind'],
    event: React.PointerEvent<Element>
  ): void => {
    if (kind === 'move' ? !sourceMoveable(source) : !sourceResizable(source)) {
      if (onRequestFreeform && !source.locked) {
        setShowFreeformHint(true)
      }
      return
    }
    onGestureActiveChange?.(true)
    gestureRef.current = {
      sourceId: source.id,
      pointerId: event.pointerId,
      kind,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: {
        x: source.transform.x,
        y: source.transform.y,
        width: source.transform.width,
        height: source.transform.height
      },
      aspectForced: source.kind === 'camera' && cameraAspectLocked,
      moved: false
    }
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
  }

  const moveGesture = (event: React.PointerEvent<Element>): void => {
    const gesture = gestureRef.current
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return
    }
    const delta = normalizedDelta(gesture, event)
    if (!delta) {
      return
    }
    gesture.moved = true
    setGhost(ghostForGesture(gesture, delta, event))
  }

  const endGesture = (event: React.PointerEvent<Element>): void => {
    const gesture = gestureRef.current
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return
    }
    const delta = normalizedDelta(gesture, event)
    gestureRef.current = null
    onGestureActiveChange?.(false)
    setGhost(null)
    if (!gesture.moved || !delta) {
      return
    }
    const { rect } = ghostForGesture(gesture, delta, event)
    const committed = roundRectForCommit(rect)
    if (gesture.kind === 'move') {
      // Corner snap: releasing a camera near a canvas corner re-enters the
      // corner preset instead of committing a nearby custom position.
      const snap = 0.06
      const nearLeft = committed.x <= snap
      const nearRight = committed.x + committed.width >= 1 - snap
      const nearTop = committed.y <= snap
      const nearBottom = committed.y + committed.height >= 1 - snap
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
      // A move never writes size — width/height stay whatever the layout owns.
      onCommitTransform?.(gesture.sourceId, { x: committed.x, y: committed.y })
      return
    }
    onCommitTransform?.(gesture.sourceId, committed)
  }

  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? null
  const selectedGhostRect =
    ghost && selectedSource && ghost.sourceId === selectedSource.id ? ghost.rect : null

  return (
    <div className="relative overflow-hidden rounded-panel border border-border bg-card/40 shadow-inner">
      <svg
        ref={svgRef}
        aria-label="Scene composition diagram"
        className="mx-auto block max-h-[420px] w-full"
        role="img"
        viewBox={`0 0 ${STAGE_W} ${stageH}`}
      >
        {/* Canvas backdrop: glass gradient (theme tokens), the committed
            scene background image on top when one is set (WYSIWYG, plan
            phase 5). All static; nothing repaints at rest (idle-perf law). */}
        <defs>
          <linearGradient
            gradientUnits="objectBoundingBox"
            id={`${gradientId}-base`}
            x1="0"
            x2="1"
            y1="0"
            y2="1"
          >
            <stop offset="0" style={{ stopColor: 'var(--muted)', stopOpacity: 0.6 }} />
            <stop offset="0.55" style={{ stopColor: 'var(--background)', stopOpacity: 0.35 }} />
            <stop offset="1" style={{ stopColor: 'var(--muted)', stopOpacity: 0.5 }} />
          </linearGradient>
          <radialGradient
            gradientUnits="objectBoundingBox"
            cx="0.22"
            cy="0.16"
            id={`${gradientId}-glow-a`}
            r="0.6"
          >
            <stop offset="0" style={{ stopColor: 'var(--primary)', stopOpacity: 0.08 }} />
            <stop offset="1" style={{ stopColor: 'var(--primary)', stopOpacity: 0 }} />
          </radialGradient>
          <radialGradient
            gradientUnits="objectBoundingBox"
            cx="0.8"
            cy="0.86"
            id={`${gradientId}-glow-b`}
            r="0.65"
          >
            <stop offset="0" style={{ stopColor: 'var(--primary)', stopOpacity: 0.05 }} />
            <stop offset="1" style={{ stopColor: 'var(--primary)', stopOpacity: 0 }} />
          </radialGradient>
          <linearGradient
            gradientUnits="objectBoundingBox"
            id={`${gradientId}-sheen`}
            x1="0"
            x2="1"
            y1="0"
            y2="0"
          >
            <stop offset="0.44" style={{ stopColor: 'var(--foreground)', stopOpacity: 0 }} />
            <stop offset="0.5" style={{ stopColor: 'var(--foreground)', stopOpacity: 0.05 }} />
            <stop offset="0.56" style={{ stopColor: 'var(--foreground)', stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <rect fill={`url(#${gradientId}-base)`} height={stageH} width={STAGE_W} x={0} y={0} />
        <rect fill={`url(#${gradientId}-glow-a)`} height={stageH} width={STAGE_W} x={0} y={0} />
        <rect fill={`url(#${gradientId}-glow-b)`} height={stageH} width={STAGE_W} x={0} y={0} />
        {backgroundUrl && background ? (
          <>
            <image
              height={stageH}
              href={backgroundUrl}
              preserveAspectRatio={
                background.fit === 'fill'
                  ? 'xMidYMid slice'
                  : background.fit === 'stretch'
                    ? 'none'
                    : 'xMidYMid meet'
              }
              width={STAGE_W}
              x={0}
              y={0}
              onError={() => setFailedBackgroundAssetId(background.assetId)}
            />
            {/* Approximate the dim so the schematic boxes stay readable. */}
            <rect
              fill="black"
              fillOpacity={Math.min(Math.max(background.dimPercent, 0), 100) / 100}
              height={stageH}
              width={STAGE_W}
              x={0}
              y={0}
            />
          </>
        ) : (
          <rect fill={`url(#${gradientId}-sheen)`} height={stageH} width={STAGE_W} x={0} y={0} />
        )}
        {/* Hairline ring marks the recorded canvas against the glass frame. */}
        <rect
          className="fill-transparent stroke-border"
          height={stageH - 0.4}
          strokeWidth={0.4}
          width={STAGE_W - 0.4}
          x={0.2}
          y={0.2}
        />
        {sources.map((source) => (
          <StageSourceRect
            key={source.id}
            cameraCornerRadiusPct={cameraCornerRadiusPct}
            cameraShape={cameraShape}
            stageH={stageH}
            draggable={sourceMoveable(source)}
            ghostRect={ghost?.sourceId === source.id ? ghost.rect : null}
            selected={source.id === selectedSourceId}
            source={source}
            onPointerDown={(event) => {
              onSelectSource(source.id)
              beginGesture(source, 'move', event)
            }}
            onPointerMove={moveGesture}
            onPointerUp={endGesture}
            onSelect={() => onSelectSource(source.id)}
          />
        ))}

        {/* Snap guides while a drag is magnetized. */}
        {ghost?.guides.map((guide) => (
          <line
            key={`${guide.axis}-${guide.position}`}
            className="stroke-ring/80"
            strokeDasharray="2 1.5"
            strokeWidth={0.5}
            x1={guide.axis === 'x' ? guide.position * STAGE_W : 0}
            x2={guide.axis === 'x' ? guide.position * STAGE_W : STAGE_W}
            y1={guide.axis === 'y' ? guide.position * stageH : 0}
            y2={guide.axis === 'y' ? guide.position * stageH : stageH}
          />
        ))}

        {/* Resize handles on the selected, editable source. */}
        {selectedSource && sourceResizable(selectedSource) ? (
          <StageSelectionHandles
            rect={
              selectedGhostRect ?? {
                x: selectedSource.transform.x,
                y: selectedSource.transform.y,
                width: selectedSource.transform.width,
                height: selectedSource.transform.height
              }
            }
            stageH={stageH}
            onHandlePointerDown={(handle, event) => beginGesture(selectedSource, handle, event)}
            onPointerMove={moveGesture}
            onPointerUp={endGesture}
          />
        ) : null}

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
              <CameraIcon className="size-3" weight="duotone" />
            ) : (
              <DisplayIcon className="size-3" weight="duotone" />
            )}
            <span className="max-w-44 truncate">{source.name}</span>
          </button>
        ))}
      </div>

      {/* Fixed-arrangement affordance: offer Freeform instead of silently
          mutating a preset (plan phase 4). */}
      {showFreeformHint && onRequestFreeform ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-12 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-1.5 rounded-chip border border-border bg-background/80 py-0.5 pl-2 pr-0.5 text-[11px] text-muted-foreground backdrop-blur-sm">
            <span>This scene has a fixed arrangement.</span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setShowFreeformHint(false)
                onRequestFreeform()
              }}
            >
              Make freeform
            </Button>
          </div>
        </div>
      ) : null}

      {/* Ground truth lives in the detached preview window. */}
      <div className="absolute inset-x-0 bottom-2 flex justify-center">
        <Button size="sm" variant="secondary" onClick={onTogglePreview}>
          <ExternalLinkIcon data-icon="inline-start" />
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
  ghostRect,
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
  ghostRect: StageRect | null
  cameraShape: CameraShape
  cameraCornerRadiusPct: number
  onSelect: () => void
  onPointerDown?: (event: React.PointerEvent<SVGGElement>) => void
  onPointerMove?: (event: React.PointerEvent<SVGGElement>) => void
  onPointerUp?: (event: React.PointerEvent<SVGGElement>) => void
}): ReactElement {
  const x = (ghostRect?.x ?? source.transform.x) * STAGE_W
  const y = (ghostRect?.y ?? source.transform.y) * stageH
  const width = Math.max(2, (ghostRect?.width ?? source.transform.width) * STAGE_W)
  const height = Math.max(2, (ghostRect?.height ?? source.transform.height) * stageH)
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
            className={cn(
              'select-none stroke-background/60 [paint-order:stroke]',
              camera ? 'fill-primary' : 'fill-muted-foreground'
            )}
            dominantBaseline="central"
            fontSize={4.2}
            strokeWidth={0.7}
            textAnchor="middle"
            x={x + width / 2}
            y={y + height / 2}
          >
            {source.name}
          </text>
        ) : (
          <text
            className={cn(
              'select-none stroke-background/60 [paint-order:stroke]',
              camera ? 'fill-primary' : 'fill-muted-foreground'
            )}
            fontSize={4.2}
            strokeWidth={0.7}
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

/** Chip-tier resize handles (4 corners + 4 edge midpoints) with oversized,
 * invisible hit areas — the visible squares stay small and crisp. */
function StageSelectionHandles({
  rect,
  stageH,
  onHandlePointerDown,
  onPointerMove,
  onPointerUp
}: {
  rect: StageRect
  stageH: number
  onHandlePointerDown: (handle: StageHandleId, event: React.PointerEvent<Element>) => void
  onPointerMove: (event: React.PointerEvent<Element>) => void
  onPointerUp: (event: React.PointerEvent<Element>) => void
}): ReactElement {
  const visible = 3
  const hit = 6.5
  return (
    <g data-videorc-stage-handles>
      {stageHandlePoints(rect).map((point) => {
        const cx = point.x * STAGE_W
        const cy = point.y * stageH
        return (
          <g key={point.id} style={{ cursor: handleCursor(point.id) }}>
            <rect
              className="fill-foreground stroke-background/70"
              height={visible}
              rx={0.9}
              strokeWidth={0.4}
              width={visible}
              x={cx - visible / 2}
              y={cy - visible / 2}
            />
            <rect
              data-videorc-stage-handle={point.id}
              fill="transparent"
              height={hit}
              width={hit}
              x={cx - hit / 2}
              y={cy - hit / 2}
              onPointerDown={(event) => {
                event.stopPropagation()
                onHandlePointerDown(point.id, event)
              }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            />
          </g>
        )
      })}
    </g>
  )
}
