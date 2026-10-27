import type {
  Banner,
  OverlayItem,
  OverlayItemLayout,
  OverlayLayout,
  OverlayOrientation,
  OverlayRect
} from '@/lib/backend'
import { OVERLAY_ITEMS } from '@/lib/backend'
import { bannerFitRect } from '@/lib/banner-place'
import type { WsStatus } from '@/lib/capture'
import { OFFLINE_LOCK_REASON } from '@/lib/lock-view'
import {
  OVERLAY_ITEM_LABELS,
  clampOverlayRect,
  cloneOverlayLayout,
  overlayItemOutputBadge
} from '@/lib/overlay-layout'

import { bannerAssetUrl } from '../../../../shared/banner-assets'
import type { StageRect } from './stage-transform'

// Overlay items on the Live Scene canvas (plan 164, D15). The stage draws the
// highlight card, the caption bar and the Buddy as labelled dashed rects that
// drag and resize like sources; a released gesture is ONE
// `overlays.layout.set` with the clamped rect (never the scene transaction
// policy). Pure helpers and the commit serializer live here, unit-tested.
//
// Banners (plan 186) ride the same plumbing: a showing banner, or the one
// selected, is a stage item too, drawn under the three overlay items (D5),
// its rect hugging its image so a resize keeps the image's aspect. A released
// gesture is ONE `banners.update` with the clamped rect.

const OVERLAY_STAGE_ID_PREFIX = 'overlay:'
/** Pinned (plan 186): the backend's editor draft matches this prefix to move
 * the banner's picture with a draft. */
const BANNER_STAGE_ID_PREFIX = 'banner:'

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

/** The stage-local id a banner uses in gestures and drafts: `banner:<id>`. */
export function bannerStageId(id: string): string {
  return `${BANNER_STAGE_ID_PREFIX}${id}`
}

export function bannerIdFromStageId(id: string | null | undefined): string | null {
  if (!id || !id.startsWith(BANNER_STAGE_ID_PREFIX)) return null
  return id.slice(BANNER_STAGE_ID_PREFIX.length) || null
}

export function overlayRectToStage(rect: OverlayRect): StageRect {
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
}

/** A stage rect becomes a wire rect: clamped inside the canvas and no smaller
 * than the backend accepts, so a gesture can never be rejected. */
export function stageRectToOverlay(rect: StageRect): OverlayRect {
  return clampOverlayRect({ x: rect.x, y: rect.y, w: rect.width, h: rect.height })
}

/** What a stage item stands for: one of the three overlay items, or a banner. */
export type StageItemTarget =
  | { kind: 'overlay'; item: OverlayItem }
  | { kind: 'banner'; id: string }

/** What the label says after the name: hidden, off, or which output alone shows it. */
export type StageItemBadge = 'hidden' | 'off' | 'stream only' | 'recording only'

/** What the schematic canvas draws for an item, so a drag shows the item
 * itself moving and not only its outline: a banner's image over its rect,
 * the Buddy's still in the square its pet fills. The live canvas never
 * shows it: there the compositor draws the real thing. */
export interface StageItemPicture {
  href: string
  /** Where it sits in the item's rect: all of it (a banner's rect hugs its
   * image), or the square the Buddy's pet fills (`buddyPetBox`). */
  fit: 'rect' | 'buddy'
  /** 0 to 1: a banner's own opacity. */
  opacity: number
}

interface StageItemFacts {
  stageId: string
  label: string
  rect: StageRect
  badge: StageItemBadge | null
  /** Drawn dimmed (plan 174, C-13): no output shows it, or a banner is hidden. */
  off: boolean
  /** A resize keeps the rect's aspect, Shift or not: a banner's rect is its image. */
  aspectLocked: boolean
  /** Unselected, the item takes the pointer on its whole rect, not only on
   * its label chip: a banner's picture is on the canvas, so a press on it
   * grabs it. An overlay item is a mostly empty zone over the sources, and a
   * banner that fills the canvas is a frame: both leave the sources under
   * them to the pointer (`bannerFillsCanvas`). */
  grabsBody: boolean
  picture: StageItemPicture | null
}

/** An item the stage draws after the sources: an overlay item or a banner. */
export type OverlayStageItem = StageItemFacts & StageItemTarget
export type OverlayItemStageItem = StageItemFacts & { kind: 'overlay'; item: OverlayItem }
export type BannerStageItem = StageItemFacts & { kind: 'banner'; id: string }

/** A released rect the stage shows until its commit lands, by stage id. */
export interface StageItemDraft {
  stageId: string
  rect: StageRect
}

/** An item neither output shows. */
export function overlayItemOff(
  item: Pick<OverlayItemLayout, 'showOnStream' | 'showInRecording'>
): boolean {
  return !item.showOnStream && !item.showInRecording
}

/**
 * The square the Buddy's pet fills inside its rect, in canvas units: the
 * renderer's twin of the backend's `buddy_sprite::buddy_box` (without its
 * whole-pixel rounding). The side is the rect's width in pixels, at most the
 * canvas's shorter side; it is centred on the rect, rests on the rect's
 * bottom edge when the rect sits in the lower half (else hangs from its top
 * edge), and stays inside the canvas. `canvasAspect` is width / height.
 */
export function buddyPetBox(rect: StageRect, canvasAspect: number): StageRect {
  const aspect = Number.isFinite(canvasAspect) && canvasAspect > 0 ? canvasAspect : 16 / 9
  const width = Math.min(rect.width, 1, 1 / aspect)
  const height = width * aspect
  const x = Math.min(Math.max(rect.x + rect.width / 2 - width / 2, 0), 1 - width)
  const y = Math.min(
    Math.max(rect.y + rect.height / 2 >= 0.5 ? rect.y + rect.height - height : rect.y, 0),
    1 - height
  )
  return { x, y, width, height }
}

/** Where an item's picture sits for the rect the stage shows it at (its
 * place, a drag's ghost or a released draft), in canvas units. */
export function stageItemPictureRect(
  picture: StageItemPicture,
  rect: StageRect,
  canvasAspect: number
): StageRect {
  return picture.fit === 'buddy' ? buddyPetBox(rect, canvasAspect) : rect
}

/** `buddyPicture` is the Buddy's idle still (`buddyStateImageUrl`), drawn in
 * its pet's square on the schematic canvas; null draws its zone alone. */
export function overlayStageItems(
  layout: OverlayLayout,
  orientation: OverlayOrientation,
  buddyPicture: string | null = null
): OverlayItemStageItem[] {
  return OVERLAY_ITEMS.map((item) => {
    const off = overlayItemOff(layout[item])
    return {
      kind: 'overlay',
      item,
      stageId: overlayStageId(item),
      label: OVERLAY_ITEM_LABELS[item],
      rect: overlayRectToStage(layout[item][orientation]),
      badge: off ? 'off' : overlayItemOutputBadge(layout[item]),
      off,
      aspectLocked: false,
      grabsBody: false,
      // The highlight card and the caption bar have no picture until a
      // comment or a caption exists: their zone is the truth.
      picture:
        item === 'buddy' && buddyPicture ? { href: buddyPicture, fit: 'buddy', opacity: 1 } : null
    }
  })
}

/** A banner this much of the canvas is a frame around the picture, not a
 * thing on it: taking the pointer on its whole rect would hide every source. */
const BANNER_FRAME_COVERAGE = 0.9

/** The banner's rect covers (nearly) the whole canvas. */
export function bannerFillsCanvas(rect: StageRect): boolean {
  return rect.width * rect.height >= BANNER_FRAME_COVERAGE
}

/**
 * The other items a dragged item snaps to. An overlay item snaps to every
 * other item; a banner only to the other banners: the highlight card, the
 * captions and the Buddy are zones that are empty most of the time (and
 * unpainted on the live picture), so their edges were magnets nobody could
 * see, in the way of every banner drag across the canvas.
 */
export function stageItemSnapPeers(
  entry: OverlayStageItem,
  items: readonly OverlayStageItem[]
): OverlayStageItem[] {
  return items.filter(
    (other) =>
      other.stageId !== entry.stageId && (entry.kind === 'overlay' || other.kind === 'banner')
  )
}

/**
 * The banners on the stage (plan 186): every banner that is showing, plus the
 * selected one, in Assets order (later is on top). Each rect is the image's
 * own rect inside its place on this orientation (`bannerFitRect`), so a
 * resize keeps the image's aspect in canvas units; `canvasAspect` is the
 * stage canvas's width / height. A selected hidden banner is dimmed and says
 * "hidden".
 */
export function bannerStageItems(
  banners: readonly Banner[],
  selectedId: string | null,
  orientation: OverlayOrientation,
  canvasAspect: number
): BannerStageItem[] {
  return banners
    .filter((banner) => banner.shown || banner.id === selectedId)
    .map((banner) => {
      const off = overlayItemOff(banner)
      const rect = overlayRectToStage(
        bannerFitRect(banner, banner[orientation], canvasAspect, orientation)
      )
      return {
        kind: 'banner',
        id: banner.id,
        stageId: bannerStageId(banner.id),
        label: banner.name,
        rect,
        badge: !banner.shown ? 'hidden' : off ? 'off' : overlayItemOutputBadge(banner),
        off: !banner.shown || off,
        aspectLocked: true,
        grabsBody: !bannerFillsCanvas(rect),
        // The full image, not the thumbnail: a strip may span the canvas.
        picture: {
          href: bannerAssetUrl(banner.imageFile),
          fit: 'rect',
          opacity: Math.min(Math.max(banner.opacity, 0), 1)
        }
      }
    })
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

/** How a failed overlay change reaches the streamer (the Studio's reportError). */
export type OverlayFailure = (error: unknown) => void

/** The one reason the overlay controls are off: they need the backend
 * (plan 174, C-6), in the app's one offline wording (S1.5). Null while it is
 * connected. */
export function overlayEditsBlockedReason(wsStatus: WsStatus): string | null {
  return wsStatus === 'connected' ? null : OFFLINE_LOCK_REASON
}

/** Serializes released overlay gestures: exactly one commit per gesture, the
 * released rect shown until the committed layout arrives (or the commit
 * fails, which drops the draft so the canvas shows the truth again and reports
 * the failure: a silent drop let a streamer believe an overlay had moved). */
export class OverlayEdits {
  draft: OverlayDraft | null = null
  private epoch = 0
  private tail: Promise<void> = Promise.resolve()
  constructor(
    private commit: OverlayCommit,
    private changed: () => void,
    private failed: OverlayFailure = () => {}
  ) {}
  configure(commit: OverlayCommit, failed?: OverlayFailure): void {
    this.commit = commit
    if (failed) this.failed = failed
  }
  /** The draft as the stage shows it, on the orientation it was made on. */
  stageDraft(orientation: OverlayOrientation): StageItemDraft | null {
    const draft = this.draft
    return draft?.orientation === orientation
      ? { stageId: overlayStageId(draft.item), rect: draft.rect }
      : null
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
      } catch (error) {
        // A newer intent superseded this gesture: its failure is not news.
        if (epoch !== this.epoch) return
        this.invalidate()
        this.failed(error)
      }
    })
  }
}

export interface BannerDraft {
  id: string
  orientation: OverlayOrientation
  rect: StageRect
}

/** `banners.update` with one orientation's rect; resolves null after a failure
 * that has already been reported (the Studio hook's banner actions). */
export type BannerCommit = (
  id: string,
  patch: Partial<Record<OverlayOrientation, OverlayRect>>
) => Promise<unknown>

/**
 * Serializes released banner gestures, like `OverlayEdits`: exactly one
 * `banners.update` per gesture with the clamped rect, the released rect shown
 * until the banner list echoes it (or the update fails, which drops it so the
 * canvas shows the truth again; the hook has already said why).
 */
export class BannerEdits {
  draft: BannerDraft | null = null
  private epoch = 0
  private tail: Promise<void> = Promise.resolve()
  constructor(
    private commit: BannerCommit,
    private changed: () => void
  ) {}
  configure(commit: BannerCommit): void {
    this.commit = commit
  }
  stageDraft(orientation: OverlayOrientation): StageItemDraft | null {
    const draft = this.draft
    return draft?.orientation === orientation
      ? { stageId: bannerStageId(draft.id), rect: draft.rect }
      : null
  }
  /** The banner list caught up with the draft, or the banner is gone: drop it. */
  observe(banners: readonly Banner[]): void {
    const draft = this.draft
    if (!draft) return
    const banner = banners.find((candidate) => candidate.id === draft.id)
    const expected = stageRectToOverlay(draft.rect)
    const committed = banner?.[draft.orientation]
    if (
      !committed ||
      (committed.x === expected.x &&
        committed.y === expected.y &&
        committed.w === expected.w &&
        committed.h === expected.h)
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
  submit(id: string, orientation: OverlayOrientation, rect: StageRect): void {
    const clamped = stageRectToOverlay(rect)
    const draft = { id, orientation, rect: overlayRectToStage(clamped) }
    this.draft = draft
    const epoch = this.epoch
    const commit = this.commit
    this.changed()
    this.tail = this.tail.then(async () => {
      if (epoch !== this.epoch) return
      let result: unknown
      try {
        result = await commit(id, { [orientation]: clamped })
      } catch {
        result = null
      }
      if (epoch !== this.epoch) return
      if (result === null) {
        this.invalidate()
        return
      }
      // The reply is already in the banner list: the draft has done its job,
      // even when the backend stored the rect a hair differently.
      if (this.draft === draft) {
        this.draft = null
        this.changed()
      }
    })
  }
}
