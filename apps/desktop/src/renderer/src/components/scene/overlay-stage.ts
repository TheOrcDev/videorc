import type { OverlayItem, OverlayLayout, OverlayOrientation, OverlayRect } from '@/lib/backend'
import { OVERLAY_ITEMS } from '@/lib/backend'
import {
  OVERLAY_ITEM_LABELS,
  clampOverlayRect,
  cloneOverlayLayout,
  overlayItemOutputBadge
} from '@/lib/overlay-layout'

import type { StageRect } from './stage-transform'

// Overlay items on the Live Scene canvas (plan 164, D15). The stage draws the
// highlight card, the caption bar and the Buddy as labelled dashed rects that
// drag and resize like sources; a released gesture is ONE
// `overlays.layout.set` with the clamped rect (never the scene transaction
// policy). Pure helpers and the commit serializer live here, unit-tested.

const OVERLAY_STAGE_ID_PREFIX = 'overlay:'

/** The stage-local id an overlay item uses in gestures and drafts. It never
 * names a scene source, so a chrome-only draft for it draws the frame on the
 * live picture without moving anything. */
export function overlayStageId(item: OverlayItem): string {
  return `${OVERLAY_STAGE_ID_PREFIX}${item}`
}

export function overlayItemFromStageId(id: string | null | undefined): OverlayItem | null {
  if (!id || !id.startsWith(OVERLAY_STAGE_ID_PREFIX)) return null
  const item = id.slice(OVERLAY_STAGE_ID_PREFIX.length)
  return (OVERLAY_ITEMS as readonly string[]).includes(item) ? (item as OverlayItem) : null
}

export function overlayRectToStage(rect: OverlayRect): StageRect {
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
}

/** A stage rect becomes a wire rect: clamped inside the canvas and no smaller
 * than the backend accepts, so a gesture can never be rejected. */
export function stageRectToOverlay(rect: StageRect): OverlayRect {
  return clampOverlayRect({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })
}

export interface OverlayStageItem {
  item: OverlayItem
  stageId: string
  label: string
  rect: StageRect
  badge: 'stream only' | 'recording only' | null
}

export function overlayStageItems(
  layout: OverlayLayout,
  orientation: OverlayOrientation
): OverlayStageItem[] {
  return OVERLAY_ITEMS.map((item) => ({
    item,
    stageId: overlayStageId(item),
    label: OVERLAY_ITEM_LABELS[item],
    rect: overlayRectToStage(layout[item][orientation]),
    badge: overlayItemOutputBadge(layout[item])
  }))
}

/** The whole layout with one item's rect replaced on one orientation. */
export function withOverlayRect(
  layout: OverlayLayout,
  item: OverlayItem,
  orientation: OverlayOrientation,
  rect: OverlayRect
): OverlayLayout {
  const next = cloneOverlayLayout(layout)
  next[item] = { ...next[item], [orientation]: rect }
  return next
}

export interface OverlayDraft {
  item: OverlayItem
  orientation: OverlayOrientation
  rect: StageRect
}

export type OverlayCommit = (layout: OverlayLayout) => Promise<void>

/** Serializes released overlay gestures: exactly one commit per gesture, the
 * released rect shown until the committed layout arrives (or the commit
 * fails, which drops the draft so the canvas shows the truth again). */
export class OverlayEdits {
  draft: OverlayDraft | null = null
  private epoch = 0
  private tail: Promise<void> = Promise.resolve()
  constructor(
    private commit: OverlayCommit,
    private changed: () => void
  ) {}
  configure(commit: OverlayCommit): void {
    this.commit = commit
  }
  /** The committed layout caught up with the draft (or moved on): drop it. */
  observe(layout: OverlayLayout): void {
    const draft = this.draft
    if (!draft) return
    const committed = layout[draft.item][draft.orientation]
    const expected = stageRectToOverlay(draft.rect)
    if (
      committed.x === expected.x &&
      committed.y === expected.y &&
      committed.w === expected.w &&
      committed.h === expected.h
    ) {
      this.draft = null
      this.changed()
    }
  }
  invalidate(): void {
    this.epoch++
    this.draft = null
    this.changed()
  }
  submit(
    layout: OverlayLayout,
    item: OverlayItem,
    orientation: OverlayOrientation,
    rect: StageRect
  ): void {
    const clamped = stageRectToOverlay(rect)
    this.draft = { item, orientation, rect: overlayRectToStage(clamped) }
    const epoch = this.epoch
    const commit = this.commit
    this.changed()
    this.tail = this.tail.then(async () => {
      if (epoch !== this.epoch) return
      try {
        await commit(withOverlayRect(layout, item, orientation, clamped))
      } catch {
        if (epoch === this.epoch) this.invalidate()
      }
    })
  }
}
