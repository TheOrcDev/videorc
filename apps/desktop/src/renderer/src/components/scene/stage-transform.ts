/**
 * Pure geometry for the SceneStage's direct-manipulation gestures: drag,
 * resize handles, and snap guides. No DOM here — the stage feeds normalized
 * pointer deltas in and renders the ghost/guides out, then commits ONCE per
 * gesture through the backend-owned scene commit
 * (`scene.source.transform.update`). The backend stays the only writer of
 * committed scene state; nothing in this module is a source of truth.
 */

/** A source box in scene-normalized coordinates (0..1 of the canvas). */
export interface StageRect {
  x: number
  y: number
  width: number
  height: number
}

/** The eight resize handles, named by compass position. */
export type StageHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const STAGE_HANDLE_IDS: readonly StageHandleId[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w'
]

/**
 * Legacy normalized snapping retained for preset callers and compatibility
 * tests. Freeform uses CSS-pixel hysteresis in StageGesture and commits with
 * snap: none, so backend normalization cannot override precision intent.
 */
export const STAGE_SNAP_THRESHOLD = 0.015

/** Smallest canvas fraction a resize may leave per axis (5% of the canvas). */
export const MIN_SOURCE_FRACTION = 0.05

/** A snap guide line to draw across the canvas while a ghost is magnetized. */
export interface SnapGuide {
  axis: 'x' | 'y'
  position: number
}

export interface SnapTargets {
  x: number[]
  y: number[]
}

export interface GhostResult {
  rect: StageRect
  guides: SnapGuide[]
}

/**
 * Snap targets for a drag: the canvas edges and center lines, plus the edges
 * and centers of every OTHER source box (align-to-sibling).
 */
export function stageSnapTargets(others: StageRect[]): SnapTargets {
  const x = [0, 0.5, 1]
  const y = [0, 0.5, 1]
  for (const rect of others) {
    x.push(rect.x, rect.x + rect.width / 2, rect.x + rect.width)
    y.push(rect.y, rect.y + rect.height / 2, rect.y + rect.height)
  }
  return { x: [...new Set(x)], y: [...new Set(y)] }
}

export interface MoveInput {
  start: StageRect
  /** Pointer delta in normalized canvas units. */
  dx: number
  dy: number
  /** Shift: constrain the move to the dominant axis. */
  constrainAxis: boolean
  /** Bypass the legacy stateless snap calculation. */
  disableSnap: boolean
  targets: SnapTargets
}

/** Ghost position for a move gesture: clamp to the canvas, then magnetize. */
export function moveGhost(input: MoveInput): GhostResult {
  let dx = input.dx
  let dy = input.dy
  if (input.constrainAxis) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      dy = 0
    } else {
      dx = 0
    }
  }
  let x = clampPosition(input.start.x + dx, input.start.width)
  let y = clampPosition(input.start.y + dy, input.start.height)
  const guides: SnapGuide[] = []
  if (!input.disableSnap) {
    const snappedX = snapAxis(x, input.start.width, input.targets.x)
    if (snappedX) {
      x = clampPosition(snappedX.position, input.start.width)
      guides.push({ axis: 'x', position: snappedX.target })
    }
    const snappedY = snapAxis(y, input.start.height, input.targets.y)
    if (snappedY) {
      y = clampPosition(snappedY.position, input.start.height)
      guides.push({ axis: 'y', position: snappedY.target })
    }
  }
  return { rect: { ...input.start, x, y }, guides }
}

export interface ResizeInput {
  start: StageRect
  handle: StageHandleId
  /** Pointer delta in normalized canvas units. */
  dx: number
  dy: number
  /**
   * Keep the box's aspect. The stage shares the inspector's preference;
   * shaped sources remain locked because the mask law owns their aspect.
   */
  lockAspect: boolean
  /** Painted canvas size in CSS pixels; projection must respect screen-space aspect. */
  canvasWidth?: number
  canvasHeight?: number
  minFraction?: number
}

/**
 * Ghost box for a resize gesture. The edge(s) named by the handle follow the
 * pointer; the opposite edge (or center line, for aspect-locked edge pulls)
 * anchors. Sizes clamp to [minFraction, canvas] and the box never leaves the
 * canvas. No snapping on resize — size is precision intent, like nudges.
 */
export function resizeGhost(input: ResizeInput): GhostResult {
  const min = input.minFraction ?? MIN_SOURCE_FRACTION
  const start = input.start
  const movesLeft = input.handle.includes('w')
  const movesRight = input.handle.includes('e')
  const movesTop = input.handle.includes('n')
  const movesBottom = input.handle.includes('s')
  const isCorner = (movesLeft || movesRight) && (movesTop || movesBottom)

  const left = start.x
  const top = start.y
  const right = start.x + start.width
  const bottom = start.y + start.height

  if (input.lockAspect) {
    // Project onto the fixed-aspect resize vector in CSS pixels. Unlike a
    // dominant-axis switch, this stays continuous through diagonal reversals.
    const widthDelta = movesLeft ? -input.dx : movesRight ? input.dx : 0
    const heightDelta = movesTop ? -input.dy : movesBottom ? input.dy : 0
    const scaleFromWidth = start.width > 0 ? (start.width + widthDelta) / start.width : 1
    const scaleFromHeight = start.height > 0 ? (start.height + heightDelta) / start.height : 1
    let scale: number
    if (isCorner) {
      const vx = start.width * (input.canvasWidth ?? 1)
      const vy = start.height * (input.canvasHeight ?? 1)
      const lengthSquared = vx * vx + vy * vy
      scale =
        lengthSquared > 0
          ? (scaleFromWidth * vx * vx + scaleFromHeight * vy * vy) / lengthSquared
          : 1
    } else if (movesLeft || movesRight) {
      scale = scaleFromWidth
    } else {
      scale = scaleFromHeight
    }

    // Anchor: the opposite corner for corner handles; for edge handles the
    // opposite edge anchors the pulled axis and the box stays centered on the
    // other axis.
    const anchorX = movesLeft ? right : movesRight ? left : (left + right) / 2
    const anchorY = movesTop ? bottom : movesBottom ? top : (top + bottom) / 2

    // Clamp the scale so both axes respect the minimum and the box stays on
    // the canvas from its anchor.
    const availableWidth = movesLeft
      ? anchorX
      : movesRight
        ? 1 - anchorX
        : availableCentered(anchorX)
    const availableHeight = movesTop
      ? anchorY
      : movesBottom
        ? 1 - anchorY
        : availableCentered(anchorY)
    const maxScale = Math.min(
      start.width > 0 ? availableWidth / start.width : 1,
      start.height > 0 ? availableHeight / start.height : 1
    )
    const minScale = Math.max(
      start.width > 0 ? min / start.width : 1,
      start.height > 0 ? min / start.height : 1
    )
    scale = Math.min(Math.max(scale, minScale), Math.max(maxScale, minScale))

    const width = start.width * scale
    const height = start.height * scale
    const x = movesLeft ? anchorX - width : movesRight ? anchorX : anchorX - width / 2
    const y = movesTop ? anchorY - height : movesBottom ? anchorY : anchorY - height / 2
    return { rect: clampRect({ x, y, width, height }), guides: [] }
  }

  const newLeft = movesLeft ? clamp(left + input.dx, 0, right - min) : left
  const newRight = movesRight ? clamp(right + input.dx, left + min, 1) : right
  const newTop = movesTop ? clamp(top + input.dy, 0, bottom - min) : top
  const newBottom = movesBottom ? clamp(bottom + input.dy, top + min, 1) : bottom
  return {
    rect: clampRect({
      x: newLeft,
      y: newTop,
      width: newRight - newLeft,
      height: newBottom - newTop
    }),
    guides: []
  }
}

/** A screen's crop, as fractions of its own picture (the scene's crop fields). */
export interface StageCrop {
  cropLeft: number
  cropTop: number
  cropRight: number
  cropBottom: number
}

export const NO_STAGE_CROP: StageCrop = { cropLeft: 0, cropTop: 0, cropRight: 0, cropBottom: 0 }

/** The least of the picture a crop leaves per axis: the backend's 95% ceiling. */
export const MIN_CROP_KEPT = 0.05

export interface CropInput {
  start: StageRect
  crop: StageCrop
  handle: StageHandleId
  /** Pointer delta in normalized canvas units. */
  dx: number
  dy: number
  minFraction?: number
}

export interface CropResult extends GhostResult {
  crop: StageCrop
}

/**
 * ⌥-drag on an edge crops instead of resizing (plan 213 G2, OBS's habit).
 * Each edge the handle names follows the pointer and cuts the picture there,
 * so what stays on screen does not move or scale: the crop on that side
 * changes by the share of the picture the edge passed over. An edge stops at
 * the picture's own edge (no crop), at 5% of the picture left, at the
 * smallest box and at the canvas. No snapping, like a resize.
 */
export function cropGhost(input: CropInput): CropResult {
  const min = input.minFraction ?? MIN_SOURCE_FRACTION
  const start = input.start
  const crop = { ...input.crop }
  let { x, y, width, height } = start
  const keptX = 1 - crop.cropLeft - crop.cropRight
  const keptY = 1 - crop.cropTop - crop.cropBottom
  // The share of the picture one canvas unit of the box shows, per axis.
  const perX = start.width > 0 ? keptX / start.width : 0
  const perY = start.height > 0 ? keptY / start.height : 0
  // Push in: more crop, a smaller box. Pull out: back toward the picture's edge.
  const travel = (delta: number, outward: number, inward: number): number =>
    clamp(delta, -outward, Math.max(-outward, inward))
  if (perX > 0 && input.handle.includes('w')) {
    const moved = travel(
      input.dx,
      Math.min(crop.cropLeft / perX, x),
      Math.min((keptX - MIN_CROP_KEPT) / perX, width - min)
    )
    x += moved
    width -= moved
    crop.cropLeft += moved * perX
  } else if (perX > 0 && input.handle.includes('e')) {
    const moved = -travel(
      -input.dx,
      Math.min(crop.cropRight / perX, 1 - (x + width)),
      Math.min((keptX - MIN_CROP_KEPT) / perX, width - min)
    )
    width += moved
    crop.cropRight -= moved * perX
  }
  if (perY > 0 && input.handle.includes('n')) {
    const moved = travel(
      input.dy,
      Math.min(crop.cropTop / perY, y),
      Math.min((keptY - MIN_CROP_KEPT) / perY, height - min)
    )
    y += moved
    height -= moved
    crop.cropTop += moved * perY
  } else if (perY > 0 && input.handle.includes('s')) {
    const moved = -travel(
      -input.dy,
      Math.min(crop.cropBottom / perY, 1 - (y + height)),
      Math.min((keptY - MIN_CROP_KEPT) / perY, height - min)
    )
    height += moved
    crop.cropBottom -= moved * perY
  }
  const side = (value: number): number => clamp(value, 0, 0.95)
  return {
    rect: { x, y, width, height },
    crop: {
      cropLeft: side(crop.cropLeft),
      cropTop: side(crop.cropTop),
      cropRight: side(crop.cropRight),
      cropBottom: side(crop.cropBottom)
    },
    guides: []
  }
}

/** The crop fields of a scene transform (zero for a transform with none). */
export function stageCropOf(transform: Partial<StageCrop>): StageCrop {
  return {
    cropLeft: transform.cropLeft ?? 0,
    cropTop: transform.cropTop ?? 0,
    cropRight: transform.cropRight ?? 0,
    cropBottom: transform.cropBottom ?? 0
  }
}

/** Four decimals, like a rect's commit (0.01% of the picture). */
export function roundCropForCommit(crop: StageCrop): StageCrop {
  const round = (value: number): number => Math.round(value * 10000) / 10000
  return {
    cropLeft: round(crop.cropLeft),
    cropTop: round(crop.cropTop),
    cropRight: round(crop.cropRight),
    cropBottom: round(crop.cropBottom)
  }
}

/** Handle center points (normalized) for rendering the selection frame. */
export function stageHandlePoints(rect: StageRect): { id: StageHandleId; x: number; y: number }[] {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const right = rect.x + rect.width
  const bottom = rect.y + rect.height
  return [
    { id: 'nw', x: rect.x, y: rect.y },
    { id: 'n', x: cx, y: rect.y },
    { id: 'ne', x: right, y: rect.y },
    { id: 'e', x: right, y: cy },
    { id: 'se', x: right, y: bottom },
    { id: 's', x: cx, y: bottom },
    { id: 'sw', x: rect.x, y: bottom },
    { id: 'w', x: rect.x, y: cy }
  ]
}

/** CSS cursor for a resize handle. */
export function handleCursor(handle: StageHandleId): string {
  switch (handle) {
    case 'nw':
    case 'se':
      return 'nwse-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'n':
    case 's':
      return 'ns-resize'
    default:
      return 'ew-resize'
  }
}

/**
 * Round a rect for commit. The backend keeps floats fine, but four decimals
 * (0.01% of the canvas) keeps persisted transforms and the Inspector's
 * numeric fields readable without any visible geometry change.
 */
export function roundRectForCommit(rect: StageRect): StageRect {
  const round = (value: number): number => Math.round(value * 10000) / 10000
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height)
  }
}

function snapAxis(
  position: number,
  size: number,
  targets: number[]
): { position: number; target: number } | null {
  // Candidate alignment lines of the moving box: leading edge, center,
  // trailing edge — each maps a matched target back to a box position.
  const candidates = [
    { edge: position, toPosition: (target: number) => target },
    { edge: position + size / 2, toPosition: (target: number) => target - size / 2 },
    { edge: position + size, toPosition: (target: number) => target - size }
  ]
  let best: { position: number; target: number; distance: number } | null = null
  for (const target of targets) {
    for (const candidate of candidates) {
      const distance = Math.abs(candidate.edge - target)
      if (distance <= STAGE_SNAP_THRESHOLD && (!best || distance < best.distance)) {
        best = { position: candidate.toPosition(target), target, distance }
      }
    }
  }
  return best ? { position: best.position, target: best.target } : null
}

/** Clamp a box position so it stays on the canvas (oversized boxes center-clamp). */
function clampPosition(position: number, size: number): number {
  const low = Math.min(0, 1 - size)
  const high = Math.max(0, 1 - size)
  return clamp(position, low, high)
}

/** Space available to a box centered at `center` without leaving the canvas. */
function availableCentered(center: number): number {
  return Math.max(0, Math.min(center, 1 - center) * 2)
}

function clampRect(rect: StageRect): StageRect {
  const width = clamp(rect.width, 0, 1)
  const height = clamp(rect.height, 0, 1)
  return {
    x: clampPosition(rect.x, width),
    y: clampPosition(rect.y, height),
    width,
    height
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/** Mirror the compositor mask in viewBox units without changing editing bounds. */
export function stageSourceShape(
  rect: StageRect,
  canvasWidth: number,
  canvasHeight: number,
  shape: 'circle' | 'rounded' | 'rectangle',
  cornerRadiusPct: number
):
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx: number } {
  const x = rect.x * canvasWidth,
    y = rect.y * canvasHeight
  const width = rect.width * canvasWidth,
    height = rect.height * canvasHeight
  if (shape === 'circle')
    return { kind: 'circle', cx: x + width / 2, cy: y + height / 2, r: Math.min(width, height) / 2 }
  return {
    kind: 'rect',
    x,
    y,
    width,
    height,
    rx:
      shape === 'rounded'
        ? (Math.min(width, height) * Math.min(Math.max(cornerRadiusPct, 0), 50)) / 100
        : 0
  }
}
