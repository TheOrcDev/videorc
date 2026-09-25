import { CameraIcon, DisplayIcon, ExternalLinkIcon, PreviewIcon } from '@/components/icons'
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
import type {
  CameraShape,
  EffectiveSceneBackground,
  Scene,
  SceneEditorDraftParams,
  SceneSource
} from '@/lib/backend'
import { backgroundAssetDisplayUrl } from '@/lib/background-assets'
import {
  createEditorDraftChannel,
  type EditorDraftChannel,
  type EditorDraftSample
} from '@/lib/editor-draft-channel'
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
  roundRectForCommit,
  stageHandlePoints,
  stageSnapTargets,
  stageSourceShape,
  type GhostResult,
  type StageHandleId,
  type StageRect
} from './stage-transform'

const STAGE_W = 160
/** Window chrome kept on screen beside the tallest canvas: the pane toolbar
 * and status bar, the stage's toolbar and footer rows, the 28 px handle
 * gutter above and below, and the section padding. The docked surface only
 * shows while ~all of the slot is in view (`DOCK_SLOT_MIN_VISIBLE_FRACTION`),
 * so a canvas taller than the pane could never be live. */
const CANVAS_CHROME_PX = 248
/** Matches DOCKED_PREVIEW_CORNER_RADIUS (and `rounded-panel`): the native
 * surface clips itself to it, so the schematic canvas rounds the same way. */
const CANVAS_RADIUS_PX = 12
const NO_COMMIT: StageCommit = async () => ({ ok: false })

/** The canvas box: the full column width at the output aspect, never taller
 * than the pane can show whole. Portrait canvases keep the LANDSCAPE (16:9)
 * footprint, as the Studio preview strip does, so a 9:16 canvas stands as tall
 * as a landscape one instead of towering ~3× over the column. */
function canvasBoxStyle(aspect: number, stageH: number): React.CSSProperties {
  const footprint = aspect < 1 ? 16 / 9 : aspect
  const columnShare = Math.min(1, aspect / footprint) * 100
  return {
    aspectRatio: `${STAGE_W} / ${stageH}`,
    width: `min(${columnShare.toFixed(3)}%, calc((100vh - ${CANVAS_CHROME_PX}px) * ${aspect.toFixed(4)}))`
  }
}
type ActiveGesture = {
  motion: StageGesture
  mapping: StageMapping
  initial: StageRect
  clientX: number
  clientY: number
  moved: boolean
}
type StageGhost = GhostResult & { sourceId: string }

/** A schematic editor: pointer samples never start capture; the only IPC a
 * gesture crosses is the live draft below, and only over the live canvas.
 *
 * Live canvas (plan 058): on macOS the docked native preview glues itself over
 * the canvas rect (`slotRef`, `data-videorc-dock-slot="scene"`) and the SVG
 * runs in HIT-ONLY mode while `liveSurface` is true — every painted element is
 * `invisible` and every pointer target stays, so the real picture is the
 * visual and the gestures below never branch on it. While it is live, every
 * ghost frame also goes to the compositor as an editor draft (`onDraft`) so
 * the real picture and its chrome follow the pointer; release still makes
 * exactly one authoritative commit through `StageEdits`. Between gestures the
 * selected source's frame and handles are HELD on the live picture as a
 * chrome-only draft (`channel.hold`), so there is something to see and grab. */
export function SceneStage({
  scene,
  selectedSourceId,
  background = null,
  previewOpen,
  liveSurface = false,
  liveDocked = false,
  liveHint = null,
  slotRef,
  onPopOut,
  onShowLive,
  onDraft,
  onDraftClear,
  outputWidth,
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
  /** The docked surface is showing over the canvas: hit-only mode. */
  liveSurface?: boolean
  /** The surface is docked into this canvas (showing or hidden with a reason). */
  liveDocked?: boolean
  /** Tertiary copy under the canvas while the docked surface is hidden. */
  liveHint?: string | null
  /** Dock-slot reporter ref for the canvas rect (macOS live canvas only). */
  slotRef?: (element: HTMLElement | null) => void
  /** Present only where the live canvas is supported; the footer then offers
   * Pop out / Show live here instead of the plain open/close toggle. */
  onPopOut?: () => void
  onShowLive?: () => void
  /** `scene.editor.draft.set` / `.clear` (live canvas only, plan 058 S4). Both
   * must be present for drafts to flow; they are only used while `liveSurface`. */
  onDraft?: (params: SceneEditorDraftParams) => Promise<unknown>
  onDraftClear?: () => Promise<unknown>
  /** Output width in pixels: sizes the compositor-drawn chrome so a hairline is
   * a hairline on screen at every slot size. */
  outputWidth?: number
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
  // The draft channel outlives renders; the RPC props are read through a ref
  // so a reconnect never rebuilds it mid-gesture.
  const draftRpcRef = useRef({ onDraft, onDraftClear })
  draftRpcRef.current = { onDraft, onDraftClear }
  const channelRef = useRef<EditorDraftChannel | null>(null)
  if (!channelRef.current)
    channelRef.current = createEditorDraftChannel({
      set: (params) => draftRpcRef.current.onDraft?.(params) ?? Promise.resolve(),
      clear: () => draftRpcRef.current.onDraftClear?.() ?? Promise.resolve()
    })
  const channel = channelRef.current
  const cancelGesture = useCallback(() => {
    const gesture = gestureRef.current
    gestureRef.current = null
    channelRef.current?.cancel()
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
  const draftEnabled = liveSurface && Boolean(onDraft && onDraftClear)
  // Unmount needs no dispose: the mount effect's cleanup cancels the gesture,
  // which clears the channel, and an idle channel holds no timer.
  useLayoutEffect(() => {
    channel.enabled = draftEnabled
  }, [channel, draftEnabled])
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
  /** Output pixels per CSS pixel of the canvas, so the compositor's hairline
   * is a hairline on screen (the schema caps it at 64; a canvas that small has
   * no visible chrome anyway). */
  const chromeScale = (canvasWidth: number): number =>
    outputWidth && canvasWidth > 0 ? Math.min(64, Math.max(0, outputWidth / canvasWidth)) : 1
  /** One live-draft frame: the ghost plus the chrome the compositor draws for it. */
  const draftOf = (gesture: ActiveGesture, ghost: GhostResult): EditorDraftSample => {
    const source = sources.find((candidate) => candidate.id === gesture.motion.sourceId)
    const kind = gesture.motion.kind
    return {
      transform: ghost.rect,
      chrome: {
        selected: ghost.rect,
        handles: resizeEnabled && Boolean(source && editable(source)),
        ...(kind !== 'move' ? { activeHandle: kind } : {}),
        guides: ghost.guides,
        scale: chromeScale(gesture.motion.pixels.width)
      }
    }
  }
  const selectedSource = sources.find((source) => source.id === selectedSourceId)
  // The idle selection on the live canvas: hold a chrome-only draft for the
  // selected source so its frame and handles stay on the real picture between
  // gestures. Keyed on the DISPLAYED rect minus the ghost (a gesture suspends
  // the hold in the channel; its samples must not fight it here), and paused
  // while this stage's own commit is pending: the released draft carries the
  // new rect until that commit installs, and a hold sent before then would
  // replace it and let the picture snap back. When the committed scene lands
  // the rect changes, and the hold follows it.
  const ownCommitPending = edits.draft?.sourceId === selectedSourceId
  const heldId = draftEnabled && selectedSource ? selectedSource.id : null
  const heldRect = selectedSource
    ? edits.draft?.sourceId === selectedSource.id
      ? edits.draft.rect
      : selectedSource.transform
    : null
  const heldX = heldRect?.x ?? 0
  const heldY = heldRect?.y ?? 0
  const heldWidth = heldRect?.width ?? 0
  const heldHeight = heldRect?.height ?? 0
  const heldHandles = Boolean(selectedSource && resizeEnabled && editable(selectedSource))
  const heldScale = chromeScale(pixelScale * STAGE_W)
  useEffect(() => {
    if (ownCommitPending) return
    if (heldId === null) {
      channel.hold(null)
      return
    }
    channel.hold(heldId, {
      selected: { x: heldX, y: heldY, width: heldWidth, height: heldHeight },
      handles: heldHandles,
      guides: [],
      scale: heldScale
    })
  }, [
    channel,
    ownCommitPending,
    heldId,
    heldX,
    heldY,
    heldWidth,
    heldHeight,
    heldHandles,
    heldScale
  ])
  useEffect(() => () => channel.hold(null), [channel])
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
    // The grab itself shows the frame and handles on the live picture.
    channel.begin(source.id)
    channel.sample(draftOf(gestureRef.current, { rect: initial, guides: [] }))
  }
  const flushSample = (
    sample: {
      clientX: number
      clientY: number
      shiftKey: boolean
      altKey: boolean
    },
    { draft = true } = {}
  ): StageGhost | null => {
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
    if (draft) channel.sample(draftOf(gesture, next))
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
    // The release position is carried by the draft's final frame below, not
    // by a per-sample draft of its own.
    const final = flushSample(event, { draft: false })
    if (!final) {
      cancelGesture()
      return
    }
    const changed = gesture.moved && !sameStageRect(final.rect, gesture.initial)
    const corner =
      changed && gesture.motion.kind === 'move' && onSnapCorner ? snapCornerOf(final.rect) : null
    // The draft's last frame and the commit carry the same rounded rect, and
    // the backend drops the draft when that commit's revision installs. A
    // corner snap commits through a preset instead, so its draft is cleared
    // with the gesture (cancelGesture below).
    if (changed && !corner) channel.release(roundRectForCommit(final.rect))
    cancelGesture()
    if (!changed) return
    if (corner) {
      onSnapCorner?.(corner)
      return
    }
    edits.submit(gesture.motion.sourceId, final.rect)
  }
  const gutter = 28 / pixelScale
  const canvasRadius = Math.min(CANVAS_RADIUS_PX / pixelScale, stageH / 2)
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
      className="flex min-w-0 flex-col rounded-row border border-border"
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
      </div>
      <Separator />
      {/* The 28 px ring around the canvas is the handle gutter: quiet (no
          fill, no stroke) so the canvas reads as the one object here. */}
      <div className="p-7">
        {/* The dock slot is the CANVAS rect only (the output-aspect box), never
            the 28px handle gutter around it: main glues the native surface to
            exactly this element. rounded-panel matches the surface's
            DOCKED_PREVIEW_CORNER_RADIUS. No overflow clip here: the handle hit
            targets live in the gutter and must stay reachable. */}
        <div
          ref={slotRef}
          className="relative mx-auto rounded-panel"
          data-videorc-dock-slot="scene"
          style={canvasBoxStyle(STAGE_W / stageH, stageH)}
        >
          <svg
            ref={svgRef}
            aria-label="Scene composition editor"
            className="block h-full w-full touch-none overflow-visible select-none"
            data-videorc-stage-live={liveSurface ? 'true' : undefined}
            role="group"
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
                <rect x={0} y={0} width={STAGE_W} height={stageH} rx={canvasRadius} />
              </clipPath>
            </defs>
            <rect
              data-videorc-stage-canvas
              className={cn('fill-background/40 stroke-border', liveSurface && 'invisible')}
              x={0}
              y={0}
              width={STAGE_W}
              height={stageH}
              rx={canvasRadius}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <g clipPath={`url(#${clipId})`}>
              {backgroundUrl && background ? (
                <g className={cn(liveSurface && 'invisible')}>
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
                </g>
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
                    !source.visible && 'opacity-40',
                    liveSurface && 'invisible'
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
                        : 'cursor-default'
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
                  className={cn('stroke-ring', liveSurface && 'invisible')}
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
                hitOnly={liveSurface}
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
      </div>
      {!sources.length ? (
        <p className="px-3 pb-3 text-center text-xs text-muted-foreground">
          No sources in the scene yet
        </p>
      ) : null}
      <Separator />
      {/* Footer: what the keys do on the left (or, while the docked surface is
          hidden, why), the canvas's own actions on the right. The hint takes
          the key chips' place so a menu opening elsewhere never reflows the
          stage. */}
      <div
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2"
        data-videorc-stage-footer
      >
        <div className="flex min-h-7 min-w-0 flex-1 items-center pl-1 text-xs text-subtle">
          {liveHint ? (
            <span className="truncate" data-videorc-stage-live-hint title={liveHint}>
              {liveHint}
            </span>
          ) : dragEnabled ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <Kbd>Shift</Kbd>
                constrain / aspect
              </span>
              {effectiveSnap ? (
                <span className="inline-flex items-center gap-1.5">
                  <Kbd>Alt / ⌥</Kbd>
                  no snap
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5">
                <Kbd>Esc</Kbd>
                cancel
              </span>
            </div>
          ) : null}
        </div>
        <div className="flex h-7 items-center gap-1">
          {showFreeformHint && onRequestFreeform ? (
            <Button size="sm" variant="ghost" onClick={onRequestFreeform}>
              Make freeform
            </Button>
          ) : null}
          {freeform ? (
            <>
              <Toggle
                aria-label="Snap"
                disabled={!dragEnabled || phase === 'dragging'}
                pressed={snap}
                size="sm"
                onPressedChange={setSnap}
              >
                Snap
              </Toggle>
              <Separator className="mx-1 my-1.5" orientation="vertical" />
            </>
          ) : null}
          {/* Live canvas (macOS): the docked surface is the picture, so the
              footer offers where it lives — here or in its own window.
              Elsewhere the plain preview toggle stays. */}
          {onPopOut && onShowLive ? (
            liveDocked ? (
              <Button data-videorc-stage-pop-out size="sm" variant="ghost" onClick={onPopOut}>
                <ExternalLinkIcon data-icon="inline-start" />
                Pop out
              </Button>
            ) : (
              <Button data-videorc-stage-show-live size="sm" variant="ghost" onClick={onShowLive}>
                <PreviewIcon data-icon="inline-start" />
                Show live here
              </Button>
            )
          ) : (
            <Button size="sm" variant="ghost" onClick={onTogglePreview}>
              <ExternalLinkIcon data-icon="inline-start" />
              {previewOpen ? 'Close preview' : 'Open preview'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** A move that ends in a canvas corner becomes a preset corner snap. */
function snapCornerOf(
  rect: StageRect
): 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | null {
  if (
    (rect.x <= 0.06 || rect.x + rect.width >= 0.94) &&
    (rect.y <= 0.06 || rect.y + rect.height >= 0.94)
  )
    return `${rect.y <= 0.06 ? 'top' : 'bottom'}-${rect.x <= 0.06 ? 'left' : 'right'}`
  return null
}

function StageSelection({
  rect,
  stageH,
  scale,
  enabled,
  hitOnly = false,
  activeHandle,
  onHandle
}: {
  rect: StageRect
  stageH: number
  scale: number
  enabled: boolean
  /** Live canvas: the compositor draws the frame and handles; keep only the
   * transparent hit targets here. */
  hitOnly?: boolean
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
        className={cn('fill-none stroke-foreground/70', hitOnly && 'invisible')}
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
                      className={cn('stroke-foreground/70', hitOnly && 'invisible')}
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
                    className={cn('fill-background stroke-foreground/80', hitOnly && 'invisible')}
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
