import {
  OVERLAY_ITEMS,
  OVERLAY_RECT_MIN_SIZE,
  type CommentHighlightAnchor,
  type OverlayItem,
  type OverlayItemLayout,
  type OverlayLayout,
  type OverlayOrientation,
  type OverlayRect,
  type OverlaySnap
} from '../../../shared/backend'

// Overlay layout (plan 164, Phase B): the renderer-side mirror of
// `crates/videorc-backend/src/overlay_layout.rs`. Pure: defaults, snap
// presets, clamping for stage gestures, the one leg plan (D12) and the Go
// Live notices (D13). The shared fixture
// `protocol-fixtures/high-risk-contracts.json` pins the defaults in both
// languages; the leg-plan table is unit-tested in both.

const LANDSCAPE_SIDE_MARGIN = (0.04 * 9) / 16
const LANDSCAPE_EDGE_MARGIN = 0.04
const PORTRAIT_SIDE_MARGIN = (0.04 * 16) / 9
const PORTRAIT_TOP_MARGIN = 0.08
const PORTRAIT_BOTTOM_MARGIN = 0.22

export const OVERLAY_ITEM_LABELS: Record<OverlayItem, string> = {
  highlight: 'Highlight',
  captions: 'Captions',
  golem: 'Golem'
}

/** How a Go Live sentence names the item mid-sentence (mirrors Rust). */
const OVERLAY_ITEM_SENTENCE_LABELS: Record<OverlayItem, string> = {
  highlight: 'highlights',
  captions: 'captions',
  golem: 'the Golem'
}

export const OVERLAY_SNAPS: readonly OverlaySnap[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'bottom-center'
]

export const OVERLAY_SNAP_LABELS: Record<OverlaySnap, string> = {
  'top-left': 'Top left',
  'top-right': 'Top right',
  'bottom-left': 'Bottom left',
  'bottom-right': 'Bottom right',
  'bottom-center': 'Bottom centre'
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/** Default size `[w, h]` of an item on an orientation (mirrors Rust). */
export function overlayDefaultSize(
  item: OverlayItem,
  orientation: OverlayOrientation
): [number, number] {
  const portrait = orientation === 'vertical'
  switch (item) {
    case 'highlight':
      return portrait ? [0.78, 0.2] : [0.6, 0.26]
    case 'captions':
      return portrait ? [0.76, 0.14] : [0.92, 0.16]
    case 'golem':
      return portrait ? [0.32, (0.32 * 9) / 16] : [0.18, (0.18 * 16) / 9]
  }
}

/** The rect a snap preset produces for an item on an orientation (mirrors Rust). */
export function overlaySnapRect(
  item: OverlayItem,
  orientation: OverlayOrientation,
  snap: OverlaySnap
): OverlayRect {
  const [w, h] = overlayDefaultSize(item, orientation)
  const portrait = orientation === 'vertical'
  const side = portrait ? PORTRAIT_SIDE_MARGIN : LANDSCAPE_SIDE_MARGIN
  const top = portrait ? PORTRAIT_TOP_MARGIN : LANDSCAPE_EDGE_MARGIN
  const bottom = portrait ? PORTRAIT_BOTTOM_MARGIN : LANDSCAPE_EDGE_MARGIN
  const x =
    snap === 'top-left' || snap === 'bottom-left'
      ? side
      : snap === 'top-right' || snap === 'bottom-right'
        ? 1 - side - w
        : (1 - w) / 2
  const y = snap === 'top-left' || snap === 'top-right' ? top : 1 - bottom - h
  return { x: round6(Math.max(0, x)), y: round6(Math.max(0, y)), w: round6(w), h: round6(h) }
}

/** The corner menu in Stream Manager maps onto the four corner snaps. */
export function overlaySnapFromAnchor(anchor: CommentHighlightAnchor): OverlaySnap {
  return anchor
}

function snappedItem(
  item: OverlayItem,
  snap: OverlaySnap,
  showOnStream: boolean,
  showInRecording: boolean
): OverlayItemLayout {
  return {
    horizontal: overlaySnapRect(item, 'horizontal', snap),
    vertical: overlaySnapRect(item, 'vertical', snap),
    showOnStream,
    showInRecording
  }
}

/** Mirrors `OverlayLayout::default()`; pinned by the shared fixture. */
export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = {
  highlight: snappedItem('highlight', 'bottom-left', true, true),
  captions: snappedItem('captions', 'bottom-center', false, false),
  golem: snappedItem('golem', 'bottom-right', false, false)
}

export function cloneOverlayLayout(layout: OverlayLayout): OverlayLayout {
  return {
    highlight: { ...layout.highlight },
    captions: { ...layout.captions },
    golem: { ...layout.golem }
  }
}

export function overlayRectsEqual(a: OverlayRect, b: OverlayRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
}

export function overlayLayoutsEqual(a: OverlayLayout, b: OverlayLayout): boolean {
  return OVERLAY_ITEMS.every(
    (item) =>
      overlayRectsEqual(a[item].horizontal, b[item].horizontal) &&
      overlayRectsEqual(a[item].vertical, b[item].vertical) &&
      a[item].showOnStream === b[item].showOnStream &&
      a[item].showInRecording === b[item].showInRecording
  )
}

/**
 * Keep a dragged or resized rect inside the canvas and no smaller than the
 * backend accepts, so a gesture never produces a rejected `overlays.layout.set`.
 */
export function clampOverlayRect(rect: OverlayRect): OverlayRect {
  const w = Math.min(1, Math.max(OVERLAY_RECT_MIN_SIZE, rect.w))
  const h = Math.min(1, Math.max(OVERLAY_RECT_MIN_SIZE, rect.h))
  const x = Math.min(1 - w, Math.max(0, rect.x))
  const y = Math.min(1 - h, Math.max(0, rect.y))
  return { x: round6(x), y: round6(y), w: round6(w), h: round6(h) }
}

export function overlayRectValid(rect: OverlayRect): boolean {
  const values = [rect.x, rect.y, rect.w, rect.h]
  return (
    values.every((value) => Number.isFinite(value)) &&
    rect.w >= OVERLAY_RECT_MIN_SIZE &&
    rect.h >= OVERLAY_RECT_MIN_SIZE &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.w <= 1 + 1e-6 &&
    rect.y + rect.h <= 1 + 1e-6
  )
}

/** The rect's centre lies in the lower half, so content hugs its bottom edge. */
export function overlayRectBottomGravity(rect: OverlayRect): boolean {
  return rect.y + rect.h / 2 >= 0.5
}

/** A canvas taller than wide takes the item's vertical rect (mirrors Rust). */
export function overlayOrientationForCanvas(width: number, height: number): OverlayOrientation {
  return height > width ? 'vertical' : 'horizontal'
}

// --- Leg plan (D12) ----------------------------------------------------------

export type OverlayAuxLeg = 'none' | 'stream' | 'vertical-simulcast'

export interface OverlayLegPlan {
  primary: boolean
  aux: boolean
  needsSplit: boolean
}

export interface OverlaySessionShape {
  recordEnabled: boolean
  streamEnabled: boolean
  auxLeg: OverlayAuxLeg
}

/** The one leg plan for every overlay item; the table lives in Rust's doc. */
export function overlayLegPlan(
  recordEnabled: boolean,
  streamEnabled: boolean,
  auxLeg: OverlayAuxLeg,
  showOnStream: boolean,
  showInRecording: boolean
): OverlayLegPlan {
  if (!recordEnabled && !streamEnabled) return { primary: false, aux: false, needsSplit: false }
  if (recordEnabled && !streamEnabled) {
    return { primary: showInRecording, aux: false, needsSplit: false }
  }
  if (!recordEnabled) {
    return {
      primary: showOnStream,
      aux: auxLeg === 'vertical-simulcast' && showOnStream,
      needsSplit: false
    }
  }
  switch (auxLeg) {
    case 'none':
      return showOnStream === showInRecording
        ? { primary: showOnStream, aux: false, needsSplit: false }
        : { primary: showInRecording, aux: showOnStream, needsSplit: true }
    case 'stream':
      return { primary: showInRecording, aux: showOnStream, needsSplit: false }
    case 'vertical-simulcast':
      return { primary: showInRecording || showOnStream, aux: showOnStream, needsSplit: false }
  }
}

/** True when any item would need a separate stream leg to honour both switches. */
export function overlayLayoutNeedsSplit(
  shape: OverlaySessionShape,
  layout: OverlayLayout
): boolean {
  return OVERLAY_ITEMS.some(
    (item) =>
      overlayLegPlan(
        shape.recordEnabled,
        shape.streamEnabled,
        shape.auxLeg,
        layout[item].showOnStream,
        layout[item].showInRecording
      ).needsSplit
  )
}

export interface OverlayStartNotice {
  item: OverlayItem
  notice: string
}

/**
 * Every impossible-to-honour switch pair for this session shape (D13), shown
 * verbatim in the Go Live sheet. Captions on a shared encode keep the plan
 * 090 block instead of a notice. Sentences mirror Rust byte for byte.
 */
export function overlayStartNotices(
  shape: OverlaySessionShape,
  layout: OverlayLayout
): OverlayStartNotice[] {
  if (!(shape.recordEnabled && shape.streamEnabled)) return []
  const notices: OverlayStartNotice[] = []
  for (const item of OVERLAY_ITEMS) {
    const switches = layout[item]
    if (switches.showOnStream === switches.showInRecording) continue
    const label = OVERLAY_ITEM_SENTENCE_LABELS[item]
    if (shape.auxLeg === 'stream') continue
    if (shape.auxLeg === 'vertical-simulcast') {
      notices.push({
        item,
        notice: switches.showOnStream
          ? `Recording will include ${label} while streaming vertical.`
          : `The horizontal stream will include ${label} while streaming vertical.`
      })
      continue
    }
    if (item === 'captions') continue
    notices.push({
      item,
      notice: `Both the stream and the recording will include ${label}: this computer shares one encode for them.`
    })
  }
  return notices
}

/** The badge an item shows on the canvas when its switches differ. */
export function overlayItemOutputBadge(
  item: OverlayItemLayout
): 'stream only' | 'recording only' | null {
  if (item.showOnStream === item.showInRecording) return null
  return item.showOnStream ? 'stream only' : 'recording only'
}
