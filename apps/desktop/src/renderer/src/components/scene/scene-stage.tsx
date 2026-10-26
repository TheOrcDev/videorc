import {
  CameraIcon,
  CaptionsIcon,
  ChatIcon,
  DisplayIcon,
  ExternalLinkIcon,
  BuddyIcon,
  ImageIcon,
  PreviewIcon
} from '@/components/icons'
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ElementType,
  type ReactElement
} from 'react'

import { Button } from '@/components/ui/button'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { Separator } from '@/components/ui/separator'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type {
  CameraShape,
  EffectiveSceneBackground,
  OverlayItem,
  Scene,
  SceneEditorDraftParams,
  SceneSource
} from '@/lib/backend'
import { backgroundAssetDisplayUrl } from '@/lib/background-library'
import {
  createEditorDraftChannel,
  type EditorDraftChannel,
  type EditorDraftSample
} from '@/lib/editor-draft-channel'
import { cn } from '@/lib/utils'
import { openWorkspaceTab } from '@/lib/workspace-navigation'
import {
  overlayRectToStage,
  stageItemSnapPeers,
  stageRectToOverlay,
  type OverlayStageItem,
  type StageItemDraft
} from './overlay-stage'
import { stageNudgeForKey } from './stage-nudge'
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
import { WINDOW_NAMES } from '../../../../shared/window-names'

/** The invisible outline that drags a selected overlay item (CSS px). */
const OVERLAY_GRAB_STROKE_PX = 10
/** The label chip's hit width (CSS px); clamped to the item's own width. */
const OVERLAY_CHIP_HIT_W_PX = 120

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
  /** Set while the pointer owns an overlay item or a banner instead of a scene source. */
  item?: OverlayStageItem
}

/** Items drawn over the sources (plan 164, D15; plan 186): the overlay items
 * and the banners, placed like sources and committed by the owner of
 * `onCommit` (`overlays.layout.set`, `banners.update`). Drawn in array order,
 * so later items are on top. */
export interface StageOverlays {
  items: OverlayStageItem[]
  /** The selected item's stage id (`overlayStageId`, `bannerStageId`), or null. */
  selectedId: string | null
  /** Released rects, shown until their commits land. */
  drafts: readonly StageItemDraft[]
  editable: boolean
  onSelect: (entry: OverlayStageItem) => void
  onCommit: (entry: OverlayStageItem, rect: StageRect) => void
}

const OVERLAY_ICONS: Record<OverlayItem, ElementType> = {
  highlight: ChatIcon,
  captions: CaptionsIcon,
  buddy: BuddyIcon
}
const stageItemIcon = (entry: OverlayStageItem): ElementType =>
  entry.kind === 'overlay' ? OVERLAY_ICONS[entry.item] : ImageIcon
type StageGhost = GhostResult & { sourceId: string }

/** What the stage is doing: a pointer gesture, a released commit still landing, or nothing. */
export type StagePhase = 'idle' | 'dragging' | 'pending'

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
  onPhaseChange,
  onSelectSource,
  onTogglePreview,
  onCommitTransform,
  onSnapCorner,
  onRequestFreeform,
  onNudge,
  onUndo,
  undoEnabled = true,
  overlays
}: {
  scene: Scene | null
  selectedSourceId: string | null
  /** Overlay items drawn after the sources; absent on canvases that place none. */
  overlays?: StageOverlays
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
   * Pop out / Show preview here instead of the plain open/close toggle. */
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
  /** The stage's phase, so the owner can tell a pointer gesture from a commit
   * still landing (plan 174 S3.9, C-5: the inspector goes inert only for the gesture). */
  onPhaseChange?: (phase: StagePhase) => void
  onSelectSource: (sourceId: string) => void
  onTogglePreview: () => void
  onCommitTransform?: StageCommit
  onSnapCorner?: (corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right') => void
  onRequestFreeform?: () => void
  /** Arrow keys on the focused canvas nudge the selected source (plan 174 S3.9, C-31). */
  onNudge?: (sourceId: string, directionX: number, directionY: number, large: boolean) => void
  /** Present while there is a layout change to take back: the footer offers
   * Undo (D15). Its presence never follows the gesture: the footer must not
   * reflow at pointerdown (see `stage-undo-control.ts`). */
  onUndo?: () => void
  /** Undo can run now (no scene switch or precise edit in flight); the stage
   * also disables it for its own gesture or pending commit. */
  undoEnabled?: boolean
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
  const phase: StagePhase = ghost
    ? 'dragging'
    : edits.draft || overlays?.drafts.length || externalPending
      ? 'pending'
      : 'idle'
  useLayoutEffect(() => {
    onPhaseChange?.(phase)
  }, [onPhaseChange, phase])
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
  // The one selected thing on the stage: a scene source, an overlay item or a banner.
  const selectedItemId = overlays?.selectedId ?? null
  const selectedStageId = selectedSourceId ?? selectedItemId
  useLayoutEffect(() => {
    if (gestureRef.current && gestureRef.current.motion.sourceId !== selectedStageId)
      cancelGesture()
    if (edits.draft && edits.draft.sourceId !== selectedSourceId) edits.invalidate()
  }, [cancelGesture, edits, selectedSourceId, selectedStageId])
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
    // Any scroll moves the stage under the pointer, so the gesture ends. A
    // page that shrinks at pointerdown scrolls too (a pane at its end clamps
    // its scrollTop): nothing on the page may change size when a gesture
    // starts (the footer's Undo, the inspector's copy; see stage-undo-control).
    window.addEventListener('scroll', cancelGesture, true)
    return () => {
      mountedRef.current = false
      cancelGesture()
      edits.invalidate()
      observer.disconnect()
      onPhaseChange?.('idle')
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', cancelGesture)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', cancelGesture, true)
    }
  }, [cancelGesture, edits, onPhaseChange])

  const editable = (source: SceneSource): boolean =>
    !source.locked && (freeform || source.transform.width < 1 || source.transform.height < 1)
  const displayed = (source: SceneSource): StageRect =>
    ghost?.sourceId === source.id
      ? ghost.rect
      : edits.draft?.sourceId === source.id
        ? edits.draft.rect
        : source.transform
  /** Output pixels per CSS pixel of the canvas, as estimated from the session's
   * output width (the schema caps it at 64; a canvas that small has no visible
   * chrome anyway). Only a fallback: the compositor sizes the chrome from
   * `slotCssWidth` and the frame it really draws into, which on the native
   * preview run is the slot's device size, not the output width. */
  const chromeScale = (canvasWidth: number): number =>
    outputWidth && canvasWidth > 0 ? Math.min(64, Math.max(0, outputWidth / canvasWidth)) : 1
  /** The canvas's on-screen width in CSS px, when it is measured. */
  const chromeSlotWidth = (canvasWidth: number): { slotCssWidth: number } | Record<never, never> =>
    Number.isFinite(canvasWidth) && canvasWidth >= 1 ? { slotCssWidth: canvasWidth } : {}
  /** One live-draft frame: the ghost plus the chrome the compositor draws for it. */
  const draftOf = (gesture: ActiveGesture, ghost: GhostResult): EditorDraftSample => {
    const source = sources.find((candidate) => candidate.id === gesture.motion.sourceId)
    const kind = gesture.motion.kind
    return {
      transform: ghost.rect,
      chrome: {
        selected: ghost.rect,
        handles: gesture.item
          ? Boolean(overlays?.editable)
          : resizeEnabled && Boolean(source && editable(source)),
        ...(kind !== 'move' ? { activeHandle: kind } : {}),
        guides: ghost.guides,
        scale: chromeScale(gesture.motion.pixels.width),
        ...chromeSlotWidth(gesture.motion.pixels.width)
      }
    }
  }
  const selectedSource = sources.find((source) => source.id === selectedSourceId)
  const overlayItems = overlays?.items ?? []
  const displayedOverlay = (entry: OverlayStageItem): StageRect =>
    ghost?.sourceId === entry.stageId
      ? ghost.rect
      : (overlays?.drafts.find((draft) => draft.stageId === entry.stageId)?.rect ?? entry.rect)
  const selectedOverlay = overlayItems.find((entry) => entry.stageId === selectedItemId)
  // The idle selection on the live canvas: hold a chrome-only draft for the
  // selected source so its frame and handles stay on the real picture between
  // gestures. Keyed on the DISPLAYED rect minus the ghost (a gesture suspends
  // the hold in the channel; its samples must not fight it here), and paused
  // while this stage's own commit is pending: the released draft carries the
  // new rect until that commit installs, and a hold sent before then would
  // replace it and let the picture snap back. When the committed scene lands
  // the rect changes, and the hold follows it.
  // A released banner gesture is held the same way (plan 186): its final
  // draft keeps the picture where it was dropped until `banners.update` lands.
  const ownCommitPending =
    edits.draft?.sourceId === selectedSourceId ||
    (!selectedSource &&
      selectedOverlay?.kind === 'banner' &&
      Boolean(overlays?.drafts.some((draft) => draft.stageId === selectedOverlay.stageId)))
  // A selected overlay item or banner holds the same chrome-only draft under
  // its own stage id (`overlay:<item>`, `banner:<id>`): the backend draws the
  // frame and handles on the live picture; for an overlay item, knowing no
  // such source, it moves nothing (plan 164).
  const heldId = draftEnabled
    ? (selectedSource?.id ?? (selectedOverlay ? selectedOverlay.stageId : null))
    : null
  const heldRect = selectedSource
    ? edits.draft?.sourceId === selectedSource.id
      ? edits.draft.rect
      : selectedSource.transform
    : selectedOverlay
      ? displayedOverlay(selectedOverlay)
      : null
  const heldX = heldRect?.x ?? 0
  const heldY = heldRect?.y ?? 0
  const heldWidth = heldRect?.width ?? 0
  const heldHeight = heldRect?.height ?? 0
  const heldHandles = selectedSource
    ? Boolean(resizeEnabled && editable(selectedSource))
    : Boolean(selectedOverlay && overlays?.editable)
  const heldScale = chromeScale(pixelScale * STAGE_W)
  const heldSlotWidth = pixelScale * STAGE_W
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
      scale: heldScale,
      ...chromeSlotWidth(heldSlotWidth)
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
    heldScale,
    heldSlotWidth
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
  /** Grab an overlay item or a banner: the same pointer ownership and ghost
   * maths as a source, snapping to sources and its peers (an overlay item to
   * the other items, a banner to the other banners: `stageItemSnapPeers`),
   * released as ONE `overlays.layout.set` or `banners.update` by the owner
   * (never a scene commit). A banner's resize keeps its image's aspect, Shift
   * or not. */
  const beginOverlayGesture = (
    entry: OverlayStageItem,
    kind: 'move' | StageHandleId,
    event: React.PointerEvent<Element>
  ): void => {
    if (!overlays) return
    if (event.button !== 0 || !event.isPrimary || gestureRef.current || externalPending) return
    overlays.onSelect(entry)
    if (!overlays.editable) return
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
    const initial = { ...displayedOverlay(entry) }
    const motion = new StageGesture(
      entry.stageId,
      event.pointerId,
      kind,
      initial,
      point,
      stagePixelSize(mapping),
      stageSnapTargets([
        ...sources.map(displayed),
        ...stageItemSnapPeers(entry, overlayItems).map(displayedOverlay)
      ]),
      effectiveSnap,
      entry.aspectLocked,
      entry.aspectLocked
    )
    motion.sample(point, event)
    gestureRef.current = {
      motion,
      mapping,
      initial,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      item: entry
    }
    svg.setPointerCapture(event.pointerId)
    setGhost({ sourceId: entry.stageId, rect: initial, guides: [] })
    channel.begin(entry.stageId)
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
    if (gesture.item) {
      // No scene revision will end this draft. An overlay item's is cleared
      // with the gesture, and the hold (its frame) takes over on the live
      // picture. A banner's last frame is released instead, carrying the
      // clamped rect `banners.update` stores, so its picture stays where it
      // was dropped; the hold returns once the update lands (plan 186).
      if (changed && gesture.item.kind === 'banner')
        channel.release(overlayRectToStage(stageRectToOverlay(final.rect)))
      cancelGesture()
      if (changed) overlays?.onCommit(gesture.item, final.rect)
      return
    }
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
  // The label chips on the schematic (sources and overlay items): 11 px type
  // and 4 px padding on screen, whatever the canvas scale.
  const labelPx = 11 / pixelScale
  const padPx = 4 / pixelScale
  const chipH = 16 / pixelScale
  /** Arrow keys on the focused canvas: a nudge of the selected, editable
   * source. Dropped while a gesture or a commit is in flight (never queued),
   * like the inspector's own edits. */
  const nudgeFromKey = (event: React.KeyboardEvent<SVGSVGElement>): void => {
    if (!onNudge || !selectedSource || !dragEnabled || !editable(selectedSource)) return
    if (phase !== 'idle') return
    const nudge = stageNudgeForKey(event)
    if (!nudge) return
    event.preventDefault()
    onNudge(selectedSource.id, nudge.directionX, nudge.directionY, nudge.large)
  }
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
          type="single"
          value={selectedStageId ?? ''}
          onValueChange={(value) => {
            if (!value) return
            cancelGesture()
            const overlay = overlayItems.find((entry) => entry.stageId === value)
            if (overlay) overlays?.onSelect(overlay)
            else onSelectSource(value)
          }}
        >
          {sources.map((source) => (
            <ToggleGroupItem key={source.id} aria-label={`Select ${source.name}`} value={source.id}>
              {source.kind === 'camera' ? (
                <CameraIcon data-icon="inline-start" />
              ) : (
                <DisplayIcon data-icon="inline-start" />
              )}
              {/* A long name truncates: the title on the cut text reveals it (S1.10). */}
              <span className="max-w-44 truncate" title={source.name}>
                {source.name}
              </span>
            </ToggleGroupItem>
          ))}
          {/* The three overlay items, then the banners on the stage: the
              banners come and go, so they trail the fixed chips. */}
          {[
            ...overlayItems.filter((entry) => entry.kind === 'overlay'),
            ...overlayItems.filter((entry) => entry.kind === 'banner')
          ].map((entry) => {
            const Icon = stageItemIcon(entry)
            return (
              <ToggleGroupItem
                key={entry.stageId}
                aria-label={`Select ${entry.label}`}
                data-videorc-stage-banner-chip={entry.kind === 'banner' ? entry.id : undefined}
                data-videorc-stage-overlay-chip={entry.kind === 'overlay' ? entry.item : undefined}
                value={entry.stageId}
              >
                <Icon data-icon="inline-start" />
                {/* The stream-only or recording-only badge is on the stage itself. */}
                <span className="max-w-44 truncate" title={entry.label}>
                  {entry.label}
                </span>
              </ToggleGroupItem>
            )
          })}
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
            // Focusable (plan 174 S3.9, C-31): a click on a source lands the
            // keyboard here, and the arrows nudge it. The ring sits on the
            // canvas box, which the docked surface never covers by more than
            // its own rect.
            className="block h-full w-full touch-none overflow-visible rounded-panel outline-hidden select-none focus-visible:ring-2 focus-visible:ring-ring"
            data-videorc-stage-live={liveSurface ? 'true' : undefined}
            role="group"
            tabIndex={0}
            viewBox={`0 0 ${STAGE_W} ${stageH}`}
            onKeyDown={nudgeFromKey}
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
              {sources.map((source, index) => {
                const rect = displayed(source),
                  width = rect.width * STAGE_W,
                  height = rect.height * stageH
                // The source's name on the schematic (plan 174 S3.9, C-34),
                // clipped to its own box; a box too short for the chip has
                // none. It is a SIBLING of the source group, drawn right after
                // it (so it stays under later sources): a clip hides the
                // overflow of a long name in a narrow box, but SVG bounds
                // ignore clips, and inside the group the name would widen
                // the rect that `[data-videorc-stage-source]` reports to the
                // smokes and probes as the source's own box (the portrait
                // freeform matrix measured 79 px for a 43 px source).
                const labelClipId = `${clipId}-source-${index}`
                const labelled = height >= chipH + 2 * padPx
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
                  <Fragment key={source.id}>
                    <g
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
                    {labelled ? (
                      <g pointerEvents="none">
                        <clipPath id={labelClipId}>
                          <rect
                            x={rect.x * STAGE_W}
                            y={rect.y * stageH}
                            width={width}
                            height={height}
                          />
                        </clipPath>
                        <g
                          className={cn(
                            !source.visible && 'opacity-40',
                            liveSurface && 'invisible'
                          )}
                          clipPath={`url(#${labelClipId})`}
                          transform={`translate(${rect.x * STAGE_W + padPx} ${rect.y * stageH + padPx})`}
                        >
                          <text
                            className="fill-foreground/80"
                            data-videorc-stage-source-label={source.id}
                            dominantBaseline="middle"
                            fontSize={labelPx}
                            fontWeight={600}
                            x={padPx}
                            y={chipH / 2}
                          >
                            {source.name}
                          </text>
                        </g>
                      </g>
                    ) : null}
                  </Fragment>
                )
              })}
              {/* Overlay items (plan 164, D15) and banners (plan 186): a
                  second item layer after the sources, banners first (D5:
                  under the overlay items). Dashed hairline rects with a label
                  chip; a "stream only" / "recording only" badge when the
                  item's two output switches differ, and an item both
                  switches turn off, or a selected banner that is hidden, is
                  drawn dimmed with an "off" or "hidden" chip (plan 174,
                  C-13). Hidden under the live surface like every painted
                  element; the hit targets stay. */}
              {overlayItems.map((entry) => {
                const rect = displayedOverlay(entry)
                const selected = selectedItemId === entry.stageId
                return (
                  <g
                    key={entry.stageId}
                    data-videorc-stage-banner={entry.kind === 'banner' ? entry.id : undefined}
                    data-videorc-stage-overlay={entry.kind === 'overlay' ? entry.item : undefined}
                    data-videorc-stage-overlay-off={entry.off ? 'true' : undefined}
                    className={
                      overlays?.editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
                    }
                    onClick={(event) => {
                      if (event.button === 0 && !externalPending) overlays?.onSelect(entry)
                    }}
                    onPointerDown={(event) => beginOverlayGesture(entry, 'move', event)}
                  >
                    {/* Overlay items sit above the sources, so an unselected
                        overlay item takes the pointer only on its label chip
                        (the toolbar chips select it too); once selected, its
                        interior and outline drag it. A source underneath
                        stays clickable everywhere else (the preview-window
                        probe's scene-hit-only gate). A banner is a picture on
                        the canvas, so its whole rect grabs it, selected or
                        not, unless it fills the canvas (`grabsBody`). */}
                    <rect
                      data-videorc-stage-overlay-bounds
                      x={rect.x * STAGE_W}
                      y={rect.y * stageH}
                      width={rect.width * STAGE_W}
                      height={rect.height * stageH}
                      fill="transparent"
                      pointerEvents={selected || entry.grabsBody ? 'all' : 'none'}
                    />
                    <rect
                      data-videorc-stage-overlay-grab
                      x={rect.x * STAGE_W}
                      y={rect.y * stageH}
                      width={rect.width * STAGE_W}
                      height={rect.height * stageH}
                      fill="none"
                      pointerEvents={selected ? 'stroke' : 'none'}
                      stroke="transparent"
                      strokeWidth={OVERLAY_GRAB_STROKE_PX}
                      vectorEffect="non-scaling-stroke"
                    />
                    <rect
                      data-videorc-stage-overlay-chip-hit
                      x={rect.x * STAGE_W}
                      y={rect.y * stageH}
                      width={Math.min(rect.width * STAGE_W, OVERLAY_CHIP_HIT_W_PX / pixelScale)}
                      height={Math.min(rect.height * stageH, chipH + 2 * padPx)}
                      fill="transparent"
                      pointerEvents="all"
                    />
                    <rect
                      className={cn(
                        'fill-none stroke-foreground/30',
                        selected && 'stroke-foreground/60',
                        entry.off && 'opacity-40',
                        liveSurface && 'invisible'
                      )}
                      pointerEvents="none"
                      strokeDasharray="4 3"
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                      x={rect.x * STAGE_W}
                      y={rect.y * stageH}
                      width={rect.width * STAGE_W}
                      height={rect.height * stageH}
                    />
                    <g
                      className={cn(entry.off && 'opacity-40', liveSurface && 'invisible')}
                      pointerEvents="none"
                      transform={`translate(${rect.x * STAGE_W + padPx} ${rect.y * stageH + padPx})`}
                    >
                      <text
                        className="fill-foreground/80"
                        data-videorc-stage-overlay-label
                        dominantBaseline="middle"
                        fontSize={labelPx}
                        fontWeight={600}
                        x={padPx}
                        y={chipH / 2}
                      >
                        {entry.label}
                        {entry.badge ? (
                          <tspan
                            className="fill-muted-foreground"
                            data-videorc-stage-overlay-badge={entry.badge}
                            dx={padPx}
                            fontWeight={400}
                          >
                            {entry.badge}
                          </tspan>
                        ) : null}
                      </text>
                    </g>
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
            ) : selectedOverlay ? (
              <StageSelection
                rect={displayedOverlay(selectedOverlay)}
                activeHandle={activeHandle}
                stageH={stageH}
                scale={pixelScale}
                enabled={Boolean(overlays?.editable)}
                hitOnly={liveSurface}
                onHandle={(handle, event) => beginOverlayGesture(selectedOverlay, handle, event)}
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
        // The next step rides with the empty state (plan 174, C-21): devices
        // are chosen on Sources, never here.
        <p className="flex flex-wrap items-center justify-center gap-x-1 px-3 pb-3 text-center text-xs text-muted-foreground">
          No sources in the scene yet. Choose a screen or a camera in Sources.
          <Button
            className="h-auto p-0 text-xs font-normal"
            size="xs"
            variant="link"
            onClick={() => openWorkspaceTab('sources')}
          >
            Open Sources
          </Button>
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
        <div className="flex min-h-7 min-w-0 flex-1 items-center pl-1 text-xs text-muted-foreground">
          {liveHint ? (
            <span className="truncate" data-videorc-stage-live-hint title={liveHint}>
              {liveHint}
            </span>
          ) : dragEnabled || overlays?.editable ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {dragEnabled && onNudge ? (
                <span className="inline-flex items-center gap-1.5" data-videorc-stage-nudge-hint>
                  <span className="inline-flex items-center gap-0.5">
                    <ShortcutKeys accelerator="Left" />
                    <ShortcutKeys accelerator="Up" />
                    <ShortcutKeys accelerator="Down" />
                    <ShortcutKeys accelerator="Right" />
                  </span>
                  nudge
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5">
                <ShortcutKeys accelerator="Shift" />
                {dragEnabled && onNudge
                  ? 'constrain / aspect / bigger nudge'
                  : 'constrain / aspect'}
              </span>
              {effectiveSnap ? (
                <span className="inline-flex items-center gap-1.5">
                  <ShortcutKeys accelerator="Alt" />
                  no snap
                </span>
              ) : null}
              <span className="inline-flex items-center gap-1.5">
                <ShortcutKeys accelerator="Escape" />
                cancel
              </span>
            </div>
          ) : null}
        </div>
        <div className="flex h-7 items-center gap-1">
          {/* Single-level undo of the last layout change (plan 174 S3.9,
              D15), here for the mouse; the key works anywhere on the page.
              Disabled, never unmounted, for a gesture or a commit in flight:
              a footer that reflows at pointerdown shrinks the page, a pane
              scrolled to its end clamps its scrollTop, and that scroll is
              the one the listener above cancels the gesture on. */}
          {onUndo ? (
            <>
              <Button
                data-videorc-stage-undo
                disabled={!undoEnabled || phase !== 'idle'}
                variant="ghost"
                onClick={onUndo}
              >
                Undo
                <ShortcutKeys accelerator="CmdOrCtrl+Z" />
              </Button>
              <Separator className="mx-1 my-1.5" orientation="vertical" />
            </>
          ) : null}
          {showFreeformHint && onRequestFreeform ? (
            <Button variant="ghost" onClick={onRequestFreeform}>
              Make freeform
            </Button>
          ) : null}
          {freeform ? (
            <>
              <Toggle
                aria-label="Snap"
                disabled={!dragEnabled || phase === 'dragging'}
                pressed={snap}
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
              <Button data-videorc-stage-pop-out variant="ghost" onClick={onPopOut}>
                <ExternalLinkIcon data-icon="inline-start" />
                Pop out
              </Button>
            ) : (
              <Button data-videorc-stage-show-live variant="ghost" onClick={onShowLive}>
                <PreviewIcon data-icon="inline-start" />
                Show preview here
              </Button>
            )
          ) : (
            <Button variant="ghost" onClick={onTogglePreview}>
              <ExternalLinkIcon data-icon="inline-start" />
              {previewOpen ? `Close ${WINDOW_NAMES.preview}` : `Open ${WINDOW_NAMES.preview}`}
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
