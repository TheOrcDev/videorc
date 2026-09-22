import { CameraIcon, DisplayIcon, ExternalLinkIcon } from '@/components/icons'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactElement
} from 'react'

import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Separator } from '@/components/ui/separator'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { CameraShape, EffectiveSceneBackground, Scene, SceneSource } from '@/lib/backend'
import { backgroundAssetDisplayUrl } from '@/lib/background-assets'
import { cn } from '@/lib/utils'
import {
  StageEdits,
  StageGesture,
  sameStageRect,
  stageHandleOffset,
  visibleStageHandles,
  type StageCommit
} from './stage-gesture'
import { stagePixelSize, stagePoint, type StageMapping } from './stage-viewport'
import {
  handleCursor,
  stageHandlePoints,
  stageSnapTargets,
  stageSourceShape,
  type GhostResult,
  type StageHandleId,
  type StageRect
} from './stage-transform'

const STAGE_W = 160
const NO_COMMIT: StageCommit = async () => ({ ok: false })
type ActiveGesture = {
  motion: StageGesture
  mapping: StageMapping
  initial: StageRect
  clientX: number
  clientY: number
  moved: boolean
}
type StageGhost = GhostResult & { sourceId: string }

/** A schematic editor only: pointer samples never start capture or cross IPC. */
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
  aspectLocked = true,
  externalPending = false,
  onBusyChange,
  onSelectSource,
  onTogglePreview,
  onCommitTransform,
  onSnapCorner,
  onRequestFreeform
}: {
  scene: Scene | null
  selectedSourceId: string | null
  background?: EffectiveSceneBackground | null
  previewOpen: boolean
  cameraShape?: CameraShape
  cameraCornerRadiusPct?: number
  dragEnabled?: boolean
  resizeEnabled?: boolean
  cameraAspectLocked?: boolean
  freeform?: boolean
  outputAspect?: number
  aspectLocked?: boolean
  externalPending?: boolean
  onBusyChange?: (busy: boolean) => void
  onSelectSource: (sourceId: string) => void
  onTogglePreview: () => void
  onCommitTransform?: StageCommit
  onSnapCorner?: (corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') => void
  onRequestFreeform?: () => void
}): ReactElement {
  const sources = scene?.sources ?? []
  const stageH =
    STAGE_W / (Number.isFinite(outputAspect) && outputAspect > 0 ? outputAspect : 16 / 9)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const clipId = useId()
  const [failedBackgroundAssetId, setFailedBackgroundAssetId] = useState<string | null>(null)
  const backgroundUrl =
    background && background.assetId !== failedBackgroundAssetId
      ? backgroundAssetDisplayUrl(background.managedAssetPath)
      : null
  const [snap, setSnap] = useState(false)
  const effectiveSnap = freeform ? snap : true
  const [showFreeformHint, setShowFreeformHint] = useState(false)
  const [ghost, setGhost] = useState<StageGhost | null>(null)
  const [pixelScale, setPixelScale] = useState(1)
  const [, redraw] = useReducer((value: number) => value + 1, 0)
  const gestureRef = useRef<ActiveGesture | null>(null)
  const frameRef = useRef<number | null>(null)
  const sampleRef = useRef<{
    clientX: number
    clientY: number
    shiftKey: boolean
    altKey: boolean
  } | null>(null)
  const mountedRef = useRef(true)
  const editsRef = useRef<StageEdits | null>(null)
  const cancelGesture = useCallback(() => {
    const gesture = gestureRef.current
    gestureRef.current = null
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    sampleRef.current = null
    if (gesture && svgRef.current?.hasPointerCapture(gesture.motion.pointerId))
      svgRef.current.releasePointerCapture(gesture.motion.pointerId)
    if (mountedRef.current) setGhost(null)
  }, [])
  if (!editsRef.current)
    editsRef.current = new StageEdits(
      onCommitTransform ?? NO_COMMIT,
      () => {
        if (mountedRef.current) redraw()
      },
      cancelGesture
    )
  const edits = editsRef.current
  edits.configure(onCommitTransform ?? NO_COMMIT)
  useLayoutEffect(() => {
    edits.observe(scene)
  }, [edits, scene])
  const phase = ghost ? 'dragging' : edits.draft || externalPending ? 'pending' : 'idle'
  useLayoutEffect(() => {
    onBusyChange?.(phase !== 'idle')
  }, [onBusyChange, phase])
  // Same scene revision updates are normal acknowledgements; replacement of its
  // source identities/shape or disabling editing invalidates pointer ownership.
  const sourceIdentity = sources
    .map(
      (source) =>
        `${source.id}:${source.kind}:${source.deviceId}:${source.locked}:${source.visible}`
    )
    .join('|')
  useLayoutEffect(() => {
    cancelGesture()
    edits.invalidate()
    setShowFreeformHint(false)
  }, [
    cancelGesture,
    edits,
    scene?.id,
    sourceIdentity,
    dragEnabled,
    resizeEnabled,
    freeform,
    outputAspect,
    cameraShape,
    cameraAspectLocked
  ])
  useLayoutEffect(() => {
    if (gestureRef.current && gestureRef.current.motion.sourceId !== selectedSourceId)
      cancelGesture()
    if (edits.draft && edits.draft.sourceId !== selectedSourceId) edits.invalidate()
  }, [cancelGesture, edits, selectedSourceId])
  useEffect(() => {
    mountedRef.current = true
    const svg = svgRef.current
    const measure = (): void => {
      const matrix = svg?.getScreenCTM()
      if (matrix) setPixelScale(Math.hypot(matrix.a, matrix.b) || 1)
      cancelGesture()
    }
    const observer = new ResizeObserver(measure)
    if (svg) observer.observe(svg)
    const key = (event: KeyboardEvent): void => {
      if (!gestureRef.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancelGesture()
      } else if (event.key.startsWith('Arrow')) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', cancelGesture)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', cancelGesture, true)
    return () => {
      mountedRef.current = false
      cancelGesture()
      edits.invalidate()
      observer.disconnect()
      onBusyChange?.(false)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', cancelGesture)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', cancelGesture, true)
    }
  }, [cancelGesture, edits, onBusyChange])

  const editable = (source: SceneSource): boolean =>
    !source.locked && (freeform || source.transform.width < 1 || source.transform.height < 1)
  const displayed = (source: SceneSource): StageRect =>
    ghost?.sourceId === source.id
      ? ghost.rect
      : edits.draft?.sourceId === source.id
        ? edits.draft.rect
        : source.transform
  const beginGesture = (
    source: SceneSource,
    kind: 'move' | StageHandleId,
    event: React.PointerEvent<Element>
  ): void => {
    if (event.button !== 0 || !event.isPrimary || gestureRef.current || externalPending) return
    if (edits.draft && edits.draft.sourceId !== source.id) return
    if (source.transform.width <= 0 || source.transform.height <= 0) return
    onSelectSource(source.id)
    if (!(kind === 'move' ? dragEnabled : resizeEnabled) || !editable(source)) {
      if (onRequestFreeform && !source.locked) setShowFreeformHint(true)
      return
    }
    const svg = svgRef.current
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return
    const mapping = {
      a: matrix.a,
      b: matrix.b,
      c: matrix.c,
      d: matrix.d,
      e: matrix.e,
      f: matrix.f,
      width: STAGE_W,
      height: stageH
    }
    const point = stagePoint(mapping, event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    onSelectSource(source.id)
    const initial = { ...displayed(source) }
    const motion = new StageGesture(
      source.id,
      event.pointerId,
      kind,
      initial,
      point,
      stagePixelSize(mapping),
      stageSnapTargets(sources.filter((other) => other.id !== source.id).map(displayed)),
      effectiveSnap,
      aspectLocked,
      source.kind === 'camera' && cameraAspectLocked
    )
    // Initial modifiers establish ownership without changing the grabbed point.
    motion.sample(point, event)
    gestureRef.current = {
      motion,
      mapping,
      initial,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false
    }
    svg.setPointerCapture(event.pointerId)
    setGhost({ sourceId: source.id, rect: initial, guides: [] })
  }
  const flushSample = (sample: {
    clientX: number
    clientY: number
    shiftKey: boolean
    altKey: boolean
  }): StageGhost | null => {
    const gesture = gestureRef.current
    if (!gesture) return null
    const point = stagePoint(gesture.mapping, sample.clientX, sample.clientY)
    if (!point) {
      cancelGesture()
      return null
    }
    if (Math.hypot(sample.clientX - gesture.clientX, sample.clientY - gesture.clientY) >= 0.01)
      gesture.moved = true
    const next = { sourceId: gesture.motion.sourceId, ...gesture.motion.sample(point, sample) }
    setGhost(next)
    return next
  }
  const moveGesture = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (gestureRef.current?.motion.pointerId !== event.pointerId) return
    sampleRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      shiftKey: event.shiftKey,
      altKey: event.altKey
    }
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      if (sampleRef.current) flushSample(sampleRef.current)
    })
  }
  const endGesture = (event: React.PointerEvent<SVGSVGElement>): void => {
    const gesture = gestureRef.current
    if (!gesture || gesture.motion.pointerId !== event.pointerId) return
    const final = flushSample(event)
    cancelGesture()
    if (!final || sameStageRect(final.rect, gesture.initial) || !gesture.moved) return
    if (gesture.motion.kind === 'move' && onSnapCorner) {
      const rect = final.rect
      if (
        (rect.x <= 0.06 || rect.x + rect.width >= 0.94) &&
        (rect.y <= 0.06 || rect.y + rect.height >= 0.94)
      ) {
        onSnapCorner(`${rect.y <= 0.06 ? 'top' : 'bottom'}-${rect.x <= 0.06 ? 'left' : 'right'}`)
        return
      }
    }
    edits.submit(gesture.motion.sourceId, final.rect)
  }
  const selectedSource = sources.find((source) => source.id === selectedSourceId)
  const gutter = 28 / pixelScale
  const activeMotion = gestureRef.current
  const activeHandle =
    activeMotion && activeMotion.motion.kind !== 'move'
      ? {
          id: activeMotion.motion.kind,
          offset: stageHandleOffset(
            activeMotion.initial.width * activeMotion.motion.pixels.width,
            activeMotion.initial.height * activeMotion.motion.pixels.height
          )
        }
      : undefined
  return (
    <div
      className="flex min-w-0 flex-col rounded-panel border border-border bg-card/40"
      data-videorc-stage-phase={phase}
    >
      <div
        className="flex flex-wrap items-center justify-between gap-2 p-2"
        data-videorc-stage-toolbar
      >
        <ToggleGroup
          disabled={phase !== 'idle'}
          aria-label="Scene sources"
          className="min-w-0 flex-wrap"
          size="sm"
          type="single"
          value={selectedSourceId ?? ''}
          onValueChange={(value) => {
            if (value) {
              cancelGesture()
              onSelectSource(value)
            }
          }}
        >
          {sources.map((source) => (
            <ToggleGroupItem
              key={source.id}
              aria-label={`Select ${source.name}`}
              title={source.name}
              value={source.id}
            >
              {source.kind === 'camera' ? (
                <CameraIcon data-icon="inline-start" />
              ) : (
                <DisplayIcon data-icon="inline-start" />
              )}
              <span className="max-w-44 truncate">{source.name}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {freeform ? (
          <Toggle
            aria-label="Snap"
            disabled={!dragEnabled || phase === 'dragging'}
            pressed={snap}
            size="sm"
            onPressedChange={setSnap}
          >
            Snap
          </Toggle>
        ) : null}
      </div>
      <Separator />
      <div className="flex justify-center p-7">
        <svg
          ref={svgRef}
          aria-label="Scene composition editor"
          className="block w-full touch-none overflow-visible select-none"
          role="group"
          style={{ maxWidth: (420 * STAGE_W) / stageH, aspectRatio: `${STAGE_W} / ${stageH}` }}
          viewBox={`0 0 ${STAGE_W} ${stageH}`}
          onPointerMove={moveGesture}
          onPointerUp={endGesture}
          onPointerCancel={(event) => {
            if (event.pointerId === gestureRef.current?.motion.pointerId) cancelGesture()
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerId === gestureRef.current?.motion.pointerId) cancelGesture()
          }}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={0} y={0} width={STAGE_W} height={stageH} />
            </clipPath>
          </defs>
          <rect
            data-videorc-stage-canvas
            className="fill-background/40 stroke-border"
            x={0}
            y={0}
            width={STAGE_W}
            height={stageH}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <g clipPath={`url(#${clipId})`}>
            {backgroundUrl && background ? (
              <>
                <image
                  href={backgroundUrl}
                  x={0}
                  y={0}
                  width={STAGE_W}
                  height={stageH}
                  preserveAspectRatio={
                    background.fit === 'fill'
                      ? 'xMidYMid slice'
                      : background.fit === 'stretch'
                        ? 'none'
                        : 'xMidYMid meet'
                  }
                  onError={() => setFailedBackgroundAssetId(background.assetId)}
                />
                <rect
                  fill="black"
                  fillOpacity={Math.min(Math.max(background.dimPercent, 0), 100) / 100}
                  width={STAGE_W}
                  height={stageH}
                />
              </>
            ) : null}
            {sources.map((source) => {
              const rect = displayed(source),
                width = rect.width * STAGE_W,
                height = rect.height * stageH
              const shape = stageSourceShape(
                rect,
                STAGE_W,
                stageH,
                source.kind === 'camera' ? cameraShape : 'rectangle',
                cameraCornerRadiusPct
              )
              const paint = {
                className: cn(
                  source.kind === 'camera' ? 'fill-foreground/10' : 'fill-muted-foreground/5',
                  'stroke-muted-foreground/40',
                  !source.visible && 'opacity-40'
                ),
                strokeWidth: 1,
                strokeDasharray: source.visible ? undefined : '4 3',
                vectorEffect: 'non-scaling-stroke',
                pointerEvents: 'none'
              }
              return (
                <g
                  key={source.id}
                  data-videorc-stage-source={source.id}
                  className={
                    dragEnabled && editable(source)
                      ? 'cursor-grab active:cursor-grabbing'
                      : 'cursor-pointer'
                  }
                  onClick={(event) => {
                    if (
                      event.button === 0 &&
                      !externalPending &&
                      (!edits.draft || edits.draft.sourceId === source.id)
                    )
                      onSelectSource(source.id)
                  }}
                  onPointerDown={(event) => beginGesture(source, 'move', event)}
                >
                  {/* The transform owns picking and selection, including the
                      empty corners around a circular camera mask. */}
                  <rect
                    data-videorc-stage-bounds
                    x={rect.x * STAGE_W}
                    y={rect.y * stageH}
                    width={width}
                    height={height}
                    fill="transparent"
                  />
                  {shape.kind === 'circle' ? (
                    <circle
                      data-videorc-stage-painted-shape="circle"
                      cx={shape.cx}
                      cy={shape.cy}
                      r={shape.r}
                      {...paint}
                    />
                  ) : (
                    <rect
                      data-videorc-stage-painted-shape={
                        source.kind === 'camera' ? cameraShape : 'rectangle'
                      }
                      x={shape.x}
                      y={shape.y}
                      width={shape.width}
                      height={shape.height}
                      rx={shape.rx}
                      {...paint}
                    />
                  )}
                </g>
              )
            })}
            {ghost?.guides.map((guide) => (
              <line
                key={`${guide.axis}-${guide.position}`}
                data-videorc-stage-guide={guide.axis}
                className="stroke-ring"
                strokeDasharray="4 3"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                x1={guide.axis === 'x' ? guide.position * STAGE_W : 0}
                x2={guide.axis === 'x' ? guide.position * STAGE_W : STAGE_W}
                y1={guide.axis === 'y' ? guide.position * stageH : 0}
                y2={guide.axis === 'y' ? guide.position * stageH : stageH}
              />
            ))}
          </g>
          {selectedSource ? (
            <StageSelection
              rect={displayed(selectedSource)}
              activeHandle={activeHandle}
              stageH={stageH}
              scale={pixelScale}
              enabled={resizeEnabled && editable(selectedSource)}
              onHandle={(handle, event) => beginGesture(selectedSource, handle, event)}
            />
          ) : null}
          {/* Keep the edge hit targets within a reserved, unobstructed gutter. */}
          <rect
            x={-gutter}
            y={-gutter}
            width={STAGE_W + gutter * 2}
            height={stageH + gutter * 2}
            fill="none"
            pointerEvents="none"
          />
        </svg>
      </div>
      {!sources.length ? (
        <p className="px-3 pb-3 text-center text-xs text-muted-foreground">
          No sources in the scene yet
        </p>
      ) : null}
      <Separator />
      <div
        className="flex flex-wrap items-center justify-between gap-2 p-2"
        data-videorc-stage-footer
      >
        {dragEnabled ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              <Kbd>Shift</Kbd> constrain / aspect
            </span>
            {effectiveSnap ? (
              <span>
                <Kbd>Alt / ⌥</Kbd> no snap
              </span>
            ) : null}
            <span>
              <Kbd>Esc</Kbd> cancel
            </span>
          </div>
        ) : null}
        {showFreeformHint && onRequestFreeform ? (
          <Button size="sm" variant="ghost" onClick={onRequestFreeform}>
            Make freeform
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onTogglePreview}>
          <ExternalLinkIcon data-icon="inline-start" />
          {previewOpen ? 'Close preview' : 'Open preview'}
        </Button>
      </div>
    </div>
  )
}

function StageSelection({
  rect,
  stageH,
  scale,
  enabled,
  activeHandle,
  onHandle
}: {
  rect: StageRect
  stageH: number
  scale: number
  enabled: boolean
  activeHandle?: { id: StageHandleId; offset: number }
  onHandle: (id: StageHandleId, event: React.PointerEvent<Element>) => void
}): ReactElement {
  const visible = 6 / scale,
    hit = 24 / scale
  const handles = activeHandle
    ? [activeHandle.id]
    : visibleStageHandles(rect.width * STAGE_W * scale, rect.height * stageH * scale)
  const offset =
    (activeHandle?.offset ??
      stageHandleOffset(rect.width * STAGE_W * scale, rect.height * stageH * scale)) / scale
  return (
    <g data-videorc-stage-handles>
      <rect
        className="fill-none stroke-foreground/70"
        pointerEvents="none"
        x={rect.x * STAGE_W}
        y={rect.y * stageH}
        width={rect.width * STAGE_W}
        height={rect.height * stageH}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {enabled
        ? stageHandlePoints(rect)
            .filter((point) => handles.includes(point.id))
            .map((point) => {
              const anchorX = point.x * STAGE_W,
                anchorY = point.y * stageH
              const x = anchorX + offset,
                y = anchorY + offset
              return (
                <g key={point.id} style={{ cursor: handleCursor(point.id) }}>
                  {offset > 0 ? (
                    <line
                      className="stroke-foreground/70"
                      x1={anchorX}
                      y1={anchorY}
                      x2={x}
                      y2={y}
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  ) : null}
                  <rect
                    className="fill-background stroke-foreground/80"
                    pointerEvents="none"
                    x={x - visible / 2}
                    y={y - visible / 2}
                    width={visible}
                    height={visible}
                    rx={1 / scale}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  <rect
                    data-videorc-stage-handle={point.id}
                    aria-label={`Resize ${point.id}`}
                    x={x - hit / 2}
                    y={y - hit / 2}
                    width={hit}
                    height={hit}
                    fill="transparent"
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      onHandle(point.id, event)
                    }}
                  />
                </g>
              )
            })
        : null}
    </g>
  )
}
